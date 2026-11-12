import { raycastVolume } from "./raycast";
import type { Axis, Box, Ray, Vec3 } from "./types";

/**
 * What a shape is. A prism is any extruded cross-section (round or 3 to 12 sides), straight or
 * tapering to a point: boxes, cylinders, cones, pyramids and frustums are all prisms.
 */
export type ShapeKind = "prism" | "sphere" | "capsule" | "wedge" | "diamond" | "torus" | "limb" | "path";

export const SHAPE_KINDS: readonly ShapeKind[] = ["prism", "sphere", "capsule", "wedge", "diamond", "torus", "limb", "path"];

/** What a path makes along its points: a round tube, a wall standing on them, or (closed) a slab filling them. */
export type PathProfile = "tube" | "wall" | "slab";

export const PATH_PROFILES: readonly PathProfile[] = ["tube", "wall", "slab"];

/** A point of a path, in the shape's units, and (tubes) its own radius. */
export interface PathPoint {
  readonly at: Vec3;
  readonly radius?: number;
}

/** The most points a path has. */
export const MAX_PATH_POINTS = 64;

/** The settings a shape takes besides its box and orientation; each is unset where its kind doesn't take it. */
export interface ShapeParams {
  /** Prisms: the cross-section's sides, 3 to 12, filling the box. Unset: round. */
  sides?: number;
  /** Prisms: how much the top shrinks toward the axis, 0 (unset: straight) to 1 (a point), in 1/8 steps. */
  taper?: number;
  /** Straight prisms: the radius their edges are rounded with (a box's every edge; a cylinder's rims). */
  round?: number;
  /** Straight prisms: the top edges' radius instead of `round`; 0 keeps them sharp. */
  roundTop?: number;
  /** Straight prisms: the bottom edges' radius instead of `round`. */
  roundBottom?: number;
  /** Tori: the tube's radius across the ring, so its thickness and the hole are set apart. Unset: half its height. */
  tube?: number;
  /** Prisms, spheres and tori: how far round they go from `forward`, turning about `up`, in degrees, a multiple of 15. Unset: 360. */
  sweep?: number;
  /** A hollow shape (`shell`) has no wall on top: a cup, a bowl. */
  openTop?: boolean;
  /** A hollow shape has no wall at the bottom; with `openTop`, a pipe. */
  openBottom?: boolean;
  /** Paths: what they make along their points. Unset: a tube. */
  profile?: PathProfile;
  /** Paths: a smooth curve through the points (centripetal Catmull-Rom) rather than straight lines. */
  smooth?: boolean;
  /** Paths: the last point joins the first. A slab is always closed. */
  closed?: boolean;
  /** Walls: how thick, across the path. */
  width?: number;
  /** Walls and slabs: how tall, up from the path. */
  height?: number;
}

/** The shapes people pick: each kind, and the prisms and tori they know by name. */
export type ShapePreset =
  | "box"
  | "cylinder"
  | "cone"
  | "pyramid"
  | "hexagon"
  | "sphere"
  | "capsule"
  | "wedge"
  | "diamond"
  | "torus"
  | "arch"
  | "limb"
  | "tube"
  | "wall"
  | "slab";

export const SHAPE_PRESETS: readonly { id: ShapePreset; kind: ShapeKind; params: ShapeParams }[] = [
  { id: "box", kind: "prism", params: { sides: 4 } },
  { id: "cylinder", kind: "prism", params: {} },
  { id: "cone", kind: "prism", params: { taper: 1 } },
  { id: "pyramid", kind: "prism", params: { sides: 4, taper: 1 } },
  { id: "hexagon", kind: "prism", params: { sides: 6 } },
  { id: "sphere", kind: "sphere", params: {} },
  { id: "capsule", kind: "capsule", params: {} },
  { id: "wedge", kind: "wedge", params: {} },
  { id: "diamond", kind: "diamond", params: {} },
  { id: "torus", kind: "torus", params: {} },
  { id: "arch", kind: "torus", params: { sweep: 180 } },
  { id: "limb", kind: "limb", params: {} },
  { id: "tube", kind: "path", params: {} },
  { id: "wall", kind: "path", params: { profile: "wall" } },
  { id: "slab", kind: "path", params: { profile: "slab", closed: true } },
];

/** Presets drawn as paths (a point per tap) rather than boxes. */
export const isPathPreset = (id: ShapePreset) => presetEntry(id).kind === "path";

export const SHAPE_PRESET_IDS: readonly ShapePreset[] = SHAPE_PRESETS.map((p) => p.id);

/**
 * What changes a shape into a preset (or a kind's plain form): its kind and the settings that
 * define the preset, 0 clearing those it doesn't set, so a box made a cylinder loses its sides.
 */
export function presetChange(id: ShapePreset | ShapeKind): { kind: ShapeKind } & ShapeParams {
  const { kind, params } = presetShape(id);
  const path = kind === "path" ? { profile: params.profile ?? "tube", closed: !!params.closed } : {};
  return { kind, sides: params.sides ?? 0, taper: params.taper ?? 0, sweep: params.sweep ?? 0, ...path };
}

/** A preset's entry in SHAPE_PRESETS (the same object every time, so it can be compared). */
export function presetEntry(id: ShapePreset): (typeof SHAPE_PRESETS)[number] {
  return SHAPE_PRESETS.find((p) => p.id === id) ?? SHAPE_PRESETS[0];
}

/** A preset's kind and settings; a kind's own name gives its plain form ("prism" is a box). */
export function presetShape(id: ShapePreset | ShapeKind): { kind: ShapeKind; params: ShapeParams } {
  const preset = SHAPE_PRESETS.find((p) => p.id === id) ?? (id === "prism" ? SHAPE_PRESETS[0] : SHAPE_PRESETS.find((p) => p.kind === id));
  if (!preset) throw new Error(`Unknown shape ${id}`);
  return { kind: preset.kind, params: { ...preset.params } };
}

/**
 * The preset a shape is, if it is one: what its kind and its defining settings (sides, taper,
 * sweep) match. Size settings such as rounding or a wall don't matter: a rounded box is a box.
 */
export function presetOf(kind: ShapeKind, params: ShapeParams = {}): ShapePreset | null {
  const sweep = params.sweep ?? 360;
  const match = SHAPE_PRESETS.find(
    (p) =>
      p.kind === kind &&
      (p.params.sides ?? 0) === (params.sides ?? 0) &&
      (p.params.taper ?? 0) === (params.taper ?? 0) &&
      (p.params.sweep ?? 360) === sweep &&
      (p.params.profile ?? "tube") === (params.profile ?? "tube"),
  );
  if (match) return match.id;
  // part of a ring is an arch however far round it goes
  if (kind === "torus") return "arch";
  return null;
}

const PRESET_NAMES: Record<ShapePreset, string> = {
  box: "Box",
  cylinder: "Cylinder",
  cone: "Cone",
  pyramid: "Pyramid",
  hexagon: "Hex prism",
  sphere: "Sphere",
  capsule: "Capsule",
  wedge: "Wedge",
  diamond: "Diamond",
  torus: "Torus",
  arch: "Arch",
  limb: "Limb",
  tube: "Tube",
  wall: "Wall",
  slab: "Slab",
};

/** What to call a shape: its preset's name, or what it is ("6-sided pyramid", "Frustum"). */
export function shapeName(kind: ShapeKind, params: ShapeParams = {}): string {
  const preset = presetOf(kind, params);
  if (preset) return PRESET_NAMES[preset];
  if (kind !== "prism") return PRESET_NAMES[kind as ShapePreset] ?? kind;
  const taper = params.taper ?? 0;
  if (taper > 0 && taper < 1) return "Frustum";
  const sides = params.sides;
  if (!sides) return taper ? "Cone" : "Cylinder";
  return taper ? `${sides}-sided pyramid` : `${sides}-sided prism`;
}

