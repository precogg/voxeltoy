// Markers: named points and simple volumes in a model that aren't voxels: mounts, colliders,
// hitboxes. They sit beside the pipeline, never in it, and can be keyed per frame. A model also
// has an origin, the point it is placed by and turns around. See docs/pipeline.md.
//
// Positions are in source units (one unit is one cell at 1× resolution), Y up, so markers keep
// their place through resolution changes. Points snap to half a voxel at the finest resolution.

import { checkShapeOf, MAX_RESOLUTION, SOURCE_LIMIT, translateShape, type StepShape } from "./source";
import type { Direction } from "./shapes";
import { decomposeMat, type Quat } from "./scene-math";
import type { Json, Vec3 } from "./types";

/** Where a marker is: a point with an orientation (a mount, a socket), or a volume. */
export type MarkerShape =
  | {
      readonly kind: "point";
      readonly at: Vec3;
      /** The marker's up, in quarter turns of the model's axes. Unset: +Y. */
      readonly up?: Direction;
      /** The marker's forward, across its up. Unset: +Z (or +Y when up is along Z). */
      readonly forward?: Direction;
    }
  | { readonly kind: "volume"; readonly shape: StepShape };

/** A marker's placement from a frame on, until the next key. */
export interface MarkerKey {
  readonly frame: string;
  /** Where it is; unset with `hidden`. */
  readonly shape?: MarkerShape;
  /** Absent from this frame on (a hitbox that is only out mid-swing). */
  readonly hidden?: boolean;
}

export interface Marker {
  /** "marker:…", unique in the model. */
  readonly id: string;
  readonly name: string;
  /** Where it is in every frame no key covers: all of them, for a marker without keys. */
  readonly shape: MarkerShape;
  /** What it is for: "mount", "collision", "hitbox", "hurtbox", or a host's word. Unset: a plain marker. */
  readonly role?: string;
  /** Placements per frame, in no particular order: each holds from its frame until the next key in frame order. */
  readonly keys?: readonly MarkerKey[];
  /** A host's data, kept as it is. */
  readonly data?: Json;
}

/** Where a marker is on one frame. */
export interface MarkerPlacement {
  readonly shape: MarkerShape;
  readonly hidden: boolean;
}

export const MAX_MARKERS = 256;
export const MAX_MARKER_KEYS = 1024;
export const MAX_ROLE = 40;
/** Roles Voxeltoy draws and exports in its own way. Any other role is a host's. */
export const MARKER_ROLES = ["mount", "collision", "hitbox", "hurtbox"] as const;
/** Points snap to half a voxel at the finest resolution. */
export const MARKER_STEP = 1 / (2 * MAX_RESOLUTION);

export class MarkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkerError";
  }
}

const fail = (message: string): never => {
  throw new MarkerError(message);
};

const MARKER_ID = /^[\w:.-]{1,64}$/;

/** A point snapped to half a voxel at `resolution` (the finest lattice by default). */
export const snapMarker = (p: Vec3, resolution = MAX_RESOLUTION): Vec3 => {
  const step = 1 / (2 * resolution);
  return p.map((n) => Math.round(n / step) * step) as Vec3;
};

/** A marker shape on the lattice: a point snapped to half a voxel at `resolution`, a volume's corners to shape steps' lattice. */
export function snapMarkerShape(shape: MarkerShape, resolution?: number): MarkerShape {
  if (shape.kind === "point") return { ...shape, at: snapMarker(shape.at, resolution) };
  const snap = (v: Vec3) => v.map((n) => Math.round(n * MAX_RESOLUTION) / MAX_RESOLUTION) as Vec3;
  return { kind: "volume", shape: { ...shape.shape, min: snap(shape.shape.min), max: snap(shape.shape.max) } };
}

const onMarkerLattice =(n: number) => Number.isFinite(n) && Number.isInteger(n / MARKER_STEP);

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

function checkDirection(raw: unknown, name: string): Direction {
  const d = raw as Direction;
  if (!d || typeof d !== "object" || ![0, 1, 2].includes(d.axis) || (d.sign !== 1 && d.sign !== -1)) {
    fail(`A marker's ${name} is { axis: 0, 1 or 2, sign: 1 or -1 }`);
  }
  return { axis: d.axis, sign: d.sign };
}

/** A marker's default forward for an up: +Z, or +Y when up lies along Z. */
export const defaultMarkerForward = (up?: Direction): Direction => (up?.axis === 2 ? { axis: 1, sign: 1 } : { axis: 2, sign: 1 });

