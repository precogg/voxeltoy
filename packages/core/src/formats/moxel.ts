import { checkTags, type AnimationTag, DEFAULT_FPS, isDuration, isFps, MAX_FRAMES } from "../animation";
import { fromHex, MAX_COLORS, toHex } from "../color";
import { checkJson, isValidId, MAX_ANIMATION_BYTES, MAX_LAYERS, MAX_SIZE } from "../ops";
import { checkSource, isResolution, type ShapeSource } from "../source";
import { snapMarker, type Marker } from "../markers";
import type { DocumentData, DocumentFrame, DocumentLayer, Json, Vec3 } from "../types";


// Native format: readable JSON with run-length encoded, base64 layer data.
// New files say "format": "voxeltoy". Files that say "format": "voxeltoy" still open.
//
// {
//   "format": "voxeltoy", "version": 1,
//   "name": "Untitled", "size": [32, 32, 32],
//   "palette": ["#be4a2f", ...],          // palette[0] is voxel value 1
//   "activeLayer": 0,
//   "layers": [{ "name": "Layer 1", "visible": true, "locked": false, "voxels": "<base64 RLE>" }]
// }
//
// Older files' rigged layers had "parent" (a layer index) and "pivot" ([x, y, z] in grid units).
// Rigs are scenes now (docs/pipeline.md): a pivot opens as a mount marker named after its layer,
// and parents are dropped.
//
// RLE is a sequence of (run length - 1, value) byte pairs, cells in x-major order.
//
// Version 2 holds what version 1 can't: shape layers, override layers and an output resolution
// (see docs/vector-raster.md). A document without them is still saved as version 1, so older
// apps keep opening it; older apps turn version 2 down rather than lose what is in it.
//
// {
//   "format": "voxeltoy", "version": 2, "name": "Untitled",
//   "size": [64, 64, 64],                 // output cells
//   "resolution": 2,                       // output cells per source unit: 1, 2, 4 or 8
//   "palette": [...], "activeLayer": 1,
//   "layers": [
//     { "id": "layer:a", "kind": "shape", "name": "Box 1", "visible": true, "locked": false,
//       "shape": { "id": "node:b", "kind": "subtract", "left": { "id": "node:c", "kind": "box",
//                  "min": [8, 0, 8], "max": [24, 16, 24], "material": 1 }, "right": { ... } } },
//     { "id": "layer:d", "kind": "raster", "name": "Layer 2", "visible": true, "locked": false,
//       "voxels": "<base64 RLE>", "coverage": "<base64 RLE of 0/1, present on override layers>" }
//   ]
// }
//
// Shape corners are in source units, half-open, in multiples of 1/8. Layer ids are kept.
//
// Version 3 is an animation (see docs/animation.md): version 2's layers without their voxels,
// and frames that hold each layer's voxels (a cel) in order. A frame lasts `duration` ticks of
// 1 / fps seconds. Cels are parallel to the layers; a shape layer's is null. Saved only for a
// document with frames, so still models stay version 1 or 2.
//
// {
//   "format": "voxeltoy", "version": 3, ...version 2's fields, without "voxels" on raster layers,
//   "fps": 12, "activeFrame": 0,
//   "frames": [{ "id": "frame:a", "duration": 2, "cels": ["<base64 RLE>", null, ...] }, ...]
// }
//
// Every version may also hold, without changing its number (older apps ignore them):
//
//   "docId": "doc:…"        a stable identity, kept by saving (docs/scenes.md)
//   "revision": 12          goes up with every change
//   "data": { "<ns>": … }   host data by namespace; on a layer, "data" is that layer's host data
//   "markers": [ … ]        named points and volumes, each { id, name, shape, role?, keys?, data? };
//                           keys name frames by id (docs/pipeline.md)
//   "origin": [x, y, z]     the point the model is placed by, in source units
//   "groups": [ … ]         layer groups, each { id, name, visible, blend?, effects?, group? }
//
// and on a layer: "blend" ({ occupancy, keep }), "mask" (base64 RLE of 0/1), "effects" (a list)
// and "group" (a group id). See docs/pipeline.md.
//
// Keys this app doesn't know, at the top or on a layer, are read into `extra` and written back,
// so a file passed through an app that doesn't know them comes out intact.