/** A shape's own settings, without its box, orientation or sizes for other kinds. */
export function paramsOf(shape: ShapeParams): ShapeParams {
  const { sides, taper, round, roundTop, roundBottom, tube, sweep, openTop, openBottom, profile, smooth, closed, width, height } = shape;
  const out: ShapeParams = { sides, taper, round, roundTop, roundBottom, tube, sweep, openTop, openBottom, profile, smooth, closed, width, height };
  for (const key of Object.keys(out) as (keyof ShapeParams)[]) if (out[key] === undefined) delete out[key];
  return out;
}

/**
 * The kinds shapes had before prisms, and what they are now: models saved then, and agents that
 * still say "box", get the same shape. A cone's or pyramid's old `top` (its share of the base) is
 * `1 - taper`.
 */
export const LEGACY_KINDS: Readonly<Record<string, ShapeParams>> = {
  box: { sides: 4 },
  cylinder: {},
  cone: { taper: 1 },
  pyramid: { sides: 4, taper: 1 },
};

/**
 * A solid given with an old kind ("box", "cone", ...; a cone's or pyramid's `top`) as the prism it
 * is now, so scripts written before prisms still draw what they did.
 */
function upToDate<T extends { kind: ShapeKind; params?: ShapeParams }>(spec: T): T {
  const legacy = LEGACY_KINDS[spec.kind as string];
  if (!legacy) return spec;
  const old = spec as T & { top?: number };
  const taper = legacy.taper ? 1 - (old.top ?? 0) : undefined;
  const params = { ...legacy, ...(taper !== undefined ? { taper } : {}) };
  // a solid takes its settings directly, a brush's spec in `params`: give both
  return { ...spec, kind: "prism", ...params, params: { ...spec.params, ...params } };
}

/** A kind, the old names ("box", "cone", ...) read as the prisms they are now. */
const kindOf = (kind: ShapeKind): ShapeKind => (LEGACY_KINDS[kind as string] ? "prism" : kind);

export interface Direction {
  axis: Axis;
  sign: 1 | -1;
}

/**
 * A solid inscribed in the box `[min, max)`, in any units (cells for the brush, source units for
 * shape layers), and the options only some kinds take. Unset options mean the plain shape.
 */
export interface SolidSpec extends ShapeParams {
  kind: ShapeKind;
  min: Vec3;
  max: Vec3;
  /** Where the shape points (see `ShapeSpec.up`). Defaults to +y. */
  up?: Direction;
  /**
   * Across `up`: a wedge's slope faces this way (it is full height at the opposite side), and a
   * swept shape starts here, as does a polygon's first flat side. Defaults to `defaultForward(up)`.
   */
  forward?: Direction;
  /** Keep only a wall this thick: what is inside the same shape, inset by it on every side, is empty. */
  shell?: number;
  /** A path's points. */
  points?: readonly PathPoint[];
  /** A limb's radius at its base. Defaults to half the box's smallest side. */
  radius?: number;
  /** A limb's radius at its tip. Defaults to `radius`. */
  tip?: number;
  /** The box corner a limb grows from (see `limbEnds`); it runs to the opposite one. Defaults to 0, the min corner. */
  corner?: number;
}

/** Which way a wedge faces when nothing says: along the next axis after `up`'s, skipping y so an upright wedge faces +z. */
export function defaultForward(up: Direction): Direction {
  return { axis: up.axis === 0 ? 2 : up.axis === 1 ? 2 : 0, sign: 1 };
}

/**
 * A solid shape inscribed in a box of cells. Every shape is fully defined by its box
 * and orientation, so even sizes (with no center voxel) work like odd ones.
 */
export interface ShapeSpec {
  kind: ShapeKind;
  /** Inclusive cell range the shape fills. */
  box: Box;
  /** Where the shape points: the pyramid's and cone's apex; the cylinder's, capsule's and torus's axis. */
  up: Direction;
  /** Keep only a one-voxel shell. */
  hollow?: boolean;
  /** Limbs: the corner they grow from, the radius there and at the tip, in cells (as `SolidSpec`'s). */
  corner?: number;
  radius?: number;
  tip?: number;
  /** Wedges: the way the slope faces (see `SolidSpec.forward`). */
  forward?: Direction;
  /** The kind's settings: a prism's sides and taper, a sweep, ... (see `ShapeParams`), in cells. */
  params?: ShapeParams;
}

/** A shape being placed: its box sits on the surface it was drawn on. */
export interface ShapeDraft {
  box: Box;
  up: Direction;
  /** The direction the shape was pulled out of the surface; its base face is on the opposite side. */
  grow: Direction;
  /** Wedges: the way the slope faces, once the draft has been turned. Unset: `defaultForward(up)`. */
  forward?: Direction;
}

/** A face of the shape's box that a handle drags along its axis: "max-1" is the top, "min-1" the bottom. */
export type ShapeHandle = `${"min" | "max"}-${0 | 1 | 2}`;

/** A handle that sets one of a shape's settings by dragging along a world axis (see `paramHandles`). */
export type ParamHandleId = "param-taper" | "param-round" | "param-tube" | "param-shell" | PathHandleId;

/** A path's point to drag (`point-2`), or the middle of a segment, where a tap adds a point (`insert-2` goes in as point 2). */
export type PathHandleId = `point-${number}` | `insert-${number}`;

/** A path's handles, in the shape's units: one per point, and one in the middle of each segment (closing one too). */
export function pathHandles(spec: Pick<SolidSpec, "points" | "closed" | "profile">): { id: PathHandleId; point: Vec3 }[] {
  const points = spec.points ?? [];
  const handles: { id: PathHandleId; point: Vec3 }[] = points.map((p, i) => ({ id: `point-${i}` as PathHandleId, point: [...p.at] as Vec3 }));
  const closed = !!(spec.closed || spec.profile === "slab") && points.length > 2;
  const segments = closed ? points.length : points.length - 1;
  for (let i = 0; i < segments; i++) {
    const a = points[i].at;
    const b = points[(i + 1) % points.length].at;
    handles.push({ id: `insert-${i + 1}` as PathHandleId, point: a.map((n, k) => (n + b[k]) / 2) as Vec3 });
  }
  return handles;
}

export interface ParamHandle {
  id: ParamHandleId;
  /** Where it is, in the shape's units. */
  point: Vec3;
  /** Which way dragging it makes `distance` grow. */
  along: Direction;
  /** How far it is from where `settingAt(0)` would put it, along `along`. */
  distance: number;
  /** The setting a handle this far along gives. */
  settingAt: (distance: number) => ShapeParams & { shell?: number };
}

/**
 * Handles on the canvas for a shape's settings, each dragged along a world axis: a prism's taper
 * (on its top rim, where `forward` points) and its top edges' radius (on the rim a quarter turn
 * round), a torus's tube (its inner edge), and a hollow shape's wall (the inside of its back wall).
 * Sizes are in the shape's units; `settingAt` doesn't snap them.
 */
