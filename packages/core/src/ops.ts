import { checkTags, type AnimationTag } from "./animation";
// Document ops: every change to a document, as plain data. The editor records them in its
// history, a room applies them in order, and every client replays them. Applying an op checks
// it against the document first (and changes nothing if it doesn't fit), then fills in what it
// replaced, so it can be inverted exactly. See docs/collaboration.md.

import { FIRST_FRAME_ID, isDuration, isFps, MAX_FRAMES } from "./animation";
import { MAX_COLORS } from "./color";
import { resampleRaster } from "./evaluate";
import type { LayerGroup } from "./types";
import { checkEffects, effectColors, EffectError, type Effect } from "./effects";
import { checkBlend, resampleMask, type Blend } from "./evaluate";
import { checkMarker, checkOrigin, giveFrameKeys, MAX_MARKERS, MarkerError, takeFrameKeys, translateMarker, type Marker, type MarkerKey } from "./markers";
import { checkSource, isResolution, SourceError, sourceMaterials, translateSource, type ShapeSource } from "./source";
import type { Json, Vec3 } from "./types";

export const MAX_SIZE = 256;
export const MAX_LAYERS = 256;
export const MAX_NAME = 120;
/** Host data (a document's and all its layers'), as JSON characters. */
export const MAX_HOST_DATA = 64 * 1024;

/** A layer as ops see it. The editor's layers add local state (visibility, lock) on top. */
export interface LayerRecord {
  readonly id: string;
  readonly name: string;
  /** One byte per cell, x-major. 0 = empty, otherwise a palette index. Empty (length 0) for a shape layer. */
  readonly data: Uint8Array;
  /** Override rasters: 1 = covered. A covered 0 is explicitly empty; uncovered cells hold 0. */
  readonly coverage?: Uint8Array;
  /** Shape layers: the geometry their voxels are evaluated from. */
  readonly shape?: ShapeSource;
  readonly blend?: Blend;
  /** Where the layer acts (1), the same in every frame. */
  readonly mask?: Uint8Array;
  readonly effects?: readonly Effect[];
  readonly group?: string;
  /** The creator's visibility and lock, used as defaults where the layer arrives. */
  readonly visible?: boolean;
  readonly locked?: boolean;
  /** A host's data for the layer, and keys from newer files; kept as they are. */
  readonly hostData?: Json;
  readonly extra?: Readonly<Record<string, Json>>;
}

/**
 * One pose of an animation, lasting `duration` ticks. `cels` holds each raster layer's voxels in
 * this frame, by layer id, for every frame except the target's current one: that frame's voxels
 * are its layers' `data`. See docs/animation.md.
 */
export interface FrameRecord {
  readonly id: string;
  readonly duration: number;
  readonly cels?: Readonly<Record<string, Uint8Array>>;
}

/** What ops read and change: the editor's document, or a room's copy of it. */
export interface DocTarget {
  readonly name: string;
  readonly size: Vec3;
  /** Changes with every resize, so cell indices from another grid are never applied to this one. */
  readonly gen: string;
  /**
   * Output cells per source unit, a power of two. Undefined for a target that only holds raster
   * layers (a live room), which turns down shape layers, overrides and resolution changes.
   */
  readonly resolution?: number;
  readonly palette: readonly number[];
  readonly layers: readonly LayerRecord[];
  setName(name: string): void;
  setPalette(palette: readonly number[]): void;
  setLayers(layers: readonly LayerRecord[]): void;
  /** Swap in a new grid: size, generation and re-laid-out layers together (and the resolution, when it changes). */
  setGrid(size: Vec3, gen: string, layers: readonly LayerRecord[], resolution?: number): void;
  writeCell(data: Uint8Array, index: number, value: number): void;
  /**
   * The animation's frames in order. Undefined for a target without animation (a live room):
   * it has one frame, and turns frame edits down.
   */
  readonly frames?: readonly FrameRecord[];
  /** The frame whose voxels the layers hold. */
  readonly frame?: string;
  /** Ticks per second. */
  readonly fps?: number;
  /** Swap in new frames, the current one, and layers holding that frame's voxels, together. */
  setFrames?(frames: readonly FrameRecord[], current: string, layers: readonly LayerRecord[]): void;
  setFps?(fps: number): void;
  readonly tags?: readonly AnimationTag[];
  setTags?(tags: readonly AnimationTag[]): void;
  /** Host data by namespace. Undefined for a target that keeps none, which turns `data` ops down. */
  readonly hostData?: Readonly<Record<string, Json>>;
  setHostData?(data: Readonly<Record<string, Json>>): void;
  /** Named points and volumes (docs/pipeline.md). Undefined for a target without them (a live room), which turns marker ops down. */
  readonly markers?: readonly Marker[];
  setMarkers?(markers: readonly Marker[]): void;
  /** The point the model is placed by, in source units; null is the center of the floor. */
  readonly origin?: Vec3 | null;
  setOrigin?(origin: Vec3 | null): void;
  /** Layer groups. Undefined for a target without them (a live room), which turns group ops down. */
  readonly groups?: readonly LayerGroup[];
  setGroups?(groups: readonly LayerGroup[]): void;
}

/** Cells of one layer, written to `after`; `before` is what they held. */
export interface VoxelsOp {
  t: "voxels";
  layer: string;
  /** The frame the cells are in. Unset only where the document has one frame. */
  frame?: string;
  gen: string;
  /** Which of the layer's arrays: its values (the default), or an override's coverage (0 or 1). */
  channel?: "coverage";
  cells: Uint32Array;
  before: Uint8Array;
  after: Uint8Array;
}

export interface NameOp {
  t: "name";
  before: string;
  after: string;
}

/** A new layer at `index` (bottom to top), empty unless it brings data. */
export interface LayerAddOp {
  t: "layer.add";
  index: number;
  layer: {
    id: string;
    name: string;
    data?: Uint8Array;
    /**
     * In an animation, its voxels in each frame, by frame id. Frames it doesn't list get `data`,
     * or start empty.
     */
    cels?: Record<string, Uint8Array>;
    /** An override raster's coverage; with no `data`, the layer starts all unset. */
    coverage?: Uint8Array;
    /** A shape layer's geometry. Shape layers have no `data`. */
    shape?: ShapeSource;
    blend?: Blend;
    mask?: Uint8Array;
    effects?: readonly Effect[];
    group?: string;
    visible?: boolean;
    locked?: boolean;
    hostData?: Json;
    extra?: Record<string, Json>;
  };
}

export interface LayerRemoveOp {
  t: "layer.remove";
  id: string;
  /** Filled in when applied, to put it back. */
  index?: number;
  layer?: LayerRecord;
  /** Its voxels in every frame, where there is more than one. */
  cels?: Record<string, Uint8Array>;
}

export interface LayerMoveOp {
  t: "layer.move";
  id: string;
  to: number;
  from?: number;
}

export type LayerKey = "name" | "blend" | "effects" | "group";
/** A name; a blend (null: its kind's); effects (null: none); a group id (null: none). */
export type LayerValue = string | Blend | readonly Effect[] | null;

/** A layer's mask, replaced whole; null removes it. */
export interface LayerMaskOp {
  t: "layer.mask";
  id: string;
  after: Uint8Array | null;
  before?: Uint8Array | null;
}

/** A new layer group at `index` in the group list. `members` (layers and groups) join it, as when it is put back. */
export interface GroupAddOp {
  t: "group.add";
  index: number;
  group: LayerGroup;
  members?: { layers: string[]; groups: string[] };
}

/** Removing a group moves what was in it to the group it was in. */
export interface GroupRemoveOp {
  t: "group.remove";
  id: string;
  /** Filled in when applied, to put it back. */
  index?: number;
  group?: LayerGroup;
  members?: { layers: string[]; groups: string[] };
}

export type GroupKey = "name" | "blend" | "effects" | "group";

export interface GroupSetOp {
  t: "group.set";
  id: string;
  key: GroupKey;
  after: LayerValue;
  before?: LayerValue;
}

export interface LayerSetOp {
  t: "layer.set";
  id: string;
  key: LayerKey;
  after: LayerValue;
  before?: LayerValue;
}

