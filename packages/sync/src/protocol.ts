// The wire format between a live room and its clients: JSON messages over a WebSocket, with
// document ops in a compact form. Everything that arrives is checked: decoding throws an
// `OpError` for anything malformed, and applying an op checks it against the document.

import { decodeRle, encodeRle, fromBase64, toBase64 } from "@voxeltoy/core/formats/moxel";
import { fromHex, toHex } from "@voxeltoy/core/color";
import { checkJson, isValidId, MAX_HOST_DATA, MAX_LAYERS, OpError, type CroppedCells, type DocOp, type LayerKey } from "@voxeltoy/core/ops";
import type { DocumentData, Json, Vec3 } from "@voxeltoy/core/types";

export const PROTOCOL_VERSION = 1;

/** Room limits. Provisional: measured against Durable Object memory and request limits, not yet in production. */
export const LIMITS = {
  /** Cells times layers a live room holds. */
  roomCells: 48 * 1024 * 1024,
  /** Bytes of one WebSocket message. Bigger edits arrive in parts. */
  message: 768 * 1024,
  /** Bytes of one edit, across all its parts. */
  edit: 24 * 1024 * 1024,
  /** Bytes of an uploaded snapshot (compressed) or room seed. */
  upload: 24 * 1024 * 1024,
  /** People in one room at once. */
  participants: 24,
};

// #region Ops

const fail = (message = "Malformed edit"): never => {
  throw new OpError(message);
};

/** Ascending cell indices as base64 delta varints: a stroke's cells take a byte or two each. */
export function encodeCells(cells: Uint32Array): { cells: string; order: Uint32Array } {
  const order = Uint32Array.from(cells.keys()).sort((a, b) => cells[a] - cells[b]);
  const out: number[] = [];
  let prev = 0;
  for (const k of order) {
    let delta = cells[k] - prev;
    prev = cells[k];
    while (delta >= 0x80) {
      out.push((delta & 0x7f) | 0x80);
      delta >>>= 7;
    }
    out.push(delta);
  }
  return { cells: toBase64(Uint8Array.from(out)), order };
}