export function paramHandles(spec: SolidSpec): ParamHandle[] {
  const { min, max } = spec;
  const up = spec.up ?? { axis: 1, sign: 1 };
  const a = up.axis;
  const { f, g } = crossFrame(spec);
  const center = [0, 1, 2].map((n) => (min[n] + max[n]) / 2) as Vec3;
  const top = up.sign > 0 ? max[a] : min[a];
  /** A point on the axis at `height` (the top, or the middle), `out` from it toward `dir`. */
  const at = (height: number, dir: Direction, out: number) => {
    const p = [...center] as Vec3;
    p[a] = height;
    p[dir.axis] += dir.sign * out;
    return p;
  };
  const half = (d: Direction) => (max[d.axis] - min[d.axis]) / 2;
  const handles: ParamHandle[] = [];
  if (spec.kind === "prism") {
    const hf = half(f);
    const taper = spec.taper ?? 0;
    handles.push({
      id: "param-taper",
      point: at(top, f, hf * (1 - taper)),
      along: f,
      distance: hf * (1 - taper),
      settingAt: (d) => ({ taper: Math.min(1, Math.max(0, 1 - d / hf)) }),
    });
    const sides = spec.sides ?? 0;
    if (!taper && (sides === 0 || sides === 4)) {
      const hg = half(g);
      const r = spec.roundTop ?? spec.round ?? 0;
      // pulling in from the edge rounds it more
      handles.push({
        id: "param-round",
        point: at(top, g, hg - r),
        along: { axis: g.axis, sign: (-g.sign) as 1 | -1 },
        distance: r,
        settingAt: (d) => (spec.roundTop !== undefined ? { roundTop: Math.max(0, d) } : { round: Math.max(0, d) }),
      });
    }
  }
  if (spec.kind === "torus") {
    const ring = half(f);
    const tube = Math.min(spec.tube ?? (max[a] - min[a]) / 2, ring);
    handles.push({
      id: "param-tube",
      point: at(center[a], f, ring - 2 * tube),
      along: { axis: f.axis, sign: (-f.sign) as 1 | -1 },
      distance: 2 * tube,
      settingAt: (d) => ({ tube: Math.max(1 / 8, d / 2) }),
    });
  }
  if (spec.shell && spec.kind !== "limb") {
    const back: Direction = { axis: f.axis, sign: (-f.sign) as 1 | -1 };
    const hb = half(back);
    handles.push({
      id: "param-shell",
      point: at(center[a], back, hb - spec.shell),
      along: f,
      distance: spec.shell,
      settingAt: (d) => ({ shell: Math.max(0, d) }),
    });
  }
  return handles;
}

const EPS = 1e-9;

/**
 * A box with rounded edges along its `up` axis (`round`) and around its top and bottom faces
 * (`roundTop`, `roundBottom`, each `round` when unset), measured in the box's own frame: "top" is
 * the face `up` points through.
 */
function roundedBox(spec: SolidSpec, ext: Vec3, mid: Vec3): (p: Vec3) => boolean {
  const up = spec.up ?? UP;
  const a = up.axis;
  const [h1, h2] = ([0, 1, 2] as Axis[]).filter((n) => n !== a);
  const half = Math.min(ext[h1], ext[h2]) / 2;
  const side = Math.min(spec.round ?? 0, half);
  let top = Math.min(spec.roundTop ?? spec.round ?? 0, half);
  let bottom = Math.min(spec.roundBottom ?? spec.round ?? 0, half);
  // the two bands share the height, each keeping its share of what they ask for
  if (top + bottom > ext[a]) {
    const scale = ext[a] / (top + bottom);
    top *= scale;
    bottom *= scale;
  }
  const hx = ext[h1] / 2 - side;
  const hz = ext[h2] / 2 - side;
  const yTop = ext[a] - top;
  const ss = side * side;
  return (p) => {
    // how far past the rectangle shrunk by `side` the point is, on each axis across `up`
    const ax = Math.abs(p[h1] - mid[h1] / 2) - hx;
    const az = Math.abs(p[h2] - mid[h2] / 2) - hz;
    const ox = ax > 0 ? ax : 0;
    const oz = az > 0 ? az : 0;
    const out = ox * ox + oz * oz;
    // how far up from the base
    const y = up.sign > 0 ? p[a] - spec.min[a] : spec.max[a] - p[a];
    const r = y > yTop ? top : y < bottom ? bottom : 0;
    if (!r) return out <= ss * (1 + EPS);
    // in a rounded band: the distance in from the plan's outline, and how far up (or down) the band
    const d = Math.sqrt(out) + Math.min(Math.max(ax, az), 0) - side;
    const q = d + r;
    const t = y > yTop ? y - yTop : bottom - y;
    return (q > 0 ? q * q : 0) + t * t <= r * r * (1 + EPS);
  };
}

const sq = (n: number) => n * n;

/** A limb's line: its base and tip centers and their radii, in the box's units. */
export interface LimbEnds {
  from: Vec3;
  to: Vec3;
  radius: number;
  tip: number;
}

/**
 * Where a limb runs in its box: from the corner `corner` names (bit 0 set: max x, bit 1: max y,
 * bit 2: max z) to the opposite one. Both ends are pulled in from their corners by the thicker
 * end's radius, as far as half the box on each axis, so the rounded ends stay inside and a
 * tapered limb in an upright box stands straight (its thin end stops short of the box by the
 * difference). A longer, flatter box leans it over. The radii are kept within half the box's
 * smallest side.
 */
export function limbEnds(spec: Pick<SolidSpec, "min" | "max" | "radius" | "tip" | "corner">): LimbEnds {
  const { min, max } = spec;
  const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const most = Math.min(ext[0], ext[1], ext[2]) / 2;
  const radius = Math.min(spec.radius ?? most, most);
  const tip = Math.min(spec.tip ?? radius, most);
  const corner = spec.corner ?? 0;
  const from = [0, 0, 0] as Vec3;
  const to = [0, 0, 0] as Vec3;
  for (let a = 0; a < 3; a++) {
    const high = (corner >> a) & 1;
    // in from both ends by the thicker radius, but never past the middle
    const inset = Math.min(Math.max(radius, tip), ext[a] / 2);
    from[a] = high ? max[a] - inset : min[a] + inset;
    to[a] = high ? min[a] + inset : max[a] - inset;
  }
  return { from, to, radius, tip };
}

/** Inside a limb: a tube along its line, its radius going from base to tip, with rounded ends. */
function limbTest({ from, to, radius, tip }: LimbEnds): (p: Vec3) => boolean {
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  return (p) => {
    const w0 = p[0] - from[0], w1 = p[1] - from[1], w2 = p[2] - from[2];
    let t = len2 > 0 ? (w0 * d[0] + w1 * d[1] + w2 * d[2]) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const r = radius + (tip - radius) * t;
    return sq(w0 - d[0] * t) + sq(w1 - d[1] * t) + sq(w2 - d[2] * t) <= r * r * (1 + EPS);
  };
}

// #region Paths

/** Segments per span of a smooth path. */
const PATH_SAMPLES = 8;

/** A path's tube radius where a point has none of its own. */
export const DEFAULT_PATH_RADIUS = 1;
/** A wall's width and a wall's or slab's height when unset. */
export const DEFAULT_PATH_WIDTH = 1;
export const DEFAULT_PATH_HEIGHT = 4;

/**
 * The polyline a path is drawn along: its points joined straight, or for a smooth path a
 * centripetal Catmull-Rom curve through them sampled `PATH_SAMPLES` segments a span, each vertex
 * with its radius (interpolated along the span). Closed paths repeat their first vertex at the end.
 * Only `+ − × ÷` and `sqrt`, so every engine samples the same curve.
 */