export interface PaletteSetOp {
  t: "palette.set";
  index: number;
  after: number;
  before?: number;
}

/** A color appended to the palette. `index` must be the palette's length, so two people adding at once can't share a slot. */
export interface PaletteAddOp {
  t: "palette.add";
  index: number;
  color: number;
}

/** The last palette color, removed; only while no voxel uses it. */
export interface PaletteRemoveOp {
  t: "palette.remove";
  index: number;
  color?: number;
}

/** A whole new palette. Voxels must already fit it. */
export interface PaletteReplaceOp {
  t: "palette.replace";
  after: number[];
  before?: number[];
}

/** Cells a resize cut off, in the grid they were cut from. */
export interface CroppedCells {
  layer: string;
  /** The frame they were in. Unset where the document has one frame. */
  frame?: string;
  cells: Uint32Array;
  values: Uint8Array;
  /** The cells were covered (an override layer's), so a 0 among `values` is a covered empty. */
  covered?: boolean;
}

/** A shape layer's whole source, replaced. Sources are small, so every shape edit is one of these. */
export interface LayerShapeOp {
  t: "layer.shape";
  id: string;
  after: ShapeSource;
  before?: ShapeSource;
}

/**
 * A raster layer's coverage, replaced: an array makes it an override layer, null a legacy one.
 * Values must already fit (a nonzero value is always covered).
 */
export interface LayerCoverageOp {
  t: "layer.coverage";
  id: string;
  after: Uint8Array | null;
  before?: Uint8Array | null;
}

/** A raster layer's arrays, as they were before a resolution change. */
export interface RasterRecord {
  id: string;
  data: Uint8Array;
  coverage?: Uint8Array;
}

/**
 * A new output resolution. Shape geometry stays where it is in source space; raster layers are
 * resampled (refining is exact; coarsening keeps each block's most common state). `before` keeps what was replaced so the inverse restores it exactly.
 */
export interface ResolutionOp {
  t: "resolution";
  from: number;
  to: number;
  fromGen: string;
  toGen: string;
  /** Filled in when applied. */
  before?: { rasters: RasterRecord[]; masks?: { id: string; before: Uint8Array }[] };
  /** Set on an inverse: the arrays to put back instead of resampling. */
  restore?: { rasters: RasterRecord[]; masks?: { id: string; before: Uint8Array }[] };
}

/**
 * A new grid size. Voxels shift by `offset` (new = old + offset); those that fall outside are
 * kept in `cropped` so the inverse can put them back. Shapes and markers shift too.
 */
export interface ResizeOp {
  t: "resize";
  from: Vec3;
  to: Vec3;
  offset: Vec3;
  fromGen: string;
  toGen: string;
  /** Filled in when applied. */
  cropped?: CroppedCells[];
  /** Filled in when applied: the masks as they were, which a resize may crop. */
  masks?: { id: string; before: Uint8Array }[];
  /** Set on an inverse: cells and masks to put back once the grid is restored. */
  restore?: { cells: CroppedCells[]; masks?: { id: string; before: Uint8Array }[] };
}

/** A new frame at `index`, with each layer's voxels (layers it doesn't list start empty). */
export interface FrameAddOp {
  t: "frame.add";
  index: number;
  frame: {
    id: string;
    duration: number;
    cels?: Record<string, Uint8Array>;
    /** Marker keys on the new frame, by marker id (markers that are gone are skipped). */
    markers?: Record<string, Omit<MarkerKey, "frame">>;
  };
}

/** The document always keeps at least one frame. Marker keys on it go with it. */
export interface FrameRemoveOp {
  t: "frame.remove";
  id: string;
  /** Filled in when applied, to put it back. */
  index?: number;
  frame?: { id: string; duration: number; cels: Record<string, Uint8Array>; markers?: Record<string, Omit<MarkerKey, "frame">> };
}

export interface FrameMoveOp {
  t: "frame.move";
  id: string;
  to: number;
  from?: number;
}

/** How many ticks a frame lasts. */
export interface FrameDurationOp {
  t: "frame.duration";
  id: string;
  after: number;
  before?: number;
}

/** Ticks per second, for the whole animation. */
export interface FpsOp {
  t: "fps";
  after: number;
  before?: number;
}

/** A layer's host data, replaced whole; null removes it. */
export interface LayerDataOp {
  t: "layer.data";
  id: string;
  after: Json;
  before?: Json;
}

/** One namespace of the document's host data, replaced whole; null removes it. */
export interface DataOp {
  t: "data";
  key: string;
  after: Json;
  before?: Json;
}

export interface TagsOp { t: "tags"; after: readonly AnimationTag[]; before?: readonly AnimationTag[]; }

/** A new marker at `index` in the list. */
export interface MarkerAddOp {
  t: "marker.add";
  index: number;
  marker: Marker;
}

export interface MarkerRemoveOp {
  t: "marker.remove";
  id: string;
  /** Filled in when applied, to put it back. */
  index?: number;
  marker?: Marker;
}

/** A marker replaced whole: name, role, placement, keys and data. Its id stays. */
export interface MarkerSetOp {
  t: "marker.set";
  id: string;
  after: Marker;
  before?: Marker;
}

/** The model's origin, in source units; null is the center of the floor. */
export interface OriginOp {
  t: "origin";
  after: Vec3 | null;
  before?: Vec3 | null;
}

export type DocOp =
  | TagsOp
  | LayerMaskOp
  | GroupAddOp
  | GroupRemoveOp
  | GroupSetOp
  | MarkerAddOp
  | MarkerRemoveOp
  | MarkerSetOp
  | OriginOp
  | VoxelsOp
  | NameOp
  | LayerAddOp
  | LayerRemoveOp
  | LayerMoveOp
  | LayerSetOp
  | PaletteSetOp
  | PaletteAddOp
  | PaletteRemoveOp
  | PaletteReplaceOp
  | ResizeOp
  | LayerShapeOp
  | LayerCoverageOp
  | ResolutionOp
  | FrameAddOp
  | FrameRemoveOp
  | FrameMoveOp
  | FrameDurationOp
  | FpsOp
  | LayerDataOp
  | DataOp;

/** An op that doesn't fit the document; the message says why. */
export class OpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpError";
  }
}

const fail = (message: string): never => {
  throw new OpError(message);
};

// #region Ids

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A random, collision-resistant id (about 82 bits). */
export function randomId(prefix = "", length = 16): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = prefix;
  for (const b of bytes) out += ALPHABET[b % 36];
  return out;
}

export const newLayerId = () => randomId("layer:");
export const newFrameId = () => randomId("frame:");
export const newGen = () => randomId("g", 10);

const ID_PATTERN = /^[\w:.-]{1,64}$/;
export const isValidId = (id: unknown): id is string => typeof id === "string" && ID_PATTERN.test(id);

// #endregion

// #region Checks

const isColor = (c: unknown): c is number => Number.isInteger(c) && (c as number) >= 0 && (c as number) <= 0xffffff;

const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

const isSize = (v: unknown): v is Vec3 =>
  isVec3(v) && v.every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_SIZE);

const checkName = (name: unknown, what: string): string => {
  if (typeof name !== "string") return fail(`${what} must be text`);
  const trimmed = name.trim();
  if (!trimmed) return fail(`${what} can't be empty`);
  if (trimmed.length > MAX_NAME) return fail(`${what} is longer than ${MAX_NAME} characters`);
  return trimmed;
};

const cellCount = (size: Vec3) => size[0] * size[1] * size[2];

function findLayer(target: DocTarget, id: string): { layer: LayerRecord; index: number } {
  const index = target.layers.findIndex((l) => l.id === id);
  if (index < 0) fail("That layer was deleted");
  return { layer: target.layers[index], index };
}

/** Throw unless every value is empty or a color in the palette. */
function checkValues(values: Uint8Array, palette: readonly number[]) {
  const n = palette.length;
  for (let i = 0; i < values.length; i++) if (values[i] >= n) fail("A voxel uses a color that isn't in the palette");
}

