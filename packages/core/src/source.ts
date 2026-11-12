// Shape (procedural) sources: a stack of steps in continuous source space, and the conversions
// between source space and the output grid. See docs/vector-raster.md.
//
// Source space is Y-up and measured in source units; one unit is one cell of the reference grid
// (the grid at resolution 1). The output grid has `resolution` cells per unit, a power of two.
// Output cell `i` samples source position `(i + 0.5) / resolution`, and shapes are half-open,
// `[min, max)`. Coordinates are multiples of 1 / MAX_RESOLUTION, so every coordinate and
// sample is an exact binary fraction and evaluation gives the same cells everywhere.

import {
  defaultForward,
  LEGACY_KINDS,
  MAX_PATH_POINTS,
  PATH_PROFILES,
  pathBounds,
  presetShape,
  SHAPE_KINDS,
  SHAPE_PRESET_IDS,
  shapeOrientations,
  type Direction,
  type PathPoint,
  type ShapeKind,
  type ShapeParams,
  type ShapePreset,
} from "./shapes";
import type { Axis, Box, Vec3 } from "./types";

/** The options a step's shape can take, beyond its kind and box. Each is unset where the kind doesn't take it. */
export interface ShapeOptions extends ShapeParams {
  /**
   * Where the shape points, for shapes that have a direction (`shapeOrientations`): a prism's
   * top, a wedge's apex edge, a capsule's axis (sign always +), a swept sphere's or torus's axis.
   */
  readonly up?: Direction;
  /** Across `up`: where a wedge's slope faces, a sweep starts and a polygon's first flat side faces. */
  readonly forward?: Direction;
  /** Hollow: the wall's thickness, in source units. */
  readonly shell?: number;
  /** Limbs: the radius at the base, in source units. Unset: half the box's smallest side. */
  readonly radius?: number;
  /** Limbs: the radius at the tip, in source units. Unset: the same as at the base. */
  readonly tip?: number;
  /** Limbs: the corner of the box they grow from, 0 to 7 (bits: max x, max y, max z); they run to the opposite one. */
  readonly corner?: number;
  /** Paths: their points, in source units. A path's box is where they reach (see `pathBounds`). */
  readonly points?: readonly PathPoint[];
}

/**
 * Where a step acts: a solid inscribed in a box in source space, half-open, covering [min, max)
 * on each axis, sampled at cell centers (see `insideShape`).
 */
export interface StepShape extends ShapeOptions {
  readonly kind: ShapeKind;
  readonly min: Vec3;
  readonly max: Vec3;
}

/**
 * What a step does to the volume below it in its layer: add its shape, cut it out, keep only
 * what is inside it, or leave the volume alone and only recolor what is inside it.
 */
export type StepMode = "add" | "cut" | "intersect" | "paint";

export const STEP_MODES: readonly StepMode[] = ["add", "cut", "intersect", "paint"];

export type FillKind = "gradient" | "checker" | "stripes";

export const FILL_KINDS: readonly FillKind[] = ["gradient", "checker", "stripes"];

/**
 * A step's color varying with position, between its `material` and `to`, measured from its box's
 * min corner so the pattern moves with the shape:
 * - gradient: along `axis` across the box, through every palette slot from `material` to `to`
 *   (palettes keep ramps of a hue next to each other);
 * - checker: cubes `size` source units a side, alternating;
 * - stripes: slabs `size` thick across `axis`, alternating.
 */
export interface StepFill {
  readonly kind: FillKind;
  /** The second palette index. */
  readonly to: number;
  /** Gradient and stripes. */
  readonly axis?: Axis;
  /** Checker and stripes: the period's half, in source units. */
  readonly size?: number;
}

/** A fill in its canonical form: only the fields its kind takes. */
export function stepFill(kind: FillKind, to: number, options: { axis?: Axis; size?: number } = {}): StepFill {
  const axis = options.axis ?? 1;
  const size = options.size || 1;
  if (kind === "gradient") return { kind, to, axis };
  if (kind === "checker") return { kind, to, size };
  return { kind, to, axis, size };
}