export function pathPolyline(spec: Pick<SolidSpec, "points" | "smooth" | "closed" | "radius" | "profile">): { at: Vec3; radius: number }[] {
  const points = spec.points ?? [];
  const r0 = spec.radius ?? DEFAULT_PATH_RADIUS;
  const radius = (p: PathPoint) => p.radius ?? r0;
  const closed = !!(spec.closed || spec.profile === "slab") && points.length > 2;
  const n = points.length;
  if (!spec.smooth || n < 3) {
    const line = points.map((p) => ({ at: [...p.at] as Vec3, radius: radius(p) }));
    if (closed) line.push({ at: [...points[0].at] as Vec3, radius: radius(points[0]) });
    return line;
  }
  const at = (i: number): Vec3 => {
    if (closed) return points[((i % n) + n) % n].at;
    if (i < 0) return points[0].at.map((v, a) => 2 * v - points[1].at[a]) as Vec3;
    if (i >= n) return points[n - 1].at.map((v, a) => 2 * v - points[n - 2].at[a]) as Vec3;
    return points[i].at;
  };
  const rad = (i: number) => radius(points[closed ? ((i % n) + n) % n : Math.min(n - 1, Math.max(0, i))]);
  /** Centripetal knot spacing: the square root of the distance, never zero. */
  const knot = (a: Vec3, b: Vec3) => Math.max(1e-6, Math.sqrt(Math.sqrt(sq(b[0] - a[0]) + sq(b[1] - a[1]) + sq(b[2] - a[2]))));
  const lerp = (a: Vec3, b: Vec3, ta: number, tb: number, t: number): Vec3 =>
    a.map((v, k) => ((tb - t) * v + (t - ta) * b[k]) / (tb - ta)) as Vec3;
  const spans = closed ? n : n - 1;
  const line: { at: Vec3; radius: number }[] = [];
  for (let i = 0; i < spans; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    for (let k = 0; k < PATH_SAMPLES; k++) {
      const f = k / PATH_SAMPLES;
      const t = t1 + (t2 - t1) * f;
      // Barry and Goldman's pyramid of lerps
      const a1 = lerp(p0, p1, t0, t1, t);
      const a2 = lerp(p1, p2, t1, t2, t);
      const a3 = lerp(p2, p3, t2, t3, t);
      const b1 = lerp(a1, a2, t0, t2, t);
      const b2 = lerp(a2, a3, t1, t3, t);
      line.push({ at: lerp(b1, b2, t1, t2, t), radius: rad(i) + (rad(i + 1) - rad(i)) * f });
    }
  }
  const last = closed ? 0 : n - 1;
  line.push({ at: [...points[last].at] as Vec3, radius: rad(last) });
  return line;
}

/**
 * The box a path fills, on the lattice: its curve's bounds grown by its radius (tubes), by half
 * its width across and its height up (walls), or by its height up (slabs). At least 1/8 every way.
 */
export function pathBounds(spec: Pick<SolidSpec, "points" | "smooth" | "closed" | "radius" | "profile" | "width" | "height">): { min: Vec3; max: Vec3 } {
  const line = pathPolyline(spec);
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  const profile = spec.profile ?? "tube";
  const half = (spec.width ?? DEFAULT_PATH_WIDTH) / 2;
  const height = spec.height ?? DEFAULT_PATH_HEIGHT;
  for (const v of line) {
    for (let a = 0; a < 3; a++) {
      const grow = profile === "tube" ? v.radius : profile === "wall" && a !== 1 ? half : 0;
      lo[a] = Math.min(lo[a], v.at[a] - grow);
      hi[a] = Math.max(hi[a], v.at[a] + grow + (a === 1 && profile !== "tube" ? height : 0));
    }
  }
  if (profile === "slab") hi[1] = Math.min(...line.map((v) => v.at[1])) + height;
  const down = (n: number) => Math.floor(n * 8) / 8;
  const up = (n: number) => Math.ceil(n * 8) / 8;
  const min = lo.map(down) as Vec3;
  const max = hi.map((n, a) => Math.max(up(n), min[a] + 1 / 8)) as Vec3;
  return { min, max };
}

/**
 * Inside a path: within a tube's radius of its curve; within half a wall's width of it across
 * (x and z) and between it and its height above; or, for a slab, inside the outline the curve
 * closes (x and z) between its lowest point and its height above.
 */
function pathTest(spec: SolidSpec): (p: Vec3) => boolean {
  const line = pathPolyline(spec);
  const profile = spec.profile ?? "tube";
  if (line.length === 0) return () => false;
  if (profile === "slab") {
    const base = Math.min(...line.map((v) => v.at[1]));
    const top = base + (spec.height ?? DEFAULT_PATH_HEIGHT);
    return (p) => {
      if (p[1] < base || p[1] >= top) return false;
      // even-odd crossings of a ray toward +x, in x and z
      let inside = false;
      for (let i = 0, j = line.length - 1; i < line.length; j = i++) {
        const [xi, , zi] = line[i].at;
        const [xj, , zj] = line[j].at;
        if (zi > p[2] !== zj > p[2] && p[0] < ((xj - xi) * (p[2] - zi)) / (zj - zi) + xi) inside = !inside;
      }
      return inside;
    };
  }
  // one vertex alone: a ball (tube) or a post (wall)
  const segments = line.length === 1 ? [[line[0], line[0]]] : line.slice(1).map((v, i) => [line[i], v]);
  if (profile === "wall") {
    const half = (spec.width ?? DEFAULT_PATH_WIDTH) / 2;
    const height = spec.height ?? DEFAULT_PATH_HEIGHT;
    const hh = half * half;
    return (p) => {
      for (const [a, b] of segments) {
        const dx = b.at[0] - a.at[0];
        const dz = b.at[2] - a.at[2];
        const len2 = dx * dx + dz * dz;
        let t = len2 > 0 ? ((p[0] - a.at[0]) * dx + (p[2] - a.at[2]) * dz) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        if (sq(p[0] - a.at[0] - dx * t) + sq(p[2] - a.at[2] - dz * t) > hh * (1 + EPS)) continue;
        const base = a.at[1] + (b.at[1] - a.at[1]) * t;
        if (p[1] >= base && p[1] < base + height) return true;
      }
      return false;
    };
  }
  const tubes = segments.map(([a, b]) => {
    const r = Math.max(a.radius, b.radius);
    return {
      test: limbTest({ from: a.at, to: b.at, radius: a.radius, tip: b.radius }),
      lo: a.at.map((v, k) => Math.min(v, b.at[k]) - r),
      hi: a.at.map((v, k) => Math.max(v, b.at[k]) + r),
    };
  });
  return (p) => {
    for (const t of tubes) {
      if (p[0] < t.lo[0] || p[0] > t.hi[0] || p[1] < t.lo[1] || p[1] > t.hi[1] || p[2] < t.lo[2] || p[2] > t.hi[2]) continue;
      if (t.test(p)) return true;
    }
    return false;
  };
}

// #endregion

// #region Rasterizing