/** Throw unless a coverage array fits a layer's values: 0s and 1s, with every nonzero value covered. */
function checkCoverage(coverage: unknown, data: Uint8Array, count: number) {
  if (!(coverage instanceof Uint8Array) || coverage.length !== count) fail("The layer's coverage doesn't fit the model");
  const c = coverage as Uint8Array;
  for (let i = 0; i < count; i++) {
    if (c[i] > 1) fail("Coverage is 0 or 1 per cell");
    if (data.length && data[i] && !c[i]) fail("A voxel of an override layer isn't covered");
  }
}

/** A shape source checked against the palette, as an `OpError`. */
function checkShape(shape: unknown, palette: readonly number[]): ShapeSource {
  try {
    return checkSource(shape, palette.length);
  } catch (e) {
    if (e instanceof SourceError) fail(e.message);
    throw e;
  }
}

/** Shape layers, overrides and resolutions don't come from untrusted senders yet, nor go to targets that can't hold them (a live room). */
function checkSourceOp(target: DocTarget, strict: boolean) {
  if (strict || target.resolution === undefined) fail("Shape and override layers can't be shared yet");
}

/** Throw if a shape layer uses a color past the end of `palette`. */
function checkMaterials(target: DocTarget, length: number) {
  for (const layer of target.layers) {
    if (layer.effects && effectColors(layer.effects).some((c) => c >= length)) fail("An effect uses a color that isn't in the palette");
    if (!layer.shape) continue;
    for (const m of sourceMaterials(layer.shape)) if (m >= length) fail("A shape uses a color that isn't in the palette");
  }
  for (const g of target.groups ?? []) {
    if (g.effects && effectColors(g.effects).some((c) => c >= length)) fail("An effect uses a color that isn't in the palette");
  }
}

/** A stage's effects, checked against the palette; [] means none. */
function stageEffects(target: DocTarget, raw: unknown): Effect[] {
  try {
    return checkEffects(raw, target.palette.length);
  } catch (e) {
    if (e instanceof EffectError) fail(e.message);
    throw e;
  }
}

function stageBlend(raw: unknown): Blend {
  try {
    return checkBlend(raw);
  } catch (e) {
    return fail((e as Error).message);
  }
}

function groupsOf(target: DocTarget): readonly LayerGroup[] {
  if (!target.groups || !target.setGroups) fail("Layer groups are unavailable in live rooms");
  return target.groups!;
}

/** Whether group `ancestor` is `id` or holds it, at any depth. */
function groupHolds(groups: readonly LayerGroup[], ancestor: string, id: string): boolean {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const seen = new Set<string>();
  for (let at: string | undefined = id; at && !seen.has(at); at = byId.get(at)?.group) {
    if (at === ancestor) return true;
    seen.add(at);
  }
  return false;
}

/** A layer or group record with `key` set to `value`, or unset when it is undefined. */
function withKey<T extends object>(record: T, key: string, value: unknown): T {
  const { [key]: _, ...rest } = record as Record<string, unknown>;
  return (value === undefined ? rest : { ...rest, [key]: value }) as T;
}

const sameVec = (a: Vec3 | undefined | null, b: Vec3 | undefined | null) =>
  a === b || (!!a && !!b && a.every((n, i) => n === b[i]));

/** The most voxel bytes an animation may hold across its frames and layers: 256 MiB. */
export const MAX_ANIMATION_BYTES = 256 * 1024 * 1024;

/** A target's frames, or a failure where it has no animation. */
const framesOf = (target: DocTarget): readonly FrameRecord[] => target.frames ?? fail("Animation can't be shared yet");

/** Whether the target has frames other than the current one. */
const animated = (target: DocTarget) => (target.frames?.length ?? 1) > 1;

/** Throw unless `frames` × `layers` dense volumes of `count` cells fit the animation budget. */
function checkBudget(frames: number, layers: number, count: number) {
  if (frames * layers * count > MAX_ANIMATION_BYTES) {
    fail(`That would be more than ${MAX_ANIMATION_BYTES / 1024 / 1024} MiB of voxels; use fewer frames, layers or a smaller model`);
  }
}

const rasterCount = (target: DocTarget, extra = 0) => target.layers.filter((l) => !l.shape).length + extra;

/**
 * The voxels of `layer` in frame `frameId`: the layer's data for the current frame. Undefined if
 * that frame doesn't exist. With no frame given, there must be only one.
 */
export function celData(target: DocTarget, frameId: string | undefined, layer: LayerRecord): Uint8Array | undefined {
  const frames = target.frames;
  if (frameId === undefined) return !frames || frames.length === 1 ? layer.data : undefined;
  // a target without animation has the one frame every copy of a frameless document calls this
  if (!frames) return frameId === FIRST_FRAME_ID ? layer.data : undefined;
  if (frameId === target.frame) return layer.data;
  const frame = frames.find((f) => f.id === frameId);
  if (!frame) return undefined;
  return frame.cels?.[layer.id] ?? (layer.shape ? layer.data : undefined);
}

/** Every voxel array of a layer, across all frames. */
function* layerCels(target: DocTarget, layer: LayerRecord): Generator<Uint8Array> {
  yield layer.data;
  if (layer.shape) return;
  for (const frame of target.frames ?? []) {
    const cel = frame.id === target.frame ? undefined : frame.cels?.[layer.id];
    if (cel) yield cel;
  }
}

/** A frame with every layer's voxels, the current frame's taken from the layers. */
function fullFrame(target: DocTarget, frame: FrameRecord): { id: string; duration: number; cels: Record<string, Uint8Array> } {
  if (frame.id !== target.frame) return { id: frame.id, duration: frame.duration, cels: { ...frame.cels } };
  const cels: Record<string, Uint8Array> = {};
  for (const l of target.layers) if (!l.shape) cels[l.id] = l.data;
  return { id: frame.id, duration: frame.duration, cels };
}

/**
 * Put frames that each have all their cels back into the target, with `current` as the frame the
 * layers hold. `layers` are the layer records to use (their data is replaced).
 */
function commitFrames(
  target: DocTarget,
  frames: readonly { id: string; duration: number; cels: Record<string, Uint8Array> }[],
  current: string,
  layers: readonly LayerRecord[] = target.layers,
) {
  const count = cellCount(target.size);
  const now = frames.find((f) => f.id === current) ?? fail("That frame was deleted");
  const nextLayers = layers.map((l) => (l.shape ? l : { ...l, data: now.cels[l.id] ?? new Uint8Array(count) }));
  const records = frames.map((f): FrameRecord => (f.id === current ? { id: f.id, duration: f.duration } : f));
  target.setFrames!(records, current, nextLayers);
}

/**
 * Switch which frame the layers hold. Not an op: which frame is open is local, and changes no
 * content. Returns the new frames and layers for the caller to keep.
 */
export function openFrame(
  frames: readonly FrameRecord[],
  layers: readonly LayerRecord[],
  current: string,
  next: string,
  count: number,
): { frames: FrameRecord[]; layers: LayerRecord[] } {
  const target = frames.find((f) => f.id === next);
  if (!target) throw new OpError("That frame was deleted");
  const stash: Record<string, Uint8Array> = {};
  for (const l of layers) if (!l.shape) stash[l.id] = l.data;
  return {
    frames: frames.map((f) =>
      f.id === current ? { id: f.id, duration: f.duration, cels: stash } : f.id === next ? { id: f.id, duration: f.duration } : f,
    ),
    layers: layers.map((l) => (l.shape ? l : { ...l, data: target.cels?.[l.id] ?? new Uint8Array(count) })),
  };
}

// #endregion

// #region Apply

/**
 * Apply an op to a document, filling in what it replaced. What it asks for stays as it is, so it
 * replays the same on any copy. Throws an `OpError`, without changing anything, if it doesn't
 * fit. `strict` adds checks for ops from untrusted senders.
 */