/** Check a placement from anywhere and return a clean copy: points on the lattice, volumes as shape steps take them. */
export function checkMarkerShape(raw: unknown): MarkerShape {
  if (!raw || typeof raw !== "object") fail("A marker needs a shape");
  const s = raw as Record<string, unknown>;
  if (s.kind === "point") {
    if (!isVec3(s.at)) fail("A point marker needs at: [x, y, z]");
    const at = s.at as Vec3;
    if (!at.every(onMarkerLattice)) fail(`A marker's position is a multiple of 1/${1 / MARKER_STEP}`);
    if (at.some((n) => Math.abs(n) > SOURCE_LIMIT)) fail("A marker is too far outside the model");
    const up = s.up === undefined ? undefined : checkDirection(s.up, "up");
    const forward = s.forward === undefined ? undefined : checkDirection(s.forward, "forward");
    if (forward && forward.axis === (up?.axis ?? 1)) fail("A marker's forward must be across its up");
    const isUp = !up || (up.axis === 1 && up.sign === 1);
    const def = defaultMarkerForward(up);
    const isForward = !forward || (forward.axis === def.axis && forward.sign === def.sign);
    return { kind: "point", at: [...at] as Vec3, ...(isUp ? {} : { up }), ...(isForward ? {} : { forward }) };
  }
  if (s.kind === "volume") {
    if ((s.shape as { kind?: unknown } | undefined)?.kind === "path") fail("A marker's volume is a solid shape, not a path");
    try {
      return { kind: "volume", shape: checkShapeOf(s.shape) };
    } catch (e) {
      return fail((e as Error).message.replace(/^A step/, "A marker"));
    }
  }
  return fail(`Unknown marker shape ${String(s.kind)}`);
}

/**
 * Check a marker from anywhere (a file, a script, an op) and return a clean copy. `frames` are the
 * document's frame ids, which keys must name; a key for a frame it doesn't have is turned down.
 */
export function checkMarker(raw: unknown, frames: ReadonlySet<string>, checkData: (v: unknown) => Json = (v) => v as Json): Marker {
  if (!raw || typeof raw !== "object") fail("A marker must be an object");
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== "string" || !MARKER_ID.test(m.id)) fail("A marker needs an id");
  if (typeof m.name !== "string" || !m.name.trim() || m.name.length > 120) fail("A marker's name is 1 to 120 characters");
  if (m.role !== undefined && (typeof m.role !== "string" || !m.role || m.role.length > MAX_ROLE)) fail(`A marker's role is 1 to ${MAX_ROLE} characters`);
  const shape = checkMarkerShape(m.shape);
  let keys: MarkerKey[] | undefined;
  if (m.keys !== undefined) {
    if (!Array.isArray(m.keys)) fail("A marker's keys are a list");
    const seen = new Set<string>();
    keys = (m.keys as unknown[]).map((raw): MarkerKey => {
      const k = raw as Record<string, unknown>;
      if (!k || typeof k !== "object" || typeof k.frame !== "string") fail("A marker key names its frame");
      const frame = k.frame as string;
      if (!frames.has(frame)) fail("A marker key names a frame the model doesn't have");
      if (seen.has(frame)) fail("A marker has two keys on one frame");
      seen.add(frame);
      if (k.hidden !== undefined && typeof k.hidden !== "boolean") fail("A marker key's hidden is true or false");
      if (k.hidden) return { frame, hidden: true };
      return { frame, shape: checkMarkerShape(k.shape) };
    });
    if (keys.length > MAX_MARKER_KEYS) fail(`A marker can have at most ${MAX_MARKER_KEYS} keys`);
    if (!keys.length) keys = undefined;
  }
  const data = m.data === undefined || m.data === null ? undefined : checkData(m.data);
  return {
    id: m.id as string,
    name: (m.name as string).trim(),
    shape,
    ...(m.role ? { role: m.role as string } : {}),
    ...(keys ? { keys } : {}),
    ...(data !== undefined ? { data } : {}),
  };
}

/** Check a model's markers: each one, distinct ids, and how many. */
export function checkMarkers(raw: unknown, frames: ReadonlySet<string>, checkData?: (v: unknown) => Json): Marker[] {
  if (!Array.isArray(raw)) fail("Markers are a list");
  const list = raw as unknown[];
  if (list.length > MAX_MARKERS) fail(`A model can have at most ${MAX_MARKERS} markers`);
  const ids = new Set<string>();
  return list.map((r) => {
    const m = checkMarker(r, frames, checkData);
    if (ids.has(m.id)) fail("Two markers have the same id");
    ids.add(m.id);
    return m;
  });
}

/**
 * Where a marker is on a frame: the latest key at or before it in frame order, or its own shape.
 * A hidden marker's shape is where it was last shown, so showing it again puts it back there.
 */
export function markerAt(marker: Marker, frames: readonly { id: string }[], frame: string): MarkerPlacement {
  if (!marker.keys?.length) return { shape: marker.shape, hidden: false };
  const at = frames.findIndex((f) => f.id === frame);
  const order = new Map(frames.map((f, i) => [f.id, i]));
  const before = marker.keys
    .filter((k) => (order.get(k.frame) ?? Infinity) <= at)
    .sort((a, b) => order.get(a.frame)! - order.get(b.frame)!);
  let shape = marker.shape;
  let hidden = false;
  for (const key of before) {
    hidden = !!key.hidden;
    if (key.shape) shape = key.shape;
  }
  return { shape, hidden };
}