export function boxExtent({ min, max }: Box): Vec3 {
  return [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
}

/** One byte per cell of the shape's box (x-major, local coordinates): 1 inside, 0 outside. */
export function shapeMask(spec: ShapeSpec): Uint8Array {
  spec = upToDate(spec);
  const ext = boxExtent(spec.box);
  if (ext.some((e) => e <= 0)) return new Uint8Array(0);
  const [ex, ey, ez] = ext;
  const { kind, up, corner, radius, tip, forward } = spec;
  const inside = insideShape(
    kind === "limb" ? { kind, min: [0, 0, 0], max: ext, up, corner, radius, tip } : { ...spec.params, kind, min: [0, 0, 0], max: ext, up, forward },
  );
  const mask = new Uint8Array(ex * ey * ez);
  const p: Vec3 = [0, 0, 0];
  let i = 0;
  for (let z = 0; z < ez; z++)
    for (let y = 0; y < ey; y++)
      for (let x = 0; x < ex; x++) {
        p[0] = x + 0.5;
        p[1] = y + 0.5;
        p[2] = z + 0.5;
        mask[i++] = inside(p) ? 1 : 0;
      }
  return mask;
}

/** The cells a shape covers, in volume coordinates. */
export function shapeCells(spec: ShapeSpec): Vec3[] {
  const mask = shapeMask(spec);
  if (mask.length === 0) return [];
  const [ex, ey, ez] = boxExtent(spec.box);
  const { min } = spec.box;
  const filled = (x: number, y: number, z: number) =>
    x >= 0 && y >= 0 && z >= 0 && x < ex && y < ey && z < ez && mask[x + ex * (y + ey * z)] === 1;

  const cells: Vec3[] = [];
  let i = 0;
  for (let z = 0; z < ez; z++)
    for (let y = 0; y < ey; y++)
      for (let x = 0; x < ex; x++, i++) {
        if (!mask[i]) continue;
        if (
          spec.hollow &&
          filled(x - 1, y, z) &&
          filled(x + 1, y, z) &&
          filled(x, y - 1, z) &&
          filled(x, y + 1, z) &&
          filled(x, y, z - 1) &&
          filled(x, y, z + 1)
        ) {
          continue;
        }
        cells.push([min[0] + x, min[1] + y, min[2] + z]);
      }
  return cells;
}

/** Each regular polygon of 3 to 12 sides, flat side down, its vertices counterclockwise on the unit circle: [x0, y0, x1, y1, ...]. Literal, so no engine has to agree on Math.cos. */
const POLYGONS: Record<number, readonly number[]> = {
  3: [0.8660254037844387, -0.49999999999999994, 0, 1, -0.8660254037844387, -0.49999999999999994],
  4: [0.7071067811865475, -0.7071067811865476, 0.7071067811865476, 0.7071067811865475, -0.7071067811865475, 0.7071067811865476, -0.7071067811865476, -0.7071067811865475],
  5: [0.5877852522924731, -0.8090169943749475, 0.9510565162951535, 0.3090169943749474, 0, 1, -0.9510565162951535, 0.3090169943749474, -0.5877852522924731, -0.8090169943749475],
  6: [0.49999999999999994, -0.8660254037844387, 1, 0, 0.49999999999999994, 0.8660254037844387, -0.49999999999999994, 0.8660254037844387, -1, 0, -0.49999999999999994, -0.8660254037844387],
  7: [0.43388373911755823, -0.900968867902419, 0.9749279121818237, -0.22252093395631398, 0.7818314824680299, 0.6234898018587334, 0, 1, -0.7818314824680299, 0.6234898018587334, -0.9749279121818235, -0.22252093395631495, -0.4338837391175591, -0.9009688679024187],
  8: [0.3826834323650898, -0.9238795325112867, 0.9238795325112867, -0.3826834323650898, 0.9238795325112867, 0.3826834323650898, 0.3826834323650898, 0.9238795325112867, -0.3826834323650898, 0.9238795325112867, -0.9238795325112867, 0.3826834323650898, -0.9238795325112867, -0.3826834323650898, -0.3826834323650898, -0.9238795325112867],
  9: [0.3420201433256687, -0.9396926207859084, 0.8660254037844387, -0.49999999999999994, 0.984807753012208, 0.17364817766693033, 0.6427876096865393, 0.766044443118978, 0, 1, -0.6427876096865393, 0.766044443118978, -0.984807753012208, 0.17364817766693033, -0.8660254037844387, -0.49999999999999994, -0.3420201433256687, -0.9396926207859084],
  10: [0.3090169943749474, -0.9510565162951535, 0.8090169943749475, -0.5877852522924731, 1, 0, 0.8090169943749475, 0.5877852522924731, 0.3090169943749474, 0.9510565162951535, -0.3090169943749474, 0.9510565162951535, -0.8090169943749475, 0.5877852522924731, -1, 0, -0.8090169943749475, -0.5877852522924731, -0.3090169943749474, -0.9510565162951535],
  11: [0.28173255684142984, -0.9594929736144974, 0.755749574354258, -0.6548607339452853, 0.9898214418809327, -0.14231483827328523, 0.9096319953545182, 0.4154150130018867, 0.5406408174555979, 0.841253532831181, 0, 1, -0.5406408174555979, 0.841253532831181, -0.9096319953545187, 0.4154150130018857, -0.9898214418809326, -0.1423148382732862, -0.7557495743542574, -0.6548607339452862, -0.28173255684142984, -0.9594929736144974],
  12: [0.25881904510252074, -0.9659258262890683, 0.7071067811865475, -0.7071067811865476, 0.9659258262890683, -0.25881904510252074, 0.9659258262890683, 0.25881904510252074, 0.7071067811865476, 0.7071067811865475, 0.25881904510252074, 0.9659258262890683, -0.25881904510252074, 0.9659258262890683, -0.7071067811865475, 0.7071067811865476, -0.9659258262890683, 0.25881904510252074, -0.9659258262890683, -0.25881904510252074, -0.7071067811865476, -0.7071067811865475, -0.25881904510252074, -0.9659258262890683],
};

/** cos and sin of every multiple of 15°, 0° to 345°: [cos, sin, cos, sin, ...]. Literal, like POLYGONS. */
const SWEEP_TRIG: readonly number[] = [
  1, 0, 0.9659258262890683, 0.25881904510252074, 0.8660254037844387, 0.49999999999999994, 0.7071067811865476, 0.7071067811865475, 0.49999999999999994, 0.8660254037844387, 0.25881904510252074, 0.9659258262890683, 0, 1, -0.25881904510252074, 0.9659258262890683, -0.49999999999999994, 0.8660254037844387, -0.7071067811865475, 0.7071067811865476, -0.8660254037844387, 0.49999999999999994, -0.9659258262890683, 0.25881904510252074, -1, 0, -0.9659258262890683, -0.25881904510252074, -0.8660254037844387, -0.49999999999999994, -0.7071067811865476, -0.7071067811865475, -0.49999999999999994, -0.8660254037844387, -0.25881904510252074, -0.9659258262890683, 0, -1, 0.25881904510252074, -0.9659258262890683, 0.49999999999999994, -0.8660254037844387, 0.7071067811865475, -0.7071067811865476, 0.8660254037844387, -0.49999999999999994, 0.9659258262890683, -0.25881904510252074,
];

const UP: Direction = { axis: 1, sign: 1 };

/**
 * An inside test for a solid (see `SolidSpec`), on points: cell centers, in whatever units the
 * box is in. The brush uses it in cells, shape layers in source units, so a step at 1× covers
 * exactly the cells the brush would. Only `+ − × ÷` and `sqrt` are used: IEEE rounds them the
 * same everywhere (`**` and `Math.hypot` it doesn't promise to), so every engine agrees on every cell.
 */
export function insideShape(spec: SolidSpec): (p: Vec3) => boolean {
  spec = upToDate(spec);
  const solid = solidTest(spec);
  const shell = spec.shell;
  if (!shell) return solid;
  // the wall: inside the shape and outside the same shape inset by `shell`
  const min = spec.min.map((n) => n + shell) as Vec3;
  const max = spec.max.map((n) => n - shell) as Vec3;
  if (max.some((n, a) => n <= min[a])) return solid;
  const inset = (r: number | undefined) => (r === undefined ? undefined : Math.max(0, r - shell));
  // a path has its own thickness (radius, width); a wall around it means nothing
  if (spec.kind === "path") return solid;
  // a limb's wall is its own tube, thinner by `shell`, along the same line
  if (spec.kind === "limb") {
    const outer = limbEnds(spec);
    const tube = limbTest({ ...outer, radius: Math.max(0, outer.radius - shell), tip: Math.max(0, outer.tip - shell) });
    return (p) => solid(p) && !tube(p);
  }
  const inner = solidTest({
    ...spec,
    min,
    max,
    round: inset(spec.round),
    roundTop: inset(spec.roundTop),
    roundBottom: inset(spec.roundBottom),
    tube: spec.tube === undefined ? undefined : Math.max(1 / 64, spec.tube - shell),
  });
  // each test assumes its point is in its box; the outer one's caller sees to that, this sees to the inner one's
  const within = (p: Vec3) => p[0] >= min[0] && p[0] < max[0] && p[1] >= min[1] && p[1] < max[1] && p[2] >= min[2] && p[2] < max[2];
  const up = spec.up ?? UP;
  const a = up.axis;
  const openHigh = up.sign > 0 ? spec.openTop : spec.openBottom;
  const openLow = up.sign > 0 ? spec.openBottom : spec.openTop;
  if (!openHigh && !openLow) return (p) => solid(p) && !(within(p) && inner(p));
  // an open end: past the inner shape's end, what is inside it where it ends is empty too
  const lastIn = max[a] - (max[a] - min[a]) / 1024;
  const q: Vec3 = [0, 0, 0];
  return (p) => {
    if (!solid(p)) return false;
    q[0] = p[0];
    q[1] = p[1];
    q[2] = p[2];
    if (openHigh && q[a] >= max[a]) q[a] = lastIn;
    if (openLow && q[a] < min[a]) q[a] = min[a];
    return !(within(q) && inner(q));
  };
}

/** The axes across a shape's `up`, from its `forward` (`f`) a quarter turn on (`g`, right-handed about `up`). */
export function crossFrame(spec: Pick<SolidSpec, "up" | "forward">): { f: Direction; g: Direction } {
  const up = spec.up ?? UP;
  const f = spec.forward && spec.forward.axis !== up.axis ? spec.forward : defaultForward(up);
  // up x f: the third axis, + when the two go round x, y, z in order
  const c = (3 - up.axis - f.axis) as Axis;
  const cyclic = (f.axis - up.axis + 3) % 3 === 1;
  return { f, g: { axis: c, sign: (up.sign * f.sign * (cyclic ? 1 : -1)) as 1 | -1 } };
}

/**
 * Whether a point (`pf`, `pg` across `up`, measured from `forward`) is within `sweep` degrees
 * of `forward`, turning toward `g`. Only half-planes from SWEEP_TRIG: no engine's atan2 involved.
 */
function inSweep(sweep: number, pf: number, pg: number): boolean {
  const k = sweep / 15;
  const c = SWEEP_TRIG[2 * k];
  const s = SWEEP_TRIG[2 * k + 1];
  // past the end edge, turning on from the start: the end is cos, sin of the sweep
  const beforeEnd = pf * s - pg * c >= -EPS;
  if (sweep <= 180) return pg >= -EPS && beforeEnd;
  return pg >= -EPS || beforeEnd;
}

/** A regular polygon of `sides` sides stretched to fill [-1, 1] on both axes, as half-planes `x * nx + y * ny <= c`. */
function polygonEdges(sides: number): { nx: number; ny: number; c: number }[] {
  const v = POLYGONS[sides];
  let lx = Infinity, hx = -Infinity, ly = Infinity, hy = -Infinity;
  for (let i = 0; i < v.length; i += 2) {
    lx = Math.min(lx, v[i]);
    hx = Math.max(hx, v[i]);
    ly = Math.min(ly, v[i + 1]);
    hy = Math.max(hy, v[i + 1]);
  }
  const x = (i: number) => (2 * v[i] - (hx + lx)) / (hx - lx);
  const y = (i: number) => (2 * v[i + 1] - (hy + ly)) / (hy - ly);
  const edges: { nx: number; ny: number; c: number }[] = [];
  for (let i = 0; i < v.length; i += 2) {
    const j = (i + 2) % v.length;
    // counterclockwise: the outward normal of a -> b is (dy, -dx)
    const nx = y(j) - y(i);
    const ny = x(i) - x(j);
    edges.push({ nx, ny, c: nx * x(i) + ny * y(i) });
  }
  return edges;
}

function solidTest(spec: SolidSpec): (p: Vec3) => boolean {
  const { kind, min, max } = spec;
  const up = spec.up ?? UP;
  const a = up.axis;
  const u = ((a + 1) % 3) as Axis;
  const v = ((a + 2) % 3) as Axis;
  const ext: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const mid: Vec3 = [min[0] + max[0], min[1] + max[1], min[2] + max[2]];
  /** -1..1 across the box. */
  const t = (p: Vec3, axis: Axis) => (2 * p[axis] - mid[axis]) / ext[axis];
  /** 0 at the base, 1 at the apex. */
  const h = (p: Vec3) => (up.sign > 0 ? p[a] - min[a] : max[a] - p[a]) / ext[a];
  /** Keep only what is within the sweep, for the kinds that go round. */
  const swept = (test: (p: Vec3) => boolean): ((p: Vec3) => boolean) => {
    const sweep = spec.sweep ?? 360;
    if (sweep >= 360) return test;
    const { f, g } = crossFrame(spec);
    return (p) => test(p) && inSweep(sweep, f.sign * t(p, f.axis), g.sign * t(p, g.axis));
  };

  switch (kind) {
    case "prism":
      return swept(prismTest(spec, ext, mid, t, h));
    case "sphere":
      return swept((p) => sq(t(p, 0)) + sq(t(p, 1)) + sq(t(p, 2)) <= 1 + EPS);
    case "diamond":
      return (p) => Math.abs(t(p, 0)) + Math.abs(t(p, 1)) + Math.abs(t(p, 2)) <= 1 + EPS;
    case "wedge": {
      // a ramp: full height at the back, down to nothing at the side it faces
      const f = spec.forward && spec.forward.axis !== a ? spec.forward : defaultForward(up);
      const s = (p: Vec3) => (f.sign > 0 ? p[f.axis] - min[f.axis] : max[f.axis] - p[f.axis]) / ext[f.axis];
      return (p) => h(p) + s(p) <= 1 + EPS;
    }
    case "capsule": {
      // a cylinder with rounded ends: each end is a half ellipsoid as deep as the narrower radius
      const cap = Math.min(ext[u], ext[v], ext[a]) / 2;
      const straight = ext[a] / 2 - cap;
      return (p) => {
        const along = Math.max(0, Math.abs(p[a] - mid[a] / 2) - straight) / cap;
        return sq(t(p, u)) + sq(t(p, v)) + along * along <= 1 + EPS;
      };
    }
    case "limb":
      return limbTest(limbEnds(spec));
    case "path":
      return pathTest(spec);
    case "torus": {
      // The base is the ring's outline; the tube is `tube` across the ring (unset: half the
      // height) and the box's height through it.
      const ru = ext[u] / 2;
      const rv = ext[v] / 2;
      const thick = ext[a] / 2;
      const tube = Math.min(spec.tube ?? thick, Math.min(ru, rv));
      return swept((p) => {
        const pu = p[u] - mid[u] / 2;
        const pv = p[v] - mid[v] / 2;
        const rho = Math.sqrt(sq(pu / ru) + sq(pv / rv));
        const dist = Math.sqrt(pu * pu + pv * pv);
        // distance from the center to the outline, in this point's direction
        const outer = rho > 0 ? dist / rho : Math.min(ru, rv);
        const radial = (outer - tube - dist) / tube;
        return sq(radial) + sq(t(p, a)) <= 1 + EPS;
      });
    }
  }
}

/**
 * A prism: its cross-section (round, a rectangle, or a regular polygon stretched to the box)
 * shrinking toward the axis by `taper` from base to top, with rounded edges when it is straight.
 */
function prismTest(
  spec: SolidSpec,
  ext: Vec3,
  mid: Vec3,
  t: (p: Vec3, axis: Axis) => number,
  h: (p: Vec3) => number,
): (p: Vec3) => boolean {
  const taper = spec.taper ?? 0;
  const sides = spec.sides ?? 0;
  const roundsEnds = spec.roundTop !== undefined || spec.roundBottom !== undefined;
  const { f, g } = crossFrame(spec);
  const tf = (p: Vec3) => f.sign * t(p, f.axis);
  const tg = (p: Vec3) => g.sign * t(p, g.axis);

  if (sides === 4) {
    if (!taper) {
      if (roundsEnds) return roundedBox(spec, ext, mid);
      const round = Math.min(spec.round ?? 0, ext[0] / 2, ext[1] / 2, ext[2] / 2);
      if (!round) return () => true;
      // the box shrunk by the radius, then grown back by it with rounded edges
      const rr = round * round;
      return (p) => {
        let d = 0;
        for (let i = 0; i < 3; i++) {
          const q = Math.abs(p[i] - mid[i] / 2) - (ext[i] / 2 - round);
          if (q > 0) d += q * q;
        }
        return d <= rr * (1 + EPS);
      };
    }
    return (p) => {
      const r = 1 - h(p) * taper + EPS;
      return Math.abs(tf(p)) <= r && Math.abs(tg(p)) <= r;
    };
  }

  if (!sides) {
    if (taper) {
      return (p) => {
        const r = 1 - h(p) * taper + EPS;
        return sq(tf(p)) + sq(tg(p)) <= r * r;
      };
    }
    if (!spec.round && !roundsEnds) return (p) => sq(tf(p)) + sq(tg(p)) <= 1 + EPS;
    return roundedCylinder(spec, ext, tf, tg);
  }

  const edges = polygonEdges(sides);
  return (p) => {
    const r = 1 - h(p) * taper;
    const x = tf(p);
    const y = tg(p);
    for (const e of edges) if (e.nx * x + e.ny * y > e.c * r + EPS) return false;
    return true;
  };
}

/** A straight round prism with its rims rounded: `roundTop` and `roundBottom`, each `round` when unset. */
function roundedCylinder(spec: SolidSpec, ext: Vec3, tf: (p: Vec3) => number, tg: (p: Vec3) => number): (p: Vec3) => boolean {
  const up = spec.up ?? UP;
  const a = up.axis;
  const { f, g } = crossFrame(spec);
  const radius = Math.min(ext[f.axis], ext[g.axis]) / 2;
  let top = Math.min(spec.roundTop ?? spec.round ?? 0, radius);
  let bottom = Math.min(spec.roundBottom ?? spec.round ?? 0, radius);
  if (top + bottom > ext[a]) {
    const scale = ext[a] / (top + bottom);
    top *= scale;
    bottom *= scale;
  }
  const yTop = ext[a] - top;
  return (p) => {
    const rho2 = sq(tf(p)) + sq(tg(p));
    const y = up.sign > 0 ? p[a] - spec.min[a] : spec.max[a] - p[a];
    const r = y > yTop ? top : y < bottom ? bottom : 0;
    if (!r) return rho2 <= 1 + EPS;
    // the distance in from the side (in the shape's units, along its narrower radius), and up the band
    const d = (Math.sqrt(rho2) - 1) * radius;
    const q = d + r;
    const band = y > yTop ? y - yTop : bottom - y;
    return (q > 0 ? q * q : 0) + band * band <= r * r * (1 + EPS);
  };
}


// #endregion

// #region Placing

/**
 * Orientations `rotateDraft` steps through: any of six ways for shapes with a top (a prism's, a
 * swept sphere's or torus's), along an axis for capsules, none for shapes that look the same every way.
 */
export function shapeOrientations(kind: ShapeKind): Direction[] {
  kind = kindOf(kind);
  if (kind === "prism" || kind === "wedge" || kind === "sphere" || kind === "torus") {
    // lying down comes before upside down: a cylinder turned once lies on its side
    return [
      { axis: 1, sign: 1 },
      { axis: 0, sign: 1 },
      { axis: 2, sign: 1 },
      { axis: 1, sign: -1 },
      { axis: 0, sign: -1 },
      { axis: 2, sign: -1 },
    ];
  }
  if (kind === "capsule") {
    return [
      { axis: 1, sign: 1 },
      { axis: 0, sign: 1 },
      { axis: 2, sign: 1 },
    ];
  }
  return [];
}

/** How tall a freshly drawn shape is, given its base. */
export function defaultHeight(kind: ShapeKind, width: number, depth: number, params: ShapeParams = {}): number {
  const side = Math.min(width, depth);
  // a pyramid in 45° steps
  if (kind === "prism" && params.sides === 4 && params.taper === 1) return Math.ceil(side / 2);
  // a capsule twice as long as it is wide
  if (kind === "capsule") return side * 2;
  // a ring with a hole as wide as its tube
  if (kind === "torus") return Math.max(1, Math.round(side / 3));
  // a limb reaching three times as far as it is wide
  if (kind === "limb") return side * 3;
  return side;
}

/** The draft's extent along its grow axis. */
export function draftHeight(draft: ShapeDraft): number {
  return boxExtent(draft.box)[draft.grow.axis];
}

/** Change the draft's height, keeping its base face in place. */
export function withHeight(draft: ShapeDraft, height: number, size: Vec3): ShapeDraft {
  const g = draft.grow.axis;
  const min = [...draft.box.min] as Vec3;
  const max = [...draft.box.max] as Vec3;
  if (draft.grow.sign > 0) max[g] = Math.min(size[g] - 1, min[g] + Math.max(1, height) - 1);
  else min[g] = Math.max(0, max[g] - Math.max(1, height) + 1);
  return { ...draft, box: { min, max } };
}

/**
 * Turn the shape to its next orientation. The box turns with it: a standing cylinder
 * lies down along the surface rather than being squashed into the same box.
 */
export function rotateDraft(kind: ShapeKind, draft: ShapeDraft, size: Vec3): ShapeDraft {
  const list = shapeOrientations(kind);
  if (list.length === 0) return draft;
  const axisOnly = list.every((d) => d.sign > 0);
  const i = list.findIndex((d) => d.axis === draft.up.axis && (axisOnly || d.sign === draft.up.sign));
  const up = list[(i + 1) % list.length];

  const ext = boxExtent(draft.box);
  [ext[draft.up.axis], ext[up.axis]] = [ext[up.axis], ext[draft.up.axis]];
  const min: Vec3 = [0, 0, 0];
  const max: Vec3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const { min: m, max: M } = draft.box;
    if (a === draft.grow.axis) {
      // the base face stays on the surface
      min[a] = draft.grow.sign > 0 ? m[a] : M[a] - ext[a] + 1;
    } else {
      min[a] = Math.floor((m[a] + M[a] - ext[a] + 1) / 2);
    }
    max[a] = min[a] + ext[a] - 1;
  }
  return { ...draft, up, box: shiftInside({ min, max }, size) };
}