export function applyOp(target: DocTarget, op: DocOp, strict = false): void {
  switch (op.t) {
    case "voxels":
      return applyVoxels(target, op, strict);
    case "name": {
      const after = checkName(op.after, "The model's name");
      op.before = target.name;
      op.after = after;
      target.setName(after);
      return;
    }
    case "layer.add":
      return addLayer(target, op, strict);
    case "layer.remove":
      return removeLayer(target, op);
    case "layer.move": {
      const { layer, index } = findLayer(target, op.id);
      if (!Number.isInteger(op.to)) fail("A layer position must be a whole number");
      const to = Math.max(0, Math.min(target.layers.length - 1, op.to));
      op.from = index;
      if (to === index) return;
      const next = target.layers.filter((l) => l.id !== op.id);
      next.splice(to, 0, layer);
      target.setLayers(next);
      return;
    }
    case "layer.set":
      return setLayer(target, op);
    case "palette.set": {
      const { index } = op;
      if (!Number.isInteger(index) || index < 1 || index >= target.palette.length) fail("That palette color doesn't exist");
      if (!isColor(op.after)) fail("Colors must be 0xRRGGBB numbers");
      op.before = target.palette[index];
      const next = [...target.palette];
      next[index] = op.after;
      target.setPalette(next);
      return;
    }
    case "palette.add": {
      if (op.index !== target.palette.length) fail("The palette changed; add the color again");
      if (target.palette.length > MAX_COLORS) fail("Palette is full");
      if (!isColor(op.color)) fail("Colors must be 0xRRGGBB numbers");
      target.setPalette([...target.palette, op.color]);
      return;
    }
    case "palette.remove": {
      const { index } = op;
      if (index !== target.palette.length - 1 || index < 2) fail("The palette changed since this color was added");
      for (const layer of target.layers) for (const cel of layerCels(target, layer)) if (cel.includes(index)) fail("Voxels use that color now");
      checkMaterials(target, index);
      op.color = target.palette[index];
      target.setPalette(target.palette.slice(0, index));
      return;
    }
    case "palette.replace": {
      const after = op.after;
      if (!Array.isArray(after) || after.length < 2 || after.length > MAX_COLORS + 1) fail("A palette has 1 to 255 colors");
      if (after[0] !== 0 || !after.every(isColor)) fail("Colors must be 0xRRGGBB numbers");
      for (const layer of target.layers) for (const cel of layerCels(target, layer)) checkValues(cel, after);
      checkMaterials(target, after.length);
      op.before = [...target.palette];
      target.setPalette([...after]);
      return;
    }
    case "resize":
      return resize(target, op, strict);
    case "layer.shape": {
      checkSourceOp(target, strict);
      const { layer } = findLayer(target, op.id);
      if (!layer.shape) fail("That layer isn't a shape layer");
      const after = checkShape(op.after, target.palette);
      op.before = layer.shape;
      op.after = after;
      target.setLayers(target.layers.map((l) => (l.id === op.id ? { ...l, shape: after } : l)));
      return;
    }
    case "layer.coverage": {
      checkSourceOp(target, strict);
      const { layer } = findLayer(target, op.id);
      if (layer.shape) fail("Shape layers have no coverage");
      if (op.after !== null && animated(target)) fail("Override layers can't be animated yet");
      if (op.after !== null) checkCoverage(op.after, layer.data, layer.data.length);
      // a fresh array: the op's may be shared with the op it was inverted from
      const coverage = op.after ? op.after.slice() : undefined;
      op.before = layer.coverage ?? null;
      target.setLayers(
        target.layers.map((l) => {
          if (l.id !== op.id) return l;
          const { coverage: _, ...rest } = l;
          return coverage ? { ...rest, coverage } : rest;
        }),
      );
      return;
    }
    case "resolution":
      return changeResolution(target, op, strict);
    case "frame.add":
      return addFrame(target, op);
    case "frame.remove":
      return removeFrame(target, op);
    case "frame.move": {
      const frames = framesOf(target);
      const index = frames.findIndex((f) => f.id === op.id);
      if (index < 0) fail("That frame was deleted");
      if (!Number.isInteger(op.to)) fail("A frame position must be a whole number");
      const to = Math.max(0, Math.min(frames.length - 1, op.to));
      op.from = index;
      if (to === index) return;
      const next = frames.filter((f) => f.id !== op.id);
      next.splice(to, 0, frames[index]);
      target.setFrames!(next, target.frame!, target.layers);
      return;
    }
    case "frame.duration": {
      const frames = framesOf(target);
      const frame = frames.find((f) => f.id === op.id) ?? fail("That frame was deleted");
      if (!isDuration(op.after)) fail("A frame lasts a whole number of ticks, from 1 to 999");
      op.before = frame.duration;
      target.setFrames!(
        frames.map((f) => (f.id === op.id ? { ...f, duration: op.after } : f)),
        target.frame!,
        target.layers,
      );
      return;
    }
    case "tags": {
      if (!target.setTags) fail("Animation tags are unavailable in live rooms");
      let after: AnimationTag[];
      try { after = checkTags(op.after, framesOf(target)); }
      catch (e) { return fail((e as Error).message); }
      op.before = target.tags ?? [];
      target.setTags!(after);
      return;
    }
    case "fps": {
      framesOf(target);
      if (!isFps(op.after)) fail("Frames per second is a whole number from 1 to 60");
      op.before = target.fps;
      target.setFps!(op.after);
      return;
    }
    case "layer.data": {
      const { layer } = findLayer(target, op.id);
      const after = op.after === undefined || op.after === null ? null : checkJson(op.after);
      op.before = layer.hostData ?? null;
      op.after = after;
      const layers = target.layers.map((l) => {
        if (l.id !== op.id) return l;
        const { hostData: _, ...rest } = l;
        return after === null ? rest : { ...rest, hostData: after };
      });
      checkHostBudget(target, layers, target.hostData);
      target.setLayers(layers);
      return;
    }
    case "data": {
      if (!target.hostData || !target.setHostData) fail("This document can't keep host data");
      if (typeof op.key !== "string" || !op.key || op.key.length > MAX_NAME) fail("Host data needs a namespace");
      const after = op.after === undefined || op.after === null ? null : checkJson(op.after);
      const { [op.key]: before, ...rest } = target.hostData!;
      op.before = before ?? null;
      op.after = after;
      const next = after === null ? rest : { ...rest, [op.key]: after };
      checkHostBudget(target, target.layers, next);
      target.setHostData!(next);
      return;
    }
    case "layer.mask": {
      const { layer } = findLayer(target, op.id);
      const count = cellCount(target.size);
      const after = op.after;
      if (after !== null && (!(after instanceof Uint8Array) || after.length !== count || after.some((v) => v > 1))) fail("The mask doesn't fit the model");
      op.before = layer.mask ?? null;
      const mask = after ? after.slice() : undefined;
      op.after = mask ?? null;
      target.setLayers(target.layers.map((l) => (l.id === op.id ? withKey(l, "mask", mask) : l)));
      return;
    }
    case "group.add": {
      const groups = groupsOf(target);
      const g = op.group;
      if (!g || !isValidId(g.id)) fail("A group needs a valid id");
      if (groups.some((x) => x.id === g.id) || target.layers.some((l) => l.id === g.id)) fail("That group already exists");
      if (groups.length >= MAX_LAYERS) fail(`A model can have at most ${MAX_LAYERS} groups`);
      const parent = g.group && groups.some((x) => x.id === g.group) ? g.group : undefined;
      const effects = g.effects === undefined ? [] : stageEffects(target, g.effects);
      const group: LayerGroup = {
        id: g.id,
        name: checkName(g.name, "A group's name"),
        visible: g.visible !== false,
        ...(g.blend ? { blend: stageBlend(g.blend) } : {}),
        ...(effects.length ? { effects } : {}),
        ...(parent ? { group: parent } : {}),
      };
      if (!Number.isInteger(op.index)) fail("A group position must be a whole number");
      const next = [...groups];
      next.splice(Math.max(0, Math.min(groups.length, op.index)), 0, group);
      target.setGroups!(next);
      // what it held when it was removed joins it again, if it is still where it went
      const m = op.members;
      if (m?.layers.length) {
        const ids = new Set(m.layers);
        target.setLayers(target.layers.map((l) => (ids.has(l.id) && l.group === parent ? withKey(l, "group", group.id) : l)));
      }
      if (m?.groups.length) {
        const ids = new Set(m.groups);
        target.setGroups!(target.groups!.map((x) => (ids.has(x.id) && x.group === parent ? withKey(x, "group", group.id) : x)));
      }
      return;
    }
    case "group.remove": {
      const groups = groupsOf(target);
      const index = groups.findIndex((g) => g.id === op.id);
      if (index < 0) fail("That group was deleted");
      const group = groups[index];
      op.index = index;
      op.group = group;
      const layers = target.layers.filter((l) => l.group === op.id).map((l) => l.id);
      const inner = groups.filter((g) => g.group === op.id).map((g) => g.id);
      op.members = { layers, groups: inner };
      // what it held moves up to the group it was in
      if (layers.length) target.setLayers(target.layers.map((l) => (l.group === op.id ? withKey(l, "group", group.group) : l)));
      target.setGroups!(groups.filter((g) => g.id !== op.id).map((g) => (g.group === op.id ? withKey(g, "group", group.group) : g)));
      return;
    }
    case "group.set": {
      const groups = groupsOf(target);
      const group = groups.find((g) => g.id === op.id) ?? fail("That group was deleted");
      let value: unknown;
      switch (op.key) {
        case "name":
          value = checkName(op.after, "A group's name");
          op.before = group.name;
          break;
        case "blend":
          value = op.after === null ? undefined : stageBlend(op.after);
          op.before = group.blend ?? null;
          break;
        case "effects": {
          const effects = op.after === null ? [] : stageEffects(target, op.after);
          value = effects.length ? effects : undefined;
          op.before = group.effects ?? null;
          break;
        }
        case "group": {
          const parent = op.after;
          if (parent !== null) {
            if (typeof parent !== "string" || !groups.some((g) => g.id === parent)) fail("That group was deleted");
            if (groupHolds(groups, op.id, parent as string)) fail("A group can't go in itself or a group it holds");
          }
          value = parent ?? undefined;
          op.before = group.group ?? null;
          break;
        }
        default:
          return fail(`Groups have no ${String((op as { key: unknown }).key)}`);
      }
      op.after = (value ?? null) as LayerValue;
      target.setGroups!(groups.map((g) => (g.id === op.id ? withKey(g, op.key, value) : g)));
      return;
    }
    case "marker.add": {
      const markers = markersOf(target);
      if (markers.length >= MAX_MARKERS) fail(`A model can have at most ${MAX_MARKERS} markers`);
      const marker = checkMarkerFor(target, op.marker);
      if (markers.some((m) => m.id === marker.id)) fail("That marker already exists");
      if (!Number.isInteger(op.index)) fail("A marker position must be a whole number");
      const next = [...markers];
      next.splice(Math.max(0, Math.min(markers.length, op.index)), 0, marker);
      target.setMarkers!(next);
      return;
    }
    case "marker.remove": {
      const markers = markersOf(target);
      const index = markers.findIndex((m) => m.id === op.id);
      if (index < 0) fail("That marker was deleted");
      op.index = index;
      op.marker = markers[index];
      target.setMarkers!(markers.filter((m) => m.id !== op.id));
      return;
    }
    case "marker.set": {
      const markers = markersOf(target);
      const index = markers.findIndex((m) => m.id === op.id);
      if (index < 0) fail("That marker was deleted");
      const marker = checkMarkerFor(target, op.after);
      if (marker.id !== op.id) fail("A marker keeps its id");
      op.before = markers[index];
      op.after = marker;
      target.setMarkers!(markers.map((m, i) => (i === index ? marker : m)));
      return;
    }
    case "origin": {
      if (!target.setOrigin) fail("Model origins are unavailable in live rooms");
      let after: Vec3 | null = null;
      if (op.after !== null) {
        try {
          after = checkOrigin(op.after);
        } catch (e) {
          return fail((e as Error).message);
        }
      }
      op.before = target.origin ? [...target.origin] : null;
      op.after = after;
      target.setOrigin!(after);
      return;
    }
    default:
      fail(`Unknown edit ${(op as { t: unknown }).t}`);
  }
}