/**
 * One step of a shape layer. Its shape and mode decide which cells are solid; its material
 * decides their color. Steps act on the steps below them in the same layer, never on other layers.
 */
export interface Step {
  readonly id: string;
  /** What the person called it. Unset: it goes by its mode and kind ("Cut sphere"). */
  readonly name?: string;
  readonly mode: StepMode;
  readonly shape: StepShape;
  /** The palette index the step's cells take. A cut doesn't use it, but keeps it for a later mode change. */
  readonly material: number;
  /** Vary the color with position, from `material` to the fill's `to`. Unset: one color. */
  readonly fill?: StepFill;
  /**
   * Keep the colors below where the step overlaps solid cells: an add only fills empty cells, and
   * an intersect leaves the colors it keeps alone. Cut and paint ignore it.
   */
  readonly keep?: boolean;
}

/** A shape layer's source: its steps, bottom first, each applied to the result of those below it. */
export interface ShapeSource {
  readonly steps: readonly Step[];
}

/** The finest output resolution, and the step coordinates snap to (1 / MAX_RESOLUTION). */
export const MAX_RESOLUTION = 8;
export const MAX_STEPS = 64;
/** How far outside the reference grid shape coordinates may reach, in source units. */
export const SOURCE_LIMIT = 1024;

const ID_PATTERN = /^[\w:.-]{1,64}$/;

export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

const fail = (message: string): never => {
  throw new SourceError(message);
};

// #region Resolution

export const isResolution = (n: unknown): n is number =>
  Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_RESOLUTION && ((n as number) & ((n as number) - 1)) === 0;

/** The resolutions offered for a grid: every power of two whose output still fits `maxSize` cells a side. */
export function resolutionChoices(size: Vec3, resolution: number, maxSize: number): number[] {
  const out: number[] = [];
  for (let m = 1; m <= MAX_RESOLUTION; m *= 2) {
    if (size.every((n) => (n * m) % resolution === 0 && (n * m) / resolution <= maxSize)) out.push(m);
  }
  return out;
}

// #endregion

// #region Coordinates

/** Whether a source coordinate sits on the 1 / MAX_RESOLUTION lattice. */
export const onLattice = (n: number) => Number.isFinite(n) && Number.isInteger(n * MAX_RESOLUTION);

/** Round a source coordinate to the lattice. */
export const snapSource = (n: number) => Math.round(n * MAX_RESOLUTION) / MAX_RESOLUTION;

/**
 * The output cells a half-open source span samples at `resolution`: `lo` inclusive to `hi`
 * exclusive. A cell is inside when its center is: `min <= (i + 0.5) / m < max`.
 */
export function spanCells(min: number, max: number, resolution: number): [number, number] {
  // + 0 turns ceil's -0 into 0
  return [Math.ceil(min * resolution - 0.5) + 0, Math.ceil(max * resolution - 0.5) + 0];
}

/**
 * The inclusive cell box a source box samples, unclipped. A box thinner than a cell can sample
 * nothing on an axis (`max < min` there).
 */
export function sourceToCells(box: { min: Vec3; max: Vec3 }, resolution: number): Box {
  const min: Vec3 = [0, 0, 0];
  const max: Vec3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const [lo, hi] = spanCells(box.min[a], box.max[a], resolution);
    min[a] = lo;
    max[a] = hi - 1;
  }
  return { min, max };
}

/** The source box whose faces lie on the boundaries of an inclusive cell box. */
export function cellsToSource(box: Box, resolution: number): { min: Vec3; max: Vec3 } {
  return {
    min: box.min.map((n) => n / resolution) as Vec3,
    max: box.max.map((n) => (n + 1) / resolution) as Vec3,
  };
}

/** A source box's exact outline in output-grid units (where cell `i` spans `[i, i + 1]`), as an inclusive box for drawing. */
export function sourceOutline(box: { min: Vec3; max: Vec3 }, resolution: number): Box {
  return {
    min: box.min.map((n) => n * resolution) as Vec3,
    max: box.max.map((n) => n * resolution - 1) as Vec3,
  };
}