/** Format string new files are written with. */
export const FORMAT = "voxeltoy";
/** Format string older files use. Still accepted on read. */
export const LEGACY_FORMAT = "moxel";

export type NativeFormat = typeof FORMAT | typeof LEGACY_FORMAT;

export function isNativeFormat(format: unknown): format is NativeFormat {
  return format === FORMAT || format === LEGACY_FORMAT;
}

/** Extension new files are saved with. */
export const VOXELTOY_EXTENSION = ".voxeltoy";
/** Extension older files use. Still opened. */
export const LEGACY_EXTENSION = ".moxel";

/** Older name for {@link LEGACY_EXTENSION}. New files use {@link VOXELTOY_EXTENSION}. */
export const MOXEL_EXTENSION = LEGACY_EXTENSION;

export function isNativeExtension(ext: string): boolean {
  const dotted = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return dotted === VOXELTOY_EXTENSION || dotted === LEGACY_EXTENSION;
}

interface MoxelFile {
  format: NativeFormat;
  version: 1;
  name: string;
  size: Vec3;
  palette: string[];
  activeLayer: number;
  layers: { name: string; visible: boolean; locked: boolean; voxels: string; parent?: number; pivot?: Vec3 }[];
}

interface MoxelLayerV2 {
  id?: string;
  kind: "raster" | "shape";
  name: string;
  visible: boolean;
  locked: boolean;
  voxels?: string;
  coverage?: string;
  shape?: ShapeSource;
  parent?: number;
  pivot?: Vec3;
}

interface MoxelFileV2 {
  format: NativeFormat;
  version: 2;
  name: string;
  size: Vec3;
  resolution: number;
  palette: string[];
  activeLayer: number;
  layers: MoxelLayerV2[];
}

interface MoxelFrame {
  id?: string;
  duration: number;
  cels: (string | null)[];
}

interface MoxelFileV3 extends Omit<MoxelFileV2, "version"> {
  version: 3;
  fps: number;
  activeFrame: number;
  frames: MoxelFrame[];
  tags?: AnimationTag[];
}

/** Whether a document needs version 2: shape layers, override layers or a resolution other than 1. */
const needsV2 = (doc: DocumentData) => (doc.resolution ?? 1) !== 1 || doc.layers.some((l) => l.shape || l.coverage);

/** Keys each version of the format defines, at the top and on layers; anything else is kept in `extra`. */
const TOP_KEYS = new Set([
  "format", "version", "name", "size", "palette", "activeLayer", "layers", "resolution",
  "fps", "activeFrame", "frames", "tags", "docId", "revision", "data", "markers", "origin", "groups",
]);
const LAYER_KEYS = new Set(["id", "kind", "name", "visible", "locked", "voxels", "coverage", "shape", "parent", "pivot", "data", "blend", "mask", "effects", "group"]);

/** Add identity, host data and kept keys to a file about to be written. */
function finish(file: object, doc: DocumentData): Record<string, unknown> {
  const out = file as Record<string, unknown> & { layers: Record<string, unknown>[] };
  if (doc.extra) for (const [k, v] of Object.entries(doc.extra)) if (!TOP_KEYS.has(k)) out[k] = v;
  if (doc.docId) out.docId = doc.docId;
  if (Number.isInteger(doc.revision)) out.revision = doc.revision;
  if (doc.hostData && Object.keys(doc.hostData).length) out.data = doc.hostData;
  if (doc.markers?.length) out.markers = doc.markers;
  if (doc.origin) out.origin = doc.origin;
  if (doc.groups?.length) out.groups = doc.groups;
  doc.layers.forEach((l, i) => {
    const layer = out.layers[i];
    if (l.blend) layer.blend = l.blend;
    if (l.mask) layer.mask = toBase64(encodeRle(l.mask));
    if (l.effects?.length) layer.effects = l.effects;
    if (l.group) layer.group = l.group;
    if (l.extra) for (const [k, v] of Object.entries(l.extra)) if (!LAYER_KEYS.has(k)) layer[k] = v;
    if (l.hostData !== undefined && l.hostData !== null) layer.data = l.hostData;
  });
  return out;
}