function markersOf(target: DocTarget): readonly Marker[] {
  if (!target.markers || !target.setMarkers) fail("Markers are unavailable in live rooms");
  return target.markers!;
}

/** A marker's host data, at most this many JSON characters. */
export const MAX_MARKER_DATA = 4096;

function checkMarkerFor(target: DocTarget, raw: unknown): Marker {
  const frames = new Set((target.frames ?? [{ id: target.frame ?? FIRST_FRAME_ID }]).map((f) => f.id));
  try {
    return checkMarker(raw, frames, (v) => {
      const data = checkJson(v);
      if (JSON.stringify(data).length > MAX_MARKER_DATA) fail(`A marker's data can be at most ${MAX_MARKER_DATA / 1024} KiB`);
      return data;
    });
  } catch (e) {
    if (e instanceof MarkerError) fail(e.message);
    throw e;
  }
}

function applyVoxels(target: DocTarget, op: VoxelsOp, strict: boolean) {
  const { layer } = findLayer(target, op.layer);
  if (op.gen !== target.gen) fail("The model was resized");
  const { cells, after } = op;
  if (!(cells instanceof Uint32Array) || !(after instanceof Uint8Array) || cells.length !== after.length) {
    fail("Malformed voxel edit");
  }
  if (layer.shape) fail("Shape layers have no voxels to edit");
  if (op.frame !== undefined && !isValidId(op.frame)) fail("Malformed voxel edit");
  let data = celData(target, op.frame, layer) ?? fail(op.frame === undefined ? "Which frame? The model is animated" : "That frame was deleted");
  if (op.channel === "coverage") {
    checkSourceOp(target, strict);
    data = layer.coverage ?? fail("That layer isn't an override layer");
    for (let k = 0; k < after.length; k++) if (after[k] > 1) fail("Coverage is 0 or 1 per cell");
  } else if (op.channel !== undefined) {
    fail("Malformed voxel edit");
  } else {
    checkValues(after, target.palette);
  }
  if (strict) {
    const seen = new Set<number>();
    for (let k = 0; k < cells.length; k++) {
      if (cells[k] >= data.length) fail("A cell is outside the model");
      if (seen.has(cells[k])) fail("A cell appears twice in one edit");
      seen.add(cells[k]);
    }
  } else {
    for (let k = 0; k < cells.length; k++) if (cells[k] >= data.length) fail("A cell is outside the model");
  }
  // a fresh array: the op's arrays may be shared with the op it was inverted from
  const before = new Uint8Array(cells.length);
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    before[k] = data[i];
    if (data[i] !== after[k]) target.writeCell(data, i, after[k]);
  }
  op.before = before;
}