/** Move a box by whole cells so it fits inside the volume, then clip what still doesn't. */
export function shiftInside({ min, max }: Box, size: Vec3): Box {
  const out: Box = { min: [...min], max: [...max] };
  for (let a = 0; a < 3; a++) {
    const shift = out.min[a] < 0 ? -out.min[a] : out.max[a] > size[a] - 1 ? size[a] - 1 - out.max[a] : 0;
    out.min[a] = Math.max(0, out.min[a] + shift);
    out.max[a] = Math.min(size[a] - 1, out.max[a] + shift);
  }
  return out;
}

export function clipBox({ min, max }: Box, size: Vec3): Box {
  return {
    min: min.map((n) => Math.max(0, n)) as Vec3,
    max: max.map((n, a) => Math.min(size[a] - 1, n)) as Vec3,
  };
}

/** The axes of the base face, perpendicular to the grow direction. */
export function baseAxes(draft: ShapeDraft): [Axis, Axis] {
  const g = draft.grow.axis;
  return [((g + 1) % 3) as Axis, ((g + 2) % 3) as Axis];
}

/** Coordinate of the plane the base face lies on. */
export function basePlane(draft: ShapeDraft): number {
  const g = draft.grow.axis;
  return draft.grow.sign > 0 ? draft.box.min[g] : draft.box.max[g] + 1;
}