/** The keys of `from` that `known` doesn't list, checked as JSON. */
function unknownKeys(from: Record<string, unknown>, known: Set<string>): Record<string, Json> | undefined {
  let out: Record<string, Json> | undefined;
  for (const [k, v] of Object.entries(from)) {
    if (known.has(k) || v === undefined) continue;
    (out ??= {})[k] = checkJson(v);
  }
  return out;
}

/** Read identity, host data and kept keys from a parsed file into its document. */
function attach(file: Record<string, unknown>, doc: DocumentData): DocumentData {
  try {
    if (typeof file.docId === "string" && isValidId(file.docId)) doc.docId = file.docId;
    if (Number.isInteger(file.revision) && (file.revision as number) >= 0) doc.revision = file.revision as number;
    if (file.data !== undefined && file.data !== null) {
      const data = checkJson(file.data);
      if (typeof data !== "object" || Array.isArray(data) || data === null) throw new Error("its data must be an object");
      doc.hostData = data;
    }
    // checked when the document opens them, against its frames
    if (file.markers !== undefined) {
      if (!Array.isArray(file.markers)) throw new Error("its markers must be a list");
      doc.markers = [...(doc.markers ?? []), ...(checkJson(file.markers) as unknown as Marker[])];
    }
    if (file.origin !== undefined) {
      if (!isVec3(file.origin)) throw new Error("its origin must be [x, y, z]");
      doc.origin = [...file.origin] as Vec3;
    }
    if (file.groups !== undefined) {
      if (!Array.isArray(file.groups)) throw new Error("its groups must be a list");
      doc.groups = checkJson(file.groups) as unknown as DocumentData["groups"];
    }
    const extra = unknownKeys(file, TOP_KEYS);
    if (extra) doc.extra = extra;
    const layers = Array.isArray(file.layers) ? (file.layers as Record<string, unknown>[]) : [];
    doc.layers.forEach((l, i) => {
      const from = layers[i];
      if (!from || typeof from !== "object") return;
      if (from.data !== undefined && from.data !== null) l.hostData = checkJson(from.data);
      // checked when the document opens them
      if (from.blend !== undefined) l.blend = checkJson(from.blend) as unknown as DocumentLayer["blend"];
      if (from.effects !== undefined) l.effects = checkJson(from.effects) as unknown as DocumentLayer["effects"];
      if (typeof from.group === "string") l.group = from.group;
      if (typeof from.mask === "string") {
        const count = doc.size[0] * doc.size[1] * doc.size[2];
        l.mask = decodeRle(fromBase64(from.mask), count);
      }
      const kept = unknownKeys(from, LAYER_KEYS);
      if (kept) l.extra = kept;
    });
  } catch (e) {
    throw new Error(`This Voxeltoy file is damaged: ${(e as Error).message.replace(/^This Voxeltoy file is damaged: /, "")}`);
  }
  return doc;
}

/**
 * One model as an older (version 1 to 3) `.moxel` file. The app saves libraries
 * (`serializeLibrary`); this is the form a library's models take inside one.
 */
export function serializeMoxel(doc: DocumentData): string {
  return JSON.stringify(moxelObject(doc));
}