function addLayer(target: DocTarget, op: LayerAddOp, strict: boolean) {
  const src = op.layer;
  if (!src || !isValidId(src.id)) fail("A layer needs a valid id");
  if (target.layers.some((l) => l.id === src.id)) fail("That layer already exists");
  if (target.layers.length >= MAX_LAYERS) fail(`A model can have at most ${MAX_LAYERS} layers`);
  const name = checkName(src.name, "A layer's name");
  const count = cellCount(target.size);
  const frames = target.frames;
  if (src.cels !== undefined) {
    if (!frames) framesOf(target);
    if (!src.cels || typeof src.cels !== "object" || src.shape !== undefined) fail("Malformed layer");
    for (const [id, cel] of Object.entries(src.cels)) {
      if (!frames!.some((f) => f.id === id)) continue; // a frame deleted since
      if (!(cel instanceof Uint8Array) || cel.length !== count) fail("The layer's voxels don't fit the model");
      checkValues(cel, target.palette);
    }
  }
  if (animated(target) && src.shape === undefined) {
    if (src.coverage !== undefined) fail("Override layers can't be animated yet");
    checkBudget(frames!.length, rasterCount(target, 1), count);
  }
  let data: Uint8Array;
  let coverage: Uint8Array | undefined;
  let shape: ShapeSource | undefined;
  if (src.shape !== undefined) {
    checkSourceOp(target, strict);
    if ((src.data !== undefined && src.data.length) || src.coverage !== undefined) fail("Shape layers have no voxels");
    shape = checkShape(src.shape, target.palette);
    data = new Uint8Array(0);
  } else if (src.data !== undefined) {
    if (!(src.data instanceof Uint8Array) || src.data.length !== count) fail("The layer's voxels don't fit the model");
    checkValues(src.data, target.palette);
    data = src.data.slice();
  } else {
    data = new Uint8Array(count);
  }
  if (src.coverage !== undefined) {
    checkSourceOp(target, strict);
    checkCoverage(src.coverage, data, count);
    coverage = src.coverage.slice();
  }
  if (!Number.isInteger(op.index)) fail("A layer position must be a whole number");
  const index = Math.max(0, Math.min(target.layers.length, op.index));
  if (src.mask !== undefined && (!(src.mask instanceof Uint8Array) || src.mask.length !== count || src.mask.some((v) => v > 1))) fail("The layer's mask doesn't fit the model");
  const effects = src.effects === undefined ? [] : stageEffects(target, src.effects);
  // a group that is gone leaves it ungrouped
  const group = src.group && target.groups?.some((g) => g.id === src.group) ? src.group : undefined;
  const layer: LayerRecord = {
    id: src.id,
    name,
    data,
    ...(coverage ? { coverage } : {}),
    ...(shape ? { shape } : {}),
    ...(src.blend ? { blend: stageBlend(src.blend) } : {}),
    ...(src.mask ? { mask: src.mask.slice() } : {}),
    ...(effects.length ? { effects } : {}),
    ...(group ? { group } : {}),
    ...(src.visible !== undefined ? { visible: !!src.visible } : {}),
    ...(src.locked !== undefined ? { locked: !!src.locked } : {}),
    ...(src.hostData !== undefined && src.hostData !== null ? { hostData: checkJson(src.hostData) } : {}),
    ...(src.extra && Object.keys(src.extra).length ? { extra: checkJson(src.extra) as Record<string, Json> } : {}),
  };
  if (layer.hostData !== undefined || layer.extra) checkHostBudget(target, [...target.layers, layer], target.hostData);
  const layers = [...target.layers];
  layers.splice(index, 0, layer);
  if (!frames || shape) return target.setLayers(layers);
  // every frame gets its cel: the one it was given, a copy of `data`, or empty
  const cel = (frameId: string) => {
    const given = src.cels?.[frameId];
    if (given) return given.slice();
    return src.data !== undefined ? data.slice() : new Uint8Array(count);
  };
  const current = target.frame!;
  const placed = layers.map((l) => (l.id === layer.id ? { ...l, data: cel(current) } : l));
  target.setFrames!(
    frames.map((f) => (f.id === current ? f : { ...f, cels: { ...f.cels, [layer.id]: cel(f.id) } })),
    current,
    placed,
  );
}

function removeLayer(target: DocTarget, op: LayerRemoveOp) {
  const { layer, index } = findLayer(target, op.id);
  if (target.layers.length === 1) fail("A model needs at least one layer");
  op.index = index;
  op.layer = layer;
  const frames = target.frames;
  if (frames && frames.length > 1 && !layer.shape) {
    const cels: Record<string, Uint8Array> = {};
    for (const f of frames) cels[f.id] = f.id === target.frame ? layer.data : f.cels![layer.id];
    op.cels = cels;
  }
  const next = target.layers.filter((l) => l.id !== op.id);
  if (!frames) return target.setLayers(next);
  target.setFrames!(
    frames.map((f) => {
      if (!f.cels || !(op.id in f.cels)) return f;
      const { [op.id]: _, ...cels } = f.cels;
      return { ...f, cels };
    }),
    target.frame!,
    next,
  );
}

function addFrame(target: DocTarget, op: FrameAddOp) {
  const frames = framesOf(target);
  const src = op.frame;
  if (!src || !isValidId(src.id)) fail("A frame needs a valid id");
  if (frames.some((f) => f.id === src.id)) fail("That frame already exists");
  if (frames.length >= MAX_FRAMES) fail(`An animation can have at most ${MAX_FRAMES} frames`);
  if (!isDuration(src.duration)) fail("A frame lasts a whole number of ticks, from 1 to 999");
  if (!Number.isInteger(op.index)) fail("A frame position must be a whole number");
  if (target.layers.some((l) => l.coverage)) fail("Override layers can't be animated yet");
  const count = cellCount(target.size);
  checkBudget(frames.length + 1, rasterCount(target), count);
  if (src.cels !== undefined && (!src.cels || typeof src.cels !== "object")) fail("Malformed frame");
  const cels: Record<string, Uint8Array> = {};
  for (const layer of target.layers) {
    if (layer.shape) continue;
    const given = src.cels?.[layer.id];
    if (given === undefined) {
      cels[layer.id] = new Uint8Array(count);
      continue;
    }
    if (!(given instanceof Uint8Array) || given.length !== count) fail("The frame's voxels don't fit the model");
    checkValues(given, target.palette);
    // a copy: the content is what the author saw, whatever happens to the op's arrays later
    cels[layer.id] = given.slice();
  }
  const index = Math.max(0, Math.min(frames.length, op.index));
  const next: FrameRecord[] = [...frames];
  next.splice(index, 0, { id: src.id, duration: src.duration, cels });
  target.setFrames!(next, target.frame!, target.layers);
  if (src.markers && target.markers && target.setMarkers && Object.keys(src.markers).length) {
    const given = giveFrameKeys(target.markers, src.id, src.markers);
    // checked as the markers they become, now that the frame exists
    target.setMarkers(given.map((m) => (src.markers![m.id] ? checkMarkerFor(target, m) : m)));
  }
}

function removeFrame(target: DocTarget, op: FrameRemoveOp) {
  const frames = framesOf(target);
  const index = frames.findIndex((f) => f.id === op.id);
  if (index < 0) fail("That frame was deleted");
  if (frames.length === 1) fail("An animation needs at least one frame");
  if (target.tags?.some(t => t.from === op.id || t.to === op.id)) fail("Update animation tag endpoints before deleting their frame");
  const removed: NonNullable<FrameRemoveOp["frame"]> = fullFrame(target, frames[index]);
  if (target.markers && target.setMarkers) {
    const { markers, keys } = takeFrameKeys(target.markers, op.id);
    if (Object.keys(keys).length) {
      removed.markers = Object.fromEntries(Object.entries(keys).map(([id, { frame: _, ...key }]) => [id, key]));
      target.setMarkers(markers);
    }
  }
  op.index = index;
  op.frame = removed;
  if (op.id !== target.frame) {
    target.setFrames!(
      frames.filter((f) => f.id !== op.id),
      target.frame!,
      target.layers,
    );
    return;
  }
  // the current frame goes: the one before it (or after, for the first) opens instead
  const rest = frames.filter((f) => f.id !== op.id).map((f) => fullFrame(target, f));
  commitFrames(target, rest, rest[Math.max(0, index - 1)].id);
}

function setLayer(target: DocTarget, op: LayerSetOp) {
  const { layer } = findLayer(target, op.id);
  let patch: Partial<LayerRecord>;
  switch (op.key) {
    case "name": {
      const name = checkName(op.after, "A layer's name");
      op.before = layer.name;
      op.after = name;
      patch = { name };
      break;
    }
    case "blend": {
      const blend = op.after === null ? undefined : stageBlend(op.after);
      op.before = layer.blend ?? null;
      op.after = blend ?? null;
      return target.setLayers(target.layers.map((l) => (l.id === op.id ? withKey(l, "blend", blend) : l)));
    }
    case "effects": {
      const effects = op.after === null ? [] : stageEffects(target, op.after);
      op.before = layer.effects ?? null;
      op.after = effects.length ? effects : null;
      return target.setLayers(target.layers.map((l) => (l.id === op.id ? withKey(l, "effects", effects.length ? effects : undefined) : l)));
    }
    case "group": {
      const group = op.after;
      if (group !== null && (typeof group !== "string" || !groupsOf(target).some((g) => g.id === group))) fail("That group was deleted");
      op.before = layer.group ?? null;
      return target.setLayers(target.layers.map((l) => (l.id === op.id ? withKey(l, "group", group ?? undefined) : l)));
    }
    default:
      return fail(`Layers have no ${String((op as { key: unknown }).key)}`);
  }
  target.setLayers(
    target.layers.map((l) => {
      if (l.id !== op.id) return l;
      return { ...l, ...patch };
    }),
  );
}