// #endregion

// #region Stacks

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A new step id, unique within a layer with overwhelming likelihood. */
export function newStepId(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = "step:";
  for (const b of bytes) out += ALPHABET[b % 36];
  return out;
}

const UP: Direction = { axis: 1, sign: 1 };

/**
 * A shape in its canonical form: only the options its kind takes, `up` with sign + where only the
 * axis matters, `forward` across `up` (always for a wedge), and no zero or default setting (a
 * straight taper, a full sweep, a closed end); a prism's top or bottom radius whenever supplied.
 */
export function stepShape(kind: ShapeKind, min: Vec3, max: Vec3, options: ShapeOptions = {}): StepShape {
  // a box, cylinder, cone or pyramid named the old way (a cone's `top` its share of the base): the prism it is now
  const legacy = LEGACY_KINDS[kind as string];
  if (legacy) {
    const top = (options as { top?: number }).top;
    kind = "prism";
    options = { ...legacy, ...options, ...(top !== undefined && legacy.taper ? { taper: 1 - top } : {}) };
  } else if (!SHAPE_KINDS.includes(kind) && SHAPE_PRESET_IDS.includes(kind as unknown as ShapePreset)) {
    // a preset by name ("hexagon", "arch"): its kind, with its settings under the ones given
    const preset = presetShape(kind as unknown as ShapePreset);
    kind = preset.kind;
    options = { ...preset.params, ...options };
  }
  const shape: { -readonly [K in keyof StepShape]: StepShape[K] } = { kind, min: [...min], max: [...max] };
  const turns = shapeOrientations(kind);
  if (turns.length) {
    const up = options.up ?? UP;
    shape.up = { axis: up.axis, sign: turns.some((d) => d.sign < 0) ? up.sign : 1 };
    const f = options.forward;
    if (f && f.axis !== shape.up.axis) shape.forward = { axis: f.axis, sign: f.sign };
    else if (kind === "wedge") shape.forward = defaultForward(shape.up);
  }
  if (options.shell) {
    shape.shell = options.shell;
    if (kind !== "limb" && kind !== "diamond" && options.openTop) shape.openTop = true;
    if (kind !== "limb" && kind !== "diamond" && options.openBottom) shape.openBottom = true;
  }
  if (kind === "prism") {
    if (options.sides) shape.sides = options.sides;
    if (options.taper) shape.taper = options.taper;
    if (options.round) shape.round = options.round;
    // Keep explicit radii even when they match round: later changes to round must not reset them.
    if (options.roundTop !== undefined) shape.roundTop = options.roundTop;
    if (options.roundBottom !== undefined) shape.roundBottom = options.roundBottom;
  }
  if ((kind === "prism" || kind === "sphere" || kind === "torus") && options.sweep && options.sweep < 360) shape.sweep = options.sweep;
  if (kind === "torus" && options.tube) shape.tube = options.tube;
  if (kind === "limb") {
    if (options.radius) shape.radius = options.radius;
    if (options.tip !== undefined) shape.tip = options.tip;
    if (options.corner) shape.corner = options.corner;
  }
  if (kind === "path") {
    delete shape.up;
    delete shape.forward;
    delete shape.shell;
    delete shape.openTop;
    delete shape.openBottom;
    shape.points = (options.points ?? [{ at: [...min].map((n, a) => (n + max[a]) / 2) as Vec3 }]).map((p) => ({
      at: [...p.at] as Vec3,
      ...(p.radius !== undefined ? { radius: p.radius } : {}),
    }));
    const profile = options.profile ?? "tube";
    if (profile !== "tube") shape.profile = profile;
    if (options.smooth) shape.smooth = true;
    if (options.closed || profile === "slab") shape.closed = true;
    if (profile === "tube" && options.radius) shape.radius = options.radius;
    if (profile === "wall" && options.width) shape.width = options.width;
    if (profile !== "tube" && options.height) shape.height = options.height;
    // a path's box is where its points reach, not what was asked
    const bounds = pathBounds(shape);
    shape.min = bounds.min;
    shape.max = bounds.max;
  }
  return shape;
}