/** One model as the JSON object a version 1 to 3 file holds. */
export function moxelObject(doc: DocumentData): Record<string, unknown> {
  if (doc.frames?.length) return finish(toV3(doc, doc.frames), doc);
  if (needsV2(doc)) return finish(toV2(doc), doc);
  const file: MoxelFile = {
    format: FORMAT,
    version: 1,
    name: doc.name,
    size: doc.size,
    palette: doc.palette.slice(1).map(toHex),
    activeLayer: doc.activeLayer,
    layers: doc.layers.map((l) => ({
      name: l.name,
      visible: l.visible,
      locked: l.locked,
      voxels: toBase64(encodeRle(l.data)),
    })),
  };
  return finish(file, doc);
}

function toV2(doc: DocumentData): MoxelFileV2 {
  return {
    format: FORMAT,
    version: 2,
    name: doc.name,
    size: doc.size,
    resolution: doc.resolution ?? 1,
    palette: doc.palette.slice(1).map(toHex),
    activeLayer: doc.activeLayer,
    layers: doc.layers.map((l) => ({
      ...(l.id ? { id: l.id } : {}),
      kind: l.shape ? "shape" : "raster",
      name: l.name,
      visible: l.visible,
      locked: l.locked,
      ...(l.shape ? { shape: l.shape } : { voxels: toBase64(encodeRle(l.data)) }),
      ...(l.coverage && !l.shape ? { coverage: toBase64(encodeRle(l.coverage)) } : {}),
    })),
  };
}

function toV3(doc: DocumentData, frames: DocumentFrame[]): MoxelFileV3 {
  const v2 = toV2(doc);
  return {
    ...v2,
    version: 3,
    layers: v2.layers.map(({ voxels: _, ...l }) => l),
    fps: doc.fps ?? DEFAULT_FPS,
    tags: checkTags(doc.tags ?? [], frames),
    activeFrame: doc.activeFrame ?? 0,
    frames: frames.map((f) => ({
      ...(f.id ? { id: f.id } : {}),
      duration: f.duration,
      cels: doc.layers.map((l, i) => (l.shape ? null : toBase64(encodeRle(f.cels[i])))),
    })),
  };
}

/**
 * One model from a `.moxel` file: the file's model, or a library's primary model (else its first).
 * The app opens whole libraries (`parseLibrary`); this is for tools that want one model.
 */
export function parseMoxel(text: string): DocumentData {
  const file = JSON.parse(text) as Record<string, unknown>;
  if (!file || !isNativeFormat(file.format)) throw new Error("Not a Voxeltoy file");
  if (file.version === 4) {
    const models = Array.isArray(file.models) ? (file.models as Record<string, unknown>[]) : [];
    const main = models.find((m) => m?.id === file.primary) ?? models[0];
    if (!main || typeof main.model !== "object") throw new Error("This library has no model");
    return parseMoxelObject(main.model as Record<string, unknown>);
  }
  return parseMoxelObject(file);
}

/** One model from the JSON object of a version 1 to 3 file. */
export function parseMoxelObject(object: Record<string, unknown>): DocumentData {
  const file = object as unknown as MoxelFile | MoxelFileV2 | MoxelFileV3;
  if (!file || !isNativeFormat(file.format)) throw new Error("Not a Voxeltoy file");
  return attach(object, parseFile(file));
}

function parseFile(file: MoxelFile | MoxelFileV2 | MoxelFileV3): DocumentData {
  const doc = parseLayers(file);
  const markers = pivotMarkers(file);
  return markers.length ? { ...doc, markers } : doc;
}

/**
 * Older files' layer pivots, as mount markers named after their layers, in source units. A
 * marker's id comes from its layer's (or its position), so attachments to the part can find it.
 */