/** Coordinate of the plane the far face (opposite the base) lies on. */
export function farPlane(draft: ShapeDraft): number {
  const g = draft.grow.axis;
  return draft.grow.sign > 0 ? draft.box.max[g] + 1 : draft.box.min[g];
}

/**
 * A handle in the middle of each face of the box, in voxel space, with the way it faces: drag
 * one along its axis to move that face. Every axis works the same, whichever way the shape grew.
 */
export function shapeHandles(draft: Pick<ShapeDraft, "box">): { id: ShapeHandle; point: Vec3; normal: Direction }[] {
  const { min, max } = draft.box;
  const handles: { id: ShapeHandle; point: Vec3; normal: Direction }[] = [];
  for (const axis of [0, 1, 2] as Axis[]) {
    for (const side of ["min", "max"] as const) {
      const point = [0, 1, 2].map((a) => (min[a] + max[a] + 1) / 2) as Vec3;
      point[axis] = side === "max" ? max[axis] + 1 : min[axis];
      handles.push({ id: `${side}-${axis}` as ShapeHandle, point, normal: { axis, sign: side === "max" ? 1 : -1 } });
    }
  }
  return handles;
}

/** Move one face of a box along its axis by `delta` cells, keeping at least one cell, inside a grid of `size`. */
export function moveFace(box: Box, handle: ShapeHandle, delta: number, size: Vec3): Box {
  const [side, a] = handle.split("-") as ["min" | "max", string];
  const axis = Number(a) as Axis;
  const min = [...box.min] as Vec3;
  const max = [...box.max] as Vec3;
  if (side === "max") max[axis] = Math.min(size[axis] - 1, Math.max(min[axis], box.max[axis] + delta));
  else min[axis] = Math.max(0, Math.min(max[axis], box.min[axis] + delta));
  return { min, max };
}