/** A path from anywhere, checked: its points, profile and sizes. Its box is worked out from them. */
function checkPath(shape: Record<string, unknown>): StepShape {
  const { points, profile, smooth, closed, radius, width, height } = shape;
  if (!Array.isArray(points) || points.length === 0) fail("A path needs at least one point");
  if ((points as unknown[]).length > MAX_PATH_POINTS) fail(`A path has at most ${MAX_PATH_POINTS} points`);
  const checked = (points as unknown[]).map((raw): PathPoint => {
    const p = raw as Record<string, unknown>;
    if (!p || typeof p !== "object" || !isVec3(p.at)) fail("A path's point is { at: [x, y, z], radius? }");
    const at = p.at as Vec3;
    if (!at.every((n) => onLattice(n) && Math.abs(n) <= SOURCE_LIMIT)) fail(`A path's points are multiples of 1/${MAX_RESOLUTION}, inside the model's reach`);
    if (p.radius !== undefined && (typeof p.radius !== "number" || !onLattice(p.radius) || p.radius <= 0 || p.radius > SOURCE_LIMIT)) {
      fail(`A point's radius is a size, a multiple of 1/${MAX_RESOLUTION}`);
    }
    return { at, ...(p.radius !== undefined ? { radius: p.radius as number } : {}) };
  });
  if (profile !== undefined && !PATH_PROFILES.includes(profile as never)) fail(`A path's profile is ${PATH_PROFILES.join(", ")}`);
  for (const [name, b] of [["smooth", smooth], ["closed", closed]] as const) {
    if (b !== undefined && typeof b !== "boolean") fail(`A path's ${name} is true or false`);
  }
  for (const [name, n] of [["radius", radius], ["width", width], ["height", height]] as const) {
    if (n === undefined) continue;
    if (typeof n !== "number" || !onLattice(n) || n < 0 || n > SOURCE_LIMIT) fail(`A path's ${name} is a size, a multiple of 1/${MAX_RESOLUTION}`);
  }
  if (profile === "slab" && checked.length < 3) fail("A slab needs at least three points");
  return stepShape("path", [0, 0, 0], [1, 1, 1], { ...(shape as ShapeOptions), points: checked });
}

/** A shape with new options (unset in `change` keeps the old value; 0 clears a number), back in canonical form. */
export function reshape(shape: StepShape, change: ShapeOptions & { kind?: ShapeKind; min?: Vec3; max?: Vec3 }): StepShape {
  // a path's box follows its points: a new box moves and scales the points into it
  if (shape.kind === "path" && (change.kind ?? "path") === "path" && !change.points && (change.min || change.max)) {
    change = { ...change, points: fitPath(shape, change.min ?? shape.min, change.max ?? shape.max) };
  }
  return stepShape(change.kind ?? shape.kind, change.min ?? shape.min, change.max ?? shape.max, { ...shape, ...change });
}

/**
 * A path's points moved and scaled so its box becomes `min`-`max`: on each axis, the span its
 * points cover (its box less the margin its radius or width adds) maps onto the same span of the
 * new box, snapped to the lattice. A span of nothing (a flat path) just moves.
 */
export function fitPath(shape: StepShape, min: Vec3, max: Vec3): PathPoint[] {
  const points = shape.points ?? [];
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let a = 0; a < 3; a++) {
    lo[a] = Math.min(lo[a], p.at[a]);
    hi[a] = Math.max(hi[a], p.at[a]);
  }
  const map = (v: number, a: number) => {
    const padLo = lo[a] - shape.min[a];
    const padHi = shape.max[a] - hi[a];
    const from = hi[a] - lo[a];
    const to = Math.max(0, max[a] - padHi - (min[a] + padLo));
    return snapSource(from > 0 ? min[a] + padLo + ((v - lo[a]) * to) / from : v + (min[a] - shape.min[a]));
  };
  return points.map((p) => ({ ...p, at: p.at.map(map) as Vec3 }));
}