function pivotMarkers(file: MoxelFile | MoxelFileV2 | MoxelFileV3): Marker[] {
  const resolution = file.version === 1 ? 1 : (file.resolution ?? 1);
  const layers: { id?: string; name?: string; pivot?: unknown }[] = Array.isArray(file.layers) ? file.layers : [];
  return layers.flatMap((l, n): Marker[] => {
    if (!l || !isVec3(l.pivot)) return [];
    const name = typeof l.name === "string" && l.name.trim() ? l.name.trim().slice(0, 120) : `Layer ${n + 1}`;
    return [{ id: pivotMarkerId(l.id, n), name, role: "mount", shape: { kind: "point", at: snapMarker(l.pivot.map((v) => v / resolution) as Vec3) } }];
  });
}

/** The marker an older file's layer pivot becomes: by the layer's id, or its position. */
export function pivotMarkerId(layerId: unknown, index: number): string {
  return typeof layerId === "string" && /^[\w:.-]{1,56}$/.test(layerId) ? `marker:${layerId}` : `marker:pivot-${index}`;
}

function parseLayers(file: MoxelFile | MoxelFileV2 | MoxelFileV3): DocumentData {
  if (file.version === 2) return parseV2(file);
  if (file.version === 3) return parseV3(file);
  if (file.version !== 1) throw new Error(`Unsupported Voxeltoy version ${(file as { version: unknown }).version}`);
  const [sx, sy, sz] = file.size;
  const count = sx * sy * sz;
  return {
    name: file.name,
    size: [sx, sy, sz],
    palette: [0, ...file.palette.map(fromHex)],
    activeLayer: file.activeLayer ?? 0,
    layers: file.layers.map((l) => ({
      name: l.name,
      visible: l.visible ?? true,
      locked: l.locked ?? false,
      data: decodeRle(fromBase64(l.voxels), count),
    })),
  };
}

/**
 * A version 3 file: version 2's layers, with voxels from the frames. Checked before anything is
 * allocated for it.
 */
function parseV3(file: MoxelFileV3): DocumentData {
  const bad = (why: string): never => {
    throw new Error(`This Voxeltoy file is damaged: ${why}`);
  };
  const fps = file.fps ?? DEFAULT_FPS;
  if (!isFps(fps)) bad("its frames per second must be from 1 to 60");
  const frames = file.frames;
  if (!Array.isArray(frames) || !frames.length) bad("it has no frames");
  if (frames.length > MAX_FRAMES) bad(`it has more than ${MAX_FRAMES} frames`);
  if (!Array.isArray(file.layers)) bad("its layers are malformed");
  const size = file.size;
  if (!isVec3(size) || !size.every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_SIZE)) bad("its size is out of range");
  const count = size[0] * size[1] * size[2];
  const rasters = file.layers.filter((l) => l?.kind !== "shape").length;
  if (frames.length * rasters * count > MAX_ANIMATION_BYTES) bad("it is too big to open");
  const activeFrame = Number.isInteger(file.activeFrame) ? Math.max(0, Math.min(frames.length - 1, file.activeFrame)) : 0;
  const parsed: DocumentFrame[] = frames.map((f, n) => {
    if (!f || !isDuration(f.duration)) bad(`frame ${n + 1} must last 1 to 999 ticks`);
    if (f.id !== undefined && !isValidId(f.id)) bad(`frame ${n + 1} has a malformed id`);
    if (!Array.isArray(f.cels) || f.cels.length !== file.layers.length) bad(`frame ${n + 1} doesn't match the layers`);
    return {
      ...(f.id !== undefined ? { id: f.id } : {}),
      duration: f.duration,
      cels: file.layers.map((l, i) => {
        if (l?.kind === "shape") return new Uint8Array(0);
        const cel = f.cels[i];
        if (typeof cel !== "string") return bad(`frame ${n + 1} is missing voxels for a layer`);
        return decodeRle(fromBase64(cel), count);
      }),
    };
  });
  // version 2's checks, with the open frame's voxels on the layers
  const open = parsed[activeFrame];
  const doc = parseV2({
    ...file,
    version: 2,
    layers: file.layers.map((l, i) => (l?.kind === "shape" ? l : { ...l, voxels: toBase64(encodeRle(open.cels[i])) })),
  });
  for (const [n, frame] of parsed.entries()) {
    for (const cel of frame.cels) for (let i = 0; i < cel.length; i++) if (cel[i] >= doc.palette.length) bad(`frame ${n + 1} uses a color that isn't in the palette`);
  }
  doc.layers.forEach((l, i) => {
    if (!l.shape) l.data = open.cels[i];
  });
  return { ...doc, fps, frames: parsed, activeFrame, tags: checkTags(file.tags ?? [], parsed) };
}