function resize(target: DocTarget, op: ResizeOp, strict: boolean) {
  if (op.fromGen !== target.gen) fail("The model was resized");
  if (!isSize(op.to)) fail(`Sizes are whole numbers from 1 to ${MAX_SIZE}`);
  if (!isVec3(op.offset) || !op.offset.every(Number.isInteger)) fail("A resize offset is [x, y, z] whole numbers");
  if (!sameVec(op.from, target.size)) fail("The model was resized");
  if (typeof op.toGen !== "string" || !op.toGen || op.toGen === op.fromGen) fail("A resize needs a new grid id");
  const resolution = target.resolution ?? 1;
  if (resolution > 1 && (op.to.some((n) => n % resolution) || op.offset.some((n) => n % resolution))) {
    fail(`At ${resolution}× resolution, sizes and offsets are multiples of ${resolution}`);
  }
  const old = target.size;
  const size = op.to;
  const offset = op.offset;
  const count = cellCount(size);
  const restore = op.restore;
  if (restore && strict) {
    for (const c of restore.cells) {
      if (!(c.cells instanceof Uint32Array) || !(c.values instanceof Uint8Array) || c.cells.length !== c.values.length) {
        fail("Malformed resize");
      }
      for (const i of c.cells) if (i >= count) fail("A cell is outside the model");
      checkValues(c.values, target.palette);
    }
  }
  const frames = target.frames;
  if (frames && frames.length > 1) checkBudget(frames.length, rasterCount(target), count);
  const cropped: CroppedCells[] = [];
  const masks: { id: string; before: Uint8Array }[] = [];
  // shapes move with the voxels, in source units; they aren't cropped, only clipped when evaluated
  const shift = offset.map((n) => n / resolution) as Vec3;
  /** One layer's voxels in another frame, moved to the new grid like the current frame's below. */
  const moveCel = (layer: string, src: Uint8Array, frame: string) => {
    const data = new Uint8Array(count);
    const lostCells: number[] = [];
    const lostValues: number[] = [];
    for (let z = 0, i = 0; z < old[2]; z++)
      for (let y = 0; y < old[1]; y++)
        for (let x = 0; x < old[0]; x++, i++) {
          const v = src[i];
          if (!v) continue;
          const nx = x + offset[0];
          const ny = y + offset[1];
          const nz = z + offset[2];
          if (nx < 0 || ny < 0 || nz < 0 || nx >= size[0] || ny >= size[1] || nz >= size[2]) {
            lostCells.push(i);
            lostValues.push(v);
          } else {
            data[nx + size[0] * (ny + size[1] * nz)] = v;
          }
        }
    if (lostCells.length) cropped.push({ layer, frame, cells: Uint32Array.from(lostCells), values: Uint8Array.from(lostValues) });
    for (const c of restore?.cells ?? []) {
      if (c.layer !== layer || c.frame !== frame) continue;
      for (let k = 0; k < c.cells.length; k++) if (c.cells[k] < count) data[c.cells[k]] = c.values[k];
    }
    return data;
  };
  const layers = target.layers.map((layer): LayerRecord => {
    let shape = layer.shape;
    const data = new Uint8Array(shape ? 0 : count);
    const cov = layer.coverage;
    const coverage = cov ? new Uint8Array(count) : undefined;
    const lostCells: number[] = [];
    const lostValues: number[] = [];
    const src = layer.data;
    if (shape) {
      shape = translateSource(shape, shift);
      try {
        shape = checkSource(shape, Infinity);
      } catch {
        fail("The resize would move a shape too far outside the model");
      }
    } else {
      for (let z = 0, i = 0; z < old[2]; z++)
        for (let y = 0; y < old[1]; y++)
          for (let x = 0; x < old[0]; x++, i++) {
            const v = src[i];
            if (cov ? !cov[i] : !v) continue;
            const nx = x + offset[0];
            const ny = y + offset[1];
            const nz = z + offset[2];
            if (nx < 0 || ny < 0 || nz < 0 || nx >= size[0] || ny >= size[1] || nz >= size[2]) {
              lostCells.push(i);
              lostValues.push(v);
            } else {
              const j = nx + size[0] * (ny + size[1] * nz);
              data[j] = v;
              if (coverage) coverage[j] = 1;
            }
          }
    }
    if (lostCells.length) {
      cropped.push({
        layer: layer.id,
        ...(frames ? { frame: target.frame } : {}),
        cells: Uint32Array.from(lostCells),
        values: Uint8Array.from(lostValues),
        ...(cov ? { covered: true } : {}),
      });
    }
    if (restore && !shape) {
      for (const c of restore.cells) {
        if (c.layer !== layer.id || (frames && (c.frame ?? target.frame) !== target.frame)) continue;
        for (let k = 0; k < c.cells.length; k++) {
          if (c.cells[k] >= count) continue;
          data[c.cells[k]] = c.values[k];
          if (coverage && c.covered) coverage[c.cells[k]] = 1;
        }
      }
    }
    const { coverage: _, shape: __, mask: oldMask, ...rest } = layer;
    let mask: Uint8Array | undefined;
    if (oldMask) {
      masks.push({ id: layer.id, before: oldMask });
      const back = restore?.masks?.find((m) => m.id === layer.id);
      if (back && back.before.length === count) mask = back.before.slice();
      else {
        mask = new Uint8Array(count);
        for (let z = 0, i = 0; z < old[2]; z++)
          for (let y = 0; y < old[1]; y++)
            for (let x = 0; x < old[0]; x++, i++) {
              if (!oldMask[i]) continue;
              const nx = x + offset[0];
              const ny = y + offset[1];
              const nz = z + offset[2];
              if (nx >= 0 && ny >= 0 && nz >= 0 && nx < size[0] && ny < size[1] && nz < size[2]) mask[nx + size[0] * (ny + size[1] * nz)] = 1;
            }
      }
    }
    return { ...rest, data, ...(coverage ? { coverage } : {}), ...(shape ? { shape } : {}), ...(mask ? { mask } : {}) };
  });
  // the other frames' cels move the same way
  const moved = frames?.map((f): FrameRecord => {
    if (f.id === target.frame || !f.cels) return f;
    const cels: Record<string, Uint8Array> = {};
    for (const [id, cel] of Object.entries(f.cels)) {
      if (target.layers.some((l) => l.id === id)) cels[id] = moveCel(id, cel, f.id);
    }
    return { ...f, cels };
  });
  op.cropped = cropped;
  op.masks = masks;
  target.setGrid([...size], op.toGen, layers);
  if (moved) target.setFrames!(moved, target.frame!, target.layers);
  // markers and the origin move with the voxels, in source units, as shapes do
  if (target.markers?.length && target.setMarkers) target.setMarkers(target.markers.map((m) => translateMarker(m, shift)));
  if (target.origin && target.setOrigin) target.setOrigin(target.origin.map((n, a) => n + shift[a]) as Vec3);
}

function changeResolution(target: DocTarget, op: ResolutionOp, strict: boolean) {
  checkSourceOp(target, strict);
  if (animated(target)) fail("An animated model can't change resolution yet");
  if (op.fromGen !== target.gen) fail("The model was resized");
  if (op.from !== target.resolution) fail("The resolution changed");
  if (!isResolution(op.to)) fail("Resolution is 1, 2, 4 or 8 cells per unit");
  if (typeof op.toGen !== "string" || !op.toGen || op.toGen === op.fromGen) fail("A resolution change needs a new grid id");
  const factor = op.to / op.from;
  const old = target.size;
  const size = old.map((n) => n * factor) as Vec3;
  if (!size.every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_SIZE)) {
    fail(`At ${op.to}× the model would be ${size.join(" × ")} cells; the most is ${MAX_SIZE} a side`);
  }
  const count = cellCount(size);
  const restore = op.restore;
  const rasters: RasterRecord[] = [];
  const masks: { id: string; before: Uint8Array }[] = [];
  const layers = target.layers.map((layer): LayerRecord => {
    let next: LayerRecord = layer;
    if (!layer.shape) {
      rasters.push({ id: layer.id, data: layer.data, ...(layer.coverage ? { coverage: layer.coverage } : {}) });
      const back = restore?.rasters.find((r) => r.id === layer.id);
      const resampled =
        back && back.data.length === count && (!layer.coverage || back.coverage?.length === count)
          ? { data: back.data.slice(), coverage: layer.coverage ? back.coverage!.slice() : undefined }
          : resampleRaster(layer.data, layer.coverage, old, factor);
      const { coverage: _, ...rest } = layer;
      next = { ...rest, data: resampled.data, ...(resampled.coverage ? { coverage: resampled.coverage } : {}) };
    }
    if (layer.mask) {
      masks.push({ id: layer.id, before: layer.mask });
      const back = restore?.masks?.find((m) => m.id === layer.id);
      next = { ...next, mask: back && back.before.length === count ? back.before.slice() : resampleMask(layer.mask, old, factor) };
    }
    return next;
  });
  op.before = { rasters, masks };
  target.setGrid(size, op.toGen, layers, op.to);
}