export const boxShape = (min: Vec3, max: Vec3): StepShape => stepShape("prism", min, max, { sides: 4 });

export function boxStep(
  min: Vec3,
  max: Vec3,
  material: number,
  mode: StepMode = "add",
  options: ShapeOptions & { id?: string; keep?: boolean; kind?: ShapeKind } = {},
): Step {
  return {
    id: options.id ?? newStepId(),
    mode,
    shape: stepShape(options.kind ?? "prism", min, max, options.kind ? options : { sides: 4, ...options }),
    material,
    ...(options.keep ? { keep: true } : {}),
  };
}

export const findStep = (source: ShapeSource, id: string): Step | null => source.steps.find((s) => s.id === id) ?? null;

/** A copy of the source with step `id` changed by `change` (or the source itself if it isn't there or doesn't change). */
export function updateStep(source: ShapeSource, id: string, change: (step: Step) => Step): ShapeSource {
  let changed = false;
  const steps = source.steps.map((s) => {
    if (s.id !== id) return s;
    const next = change(s);
    if (next !== s) changed = true;
    return next;
  });
  return changed ? { steps } : source;
}

/** A copy of the source with every step's materials (its own and its fill's) passed through `map`. */
export function mapMaterials(source: ShapeSource, map: (material: number) => number): ShapeSource {
  let changed = false;
  const steps = source.steps.map((s) => {
    const material = map(s.material);
    const to = s.fill && map(s.fill.to);
    if (material === s.material && to === s.fill?.to) return s;
    changed = true;
    return { ...s, material, ...(s.fill ? { fill: { ...s.fill, to: to! } } : {}) };
  });
  return changed ? { steps } : source;
}

export const translateShape = (shape: StepShape, delta: Vec3): StepShape => ({
  ...shape,
  min: shape.min.map((n, a) => n + delta[a]) as Vec3,
  max: shape.max.map((n, a) => n + delta[a]) as Vec3,
  ...(shape.points ? { points: shape.points.map((p) => ({ ...p, at: p.at.map((n, a) => n + delta[a]) as Vec3 })) } : {}),
});

/** A copy of the source moved by `delta` source units. */
export function translateSource(source: ShapeSource, delta: Vec3): ShapeSource {
  return { steps: source.steps.map((s) => ({ ...s, shape: translateShape(s.shape, delta) })) };
}

export function sourceMaterials(source: ShapeSource): Set<number> {
  return new Set(source.steps.flatMap((s) => (s.fill ? [s.material, s.fill.to] : [s.material])));
}

// #endregion

// #region Validation

const isVec3 = (v: unknown): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