/** A version 2 file, checked before anything is allocated for it. */
function parseV2(file: MoxelFileV2): DocumentData {
  const bad = (why: string): never => {
    throw new Error(`This Voxeltoy file is damaged: ${why}`);
  };
  const size = file.size;
  if (!isVec3(size) || !size.every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_SIZE)) bad("its size is out of range");
  const resolution = file.resolution ?? 1;
  if (!isResolution(resolution)) bad("its resolution must be 1, 2, 4 or 8");
  if (size.some((n) => n % resolution)) bad("its size doesn't fit its resolution");
  if (!Array.isArray(file.palette) || file.palette.length > MAX_COLORS || !file.palette.every((c) => typeof c === "string")) {
    bad("its palette is malformed");
  }
  const palette = [0, ...file.palette.map(fromHex)];
  if (!Array.isArray(file.layers) || file.layers.length > MAX_LAYERS) bad("it has too many layers");
  const count = size[0] * size[1] * size[2];
  const layers = file.layers.map((l, n): DocumentLayer => {
    const name = typeof l.name === "string" && l.name.trim() ? l.name : `Layer ${n + 1}`;
    const base = {
      ...(typeof l.id === "string" ? { id: l.id } : {}),
      name,
      visible: l.visible ?? true,
      locked: l.locked ?? false,
    };
    if (l.kind === "shape") {
      let shape: ShapeSource;
      try {
        shape = checkSource(l.shape, palette.length);
      } catch (e) {
        return bad(`layer “${name}”: ${(e as Error).message}`);
      }
      return { ...base, data: new Uint8Array(0), shape };
    }
    if (l.kind !== "raster" || typeof l.voxels !== "string") return bad(`layer “${name}” is malformed`);
    const data = decodeRle(fromBase64(l.voxels), count);
    for (let i = 0; i < count; i++) if (data[i] >= palette.length) bad(`layer “${name}” uses a color that isn't in the palette`);
    if (l.coverage === undefined) return { ...base, data };
    if (typeof l.coverage !== "string") return bad(`layer “${name}” is malformed`);
    const coverage = decodeRle(fromBase64(l.coverage), count);
    for (let i = 0; i < count; i++) {
      if (coverage[i] > 1 || (data[i] && !coverage[i])) bad(`layer “${name}” has malformed coverage`);
    }
    return { ...base, data, coverage };
  });
  return {
    name: typeof file.name === "string" ? file.name : "Untitled",
    size: [...size],
    ...(resolution !== 1 ? { resolution } : {}),
    palette,
    activeLayer: Number.isInteger(file.activeLayer) ? file.activeLayer : 0,
    layers,
  };
}

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

export function encodeRle(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const value = data[i];
    let run = 1;
    while (run < 256 && i + run < data.length && data[i + run] === value) run++;
    out.push(run - 1, value);
    i += run;
  }
  return Uint8Array.from(out);
}

export function decodeRle(rle: Uint8Array, count: number): Uint8Array {
  const data = new Uint8Array(count);
  let o = 0;
  for (let i = 0; i + 1 < rle.length && o < count; i += 2) {
    const run = rle[i] + 1;
    data.fill(rle[i + 1], o, Math.min(count, o + run));
    o += run;
  }
  return data;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