/**
 * The op that takes `op` back. `op` must have been applied (so it knows what it replaced).
 */
export function invertOp(op: DocOp): DocOp {
  switch (op.t) {
    case "voxels":
      return {
        t: "voxels",
        layer: op.layer,
        ...(op.frame !== undefined ? { frame: op.frame } : {}),
        gen: op.gen,
        ...(op.channel ? { channel: op.channel } : {}),
        cells: op.cells,
        before: op.after,
        after: op.before,
      };
    case "name":
      return { t: "name", before: op.after, after: op.before };
    case "layer.add":
      return { t: "layer.remove", id: op.layer.id };
    case "layer.remove": {
      const layer = op.layer ?? fail("That layer removal was never applied");
      return {
        t: "layer.add",
        index: op.index ?? 0,
        layer: {
          id: layer.id,
          name: layer.name,
          ...(layer.shape ? { shape: layer.shape } : op.cels ? { cels: op.cels } : { data: layer.data }),
          ...(layer.coverage ? { coverage: layer.coverage } : {}),
          ...(layer.visible !== undefined ? { visible: layer.visible } : {}),
          ...(layer.locked !== undefined ? { locked: layer.locked } : {}),
          ...(layer.hostData !== undefined ? { hostData: layer.hostData } : {}),
          ...(layer.extra ? { extra: { ...layer.extra } } : {}),
        },
      };
    }
    case "layer.move":
      return { t: "layer.move", id: op.id, to: op.from ?? op.to };
    case "layer.set":
      if (op.before === undefined) fail("That layer change was never applied");
      return { t: "layer.set", id: op.id, key: op.key, after: op.before as LayerValue, before: op.after };
    case "palette.set":
      return { t: "palette.set", index: op.index, after: op.before ?? 0, before: op.after };
    case "palette.add":
      return { t: "palette.remove", index: op.index, color: op.color };
    case "palette.remove":
      return { t: "palette.add", index: op.index, color: op.color ?? 0 };
    case "palette.replace":
      return { t: "palette.replace", after: op.before ?? fail("That palette change was never applied"), before: op.after };
    case "resize":
      return {
        t: "resize",
        from: op.to,
        to: op.from,
        offset: op.offset.map((n) => -n) as Vec3,
        fromGen: op.toGen,
        toGen: op.fromGen,
        restore: { cells: op.cropped ?? [], masks: op.masks ?? [] },
      };
    case "layer.shape":
      return { t: "layer.shape", id: op.id, after: op.before ?? fail("That shape change was never applied"), before: op.after };
    case "layer.coverage":
      if (op.before === undefined) fail("That coverage change was never applied");
      return { t: "layer.coverage", id: op.id, after: op.before ?? null, before: op.after };
    case "resolution":
      return {
        t: "resolution",
        from: op.to,
        to: op.from,
        fromGen: op.toGen,
        toGen: op.fromGen,
        restore: op.before ?? fail("That resolution change was never applied"),
      };
    case "frame.add":
      return { t: "frame.remove", id: op.frame.id };
    case "frame.remove": {
      const frame = op.frame ?? fail("That frame removal was never applied");
      return { t: "frame.add", index: op.index ?? 0, frame };
    }
    case "frame.move":
      return { t: "frame.move", id: op.id, to: op.from ?? op.to };
    case "frame.duration":
      return { t: "frame.duration", id: op.id, after: op.before ?? fail("That timing change was never applied"), before: op.after };
    case "tags":
      return { t: "tags", after: op.before ?? fail("That tag change was never applied"), before: op.after };
    case "fps":
      return { t: "fps", after: op.before ?? fail("That timing change was never applied"), before: op.after };
    case "layer.data":
      return { t: "layer.data", id: op.id, after: op.before === undefined ? fail("That data change was never applied") : op.before, before: op.after };
    case "data":
      return { t: "data", key: op.key, after: op.before === undefined ? fail("That data change was never applied") : op.before, before: op.after };
    case "layer.mask":
      if (op.before === undefined) fail("That mask change was never applied");
      return { t: "layer.mask", id: op.id, after: op.before ?? null, before: op.after };
    case "group.add":
      return { t: "group.remove", id: op.group.id };
    case "group.remove":
      return { t: "group.add", index: op.index ?? 0, group: op.group ?? fail("That group removal was never applied"), ...(op.members ? { members: op.members } : {}) };
    case "group.set":
      if (op.before === undefined) fail("That group change was never applied");
      return { t: "group.set", id: op.id, key: op.key, after: op.before as LayerValue, before: op.after };
    case "marker.add":
      return { t: "marker.remove", id: op.marker.id };
    case "marker.remove":
      return { t: "marker.add", index: op.index ?? 0, marker: op.marker ?? fail("That marker removal was never applied") };
    case "marker.set":
      return { t: "marker.set", id: op.id, after: op.before ?? fail("That marker change was never applied"), before: op.after };
    case "origin":
      if (op.before === undefined) fail("That origin change was never applied");
      return { t: "origin", after: op.before ?? null, before: op.after };
  }
}

/** Apply ops in order, all or nothing: if one doesn't fit, the ones before it are taken back and the error rethrown. */
export function applyOps(target: DocTarget, ops: readonly DocOp[], strict = false) {
  let done = 0;
  try {
    for (; done < ops.length; done++) applyOp(target, ops[done], strict);
  } catch (e) {
    for (let i = done - 1; i >= 0; i--) applyOp(target, invertOp(ops[i]));
    throw e;
  }
}

/**
 * A copy of a JSON value, checked: plain objects, arrays, finite numbers, strings, booleans and
 * null only, nested at most 32 deep. Host data is kept as it is, so it must survive a file.
 */
export function checkJson(value: unknown, depth = 0): Json {
  if (depth > 32) fail("Host data is nested too deeply");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : fail("Host data can't hold NaN or Infinity");
  if (Array.isArray(value)) return value.map((v) => checkJson(v, depth + 1));
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = checkJson(v, depth + 1);
    }
    return out;
  }
  return fail("Host data must be plain JSON");
}

/** Throws if a document's host data, with these layers and namespaces, would be over `MAX_HOST_DATA`. */
function checkHostBudget(
  _target: DocTarget,
  layers: readonly LayerRecord[],
  data: Readonly<Record<string, Json>> | undefined,
) {
  let size = data ? JSON.stringify(data).length : 0;
  for (const l of layers) {
    if (l.hostData !== undefined) size += JSON.stringify(l.hostData).length;
    if (l.extra) size += JSON.stringify(l.extra).length;
    if (size > MAX_HOST_DATA) fail(`Host data can be at most ${MAX_HOST_DATA / 1024} KiB in all`);
  }
  if (size > MAX_HOST_DATA) fail(`Host data can be at most ${MAX_HOST_DATA / 1024} KiB in all`);
}

/** Take back ops applied earlier, newest first. */
export function revertOps(target: DocTarget, ops: readonly DocOp[]) {
  for (let i = ops.length - 1; i >= 0; i--) applyOp(target, invertOp(ops[i]));
}

/** Ops that change what layers exist, their order, the palette's slots, or the grid. */
export function isStructural(op: DocOp) {
  return (
    op.t === "layer.add" ||
    op.t === "layer.remove" ||
    op.t === "layer.move" ||
    op.t === "palette.add" ||
    op.t === "palette.remove" ||
    op.t === "palette.replace" ||
    op.t === "resize" ||
    op.t === "resolution" ||
    op.t === "layer.coverage" ||
    op.t === "frame.add" ||
    op.t === "frame.remove" ||
    op.t === "frame.move"
  );
}

// #endregion