export function checkShapeOf(raw: unknown): StepShape {
  if (!raw || typeof raw !== "object") fail("A step needs a shape");
  let shape = raw as Record<string, unknown>;
  // a box, cylinder, cone or pyramid from before prisms: the prism it is now
  const legacy = typeof shape.kind === "string" ? LEGACY_KINDS[shape.kind] : undefined;
  if (legacy) {
    const { top, ...rest } = shape;
    if (top !== undefined && (typeof top !== "number" || !onLattice(top) || top < 0 || top >= 1)) {
      fail(`A shape's top is 0 up to 1, in steps of 1/${MAX_RESOLUTION}`);
    }
    const taper = legacy.taper ? 1 - ((top as number | undefined) ?? 0) : undefined;
    // a box had no direction; it stood up +y
    shape = { up: UP, ...rest, kind: "prism", ...legacy, ...(taper !== undefined ? { taper } : {}) };
  }
  const kind = shape.kind as ShapeKind;
  if (!SHAPE_KINDS.includes(kind)) fail(`Unknown shape ${String(shape.kind)}`);
  if (kind === "path") return checkPath(shape);
  const { min, max, up, forward, shell, round, roundTop, roundBottom, radius, tip, corner, sides, taper, tube, sweep, openTop, openBottom } = shape;
  if (!isVec3(min) || !isVec3(max)) fail("A shape needs min and max corners, [x, y, z]");
  for (const [name, d] of [["up", up], ["forward", forward]] as const) {
    if (d === undefined) continue;
    const dir = d as Record<string, unknown>;
    if (!dir || typeof dir !== "object" || ![0, 1, 2].includes(dir.axis as number) || (dir.sign !== 1 && dir.sign !== -1)) {
      fail(`A shape's ${name} is { axis: 0, 1 or 2, sign: 1 or -1 }`);
    }
  }
  if (kind === "wedge" && forward !== undefined && (forward as Direction).axis === ((up as Direction | undefined)?.axis ?? 1)) {
    fail("A wedge's forward must be across its up");
  }
  for (const [name, n] of [["shell", shell], ["round", round], ["roundTop", roundTop], ["roundBottom", roundBottom], ["radius", radius], ["tip", tip], ["tube", tube]] as const) {
    if (n === undefined) continue;
    if (typeof n !== "number" || !onLattice(n) || n < 0 || n > SOURCE_LIMIT) fail(`A shape's ${name} is a size, a multiple of 1/${MAX_RESOLUTION}`);
  }
  if (corner !== undefined && !(Number.isInteger(corner) && (corner as number) >= 0 && (corner as number) <= 7)) fail("A limb's corner is 0 to 7");
  if (sides !== undefined && sides !== 0 && !(Number.isInteger(sides) && (sides as number) >= 3 && (sides as number) <= 12)) {
    fail("A prism's sides are 3 to 12 (or 0, round)");
  }
  if (taper !== undefined && (typeof taper !== "number" || !onLattice(taper) || taper < 0 || taper > 1)) {
    fail(`A prism's taper is 0 to 1, in steps of 1/${MAX_RESOLUTION}`);
  }
  if (sweep !== undefined && !(Number.isInteger(sweep) && (sweep as number) >= 15 && (sweep as number) <= 360 && (sweep as number) % 15 === 0)) {
    fail("A sweep is 15 to 360 degrees, in steps of 15");
  }
  for (const [name, b] of [["openTop", openTop], ["openBottom", openBottom]] as const) {
    if (b !== undefined && typeof b !== "boolean") fail(`A shape's ${name} is true or false`);
  }
  const lo = min as Vec3;
  const hi = max as Vec3;
  for (let a = 0; a < 3; a++) {
    if (!onLattice(lo[a]) || !onLattice(hi[a])) fail(`Shape corners must be multiples of 1/${MAX_RESOLUTION}`);
    if (Math.abs(lo[a]) > SOURCE_LIMIT || Math.abs(hi[a]) > SOURCE_LIMIT) fail("A shape reaches too far outside the model");
    if (hi[a] <= lo[a]) fail("A shape must have some size on every axis");
  }
  return stepShape(kind, lo, hi, shape as ShapeOptions);
}

function checkFill(raw: unknown, paletteLength: number): StepFill {
  if (!raw || typeof raw !== "object") fail("A step's fill must be an object");
  const { kind, to, axis, size } = raw as Record<string, unknown>;
  if (!FILL_KINDS.includes(kind as FillKind)) fail(`Unknown fill ${String(kind)}`);
  if (!Number.isInteger(to) || (to as number) < 1 || (to as number) >= paletteLength) fail("A fill's second color must be in the palette");
  if (axis !== undefined && ![0, 1, 2].includes(axis as number)) fail("A fill's axis is 0, 1 or 2");
  if (size !== undefined && (typeof size !== "number" || !onLattice(size) || size <= 0 || size > SOURCE_LIMIT)) {
    fail(`A fill's size is more than 0, a multiple of 1/${MAX_RESOLUTION}`);
  }
  return stepFill(kind as FillKind, to as number, { axis: axis as Axis | undefined, size: size as number | undefined });
}

/**
 * Check a shape source from anywhere (a file, a script, an op) and return a clean copy of it:
 * known fields only, coordinates on the lattice, materials in the palette, distinct ids, and a
 * bounded number of steps. Throws a `SourceError` saying what is wrong.
 */
/** The longest a step's name can be. */
export const MAX_STEP_NAME = 64;