/** A direction turned a quarter turn `turns` times about `axis` (right-handed: +x turns toward +y about z). */
export function turnDirection(d: Direction, axis: Axis, turns: number): Direction {
  const v: Vec3 = [0, 0, 0];
  v[d.axis] = d.sign;
  const t = turnVector(v, axis, turns);
  const a = t.findIndex((n) => n !== 0) as Axis;
  return { axis: a, sign: t[a] > 0 ? 1 : -1 };
}

/** A vector turned a quarter turn `turns` times about `axis`. */
export function turnVector(v: Vec3, axis: Axis, turns: number): Vec3 {
  const u = ((axis + 1) % 3) as Axis;
  const w = ((axis + 2) % 3) as Axis;
  const out = [...v] as Vec3;
  for (let i = 0; i < (((turns % 4) + 4) % 4); i++) {
    const [a, b] = [out[u], out[w]];
    out[u] = -b;
    out[w] = a;
  }
  return out.map((n) => n + 0) as Vec3;
}

/** A limb's base corner (bits: max x, max y, max z) turned with its box about `axis`. */
export function turnCorner(corner: number, axis: Axis, turns: number): number {
  const v = [0, 1, 2].map((a) => ((corner >> a) & 1 ? 1 : -1)) as Vec3;
  const t = turnVector(v, axis, turns);
  return t.reduce((bits, n, a) => bits | (n > 0 ? 1 << a : 0), 0);
}

/**
 * Turn a draft a quarter turn `turns` times about `axis`, around its middle: the box's extents
 * across the axis swap (snapped back onto cells and into the grid), and where the shape points
 * turns with it. Shapes that point along an axis either way keep pointing its + way.
 */
export function turnDraft(kind: ShapeKind, draft: ShapeDraft, axis: Axis, turns: number, size: Vec3): ShapeDraft {
  if (((turns % 4) + 4) % 4 === 0) return draft;
  const box = turnBox(draft.box, axis, turns);
  const turnsTo = shapeOrientations(kind);
  const axisOnly = turnsTo.length > 0 && turnsTo.every((d) => d.sign > 0);
  let up = turnDirection(draft.up, axis, turns);
  if (axisOnly) up = { axis: up.axis, sign: 1 };
  // where a slope, a sweep or a polygon's flat side faces turns too
  const forward = turnsTo.length ? turnDirection(draft.forward ?? defaultForward(draft.up), axis, turns) : draft.forward;
  return { ...draft, box: shiftInside(box, size), up, grow: turnDirection(draft.grow, axis, turns), ...(forward ? { forward } : {}) };
}

/** An inclusive cell box turned about `axis` around its middle: the extents across the axis swap. */
export function turnBox(box: Box, axis: Axis, turns: number): Box {
  if ((((turns % 4) + 4) % 4) % 2 === 0) return { min: [...box.min], max: [...box.max] };
  const u = ((axis + 1) % 3) as Axis;
  const w = ((axis + 2) % 3) as Axis;
  const ext = boxExtent(box);
  const min = [...box.min] as Vec3;
  const max = [...box.max] as Vec3;
  for (const [a, b] of [[u, w], [w, u]] as const) {
    // the middle stays put, rounded down when the new extent can't center exactly
    min[a] = Math.floor((box.min[a] + box.max[a] + 1 - ext[b]) / 2);
    max[a] = min[a] + ext[b] - 1;
  }
  return { min, max };
}

/** How far along the ray it hits the shape itself (not just its box), or null. */
export function rayHitShape(ray: Ray, spec: ShapeSpec): number | null {
  const mask = shapeMask(spec);
  if (mask.length === 0) return null;
  const { min } = spec.box;
  const local: Ray = {
    origin: [ray.origin[0] - min[0], ray.origin[1] - min[1], ray.origin[2] - min[2]],
    dir: ray.dir,
  };
  return raycastVolume(local, boxExtent(spec.box), (i) => mask[i] === 1)?.distance ?? null;
}

/**
 * Where along the line `point + s * axis` a ray passes closest. Null when the ray
 * runs (nearly) parallel to the line.
 */
export function rayAxisParam(ray: Ray, point: Vec3, axis: Axis): number | null {
  const d = ray.dir;
  const b = d[axis];
  const denom = 1 - b * b;
  if (denom < 1e-4) return null;
  const w: Vec3 = [point[0] - ray.origin[0], point[1] - ray.origin[1], point[2] - ray.origin[2]];
  const e = d[0] * w[0] + d[1] * w[1] + d[2] * w[2];
  return (b * e - w[axis]) / denom;
}

// #endregion