export function decodeCells(text: unknown): Uint32Array {
  if (typeof text !== "string") return fail();
  const bytes = fromBase64(text);
  const cells: number[] = [];
  let prev = 0;
  for (let i = 0; i < bytes.length; ) {
    let delta = 0;
    let shift = 0;
    for (;;) {
      if (i >= bytes.length || shift > 28) fail();
      const b = bytes[i++];
      delta += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    prev += delta;
    if (prev > 0xffffffff) fail();
    cells.push(prev);
  }
  return Uint32Array.from(cells);
}

const encodeValues = (values: Uint8Array) => toBase64(encodeRle(values));

function decodeValues(text: unknown, count: number): Uint8Array {
  if (typeof text !== "string") return fail();
  const rle = fromBase64(text);
  let total = 0;
  for (let i = 0; i < rle.length; i += 2) total += rle[i] + 1;
  if (total !== count) fail();
  return decodeRle(rle, count);
}

/** Voxel data of a whole layer: run-length encoded, base64. */
export const encodeLayerData = encodeValues;
export const decodeLayerData = decodeValues;

function encodeCropped(c: CroppedCells) {
  const { cells, order } = encodeCells(c.cells);
  return { layer: c.layer, cells, values: encodeValues(Uint8Array.from(order, (k) => c.values[k])) };
}

function decodeCropped(w: unknown): CroppedCells {
  const c = w as { layer: unknown; cells: unknown; values: unknown };
  if (!c || !isValidId(c.layer)) fail();
  const cells = decodeCells(c.cells);
  return { layer: c.layer as string, cells, values: decodeValues(c.values, cells.length) };
}

/** Ops in their wire form. Values an op replaced are left out: the receiver works them out when it applies the op. */
export type WireOp = Record<string, unknown> & { t: DocOp["t"] };

export function encodeOp(op: DocOp): WireOp {
  switch (op.t) {
    case "voxels": {
      if (op.channel) throw new OpError(HYBRID);
      const { cells, order } = encodeCells(op.cells);
      const after = new Uint8Array(order.length);
      order.forEach((k, n) => (after[n] = op.after[k]));
      return { t: op.t, layer: op.layer, gen: op.gen, cells, after: encodeValues(after) };
    }
    case "name":
      return { t: op.t, after: op.after };
    case "layer.add": {
      if (op.layer.shape || op.layer.coverage) throw new OpError(HYBRID);
      if (op.layer.cels) throw new OpError("Animation can't be shared yet");
      if (op.layer.blend || op.layer.mask || op.layer.effects || op.layer.group) throw new OpError(STAGES);
      const { data, ...layer } = op.layer;
      return {
        t: op.t,
        index: op.index,
        layer: { ...layer, ...(data ? { voxels: encodeValues(data) } : {}) },
      };
    }
    case "layer.remove":
      return { t: op.t, id: op.id };
    case "layer.move":
      return { t: op.t, id: op.id, to: op.to };
    case "layer.set":
      if (op.key !== "name") throw new OpError(STAGES);
      return { t: op.t, id: op.id, key: op.key, after: op.after };
    case "palette.set":
      return { t: op.t, index: op.index, after: op.after };
    case "palette.add":
      return { t: op.t, index: op.index, color: op.color };
    case "palette.remove":
      return { t: op.t, index: op.index };
    case "palette.replace":
      return { t: op.t, after: op.after };
    case "resize":
      return {
        t: op.t,
        from: op.from,
        to: op.to,
        offset: op.offset,
        fromGen: op.fromGen,
        toGen: op.toGen,
        ...(op.restore
          ? { restore: { cells: op.restore.cells.map(encodeCropped) } }
          : {}),
      };
    case "layer.shape":
    case "layer.coverage":
    case "resolution":
      // live rooms only carry raster layers for now; see docs/vector-raster.md
      throw new OpError(HYBRID);
    case "frame.add":
    case "frame.remove":
    case "frame.move":
    case "frame.duration":
    case "tags":
    case "fps":
      // nor animation; see docs/animation.md
      throw new OpError("Animation can't be shared yet");
    case "layer.data":
      return { t: op.t, id: op.id, after: op.after };
    case "data":
      return { t: op.t, key: op.key, after: op.after };
    case "marker.add":
    case "marker.remove":
    case "marker.set":
    case "origin":
      // nor markers; see docs/pipeline.md
      throw new OpError("Markers can't be shared yet");
    case "layer.mask":
    case "group.add":
    case "group.remove":
    case "group.set":
      throw new OpError(STAGES);
  }
}

const HYBRID = "Shape and override layers can't be shared yet";
const STAGES = "Blends, masks, effects and groups can't be shared yet";


const isInt = (n: unknown): n is number => Number.isInteger(n);
const isVec = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
const str = (v: unknown): string => (typeof v === "string" && v.length <= 1024 ? v : fail());
const id = (v: unknown): string => (isValidId(v) ? v : fail());
const int = (v: unknown): number => (isInt(v) ? v : fail());
const vec = (v: unknown): Vec3 => (isVec(v) ? ([...v] as Vec3) : fail());
/** Host data from the wire: plain JSON, within the size a document may keep. */
const json = (v: unknown): Json => {
  const value = checkJson(v);
  if (JSON.stringify(value).length > MAX_HOST_DATA) fail("The host data is too big");
  return value;
};
const jsonObject = (v: unknown): Record<string, Json> => {
  const value = json(v);
  return value && typeof value === "object" && !Array.isArray(value) ? value : fail();
};

/** An op from its wire form. Throws an `OpError` if it is malformed (but not whether it fits a document). */
export function decodeOp(w: unknown, cellLimit = Infinity): DocOp {
  if (!w || typeof w !== "object") return fail();
  const o = w as Record<string, unknown>;
  switch (o.t) {
    case "voxels": {
      const cells = decodeCells(o.cells);
      if (cells.length > cellLimit) fail("The edit is too big");
      return { t: "voxels", layer: id(o.layer), gen: id(o.gen), cells, before: new Uint8Array(cells.length), after: decodeValues(o.after, cells.length) };
    }
    case "name":
      return { t: "name", before: "", after: str(o.after) };
    case "layer.add": {
      const l = o.layer as Record<string, unknown>;
      if (!l || typeof l !== "object") fail();
      return {
        t: "layer.add",
        index: int(o.index),
        layer: {
          id: id(l.id),
          name: str(l.name),
          ...(l.voxels !== undefined ? { data: decodeVoxelsLater(l.voxels) } : {}),
          ...(typeof l.visible === "boolean" ? { visible: l.visible } : {}),
          ...(typeof l.locked === "boolean" ? { locked: l.locked } : {}),
          ...(l.hostData !== undefined && l.hostData !== null ? { hostData: json(l.hostData) } : {}),
          ...(l.extra !== undefined ? { extra: jsonObject(l.extra) } : {}),
        },
      };
    }
    case "layer.data":
      return { t: "layer.data", id: id(o.id), after: o.after === undefined ? null : json(o.after) };
    case "data":
      return { t: "data", key: str(o.key), after: o.after === undefined ? null : json(o.after) };
    case "layer.remove":
      return { t: "layer.remove", id: id(o.id) };
    case "layer.move":
      return { t: "layer.move", id: id(o.id), to: int(o.to) };
    case "layer.set": {
      const key = o.key as LayerKey;
      const after = o.after;
      if (key === "name") return { t: "layer.set", id: id(o.id), key, after: str(after) };
      return fail();
    }
    case "palette.set":
      return { t: "palette.set", index: int(o.index), after: int(o.after) };
    case "palette.add":
      return { t: "palette.add", index: int(o.index), color: int(o.color) };
    case "palette.remove":
      return { t: "palette.remove", index: int(o.index) };
    case "palette.replace": {
      if (!Array.isArray(o.after) || o.after.length > 256) fail();
      return { t: "palette.replace", after: (o.after as unknown[]).map(int) };
    }
    case "resize": {
      const r = o.restore as { cells?: unknown } | undefined;
      let restore: { cells: CroppedCells[] } | undefined;
      if (r !== undefined) {
        if (!r || !Array.isArray(r.cells) || r.cells.length > MAX_LAYERS) fail();
        restore = { cells: (r.cells as unknown[]).map(decodeCropped) };
      }
      return {
        t: "resize",
        from: vec(o.from),
        to: vec(o.to),
        offset: vec(o.offset),
        fromGen: id(o.fromGen),
        toGen: id(o.toGen),
        ...(restore ? { restore } : {}),
      };
    }
    default:
      return fail(`Unknown edit ${String(o.t)}`);
  }
}

/**
 * A layer's voxels arrive without their count (it depends on the document they land in), so
 * they decode to every run; `applyOp` then checks the length against the grid.
 */
function decodeVoxelsLater(text: unknown): Uint8Array {
  if (typeof text !== "string") return fail();
  const rle = fromBase64(text);
  let total = 0;
  for (let i = 0; i < rle.length; i += 2) total += rle[i] + 1;
  if (total > 256 ** 3) fail("The layer is too big");
  return decodeRle(rle, total);
}

export const encodeOps = (ops: readonly DocOp[]) => ops.map(encodeOp);

export function decodeOps(wire: unknown, cellLimit?: number): DocOp[] {
  if (!Array.isArray(wire) || wire.length > 10_000) return fail();
  return wire.map((w) => decodeOp(w, cellLimit));
}

// #endregion

// #region Snapshots

/** A whole shared document: like a .moxel file, but layers keep their ids and the grid its generation. */
export interface RoomSnapshot {
  format: "moxel-room";
  version: 1;
  name: string;
  size: Vec3;
  gen: string;
  palette: string[];
  activeLayer?: number;
  /** Host data by namespace. */
  data?: Record<string, Json>;
  layers: {
    id: string;
    name: string;
    visible: boolean;
    locked: boolean;
    voxels: string;
    data?: Json;
    extra?: Record<string, Json>;
  }[];
}

export function encodeSnapshot(doc: DocumentData): RoomSnapshot {
  // never flatten what a room can't hold
  if ((doc.resolution ?? 1) !== 1 || doc.layers.some((l) => l.shape || l.coverage)) throw new OpError(HYBRID);
  return {
    format: "moxel-room",
    version: 1,
    name: doc.name,
    size: [...doc.size],
    gen: doc.gen ?? fail("A shared document needs a grid id"),
    palette: doc.palette.slice(1).map(toHex),
    activeLayer: doc.activeLayer,
    ...(doc.hostData && Object.keys(doc.hostData).length ? { data: doc.hostData } : {}),
    layers: doc.layers.map((l) => {
      return {
        id: l.id ?? fail("A shared document needs layer ids"),
        name: l.name,
        visible: l.visible,
        locked: l.locked,
        voxels: encodeLayerData(l.data),
        ...(l.hostData !== undefined && l.hostData !== null ? { data: l.hostData } : {}),
        ...(l.extra ? { extra: l.extra } : {}),
      };
    }),
  };
}

/** A shared document from a snapshot, checked. Throws an `OpError` if it is malformed. */
export function decodeSnapshot(value: unknown): DocumentData {
  const s = value as RoomSnapshot;
  if (!s || s.format !== "moxel-room") fail("Not a shared Voxeltoy document");
  if (s.version !== 1) fail(`Unsupported shared document version ${String(s.version)}`);
  const size = vec(s.size);
  if (!size.every((n) => isInt(n) && n >= 1 && n <= 256)) fail("Bad size");
  const count = size[0] * size[1] * size[2];
  if (!Array.isArray(s.palette) || s.palette.length < 1 || s.palette.length > 255) fail("Bad palette");
  if (!Array.isArray(s.layers) || s.layers.length < 1 || s.layers.length > MAX_LAYERS) fail("Bad layers");
  const palette = [0, ...s.palette.map((h) => (typeof h === "string" && /^#?[0-9a-f]{6}$/i.test(h) ? fromHex(h) : fail("Bad palette")))];
  const ids = s.layers.map((l) => id(l?.id));
  if (new Set(ids).size !== ids.length) fail("Layer ids repeat");
  return {
    name: str(s.name),
    size,
    gen: id(s.gen),
    palette,
    activeLayer: isInt(s.activeLayer) ? s.activeLayer : s.layers.length - 1,
    ...(s.data !== undefined ? { hostData: jsonObject(s.data) } : {}),
    layers: s.layers.map((l) => {
      const data = decodeValues(l.voxels, count);
      for (const v of data) if (v >= palette.length) fail("A voxel uses a color that isn't in the palette");
      return {
        id: l.id,
        name: str(l.name),
        visible: l.visible !== false,
        locked: l.locked === true,
        data,
        ...(l.data !== undefined && l.data !== null ? { hostData: json(l.data) } : {}),
        ...(l.extra !== undefined ? { extra: jsonObject(l.extra) } : {}),
      };
    }),
  };
}

// #endregion

// #region Messages

export type Role = "view" | "edit";

/** Someone in a room, as everyone else sees them. */
export interface Peer {
  actor: string;
  name: string;
  /** 0xRRGGBB. */
  color: number;
  role: Role;
  /** The layer they are working on. */
  layer?: string;
  /** Where their pointer is on the model, in grid units, or null when it is off the model. */
  pointer?: Vec3 | null;
}

export interface RemoteEdit {
  revision: number;
  id: string;
  actor: string;
  ops: WireOp[];
}

export type ClientMessage =
  | {
      type: "hello";
      version: number;
      token: string;
      name: string;
      color: number;
      /** The last revision this client has, to catch up from; -1 for a fresh snapshot. */
      revision: number;
      /** Edits it sent that may not have been answered. */
      pending: string[];
    }
  /** An edit, or one part of a big one: the room applies it when the last part arrives. */
  | { type: "edit"; id: string; ops: WireOp[]; part?: number; parts?: number }
  | { type: "presence"; name?: string; color?: number; layer?: string; pointer?: Vec3 | null }
  | { type: "ping" };

export type ServerMessage =
  | {
      type: "welcome";
      actor: string;
      role: Role;
      revision: number;
      /**
       * Either the whole document (a fresh start) or the edits since the client's revision. A big
       * document comes in `snapshotParts` "snapshot" messages instead: pieces of its JSON text.
       */
      snapshot?: RoomSnapshot;
      snapshotParts?: number;
      edits?: RemoteEdit[];
      /** What became of the client's pending edits. */
      applied: { id: string; revision: number }[];
      rejected: { id: string; reason: string }[];
      peers: Peer[];
    }
  | { type: "snapshot"; part: number; data: string }
  | { type: "ack"; id: string; revision: number }
  | { type: "reject"; id: string; reason: string }
  | ({ type: "edit" } & RemoteEdit)
  | { type: "peers"; peers: Peer[] }
  | { type: "presence"; actor: string; layer?: string; pointer?: Vec3 | null }
  | { type: "pong" }
  /** Something went wrong; `close` says the room is gone or access ended. */
  | { type: "error"; reason: string; close?: "revoked" | "deleted" | "unauthorized" | "full" | "version" | "disabled" };

/** Split an edit's ops into messages under the size limit. */
export function editMessages(id: string, ops: WireOp[], limit = LIMITS.message): ClientMessage[] {
  const parts: WireOp[][] = [[]];
  let size = 0;
  for (const op of ops) {
    const n = JSON.stringify(op).length;
    if (size + n > limit - 256 && parts[parts.length - 1].length) {
      parts.push([]);
      size = 0;
    }
    if (n > limit - 256) {
      // one op too big for a message: voxel edits split by cells
      for (const piece of splitOp(op, limit - 256)) {
        if (parts[parts.length - 1].length) parts.push([]);
        parts[parts.length - 1].push(piece);
      }
      parts.push([]);
      size = 0;
      continue;
    }
    parts[parts.length - 1].push(op);
    size += n;
  }
  if (!parts[parts.length - 1].length && parts.length > 1) parts.pop();
  if (parts.length === 1) return [{ type: "edit", id, ops: parts[0] }];
  return parts.map((p, part) => ({ type: "edit", id, ops: p, part, parts: parts.length }));
}

/** Split an op too big for one message. Only voxel edits can be; anything else goes whole. */
function splitOp(op: WireOp, limit: number): WireOp[] {
  if (op.t !== "voxels") return [op];
  const decoded = decodeOp(op) as Extract<DocOp, { t: "voxels" }>;
  const pieces: WireOp[] = [];
  // each cell costs at most a few bytes; pick a step that fits
  const step = Math.max(1024, Math.floor(limit / 8));
  for (let k = 0; k < decoded.cells.length; k += step) {
    pieces.push(
      encodeOp({
        ...decoded,
        cells: decoded.cells.subarray(k, k + step),
        before: decoded.before.subarray(k, k + step),
        after: decoded.after.subarray(k, k + step),
      }),
    );
  }
  return pieces;
}

// #endregion