/** A step's name, trimmed; empty means none. */
export function checkStepName(raw: unknown): string | undefined {
  if (typeof raw !== "string") fail("A step's name is text");
  const name = (raw as string).trim();
  if (name.length > MAX_STEP_NAME) fail(`A step's name is at most ${MAX_STEP_NAME} characters`);
  return name || undefined;
}

export function checkSource(input: unknown, paletteLength: number): ShapeSource {
  if (!input || typeof input !== "object" || !Array.isArray((input as { steps?: unknown }).steps)) {
    fail("A shape needs a list of steps");
  }
  const raw = (input as { steps: unknown[] }).steps;
  if (raw.length > MAX_STEPS) fail(`A shape can have at most ${MAX_STEPS} steps`);
  const ids = new Set<string>();
  const steps = raw.map((r): Step => {
    if (!r || typeof r !== "object") fail("A step must be an object");
    const step = r as Record<string, unknown>;
    const { id, mode, material, keep } = step;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) fail("A step needs a valid id");
    if (ids.has(id as string)) fail("Two steps share an id");
    ids.add(id as string);
    if (typeof mode !== "string" || !STEP_MODES.includes(mode as StepMode)) fail(`Unknown step mode ${String(mode)}`);
    if (!Number.isInteger(material) || (material as number) < 1 || (material as number) >= paletteLength) {
      fail("A step's color must be in the palette");
    }
    if (keep !== undefined && typeof keep !== "boolean") fail("A step's keep is true or false");
    const name = step.name === undefined ? undefined : checkStepName(step.name);
    const fill = step.fill === undefined ? undefined : checkFill(step.fill, paletteLength);
    return {
      id: id as string,
      ...(name ? { name } : {}),
      mode: mode as StepMode,
      shape: checkShapeOf(step.shape),
      material: material as number,
      ...(fill ? { fill } : {}),
      ...(keep ? { keep: true } : {}),
    };
  });
  return { steps };
}

const sameDirection = (a?: Direction, b?: Direction) => a?.axis === b?.axis && a?.sign === b?.sign;

const sameShape = (a: StepShape, b: StepShape) =>
  a.kind === b.kind &&
  a.min.every((n, i) => n === b.min[i]) &&
  a.max.every((n, i) => n === b.max[i]) &&
  sameDirection(a.up, b.up) &&
  sameDirection(a.forward, b.forward) &&
  a.shell === b.shell &&
  a.round === b.round &&
  a.roundTop === b.roundTop &&
  a.roundBottom === b.roundBottom &&
  a.radius === b.radius &&
  a.tip === b.tip &&
  a.corner === b.corner &&
  a.sides === b.sides &&
  a.taper === b.taper &&
  a.tube === b.tube &&
  a.sweep === b.sweep &&
  !a.openTop === !b.openTop &&
  !a.openBottom === !b.openBottom &&
  a.profile === b.profile &&
  !a.smooth === !b.smooth &&
  !a.closed === !b.closed &&
  a.width === b.width &&
  a.height === b.height &&
  samePoints(a.points, b.points);

const samePoints = (a?: readonly PathPoint[], b?: readonly PathPoint[]) =>
  a === b ||
  (!!a && !!b && a.length === b.length && a.every((p, i) => p.radius === b[i].radius && p.at.every((n, k) => n === b[i].at[k])));

const sameFill = (a?: StepFill, b?: StepFill) =>
  a === b || (!!a && !!b && a.kind === b.kind && a.to === b.to && a.axis === b.axis && a.size === b.size);

export const sameStep = (a: Step, b: Step) =>
  a === b ||
  (a.id === b.id &&
    a.name === b.name &&
    a.mode === b.mode &&
    a.material === b.material &&
    !a.keep === !b.keep &&
    sameFill(a.fill, b.fill) &&
    sameShape(a.shape, b.shape));

export function sameSource(a: ShapeSource, b: ShapeSource): boolean {
  return a === b || (a.steps.length === b.steps.length && a.steps.every((s, i) => sameStep(s, b.steps[i])));
}

// #endregion