/** The key a marker has on exactly this frame, if any. */
export const keyOn = (marker: Marker, frame: string) => marker.keys?.find((k) => k.frame === frame);

/** A marker's shape moved by `delta` source units. */
export function translateMarkerShape(shape: MarkerShape, delta: Vec3): MarkerShape {
  if (shape.kind === "point") return { ...shape, at: shape.at.map((n, a) => n + delta[a]) as Vec3 };
  return { kind: "volume", shape: translateShape(shape.shape, delta) };
}

/** A marker and its keys moved by `delta` source units. */
export function translateMarker(marker: Marker, delta: Vec3): Marker {
  return {
    ...marker,
    shape: translateMarkerShape(marker.shape, delta),
    ...(marker.keys ? { keys: marker.keys.map((k) => (k.shape ? { ...k, shape: translateMarkerShape(k.shape, delta) } : k)) } : {}),
  };
}

/** The middle of a marker's shape, in source units: a point's position, a volume's box center. */
export function markerCenter(shape: MarkerShape): Vec3 {
  if (shape.kind === "point") return shape.at;
  return shape.shape.min.map((n, a) => (n + shape.shape.max[a]) / 2) as Vec3;
}

/** The marker with a new placement on `frame`: its key there when it has keys, otherwise its own shape. */
export function placeMarker(marker: Marker, frame: string | undefined, shape: MarkerShape): Marker {
  if (!marker.keys?.length || frame === undefined) return { ...marker, shape };
  const keys = marker.keys.filter((k) => k.frame !== frame);
  return { ...marker, keys: [...keys, { frame, shape }] };
}

/** Each marker's key on `frame`, by marker id, and the markers without them. */
export function takeFrameKeys(markers: readonly Marker[], frame: string): { markers: Marker[]; keys: Record<string, MarkerKey> } {
  const keys: Record<string, MarkerKey> = {};
  const next = markers.map((m) => {
    const key = keyOn(m, frame);
    if (!key) return m;
    keys[m.id] = key;
    const rest = m.keys!.filter((k) => k !== key);
    const { keys: _, ...without } = m;
    return rest.length ? { ...without, keys: rest } : without;
  });
  return { markers: next, keys };
}

/** The markers with keys put on `frame` (by marker id; markers that are gone are skipped). */
export function giveFrameKeys(markers: readonly Marker[], frame: string, keys: Readonly<Record<string, Omit<MarkerKey, "frame">>>): Marker[] {
  return markers.map((m) => {
    const key = keys[m.id];
    if (!key) return m;
    const rest = (m.keys ?? []).filter((k) => k.frame !== frame);
    return { ...m, keys: [...rest, { ...key, frame }] };
  });
}

/** Whether a document's markers are the same, for tests and no-op checks. */
export const sameMarkers = (a: readonly Marker[], b: readonly Marker[]) => JSON.stringify(a) === JSON.stringify(b);

/** A new marker id. */
export function newMarkerId(): string {
  let id = "marker:";
  for (let i = 0; i < 12; i++) id += "0123456789abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 36)];
  return id;
}

/** A marker's axes, right-handed: x, y (its up) and z (its forward). A volume's are the model's. */
export function markerAxes(shape: MarkerShape): [Vec3, Vec3, Vec3] {
  if (shape.kind !== "point") return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const unit = (d: Direction): Vec3 => {
    const v: Vec3 = [0, 0, 0];
    v[d.axis] = d.sign;
    return v;
  };
  const y = unit(shape.up ?? { axis: 1, sign: 1 });
  const z = unit(shape.forward ?? defaultMarkerForward(shape.up));
  const x: Vec3 = [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]];
  return [x, y, z];
}

/** How a marker is turned against the model, as a quaternion. */
export function markerRotation(shape: MarkerShape): Quat {
  const [x, y, z] = markerAxes(shape);
  return decomposeMat([...x, 0, ...y, 0, ...z, 0, 0, 0, 0, 1]).rotation;
}

// #region Origin

/** A model's origin in grid units (cells of its output grid): its own, or the center of its floor. */
export function originCells(doc: { readonly origin: Vec3 | null; readonly size: Vec3; readonly resolution: number }): Vec3 {
  const o = doc.origin ?? defaultOrigin(doc.size, doc.resolution);
  return o.map((n) => n * doc.resolution) as Vec3;
}

/** Where a model's origin is by default, in source units: the center of its floor. */
export function defaultOrigin(size: Vec3, resolution = 1): Vec3 {
  return [size[0] / resolution / 2, 0, size[2] / resolution / 2];
}

/** Check an origin: [x, y, z] on the marker lattice. */
export function checkOrigin(raw: unknown): Vec3 {
  if (!isVec3(raw)) fail("An origin is [x, y, z]");
  const o = raw as Vec3;
  if (!o.every(onMarkerLattice)) fail(`An origin is a multiple of 1/${1 / MARKER_STEP}`);
  if (o.some((n) => Math.abs(n) > SOURCE_LIMIT)) fail("The origin is too far outside the model");
  return [...o] as Vec3;
}

// #endregion
