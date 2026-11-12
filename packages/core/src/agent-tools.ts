// Tools for browser agents (WebMCP). Each tool is a thin, validated wrapper over the
// Editor API; every tool that changes the document does so as one undo step.

import { layerKind, MAX_SIZE, type Editor } from "./editor";
import { MAX_SPATIAL_BRUSH } from "./spatial-brush";
import { BUILTIN_PALETTES, fromHex, MAX_COLORS, nearestColor, toHex } from "./palette";
import { countMask, maskBounds, type SelectMode } from "./selection";
import { paramsOf, PATH_PROFILES, presetOf, presetShape, SHAPE_KINDS, SHAPE_PRESET_IDS, shapeCells, type Direction, type ShapeKind, type ShapePreset } from "./shapes";

/** What agents call shapes: the presets (box, cylinder, cone, ...) and the kinds ("prism" is round unless `sides` say otherwise). */
const SHAPE_NAMES: readonly (ShapePreset | ShapeKind)[] = [...SHAPE_PRESET_IDS, ...SHAPE_KINDS.filter((k) => !SHAPE_PRESET_IDS.includes(k as ShapePreset))];

/** A shape name's kind and the settings that make it what it says. */
const readShapeName = (value: unknown, name: string) => {
  const id = readEnum(value, SHAPE_NAMES, name, "box");
  return id === "prism" ? { kind: "prism" as ShapeKind, params: {} } : presetShape(id);
};
import { cellsToSource, FILL_KINDS, findStep, snapSource, sourceToCells, STEP_MODES, stepFill, stepShape, type ShapeOptions, type ShapeSource } from "./source";
import type { MarkerShape } from "./markers";
import type { Blend } from "./evaluate";
import type { Effect } from "./effects";
import type { Axis, Box, CameraView, Json, Vec3, Workplane, WorkplaneClip } from "./types";

type Input = Record<string, unknown>;
type Schema = Record<string, unknown>;

/** A tool in the shape WebMCP's `registerTool` takes. `execute` returns the result as JSON text. */
export interface AgentTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  annotations?: { readOnlyHint?: boolean; consequentialHint?: boolean };
  execute(input: Input): string;
}

/** The camera, which lives in the viewport rather than the editor. */
export interface AgentView {
  setView(view: CameraView): void;
  fit(): void;
}

const AXES = ["x", "y", "z"] as const;
/** Workplane clip modes, as agents name them, and as the editor does. */
const CLIPS = ["off", "below", "above", "only"] as const;
const CLIP_MODES: WorkplaneClip[] = ["none", "-", "+", "="];
const DIRECTIONS = ["+x", "-x", "+y", "-y", "+z", "-z"] as const;
const SELECT_MODES: readonly SelectMode[] = ["replace", "add", "subtract", "intersect"];
const CAMERA_VIEWS: readonly CameraView[] = ["front", "back", "left", "right", "top", "bottom", "iso"];
type AxisView = Exclude<CameraView, "iso">;
const AXIS_VIEWS: readonly AxisView[] = ["front", "back", "left", "right", "top", "bottom"];
/**
 * Each axis view as the camera shows it: the axis it looks along and the side it looks from, and the
 * axes (with their direction) that point right and up on screen.
 */
const VIEW_AXES: Record<AxisView, { axis: Axis; side: 1 | -1; right: [Axis, 1 | -1]; up: [Axis, 1 | -1] }> = {
  front: { axis: 2, side: 1, right: [0, 1], up: [1, 1] },
  back: { axis: 2, side: -1, right: [0, -1], up: [1, 1] },
  right: { axis: 0, side: 1, right: [2, -1], up: [1, 1] },
  left: { axis: 0, side: -1, right: [2, 1], up: [1, 1] },
  top: { axis: 1, side: 1, right: [0, 1], up: [2, -1] },
  bottom: { axis: 1, side: -1, right: [0, 1], up: [2, 1] },
};
/** The most pixels get_projection returns, after cropping to the model. */
const MAX_PIXELS_OUT = 128 * 128;
const MAX_VOXELS_OUT = 20_000;
const FRAME_ACTIONS = ["select", "duplicate", "blank", "delete", "move", "set_duration", "set_fps", "copy_layer"] as const;
const PIPELINE_ACTIONS = [
  "set_blend", "add_effect", "remove_effect", "clear_effects", "mask_to_selection", "clear_mask", "select_mask",
  "group", "move_to_group", "ungroup", "delete_group", "rename_group", "show_group", "hide_group",
] as const;
const BLEND_NAMES = ["default", "normal", "behind", "replace", "cut", "intersect", "intersect_keep", "paint"] as const;
/** What each blend name means; default is the layer's kind's. */
const BLENDS: Record<(typeof BLEND_NAMES)[number], Blend | null> = {
  default: null,
  normal: { occupancy: "union", keep: false },
  behind: { occupancy: "union", keep: true },
  replace: { occupancy: "replace", keep: false },
  cut: { occupancy: "subtract", keep: false },
  intersect: { occupancy: "intersect", keep: false },
  intersect_keep: { occupancy: "intersect", keep: true },
  paint: { occupancy: "none", keep: false },
};
/** A blend's name, as tools take it. */
export function blendName(blend: Blend): (typeof BLEND_NAMES)[number] {
  const found = (Object.entries(BLENDS) as [(typeof BLEND_NAMES)[number], Blend | null][]).find(([, b]) => b && b.occupancy === blend.occupancy && b.keep === blend.keep);
  return found ? found[0] : "normal";
}
const MARKER_ACTIONS = [
  "add", "place", "rename", "set_role", "set_data", "delete",
  "key_per_frame", "same_every_frame", "hide", "show", "set_origin", "reset_origin",
] as const;
const LAYER_ACTIONS = [
  "create",
  "select",
  "rename",
  "delete",
  "duplicate",
  "move",
  "merge_down",
  "clear",
  "show",
  "hide",
  "lock",
  "unlock",
] as const;

// #region Schemas

const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});
const cellSchema = (description: string): Schema => ({
  type: "array",
  items: { type: "integer" },
  minItems: 3,
  maxItems: 3,
  description,
});
const colorSchema: Schema = {
  type: ["integer", "string"],
  description:
    'A palette index (see get_document), or a hex color like "#ff8800", which uses the closest palette color. ' +
    "Defaults to the current color.",
};
const enumSchema = (values: readonly string[], description: string): Schema => ({
  type: "string",
  enum: [...values],
  description,
});
const axisSchema = (description: string) => enumSchema(AXES, description);
const boxProperties = {
  min: cellSchema("One corner of the box, [x, y, z], inclusive."),
  max: cellSchema("The opposite corner, [x, y, z], inclusive."),
};
const shapeProperties = {
  kind: enumSchema(SHAPE_NAMES, "The shape inscribed in the box: box, cylinder, cone, pyramid, hexagon, sphere, capsule, wedge, diamond, torus, arch or limb. Defaults to box."),
  ...boxProperties,
  hollow: { type: "boolean", description: "Keep only a one-voxel shell." },
  up: enumSchema(
    DIRECTIONS,
    "Where the shape points: a pyramid's or cone's apex, a cylinder's or torus's axis, a capsule's (sign ignored). Defaults to +y.",
  ),
};

// #endregion

// #region Input

function fail(message: string): never {
  throw new Error(message);
}

function readCell(value: unknown, name: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isInteger)) {
    fail(`${name} must be [x, y, z] integers`);
  }
  return value as Vec3;
}

/** A box from two corners in any order. */
function readBox(input: Input): Box {
  const a = readCell(input.min, "min");
  const b = readCell(input.max, "max");
  const box: Box = {
    min: a.map((n, i) => Math.min(n, b[i])) as Vec3,
    max: a.map((n, i) => Math.max(n, b[i])) as Vec3,
  };
  if (box.max.some((n, i) => n - box.min[i] >= MAX_SIZE)) fail(`Boxes can be at most ${MAX_SIZE} cells a side`);
  return box;
}

function readEnum<T extends string>(value: unknown, values: readonly T[], name: string, fallback?: T): T {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!values.includes(value as T)) fail(`${name} must be one of: ${values.join(", ")}`);
  return value as T;
}

function readAxis(value: unknown, name: string): Axis {
  return AXES.indexOf(readEnum(value, AXES, name)) as Axis;
}

const directionName = (d: Direction) => `${d.sign > 0 ? "+" : "-"}${AXES[d.axis]}`;

/** An optional size in source units, a multiple of 1/8. */
/** A limb's base corner: 0 to 7, bits for max x, y and z. */
function readCorner(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 7) fail("corner is 0 to 7: bit 1 = max x, 2 = max y, 4 = max z");
  return value as number;
}

/** A radius in voxels: a finite number, 0 or more. */
function readRadius(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(`${name} is a radius in voxels, 0 or more`);
  return value;
}

function readSize8(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value * 8)) {
    fail(`${name} must be a size of 0 or more, in steps of 1/8`);
  }
  return value as number;
}

function readDirection(value: unknown, name = "up"): Direction {
  const dir = readEnum(value, DIRECTIONS, name, "+y");
  return { axis: AXES.indexOf(dir[1] as (typeof AXES)[number]) as Axis, sign: dir[0] === "+" ? 1 : -1 };
}

function readHex(value: unknown, name = "color"): number {
  if (typeof value !== "string" || !/^#?[0-9a-f]{6}$/i.test(value)) fail(`${name} must be a hex color like "#ff8800"`);
  return fromHex(value);
}

function readInt(value: unknown, name: string, min: number, max: number, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    fail(`${name} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function readGridPoint(value: unknown, name: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) {
    fail(`${name} must be [x, y, z] numbers`);
  }
  return value as Vec3;
}

function readSize(value: unknown): Vec3 {
  const size = readCell(value, "size");
  if (size.some((n) => n < 1 || n > MAX_SIZE)) fail(`Each side of size must be 1 to ${MAX_SIZE}`);
  return size;
}

function readPalette(value: unknown): number[] {
  if (typeof value === "string") {
    const builtin = BUILTIN_PALETTES.find((p) => p.name.toLowerCase() === value.toLowerCase());
    return builtin ? [...builtin.colors] : fail(`Unknown palette; built-ins are ${BUILTIN_PALETTES.map((p) => p.name).join(", ")}`);
  }
  if (!Array.isArray(value) || value.length === 0) fail("palette must be a built-in palette name or a list of hex colors");
  if (value.length > MAX_COLORS) fail(`Palettes have at most ${MAX_COLORS} colors`);
  return value.map((c) => readHex(c));
}

// #endregion

export function createAgentTools(editor: Editor, view?: AgentView): AgentTool[] {
  // #region Helpers

  /** A palette index for a tool's color input. `allowEmpty` accepts 0 to mean "erase". */
  const readColor = (value: unknown, allowEmpty = false): number => {
    if (value === undefined) return editor.color;
    if (typeof value === "string") return nearestColor(editor.palette, readHex(value));
    return readInt(value, "color", allowEmpty ? 0 : 1, editor.palette.length - 1);
  };

  const findLayer = (ref: unknown) => {
    if (ref === undefined) return editor.activeLayer ?? fail("There is no active layer");
    const layer = editor.layers.find((l) => l.id === ref) ?? editor.layers.find((l) => l.name === ref);
    return layer ?? fail(`No layer with id or name ${JSON.stringify(ref)}`);
  };

  /** A frame by id or position from 0. */
  const findFrame = (ref: unknown): string => {
    const frames = editor.frames;
    if (Number.isInteger(ref)) {
      return frames[ref as number]?.id ?? fail(`There are ${frames.length} frames, numbered from 0`);
    }
    return frames.find((f) => f.id === ref)?.id ?? fail(`No frame with id ${JSON.stringify(ref)}; get_document lists them`);
  };

  const animationInfo = () => ({
    tags: editor.tags,
    activeTag: editor.activeTagId,
    fps: editor.fps,
    activeFrame: editor.activeFrameIndex,
    frames: editor.frames.map((f) => ({ id: f.id, duration: f.duration })),
    seconds: editor.animationLength / 1000,
  });

  /** Why the last edit did nothing, from the editor's notice. */
  const why = (fallback: string) => editor.toast?.message ?? fallback;

  const findMarker = (ref: unknown) => {
    if (ref === undefined) fail("marker is required: its id or name");
    const marker = editor.markers.find((m) => m.id === ref) ?? editor.markers.find((m) => m.name === ref);
    return marker ?? fail(`No marker with id or name ${JSON.stringify(ref)}; get_document lists them`);
  };

  /** A marker shape in grid units, as tools take them. */
  const shapeInfo = (shape: MarkerShape) => {
    const r = editor.resolution;
    if (shape.kind === "point") {
      return {
        at: shape.at.map((n) => n * r),
        ...(shape.up ? { up: directionName(shape.up) } : {}),
        ...(shape.forward ? { forward: directionName(shape.forward) } : {}),
      };
    }
    const box = sourceToCells(shape.shape, r);
    return { volume: { kind: presetOf(shape.shape.kind, shape.shape) ?? shape.shape.kind, min: box.min, max: box.max, ...(shape.shape.up ? { up: directionName(shape.shape.up) } : {}) } };
  };

  /** The markers where they are on the active frame. */
  const markerInfo = () =>
    editor.markers.map((m) => {
      const placement = editor.markerAt(m.id, editor.activeFrameId)!;
      return {
        id: m.id,
        name: m.name,
        role: m.role ?? null,
        ...shapeInfo(placement.shape),
        ...(m.keys?.length ? { keyed: true, hidden: placement.hidden } : {}),
        ...(m.data !== undefined ? { data: m.data } : {}),
      };
    });

  const groupInfo = () =>
    editor.groups.map((g) => ({
      id: g.id,
      name: g.name,
      visible: g.visible,
      ...(g.blend ? { blend: blendName(g.blend) } : {}),
      ...(g.effects?.length ? { effects: g.effects } : {}),
      ...(g.group ? { group: g.group } : {}),
    }));

  const originInfo = () => editor.origin.map((n) => n * editor.resolution);

  const requireEditable = () => {
    const blocker = editor.editBlocker();
    if (blocker) fail(`${blocker}; edit_layer can show or unlock it, or select another layer`);
  };

  const requireSelection = () => {
    if (!editor.hasSelection) fail("Nothing is selected; use select first");
  };

  const mirrorNote = () => {
    const axes = AXES.filter((_, a) => editor.mirror[a]);
    return axes.length ? { mirrored: axes } : {};
  };

  /** The result of a brush-like edit, with what the agent needs to know about why it may have done less. */
  const edited = (changed: number) =>
    JSON.stringify({
      changed,
      ...mirrorNote(),
      ...(editor.hasSelection
        ? { note: "Something is selected, so only selected cells could change; select with action none to clear it." }
        : {}),
      undo: editor.undoLabel,
    });

  const workplaneInfo = () => {
    const { axis, level, clip } = editor.workplane;
    return { axis: AXES[axis], level, clip: CLIPS[CLIP_MODES.indexOf(clip)] };
  };

  const selectionInfo = () => ({
    selected: editor.selectionCount,
    bounds: editor.selectionBounds(),
  });

  /** A shape layer's steps, bottom first, as the cells their boxes cover and their exact source corners. */
  const stepInfo = (shape: ShapeSource) =>
    shape.steps.map((s) => ({
      id: s.id,
      ...(s.name ? { name: s.name } : {}),
      mode: s.mode,
      shape: presetOf(s.shape.kind, s.shape) ?? s.shape.kind,
      kind: s.shape.kind,
      ...paramsOf(s.shape),
      ...(s.shape.points
        ? { points: s.shape.points.map((p) => ({ at: p.at.map((n) => Math.floor(n * editor.resolution)), ...(p.radius ? { radius: p.radius } : {}) })) }
        : {}),
      ...(s.shape.up ? { up: directionName(s.shape.up) } : {}),
      ...(s.shape.forward ? { forward: directionName(s.shape.forward) } : {}),
      ...(s.shape.shell ? { shell: s.shape.shell } : {}),
      ...(s.shape.kind === "limb" ? { corner: s.shape.corner ?? 0, ...(s.shape.radius ? { radius: s.shape.radius } : {}), ...(s.shape.tip !== undefined ? { tip: s.shape.tip } : {}) } : {}),
      ...sourceToCells(s.shape, editor.resolution),
      source: { min: s.shape.min, max: s.shape.max },
      color: s.material,
      ...(s.fill ? { fill: { ...s.fill, ...(s.fill.axis !== undefined ? { axis: AXES[s.fill.axis] } : {}) } } : {}),
      keep: !!s.keep,
    }));

  const layerInfo = () =>
    editor.layers.map((l) => {
      const values = editor.layerValues(l);
      return {
        id: l.id,
        name: l.name,
        kind: layerKind(l),
        visible: l.visible,
        locked: l.locked,
        active: l.id === editor.activeLayerId,
        voxels: countMask(values),
        bounds: maskBounds(values, editor.size),
        ...(l.shape ? { steps: stepInfo(l.shape) } : {}),
        ...(l.coverage ? { covered: countMask(l.coverage) } : {}),
        ...(l.blend ? { blend: blendName(l.blend) } : {}),
        ...(l.mask ? { masked: countMask(l.mask) } : {}),
        ...(l.effects?.length ? { effects: l.effects } : {}),
        ...(l.group ? { group: l.group } : {}),
      };
    });

  const paletteInfo = () => editor.palette.map((c, i) => (i === 0 ? null : toHex(c)));

  const findShapeStep = (layerRef: unknown, id: unknown) => {
    const layer = findLayer(layerRef);
    if (!layer.shape) fail(`“${layer.name}” isn't a shape layer; get_document lists each layer's kind`);
    const step = typeof id === "string" ? findStep(layer.shape, id) : null;
    if (!step) fail(`No step with id ${JSON.stringify(id)} in “${layer.name}”; get_document lists its steps`);
    return { layer, step };
  };

  const SHAPE_ACTIONS = [
    "new_layer",
    "add_step",
    "set_box",
    "set_mode",
    "set_keep",
    "set_shape",
    "set_fill",
    "move_step",
    "duplicate_step",
    "rename_step",
    "remove_step",
    "recolor",
    "bake",
    "convert_to_override",
    "clear_override",
    "set_resolution",
  ] as const;

  const shapesTool = (): AgentTool => ({
    name: "edit_shapes",
    title: "Edit shape layers",
    description:
      "Shape layers keep shapes editable: changing a step regenerates its voxels, and voxels drawn on override " +
      "layers above stay put. A shape layer is a stack of steps, bottom first. Each step is a shape inscribed in a " +
      "box (`shape`: box, cylinder, cone, pyramid and hexagon are prisms, the others are sphere, capsule, wedge, diamond, " +
      "torus, arch and limb, pointing `up`; tube, wall and slab are paths through `points` (cells), straight or `smooth`, " +
      "maybe `closed`, with a `radius` (tubes, also per point), `width` and `height`; options: `forward` (a wedge's slope, where a sweep starts), a hollow `shell` " +
      "with `openTop` / `openBottom`, a prism's `sides`, `taper`, `round`, `roundTop` and `roundBottom`, a `sweep`, a " +
      "torus's `tube`, a limb's `radius`, `tip` and `corner`), a mode and a " +
      "color, applied to everything below it in that layer (never other layers): add fills the shape, cut empties " +
      "it, intersect keeps only what is inside it, paint recolors what is inside it without changing the volume. " +
      "With keep, add only fills empty cells and intersect doesn't recolor (it keeps by default). Each action is " +
      "one undo step. Boxes are cells (min/max, inclusive, like other tools). new_layer makes a shape layer from " +
      "a box (or an empty one, given no min/max); add_step puts a box with `mode` (and `keep`) on top of `layer`'s stack; set_box moves or resizes " +
      "`step`; set_shape changes its shape and options; set_fill varies its color from `color` to `color2` " +
      "(gradient along `axis` through the palette slots between them, checker cubes or stripes `size` thick; solid = one color); set_mode and set_keep change what it does; move_step moves it to `index` (0 = the bottom); " +
      "duplicate_step copies it to just above itself; rename_step gives it a `name` (empty clears it); remove_step takes it out; recolor gives it a color; bake turns `layer` into an override layer of its voxels, editable voxel by voxel. Override layers cover cells: a covered empty cell erases what is " +
      "below, so the brush tools can erase and paint shapes there. New layers in a model with shapes are " +
      "override layers; convert_to_override turns a plain layer into one, and clear_override uncovers its " +
      "selected cells (or all), revealing what is below. set_resolution (1, 2, 4 or 8) sets voxels per unit: " +
      "shapes keep their size and get finer, and raster layers are resampled. get_document lists layers' kinds " +
      "and steps.",
    inputSchema: object(
      {
        action: enumSchema(SHAPE_ACTIONS, "What to do."),
        layer: { type: "string", description: "The layer's id or name. Defaults to the active layer." },
        step: { type: "string", description: "For the actions on one step: the step's id, from get_document." },
        name: { type: "string", description: "For rename_step: the step's new name; empty clears it." },
        mode: enumSchema(STEP_MODES, "For add_step and set_mode. Defaults to add."),
        shape: enumSchema(
          SHAPE_NAMES,
          "For add_step (defaults to box) and set_shape: a preset (box, cylinder, cone, pyramid, hexagon and the other kinds by name, arch a half torus) or a kind (prism: round unless sides say otherwise).",
        ),
        up: shapeProperties.up,
        forward: enumSchema(DIRECTIONS, "Wedges: the way the slope faces, across up. Defaults to +z (+x when up is z)."),
        shell: { type: "number", description: "Hollow: wall thickness in source units (1/8 steps); 0 = solid." },
        openTop: { type: "boolean", description: "Hollow shapes (shell): no wall at the top, the end up points through (a cup)." },
        openBottom: { type: "boolean", description: "Hollow shapes: no wall at the bottom (with openTop, a pipe)." },
        sides: { type: "integer", minimum: 0, maximum: 12, description: "Prisms: the cross-section's sides, 3 to 12; 0 = round." },
        taper: { type: "number", description: "Prisms: how much the top shrinks, 0 (straight) to 1 (a point), in 1/8 steps." },
        round: { type: "number", description: "Straight prisms: edge radius in source units (1/8 steps): a box's every edge, a cylinder's rims." },
        roundTop: { type: "number", description: "Straight prisms: the top edges' radius instead of round (0 = sharp); a box's upright edges keep round." },
        roundBottom: { type: "number", description: "Straight prisms: the bottom edges' radius instead of round (0 = sharp)." },
        points: {
          type: "array",
          description:
            "Tubes, walls and slabs (paths; for add_step, and set_shape to replace them): the cells the path goes through, in order, each [x, y, z] or { at: [x, y, z], radius } (a tube's own radius there, source units).",
          items: {},
        },
        profile: enumSchema(PATH_PROFILES, "Paths: what they make: tube (round, radius), wall (width thick, height tall, standing on the points) or slab (filling the closed outline, height tall)."),
        smooth: { type: "boolean", description: "Paths: a smooth curve through the points instead of straight lines." },
        closed: { type: "boolean", description: "Paths: join the last point to the first (slabs always are)." },
        width: { type: "number", description: "Walls: thickness, in source units (1/8 steps). Default 1." },
        height: { type: "number", description: "Walls and slabs: height, in source units (1/8 steps). Default 4." },
        sweep: { type: "integer", description: "Prisms, spheres and tori: how far round they go, in degrees from forward about up, a multiple of 15 (0 or 360 = all the way)." },
        tube: { type: "number", description: "Tori: the tube's radius across the ring, in source units, so its thickness and the hole are set apart. Default: half the height." },
        radius: { type: "number", description: "Limbs (a tapered tube from one corner of the box to the opposite one): the radius at the base, in source units (1/8 steps). Default: half the box's smallest side." },
        tip: { type: "number", description: "Limbs: the radius at the tip, in source units. Default: the base radius." },
        corner: { type: "integer", minimum: 0, maximum: 7, description: "Limbs: the box corner they grow from; bit 1 = max x, 2 = max y, 4 = max z (0 = the min corner, growing up to +x+y+z)." },
        keep: { type: "boolean", description: "For add_step and set_keep: keep the colors below where the step overlaps them." },
        index: { type: "integer", description: "For move_step: the new position, 0 = the bottom." },
        ...boxProperties,
        color: colorSchema,
        resolution: { type: "integer", enum: [1, 2, 4, 8], description: "For set_resolution." },
        fill: enumSchema(["solid", ...FILL_KINDS] as const, "For set_fill."),
        color2: { ...colorSchema, description: "For set_fill: the second color (a palette index or hex)." },
        axis: axisSchema("For set_fill: a gradient's or stripes' axis. Defaults to y."),
        size: { type: "number", description: "For set_fill: checker cube or stripe size in source units (1/8 steps). Defaults to 1." },
      },
      ["action"],
    ),
    execute: (input) => {
      const action = readEnum(input.action, SHAPE_ACTIONS, "action");
      const sourceBox = () => cellsToSource(readBox(input), editor.resolution);
      /** The shape options given, leaving out the ones that weren't. */
      const shapeOptions = (): ShapeOptions => {
        const out: { -readonly [K in keyof ShapeOptions]: ShapeOptions[K] } = {};
        if (input.up !== undefined) out.up = readDirection(input.up);
        if (input.forward !== undefined) out.forward = readDirection(input.forward, "forward");
        const shell = readSize8(input.shell, "shell");
        const round = readSize8(input.round, "round");
        const roundTop = readSize8(input.roundTop, "roundTop");
        const roundBottom = readSize8(input.roundBottom, "roundBottom");
        const taper = readSize8(input.taper, "taper");
        if (shell !== undefined) out.shell = shell;
        if (round !== undefined) out.round = round;
        if (roundTop !== undefined) out.roundTop = roundTop;
        if (roundBottom !== undefined) out.roundBottom = roundBottom;
        const radius = readSize8(input.radius, "radius");
        const tip = readSize8(input.tip, "tip");
        if (radius !== undefined) out.radius = radius;
        if (tip !== undefined) out.tip = tip;
        if (input.corner !== undefined) out.corner = readCorner(input.corner);
        if (taper !== undefined) out.taper = taper;
        if (input.sides !== undefined) out.sides = readInt(input.sides, "sides", 0, 12);
        const tube = readSize8(input.tube, "tube");
        if (tube !== undefined) out.tube = tube;
        if (input.sweep !== undefined) out.sweep = readInt(input.sweep, "sweep", 0, 360);
        for (const key of ["openTop", "openBottom", "smooth", "closed"] as const) {
          if (input[key] === undefined) continue;
          if (typeof input[key] !== "boolean") fail(`${key} is true or false`);
          out[key] = input[key] as boolean;
        }
        if (input.profile !== undefined) out.profile = readEnum(input.profile, PATH_PROFILES, "profile");
        for (const key of ["width", "height"] as const) {
          const n = readSize8(input[key], key);
          if (n !== undefined) out[key] = n;
        }
        if (input.points !== undefined) {
          if (!Array.isArray(input.points) || input.points.length === 0) fail("points is a list of cells, [x, y, z] or { at: [x, y, z], radius }");
          const r = editor.resolution;
          // a cell stands for its middle
          out.points = (input.points as unknown[]).map((raw, i) => {
            const p = (Array.isArray(raw) ? { at: raw } : raw) as Input;
            const at = readGridPoint(p?.at, `points[${i}]`).map((n) => snapSource((n + 0.5) / r)) as Vec3;
            const radius = readSize8(p.radius, `points[${i}].radius`);
            return { at, ...(radius ? { radius } : {}) };
          });
        }
        return out;
      };
      let result: Record<string, unknown> = {};
      switch (action) {
        case "new_layer": {
          // without a box, an empty layer to add steps to
          const empty = input.min === undefined && input.max === undefined;
          const id = (empty ? editor.newShapeLayer() : editor.addBoxLayer(sourceBox(), readColor(input.color))) ?? fail(why("Couldn't add the layer"));
          result = { layer: id };
          break;
        }
        case "add_step": {
          const layer = findLayer(input.layer);
          if (!layer.shape) fail(`“${layer.name}” isn't a shape layer; new_layer makes one`);
          const mode = readEnum(input.mode, STEP_MODES, "mode", "add");
          if (input.keep !== undefined && typeof input.keep !== "boolean") fail("keep is true or false");
          const keep = input.keep as boolean | undefined;
          const kind = readEnum(input.shape, SHAPE_NAMES, "shape", "box");
          const options = shapeOptions();
          // a path's box is where its points reach
          const path = presetShape(kind === "prism" ? "cylinder" : kind).kind === "path";
          if (path && !options.points) fail(`A ${kind} needs points`);
          const box = path ? { min: options.points![0].at, max: options.points![0].at } : sourceBox();
          const id = editor.addStep(layer.id, mode, box, readColor(input.color), { keep, kind, ...options }) ?? fail(why("Couldn't add the step"));
          result = { step: id };
          break;
        }
        case "set_box": {
          const { layer, step } = findShapeStep(input.layer, input.step);
          if (!editor.setStepBox(layer.id, step.id, sourceBox())) fail(why("Couldn't change the box"));
          break;
        }
        case "set_mode": {
          const { layer, step } = findShapeStep(input.layer, input.step);
          if (!editor.setStepMode(layer.id, step.id, readEnum(input.mode, STEP_MODES, "mode"))) fail(why("Couldn't change the step"));
          break;
        }
        case "set_keep": {
          const { layer, step } = findShapeStep(input.layer, input.step);
          if (typeof input.keep !== "boolean") fail("set_keep needs keep, true or false");
          if (!editor.setStepKeep(layer.id, step.id, input.keep as boolean)) fail(why("Couldn't change the step"));
          break;
        }
        case "set_shape": {
          const { layer, step } = findShapeStep(input.layer, input.step);
          const kind = input.shape === undefined ? undefined : readEnum(input.shape, SHAPE_NAMES, "shape");
          const options = shapeOptions();
          if (!kind && !Object.keys(options).length) {
            fail("set_shape needs shape, up, forward, shell, openTop, openBottom, sides, taper, round, roundTop, roundBottom, sweep, tube, radius, tip or corner");
          }
          if (!editor.setStepShape(layer.id, step.id, { kind, ...options })) fail(why("Couldn't change the shape"));
          break;
        }
        case "set_fill": {
          const { layer, step } = findShapeStep(input.layer, input.step);
          const kind = readEnum(input.fill, ["solid", ...FILL_KINDS] as const, "fill");
          const fill =
            kind === "solid"
              ? null
              : stepFill(kind, readColor(input.color2), {
                  axis: input.axis === undefined ? undefined : readAxis(input.axis, "axis"),
                  size: readSize8(input.size, "size"),
                });
          const color = input.color === undefined ? null : readColor(input.color);
          // one undo step; the fill goes first, as only it can be turned down
          editor.transact(fill ? "Change fill" : "One color", () => {
            if (!editor.setStepFill(layer.id, step.id, fill)) fail(why("Couldn't change the fill"));
            if (color !== null) editor.setStepMaterial(layer.id, step.id, color);
          });
          break;
        }
        case "move_step": {
          const { layer, step } = findShapeStep(input.layer, input.step);
          if (!editor.moveStep(layer.id, step.id, readInt(input.index, "index", 0, 255))) fail(why("Couldn't move the step"));
          break;
        }
        case "duplicate_step": {
          const { layer, step } = findShapeStep(input.layer, input.step);
          result = { step: editor.duplicateStep(layer.id, step.id) ?? fail(why("Couldn't duplicate the step")) };
          break;
        }
        case "rename_step": {
          const { layer, step } = findShapeStep(input.layer, input.step);
          if (typeof input.name !== "string") fail("rename_step needs name, text");
          if (!editor.setStepName(layer.id, step.id, input.name as string)) fail(why("Couldn't rename the step"));
          break;
        }
        case "remove_step": {
          const { layer, step } = findShapeStep(input.layer, input.step);
          if (!editor.removeStep(layer.id, step.id)) fail(why("Couldn't remove the step"));
          break;
        }
        case "recolor": {
          const { layer, step } = findShapeStep(input.layer, input.step);
          if (!editor.setStepMaterial(layer.id, step.id, readColor(input.color))) fail(why("Couldn't recolor the step"));
          break;
        }
        case "bake": {
          const layer = findLayer(input.layer);
          if (!layer.shape) fail(`“${layer.name}” isn't a shape layer`);
          if (!editor.bakeShapeLayer(layer.id)) fail(why("Couldn't bake the layer"));
          break;
        }
        case "convert_to_override": {
          const layer = findLayer(input.layer);
          if (layer.shape) fail("Shape layers can't become override layers");
          if (!layer.coverage && !editor.convertToOverride(layer.id)) fail(why("Couldn't convert the layer"));
          break;
        }
        case "clear_override": {
          const layer = findLayer(input.layer);
          if (!layer.coverage) fail(`“${layer.name}” isn't an override layer`);
          result = { changed: editor.clearOverride(layer.id) };
          break;
        }
        case "set_resolution": {
          const m = readInt(input.resolution, "resolution", 1, 8);
          if (m !== editor.resolution && !editor.setResolution(m)) fail(why("Couldn't change the resolution"));
          view?.fit();
          result = { resolution: editor.resolution, size: editor.size };
          break;
        }
      }
      return JSON.stringify({ ...result, layers: layerInfo(), undo: editor.undoLabel });
    },
  });

  // #endregion

  const tools: AgentTool[] = [
    {
      name: "get_document",
      title: "Get document",
      description:
        "Describe the open voxel model: its size, palette, layers, selection and editor state. Call this first. " +
        "Cells are [x, y, z] integers from 0 to size - 1; Y is up and the front view looks down -Z. " +
        "Each voxel is empty or one palette color; palette[i] is the hex color of index i (index 0 means empty). " +
        "Edits go to the active layer. While something is selected, edits only change selected cells. " +
        "Enabled mirror planes reflect every edit and selection across the middle of the volume. " +
        "Markers are named points and volumes that aren't voxels (mounts, colliders, hitboxes), and the origin is " +
        "the point the model is placed by; see edit_markers. A rigged character is a scene of part models, each " +
        "attached to a mount marker on its parent part. " +
        "The workplane is where the user's tools place voxels with nothing to build on; while it clips, edits and " +
        "selections skip the hidden cells (see set_workplane). " +
        "The model can be a flipbook animation: `animation.frames` are poses in playing order, each with every " +
        "layer's voxels. Edits and reads go to the active frame; see edit_frames.",
      inputSchema: object({}),
      annotations: { readOnlyHint: true },
      execute: () =>
        JSON.stringify({
          name: editor.name,
          size: editor.size,
          resolution: editor.resolution,
          palette: paletteInfo(),
          color: editor.color,
          layers: layerInfo(),
          bounds: editor.contentBounds(),
          selection: editor.hasSelection ? selectionInfo() : null,
          mirror: AXES.filter((_, a) => editor.mirror[a]),
          workplane: workplaneInfo(),
          animation: animationInfo(),
          groups: groupInfo(),
          markers: markerInfo(),
          origin: originInfo(),
          undo: editor.undoLabel,
          redo: editor.redoLabel,
        }),
    },

    {
      name: "get_projection",
      title: "Get projection",
      description:
        "See the model as a flat image from one side, like the user's 2D view: for each pixel, the color of the " +
        "front visible voxel and how deep it is. Much smaller than get_voxels for understanding a silhouette, a " +
        "face or a front view. Rows run top to bottom and pixels left to right, as on screen; `right` and `up` " +
        "name the axis and direction each runs along, with the cell coordinates of the first and last pixel. " +
        "The image is cropped to what is visible. `colors` holds palette indices (0 = nothing there); `depth` " +
        "holds the front voxel's coordinate along `depthAxis` (null where empty), and the viewer is on the " +
        "`toward` side. The workplane's clip applies, so a clipped view is a cross-section.",
      inputSchema: object({ view: enumSchema(AXIS_VIEWS, "Which side to look from: front looks down -Z, top looks down -Y.") }, ["view"]),
      annotations: { readOnlyHint: true },
      execute: (input) => {
        const name = readEnum(input.view, AXIS_VIEWS, "view");
        const view = VIEW_AXES[name];
        const image = editor.project(view.axis, view.side);
        // image coordinates (u, v) are the next two axes after the view's axis
        const at = (a: Axis, n: number) => (a === image.u ? [n, 0] : [0, n]);
        const [ra, rs] = view.right;
        const [ua, us] = view.up;
        // crop to the filled pixels, in screen order
        let r0 = Infinity, r1 = -Infinity, t0 = Infinity, t1 = -Infinity;
        for (let iv = 0; iv < image.height; iv++)
          for (let iu = 0; iu < image.width; iu++) {
            if (image.depth[iu + image.width * iv] < 0) continue;
            const c = [0, 0, 0];
            c[image.u] = iu;
            c[image.v] = iv;
            r0 = Math.min(r0, c[ra]); r1 = Math.max(r1, c[ra]);
            t0 = Math.min(t0, c[ua]); t1 = Math.max(t1, c[ua]);
          }
        const axisName = (a: Axis, sign: number) => `${sign > 0 ? "+" : "-"}${AXES[a]}`;
        const base = { view: name, depthAxis: AXES[view.axis], toward: axisName(view.axis, view.side) };
        if (r0 > r1) return JSON.stringify({ ...base, empty: true });
        // screen order: right runs from the low end of `ra` when rs > 0; rows run from the top
        const cols = rs > 0 ? range(r0, r1) : range(r1, r0);
        const rows = us > 0 ? range(t1, t0) : range(t0, t1);
        if (cols.length * rows.length > MAX_PIXELS_OUT) {
          fail(`The view is ${cols.length}×${rows.length} pixels, more than ${MAX_PIXELS_OUT}. Use get_voxels with a box.`);
        }
        const colors: number[][] = [];
        const depth: (number | null)[][] = [];
        for (const t of rows) {
          const colorRow: number[] = [];
          const depthRow: (number | null)[] = [];
          for (const r of cols) {
            const [ru, rv] = at(ra, r);
            const [tu, tv] = at(ua, t);
            const p = ru + tu + image.width * (rv + tv);
            colorRow.push(image.color[p]);
            depthRow.push(image.depth[p] < 0 ? null : image.depth[p]);
          }
          colors.push(colorRow);
          depth.push(depthRow);
        }
        return JSON.stringify({
          ...base,
          right: { axis: axisName(ra, rs), from: cols[0], to: cols[cols.length - 1] },
          up: { axis: axisName(ua, us), top: rows[0], bottom: rows[rows.length - 1] },
          colors,
          depth,
        });
      },
    },

    {
      name: "get_voxels",
      title: "Get voxels",
      description:
        "List the filled voxels in a box as [x, y, z, color] (color is a palette index). " +
        "Reads what is visible (the topmost visible layer at each cell), or one layer. " +
        "Defaults to the whole volume, in the active frame.",
      inputSchema: object({
        ...boxProperties,
        layer: { type: "string", description: "Read only this layer (id or name), even if hidden." },
        frame: { type: ["string", "integer"], description: "Read this frame (id, or position from 0) instead of the active one." },
        limit: { type: "integer", description: `The most voxels to return (default 5000, at most ${MAX_VOXELS_OUT}).` },
      }),
      annotations: { readOnlyHint: true },
      execute: (input) => {
        const size = editor.size;
        const box =
          input.min === undefined && input.max === undefined
            ? { min: [0, 0, 0] as Vec3, max: size.map((n) => n - 1) as Vec3 }
            : readBox(input);
        const limit = readInt(input.limit, "limit", 1, MAX_VOXELS_OUT, 5000);
        // what is visible composes shapes and overrides; one layer reads its own values
        const frame = input.frame === undefined ? null : findFrame(input.frame);
        const values =
          input.layer === undefined
            ? frame
              ? editor.evaluateFrame(frame)
              : editor.evaluate()
            : frame
              ? editor.frameCel(frame, findLayer(input.layer).id)
              : editor.layerValues(findLayer(input.layer));
        const voxels: [number, number, number, number][] = [];
        const colors: Record<number, number> = {};
        let total = 0;
        const lo = box.min.map((n) => Math.max(0, n));
        const hi = box.max.map((n, a) => Math.min(size[a] - 1, n));
        for (let z = lo[2]; z <= hi[2]; z++)
          for (let y = lo[1]; y <= hi[1]; y++)
            for (let x = lo[0]; x <= hi[0]; x++) {
              const i = editor.index(x, y, z);
              const v = values[i];
              if (!v) continue;
              total++;
              colors[v] = (colors[v] ?? 0) + 1;
              if (voxels.length < limit) voxels.push([x, y, z, v]);
            }
        return JSON.stringify({ total, colors, voxels, ...(total > voxels.length ? { truncated: true } : {}) });
      },
    },

    {
      name: "set_voxels",
      title: "Set voxels",
      description:
        "Set individual voxels on the active layer, replacing whatever is there, as one undo step. " +
        "Each entry is [x, y, z, color]; color is a palette index, a hex color, or 0 to erase. " +
        "For boxes, spheres and other solids, place_shapes is much shorter.",
      inputSchema: object(
        {
          voxels: {
            type: "array",
            items: { type: "array", items: { type: ["integer", "string"] }, minItems: 4, maxItems: 4 },
            description: "[[x, y, z, color], …]",
          },
        },
        ["voxels"],
      ),
      execute: (input) => {
        if (!Array.isArray(input.voxels)) fail("voxels must be a list of [x, y, z, color]");
        requireEditable();
        const groups = new Map<number, Vec3[]>();
        for (const entry of input.voxels) {
          if (!Array.isArray(entry) || entry.length !== 4) fail("Each voxel must be [x, y, z, color]");
          const cell = readCell(entry.slice(0, 3), "Each voxel's position");
          const value = readColor(entry[3], true);
          const cells = groups.get(value);
          if (cells) cells.push(cell);
          else groups.set(value, [cell]);
        }
        let changed = 0;
        editor.transact("Set voxels", () => {
          for (const [value, cells] of groups) changed += editor.setCells(cells, value);
        });
        return edited(changed);
      },
    },

    {
      name: "brush_stroke",
      title: "Brush stroke",
      description:
        "Sweep a round brush along a line of points on the active layer, adding, erasing or painting every cell " +
        "it passes through, in empty space too, as one undo step. Points are cell coordinates and may be fractional " +
        "([2, 0, 3] is the middle of that cell). Good for wires, branches, tunnels and freehand lines; mirrored like other edits.",
      inputSchema: object(
        {
          points: {
            type: "array",
            items: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
            minItems: 1,
            description: "[[x, y, z], …] in order; one point stamps the brush once",
          },
          op: enumSchema(["add", "erase", "paint"], "Defaults to add."),
          size: { type: "integer", minimum: 1, maximum: MAX_SPATIAL_BRUSH, description: "Cells across the brush. Defaults to 1." },
          color: colorSchema,
        },
        ["points"],
      ),
      execute: (input) => {
        if (!Array.isArray(input.points) || !input.points.length) fail("points must be a non-empty list of [x, y, z]");
        const points = input.points.map((p, i) => readGridPoint(p, `points[${i}]`).map((n) => n + 0.5) as Vec3);
        const op = readEnum(input.op, ["add", "erase", "paint"] as const, "op", "add");
        const size = readInt(input.size, "size", 1, MAX_SPATIAL_BRUSH, 1);
        const value = readColor(input.color);
        requireEditable();
        const brush = editor.spatial;
        const before = brush.size;
        brush.setSize(size);
        try {
          return edited(brush.stroke(points, op, value));
        } finally {
          brush.setSize(before);
        }
      },
    },

    {
      name: "place_shapes",
      title: "Place shapes",
      description:
        "Add, erase or paint solid shapes on the active layer, in order, as one undo step. " +
        "Each shape fills the box between two corners: a box, or a sphere, cylinder, cone, capsule, pyramid, wedge, diamond, torus or limb (a tube from one corner to the opposite one: `corner`, `radius` and `tip` set it) inscribed in it. " +
        '"add" fills only empty cells, "erase" empties cells, "paint" recolors only filled cells. ' +
        "Build a model from many shapes in one call; later shapes can carve or recolor earlier ones.",
      inputSchema: object(
        {
          shapes: {
            type: "array",
            items: object(
              {
                ...shapeProperties,
                corner: {
                  type: "integer",
                  minimum: 0,
                  maximum: 7,
                  description: "Limbs: the box corner they grow from, to the opposite one; bit 1 = max x, 2 = max y, 4 = max z. Defaults to 0, the min corner.",
                },
                radius: { type: "number", minimum: 0, description: "Limbs: the radius at the base, in voxels. Defaults to half the box's smallest side." },
                tip: { type: "number", minimum: 0, description: "Limbs: the radius at the tip, in voxels. Defaults to the base radius." },
                op: enumSchema(["add", "erase", "paint"], "Defaults to add."),
                color: colorSchema,
              },
              ["min", "max"],
            ),
          },
        },
        ["shapes"],
      ),
      execute: (input) => {
        if (!Array.isArray(input.shapes) || input.shapes.length === 0) fail("shapes must be a non-empty list");
        requireEditable();
        const ops = (input.shapes as Input[]).map((s) => {
          const op = readEnum(s.op, ["add", "erase", "paint"] as const, "op", "add");
          const shape = readShapeName(s.kind, "kind");
          const spec = {
            kind: shape.kind,
            params: shape.params,
            box: readBox(s),
            up: readDirection(s.up),
            hollow: s.hollow === true,
            ...(s.corner === undefined ? {} : { corner: readCorner(s.corner) }),
            ...(s.radius === undefined ? {} : { radius: readRadius(s.radius, "radius") }),
            ...(s.tip === undefined ? {} : { tip: readRadius(s.tip, "tip") }),
          };
          return { op, value: op === "erase" ? 0 : readColor(s.color), spec };
        });
        const [first] = ops;
        const label =
          ops.length === 1 ? `${first.op[0].toUpperCase()}${first.op.slice(1)} ${presetOf(first.spec.kind, first.spec.params) ?? first.spec.kind}` : "Place shapes";
        let changed = 0;
        editor.transact(label, () => {
          for (const { op, value, spec } of ops) changed += editor.applyCells(shapeCells(spec), op, value);
        });
        return edited(changed);
      },
    },

    {
      name: "fill",
      title: "Fill",
      description:
        "Recolor the voxels on the active layer that share the color at a filled cell: the connected region " +
        "(face-adjacent), or every voxel of that color. One undo step.",
      inputSchema: object(
        {
          at: cellSchema("A filled cell on the active layer, [x, y, z]."),
          color: colorSchema,
          scope: enumSchema(["connected", "all"], "Defaults to connected."),
        },
        ["at"],
      ),
      execute: (input) => {
        const at = readCell(input.at, "at");
        const value = readColor(input.color);
        const scope = readEnum(input.scope, ["connected", "all"] as const, "scope", "connected");
        requireEditable();
        if (!editor.getVoxel(at)) fail(`The active layer has no voxel at ${JSON.stringify(at)}`);
        const data = editor.activeLayer!.data;
        const before = data.reduce((n, v) => n + (v === value ? 1 : 0), 0);
        editor.fill(at, value, scope);
        const after = data.reduce((n, v) => n + (v === value ? 1 : 0), 0);
        return edited(after - before);
      },
    },

    {
      name: "select",
      title: "Select",
      description:
        "Change the selection: a mask of cells (empty or filled) that edits are limited to and that " +
        "transform_selection and edit_selection act on. Selecting is undoable but not saved. " +
        'Actions: "box" or "shape" select the cells of a shape; "color" selects voxels of the color at a cell ' +
        '(connected, or all of them); "all" selects every visible voxel; "none" clears; "invert", "grow", ' +
        '"shrink", and "connected" (add every voxel touching the selection) change the current selection. ' +
        "mode combines box, shape and color selections with the current one.",
      inputSchema: object(
        {
          action: enumSchema(
            ["box", "shape", "color", "all", "none", "invert", "grow", "shrink", "connected"],
            "What to select.",
          ),
          mode: enumSchema(SELECT_MODES, "Defaults to replace."),
          ...shapeProperties,
          at: cellSchema('For "color": a filled cell whose color to select.'),
          scope: enumSchema(["connected", "all"], 'For "color". Defaults to connected.'),
        },
        ["action"],
      ),
      execute: (input) => {
        const action = readEnum(
          input.action,
          ["box", "shape", "color", "all", "none", "invert", "grow", "shrink", "connected"] as const,
          "action",
        );
        const mode = readEnum(input.mode, SELECT_MODES, "mode", "replace");
        switch (action) {
          case "box":
            editor.selectBox(readBox(input), mode);
            break;
          case "shape":
            editor.selectShape(
              {
                ...(({ kind, params }) => ({ kind, params }))(readShapeName(input.kind, "kind")),
                box: readBox(input),
                up: readDirection(input.up),
                hollow: input.hollow === true,
              },
              mode,
            );
            break;
          case "color":
            editor.selectColor(
              readCell(input.at, "at"),
              readEnum(input.scope, ["connected", "all"] as const, "scope", "connected"),
              mode,
            );
            break;
          case "all":
            editor.selectAll();
            break;
          case "none":
            editor.deselect();
            break;
          case "invert":
            editor.invertSelection();
            break;
          case "grow":
            editor.growSelection();
            break;
          case "shrink":
            editor.shrinkSelection();
            break;
          case "connected":
            editor.selectConnected();
            break;
        }
        return JSON.stringify({ ...selectionInfo(), ...mirrorNote() });
      },
    },

    {
      name: "transform_selection",
      title: "Transform selection",
      description:
        "Move, rotate (90° turns about the center of its bounds) and flip the selected voxels of the active layer, " +
        "or the whole layer if nothing is selected, as one undo step. Steps run in order; content stays inside the volume. " +
        "With copy, the original stays put and a copy is transformed.",
      inputSchema: object(
        {
          steps: {
            type: "array",
            items: object({
              move: cellSchema("Move by [dx, dy, dz] cells."),
              rotate: axisSchema("Turn 90° around this axis (right-handed: around y, +x turns toward -z)."),
              turns: { type: "integer", description: "For rotate: how many quarter turns; negative turns the other way. Defaults to 1." },
              flip: axisSchema("Mirror along this axis."),
            }),
            description: "Each step has one of move, rotate or flip.",
          },
          copy: { type: "boolean", description: "Transform a copy, leaving the original in place." },
        },
        ["steps"],
      ),
      execute: (input) => {
        if (!Array.isArray(input.steps)) fail("steps must be a list");
        const steps = (input.steps as Input[]).map((step) => {
          if (step.move !== undefined) return { move: readCell(step.move, "move") };
          if (step.rotate !== undefined) {
            return { rotate: readAxis(step.rotate, "rotate"), turns: readInt(step.turns, "turns", -3, 3, 1) };
          }
          if (step.flip !== undefined) return { flip: readAxis(step.flip, "flip") };
          return fail("Each step needs move, rotate or flip");
        });
        requireEditable();
        if (input.copy === true) {
          requireSelection();
          editor.duplicateSelection();
        } else if (!editor.liftSelection()) {
          fail("Nothing to move");
        }
        for (const step of steps) {
          if (step.move) editor.moveSelection(step.move);
          else if (step.rotate !== undefined) editor.rotateSelection(step.rotate, step.turns);
          else if (step.flip !== undefined) editor.flipSelection(step.flip);
        }
        const f = editor.floating!;
        const bounds: Box = { min: [...f.offset], max: f.offset.map((n, a) => n + f.size[a] - 1) as Vec3 };
        editor.applyTransform();
        return JSON.stringify({ bounds, selected: editor.selectionCount, undo: editor.undoLabel });
      },
    },

    {
      name: "extrude",
      title: "Extrude",
      description:
        "Pull a face of the active layer out by depth layers, or push it in with a negative depth, as one undo step. " +
        "The face is the connected, coplanar voxels around at whose sides look along direction into empty space; " +
        "while something is selected, only selected voxels count, so a selection can mark out part of a face. " +
        "Pulled-out cells copy the colors of the face voxels they grow from, and the selection grows with them. Mirror applies.",
      inputSchema: object(
        {
          at: cellSchema("A voxel of the active layer on the face, [x, y, z]."),
          direction: enumSchema(DIRECTIONS, "Which way the face looks: +y for a top face, -x for a left side, and so on."),
          depth: { type: "integer", description: "Layers to pull out; negative carves that many in, starting with the face." },
        },
        ["at", "direction", "depth"],
      ),
      execute: (input) => {
        const at = readCell(input.at, "at");
        const direction = readEnum(input.direction, DIRECTIONS, "direction");
        const depth = readInt(input.depth, "depth", -MAX_SIZE, MAX_SIZE);
        if (depth === 0) fail("depth must not be 0");
        requireEditable();
        if (!editor.getVoxel(at)) fail(`The active layer has no voxel at ${JSON.stringify(at)}`);
        const normal: Vec3 = [0, 0, 0];
        normal[AXES.indexOf(direction[1] as (typeof AXES)[number])] = direction[0] === "+" ? 1 : -1;
        const face = editor.extrusionRegion(at, normal);
        if (!face.length) {
          fail(
            editor.hasSelection && !editor.isSelected(at)
              ? "That voxel isn't selected; select it, or select with action none to clear the selection"
              : `The ${direction} side of that voxel is covered, so there's no face to extrude`,
          );
        }
        const before = editor.activeLayer!.data.slice();
        editor.extrude(at, normal, depth);
        const after = editor.activeLayer!.data;
        let changed = 0;
        for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) changed++;
        return JSON.stringify({ face: face.length, changed, ...mirrorNote(), undo: editor.undoLabel });
      },
    },

    {
      name: "edit_selection",
      title: "Edit selection",
      description:
        "Change the selected cells of the active layer as one undo step: delete them, fill every selected cell " +
        "(empty ones too) with a color, recolor the filled ones, or copy or move them to a new layer above.",
      inputSchema: object(
        {
          action: enumSchema(["delete", "fill", "recolor", "copy_to_layer", "move_to_layer"], "What to do."),
          color: colorSchema,
        },
        ["action"],
      ),
      execute: (input) => {
        const action = readEnum(
          input.action,
          ["delete", "fill", "recolor", "copy_to_layer", "move_to_layer"] as const,
          "action",
        );
        requireSelection();
        if (action !== "copy_to_layer") requireEditable();
        if (action === "copy_to_layer" || action === "move_to_layer") {
          const id = editor.selectionToLayer({ move: action === "move_to_layer" });
          return JSON.stringify({ layer: id, layers: layerInfo(), undo: editor.undoLabel });
        }
        const changed =
          action === "delete"
            ? editor.deleteSelection()
            : action === "fill"
              ? editor.fillSelection(readColor(input.color))
              : editor.recolorSelection(readColor(input.color));
        return JSON.stringify({ changed, undo: editor.undoLabel });
      },
    },

    {
      name: "edit_layer",
      title: "Edit layer",
      description:
        "Manage layers. Layers stack bottom to top; the topmost visible voxel shows. Actions: create (a new " +
        "empty layer above the active one, which becomes active), select (make active), rename, delete, " +
        "duplicate, move (to index, 0 = bottom), merge_down, clear, show, hide, lock, unlock. " +
        "Showing, hiding, locking and selecting aren't undoable; the rest are.",
      inputSchema: object(
        {
          action: enumSchema(
            LAYER_ACTIONS,
            "What to do.",
          ),
          layer: { type: "string", description: "The layer's id or name. Defaults to the active layer." },
          name: { type: "string", description: "For create and rename." },
          index: { type: "integer", description: "For move: the new position, 0 = bottom." },
        },
        ["action"],
      ),
      execute: (input) => {
        const action = readEnum(input.action, LAYER_ACTIONS, "action");
        const name = () => (typeof input.name === "string" && input.name.trim()) || fail("name is required");
        if (action === "create") {
          editor.createLayer(input.name === undefined ? undefined : name());
        } else {
          const { id } = findLayer(input.layer);
          switch (action) {
            case "select":
              editor.selectLayer(id);
              break;
            case "rename":
              editor.renameLayer(id, name());
              break;
            case "delete":
              editor.deleteLayer(id);
              break;
            case "duplicate":
              editor.duplicateLayer(id);
              break;
            case "move":
              editor.moveLayer(id, readInt(input.index, "index", 0, editor.layers.length - 1));
              break;
            case "merge_down":
              if (editor.layers[0].id === id) fail("The bottom layer has nothing to merge into");
              editor.mergeDown(id);
              break;
            case "clear":
              editor.clearLayer(id);
              break;
            case "show":
            case "hide":
              editor.setLayerVisible(id, action === "show");
              break;
            case "lock":
            case "unlock":
              editor.setLayerLocked(id, action === "lock");
              break;
          }
        }
        return JSON.stringify({ layers: layerInfo(), undo: editor.undoLabel });
      },
    },

    {
      name: "edit_pipeline",
      title: "Edit blends, masks, effects and groups",
      description:
        "Layers stack bottom to top like image layers. Each layer (and each group) has a blend saying how it combines with " +
        "what is below: normal (its solid voxels cover), behind (only fills empty cells), replace (overrides: covered " +
        "empties erase), cut (its solid voxels empty what is below), intersect (keeps only what it covers, recolored), " +
        "intersect_keep (keeps only what it covers, as it was), paint (recolors solid cells below, adds nothing), or " +
        "default (its kind's: normal, or replace for override layers). A mask limits where a layer acts: " +
        "mask_to_selection makes the selection its mask. Effects run on a layer's (or group's) voxels before it blends, " +
        "in order: mirror (axis), outline (color: a one-voxel skin), hollow (only the surface stays), noise (color, " +
        "amount 1-15 sixteenths, seed). A group is an isolated stack: its layers compose on their own first, so a cut " +
        "inside a group only cuts that group, then the result blends as one. Actions: set_blend, add_effect, " +
        "remove_effect, clear_effects, mask_to_selection, clear_mask, select_mask (for layers); group (puts layers in a " +
        "new group), move_to_group, ungroup, delete_group, rename_group, show_group, hide_group; set_blend and " +
        "add_effect / remove_effect / clear_effects also take group instead of layer. Each is one undo step, except " +
        "showing and hiding.",
      inputSchema: object(
        {
          action: enumSchema(PIPELINE_ACTIONS, "What to do."),
          layer: { type: "string", description: "A layer's id or name. Defaults to the active layer." },
          layers: { type: "array", items: { type: "string" }, description: "For group: the layers to put in it (ids or names). Defaults to the active layer." },
          group: { type: ["string", "null"], description: "A group's id or name; for move_to_group, null takes the layer out of its group." },
          name: { type: "string", description: "For group and rename_group." },
          blend: enumSchema(BLEND_NAMES, "For set_blend."),
          effect: {
            type: "object",
            description: "For add_effect: { kind: mirror, axis: x|y|z } | { kind: outline, color } | { kind: hollow } | { kind: noise, color, amount?, seed? }. Colors are palette indices or hex.",
          },
          index: { type: "integer", description: "For remove_effect: which effect, from 0." },
        },
        ["action"],
      ),
      execute: (input) => {
        const action = readEnum(input.action, PIPELINE_ACTIONS, "action");
        if (editor.readOnly) fail(editor.readOnly);
        const findGroup = (ref: unknown) =>
          editor.groups.find((g) => g.id === ref) ?? editor.groups.find((g) => g.name === ref) ?? fail(`No group with id or name ${JSON.stringify(ref)}; get_document lists them`);
        const onGroup = input.group !== undefined && input.group !== null && input.layer === undefined;
        const done = (ok: boolean, what: string) => {
          if (!ok) fail(why(`Couldn't ${what}`));
        };
        const readEffect = (raw: unknown): Effect => {
          const e = raw as Input;
          if (!e || typeof e !== "object") fail("effect must be an object with a kind");
          switch (e.kind) {
            case "mirror":
              return { kind: "mirror", axis: readAxis(e.axis, "axis") };
            case "outline":
              return { kind: "outline", color: readColor(e.color) };
            case "hollow":
              return { kind: "hollow" };
            case "noise":
              return {
                kind: "noise",
                color: readColor(e.color),
                amount: readInt(e.amount, "amount", 1, 15, 4),
                seed: readInt(e.seed, "seed", 0, 0xffff, 0),
              };
            default:
              return fail("effect kind must be one of: mirror, outline, hollow, noise");
          }
        };
        let result: Record<string, unknown> = {};
        switch (action) {
          case "set_blend": {
            const blend = BLENDS[readEnum(input.blend, BLEND_NAMES, "blend")];
            if (onGroup) done(editor.setGroupBlend(findGroup(input.group).id, blend), "change the blend");
            else done(editor.setLayerBlend(findLayer(input.layer).id, blend), "change the blend");
            break;
          }
          case "add_effect":
          case "remove_effect":
          case "clear_effects": {
            const current = onGroup ? (findGroup(input.group).effects ?? []) : (findLayer(input.layer).effects ?? []);
            let next: Effect[];
            if (action === "add_effect") next = [...current, readEffect(input.effect)];
            else if (action === "clear_effects") next = [];
            else {
              const index = readInt(input.index, "index", 0, Math.max(0, current.length - 1));
              if (!current[index]) fail("There is no effect there");
              next = current.filter((_, k) => k !== index);
            }
            if (onGroup) done(editor.setGroupEffects(findGroup(input.group).id, next), "change the effects");
            else done(editor.setLayerEffects(findLayer(input.layer).id, next), "change the effects");
            break;
          }
          case "mask_to_selection":
            requireSelection();
            done(editor.maskLayerToSelection(findLayer(input.layer).id), "mask the layer");
            break;
          case "clear_mask": {
            const layer = findLayer(input.layer);
            if (!layer.mask) fail(`“${layer.name}” has no mask`);
            done(editor.clearLayerMask(layer.id), "clear the mask");
            break;
          }
          case "select_mask": {
            const layer = findLayer(input.layer);
            if (!layer.mask) fail(`“${layer.name}” has no mask`);
            editor.selectLayerMask(layer.id);
            result = { selection: selectionInfo() };
            break;
          }
          case "group": {
            const refs = Array.isArray(input.layers) ? input.layers : [input.layer];
            const ids = refs.map((r) => findLayer(r).id);
            const id = editor.createGroup(ids, typeof input.name === "string" ? input.name : undefined);
            done(id !== null, "group the layers");
            result = { group: id };
            break;
          }
          case "move_to_group":
            done(editor.setLayerGroup(findLayer(input.layer).id, input.group === null || input.group === undefined ? null : findGroup(input.group).id), "move the layer");
            break;
          case "ungroup":
            done(editor.ungroup(findGroup(input.group).id), "ungroup");
            break;
          case "delete_group":
            done(editor.deleteGroup(findGroup(input.group).id), "delete the group");
            break;
          case "rename_group":
            done(editor.renameGroup(findGroup(input.group).id, (typeof input.name === "string" && input.name.trim()) || fail("name is required")), "rename the group");
            break;
          case "show_group":
          case "hide_group":
            editor.setGroupVisible(findGroup(input.group).id, action === "show_group");
            break;
        }
        return JSON.stringify({ ...result, layers: layerInfo(), groups: groupInfo(), undo: editor.undoLabel });
      },
    },

    {
      name: "edit_markers",
      title: "Edit markers",
      description:
        "Markers are named points and simple volumes in the model that aren't voxels: mount points where other " +
        "models attach (a bell on a post, a sword in a hand), collision volumes, and hitboxes or hurtboxes. They " +
        "export as named empty nodes. Positions are in grid units, where cell [x, y, z] spans x to x + 1 on each " +
        "axis, so a point between two cells sits on a whole number; points snap to half voxels. A volume is a " +
        "shape inscribed in a box of cells, min and max inclusive, as for shapes. In an animation a marker is the " +
        "same in every frame until key_per_frame; then place, hide and show change it from the active frame on, " +
        "until its next key. The model's origin (set_origin, reset_origin) is the point it is placed by and turns " +
        "around, and defaults to the center of the floor. Actions: add, place, rename, set_role, set_data, delete, " +
        "key_per_frame, same_every_frame, hide, show, set_origin, reset_origin. Each is one undo step.",
      inputSchema: object(
        {
          action: enumSchema(MARKER_ACTIONS, "What to do."),
          marker: { type: "string", description: "The marker's id or name, for every action but add and the origin's." },
          name: { type: "string", description: "For add (optional) and rename." },
          role: {
            type: ["string", "null"],
            description: "For add and set_role: mount, collision, hitbox, hurtbox, or another word a host uses; null clears it.",
          },
          data: { description: "For add and set_data: JSON a host keeps with the marker; null clears it." },
          at: {
            type: "array",
            items: { type: "number" },
            minItems: 3,
            maxItems: 3,
            description: "For a point (add, place) and set_origin: [x, y, z] in grid units.",
          },
          up: enumSchema(DIRECTIONS, "For a point: which way the marker's up points. Defaults to +y."),
          forward: enumSchema(DIRECTIONS, "For a point: which way it faces, across up. Defaults to +z (+y when up is along z)."),
          volume: {
            ...object({ kind: shapeProperties.kind, ...boxProperties, up: shapeProperties.up }, ["min", "max"]),
            description: "For a volume (add, place) instead of at: a shape in a box of cells.",
          },
        },
        ["action"],
      ),
      execute: (input) => {
        const action = readEnum(input.action, MARKER_ACTIONS, "action");
        if (editor.readOnly) fail(editor.readOnly);
        const r = editor.resolution;
        const readShape = (): MarkerShape => {
          if (input.volume !== undefined) {
            const v = input.volume as Input;
            if (!v || typeof v !== "object") fail("volume must be an object with min and max");
            const box = cellsToSource(readBox(v), r);
            const { kind, params } = readShapeName(v.kind, "kind");
            const options: ShapeOptions = { ...params, ...(v.up !== undefined ? { up: readDirection(v.up) } : {}) };
            return { kind: "volume", shape: stepShape(kind, box.min, box.max, options) };
          }
          if (input.at === undefined) fail("at (a point) or volume is required");
          const at = readGridPoint(input.at, "at").map((n) => n / r) as Vec3;
          const up = input.up === undefined ? undefined : readDirection(input.up);
          const forward = input.forward === undefined ? undefined : readDirection(input.forward, "forward");
          if (forward && forward.axis === (up?.axis ?? 1)) fail("forward must be across up");
          return { kind: "point", at, ...(up ? { up } : {}), ...(forward ? { forward } : {}) };
        };
        const role = () => (input.role === null ? null : typeof input.role === "string" && input.role.trim() ? input.role.trim() : fail("role must be a word, or null"));
        const done = (ok: boolean, what: string) => {
          if (!ok) fail(why(`Couldn't ${what}`));
        };
        let result: Record<string, unknown> = {};
        switch (action) {
          case "add": {
            const id = editor.addMarker({
              shape: readShape(),
              ...(input.name !== undefined ? { name: String(input.name) } : {}),
              ...(input.role !== undefined && input.role !== null ? { role: role()! } : {}),
              ...(input.data !== undefined ? { data: input.data as Json } : {}),
            });
            done(id !== null, "add the marker");
            result = { id };
            break;
          }
          case "set_origin":
            done(editor.setOrigin(readGridPoint(input.at, "at").map((n) => n / r) as Vec3), "move the origin");
            break;
          case "reset_origin":
            done(editor.setOrigin(null), "reset the origin");
            break;
          default: {
            const { id } = findMarker(input.marker);
            switch (action) {
              case "place":
                done(editor.placeMarker(id, readShape()), "move the marker");
                break;
              case "rename":
                done(editor.updateMarker(id, { name: (typeof input.name === "string" && input.name.trim()) || fail("name is required") }), "rename the marker");
                break;
              case "set_role":
                done(editor.updateMarker(id, { role: role() }), "change the role");
                break;
              case "set_data":
                done(editor.updateMarker(id, { data: (input.data ?? null) as Json }), "change the data");
                break;
              case "delete":
                done(editor.removeMarker(id), "delete the marker");
                break;
              case "key_per_frame":
              case "same_every_frame":
                done(editor.setMarkerKeyed(id, action === "key_per_frame"), "change the marker");
                break;
              case "hide":
              case "show":
                if (!editor.marker(id)!.keys?.length) fail("Only a marker keyed per frame can hide on some frames; use key_per_frame first");
                done(editor.setMarkerHidden(id, action === "hide"), `${action} the marker`);
                break;
            }
          }
        }
        return JSON.stringify({ ...result, markers: markerInfo(), origin: originInfo(), undo: editor.undoLabel });
      },
    },

    {
      name: "edit_animation_tags",
      title: "Edit animation tags",
      description: "Create, update, delete or select a named inclusive animation range. Endpoints are frame IDs. repeat 0 loops forever; positive repeats stop playback. Overlaps are allowed. All document edits are undoable.",
      inputSchema: object({
        action: enumSchema(["create", "update", "delete", "select"] as const, "What to do"),
        id: { type: "string", description: "Tag ID; omit for select to play all frames." },
        name: { type: "string" }, from: { type: "string" }, to: { type: "string" },
        direction: enumSchema(["forward", "reverse", "pingpong"] as const, "Playback direction"),
        repeat: { type: "integer", minimum: 0, maximum: 999 },
      }, ["action"]),
      execute: input => {
        const action = readEnum(input.action, ["create", "update", "delete", "select"] as const, "action");
        const id = typeof input.id === "string" ? input.id : null;
        if (action === "select") editor.setActiveTag(id);
        else {
          requireEditable();
          if (action === "create") {
            if (typeof input.name !== "string") fail("name is required");
            const direction = input.direction === undefined ? "forward" : readEnum(input.direction, ["forward", "reverse", "pingpong"] as const, "direction");
            const repeat = input.repeat === undefined ? 0 : readInt(input.repeat, "repeat", 0, 999);
            const created = editor.createTag(input.name as string, typeof input.from === "string" ? input.from : undefined, typeof input.to === "string" ? input.to : undefined, { direction, repeat });
            if (!created) fail(why("Couldn't create tag"));
          } else {
            if (!id) fail("id is required");
            if (action === "delete") editor.removeTag(id!);
            else {
              const changes: Record<string, unknown> = {};
              for (const key of ["name", "from", "to", "direction", "repeat"]) if (input[key] !== undefined) changes[key] = input[key];
              if (!editor.updateTag(id!, changes)) fail(why("Couldn't update tag"));
            }
          }
        }
        return JSON.stringify(animationInfo());
      },
    },

    {
      name: "edit_frames",
      title: "Edit frames",
      description:
        "Animate the model as a flipbook: a sequence of frames (poses), each holding every layer's voxels. " +
        "Edits go to the active frame only. Actions: select (make a frame active; not undoable), duplicate (copy " +
        "the active frame, or `frame`, into a new frame after it, which becomes active: the usual way to make the " +
        "next pose), blank (a new empty frame after it), delete (one or more `frames`; at least one frame stays), " +
        "move (to `index`, 0 = first), set_duration (how many ticks each of `frames` lasts, 1 to 999), set_fps " +
        "(ticks per second for the whole animation, 1 to 60; a frame lasting 3 ticks at 12 fps shows for 250 ms), " +
        "copy_layer (copy the active layer's voxels from the active frame into `to`). Frames are named by id or " +
        "position from 0.",
      inputSchema: object(
        {
          action: enumSchema(FRAME_ACTIONS, "What to do."),
          frame: { type: ["string", "integer"], description: "The frame, by id or position from 0. Defaults to the active frame." },
          frames: {
            type: "array",
            items: { type: ["string", "integer"] },
            description: "For delete and set_duration: the frames. Defaults to the active frame.",
          },
          index: { type: "integer", description: "For move: the new position, 0 = first." },
          duration: { type: "integer", description: "For set_duration: ticks, 1 to 999." },
          fps: { type: "integer", description: "For set_fps: 1 to 60." },
          to: { type: ["string", "integer"], description: "For copy_layer: the frame to copy into." },
        },
        ["action"],
      ),
      execute: (input) => {
        const action = readEnum(input.action, FRAME_ACTIONS, "action");
        const frame = () => (input.frame === undefined ? editor.activeFrameId : findFrame(input.frame));
        const frames = () => (Array.isArray(input.frames) ? input.frames.map(findFrame) : [frame()]);
        switch (action) {
          case "select":
            editor.setFrame(frame());
            break;
          case "duplicate":
          case "blank":
            if (!editor.insertFrame({ after: frame(), content: action === "blank" ? "blank" : "duplicate" })) {
              fail(why("Couldn't add a frame"));
            }
            break;
          case "delete": {
            const ids = frames();
            if (new Set(ids).size >= editor.frames.length) fail("An animation needs at least one frame; clear its layers instead");
            editor.removeFrames(ids);
            break;
          }
          case "move":
            editor.moveFrame(frame(), readInt(input.index, "index", 0, editor.frames.length - 1));
            break;
          case "set_duration":
            editor.setFrameDuration(frames(), readInt(input.duration, "duration", 1, 999));
            break;
          case "set_fps":
            editor.setFps(readInt(input.fps, "fps", 1, 60));
            break;
          case "copy_layer": {
            if (input.to === undefined) fail("to is required");
            const to = findFrame(input.to);
            if (to === editor.activeFrameId) fail("That is the active frame");
            editor.copyCel(to);
            break;
          }
        }
        return JSON.stringify({ animation: animationInfo(), undo: editor.undoLabel });
      },
    },

    {
      name: "edit_palette",
      title: "Edit palette",
      description:
        "Change the palette (up to 255 colors) as one undo step. set changes one color, which recolors every " +
        "voxel using it; add appends colors; replace swaps the whole palette for a list of colors or a built-in " +
        `palette (${BUILTIN_PALETTES.map((p) => p.name).join(", ")}). Voxels keep their indices when replacing; ` +
        "indices past the new palette's end move to the closest color.",
      inputSchema: object(
        {
          action: enumSchema(["set", "add", "replace"], "What to do."),
          index: { type: "integer", description: "For set: the palette index to change." },
          color: { type: "string", description: 'For set: a hex color like "#ff8800".' },
          colors: { type: "array", items: { type: "string" }, description: "For add: hex colors." },
          palette: {
            type: ["string", "array"],
            items: { type: "string" },
            description: "For replace: a built-in palette name, or a list of hex colors.",
          },
        },
        ["action"],
      ),
      execute: (input) => {
        const action = readEnum(input.action, ["set", "add", "replace"] as const, "action");
        if (action === "set") {
          const index = readInt(input.index, "index", 1, editor.palette.length - 1);
          editor.setPaletteColor(index, readHex(input.color));
          return JSON.stringify({ palette: paletteInfo(), undo: editor.undoLabel });
        }
        if (action === "add") {
          if (!Array.isArray(input.colors) || input.colors.length === 0) fail("colors must be a list of hex colors");
          const colors = input.colors.map((c) => readHex(c, "Each color"));
          const room = MAX_COLORS + 1 - editor.palette.length;
          if (colors.length > room) fail(`The palette has room for ${room} more colors`);
          const indices = editor.transact("Add colors", () => colors.map((c) => editor.addPaletteColor(c)));
          return JSON.stringify({ indices, palette: paletteInfo(), undo: editor.undoLabel });
        }
        editor.loadPalette(readPalette(input.palette));
        return JSON.stringify({ palette: paletteInfo(), undo: editor.undoLabel });
      },
    },

    {
      name: "update_document",
      title: "Update document",
      description:
        `Rename the document or resize the volume (1 to ${MAX_SIZE} per side). Resizing keeps X and Z centered ` +
        "and Y on the floor unless `anchor` says otherwise; voxels outside the new size are cut off. Both are undoable.",
      inputSchema: object({
        name: { type: "string" },
        size: cellSchema("The new [x, y, z] size."),
        anchor: {
          type: "array",
          items: { type: "number", minimum: 0, maximum: 1 },
          minItems: 3,
          maxItems: 3,
          description:
            "For a resize: the point that stays put, per axis 0 = the low side (floor, -x, -z), 0.5 = the middle, " +
            "1 = the high side. Defaults to [0.5, 0, 0.5].",
        },
      }),
      execute: (input) => {
        if (input.size !== undefined) {
          const anchor = input.anchor;
          if (
            anchor !== undefined &&
            (!Array.isArray(anchor) || anchor.length !== 3 || !anchor.every((n) => typeof n === "number" && n >= 0 && n <= 1))
          ) {
            fail("anchor must be [x, y, z], each 0 to 1");
          }
          editor.resize(readSize(input.size), anchor ? { anchor: anchor as Vec3 } : undefined);
          view?.fit();
        }
        if (typeof input.name === "string") editor.setName(input.name);
        return JSON.stringify({ name: editor.name, size: editor.size, bounds: editor.contentBounds() });
      },
    },

    {
      name: "new_document",
      title: "New document",
      description:
        "Replace the open model with an empty one. This discards the current model and its undo history, " +
        "so only use it when the user asks for a new model.",
      inputSchema: object({
        name: { type: "string" },
        size: cellSchema(`[x, y, z], 1 to ${MAX_SIZE} per side. Defaults to [32, 32, 32].`),
        palette: {
          type: ["string", "array"],
          items: { type: "string" },
          description: `A built-in palette (${BUILTIN_PALETTES.map((p) => p.name).join(", ")}) or a list of hex colors.`,
        },
      }),
      annotations: { consequentialHint: true },
      execute: (input) => {
        const size = input.size === undefined ? undefined : readSize(input.size);
        const palette = input.palette === undefined ? undefined : readPalette(input.palette);
        editor.newDocument(size, palette);
        if (typeof input.name === "string") editor.setName(input.name);
        view?.fit();
        return JSON.stringify({ name: editor.name, size: editor.size, palette: paletteInfo() });
      },
    },

    {
      name: "undo",
      title: "Undo",
      description: "Take back the last edits, one undo step at a time.",
      inputSchema: object({ steps: { type: "integer", description: "How many steps (default 1)." } }),
      execute: (input) => {
        const steps = readInt(input.steps, "steps", 1, 200, 1);
        const undone: string[] = [];
        while (undone.length < steps) {
          const label = editor.undoLabel;
          if (!label || !editor.undo()) break;
          undone.push(label);
        }
        return JSON.stringify({ undone, undo: editor.undoLabel, redo: editor.redoLabel });
      },
    },

    {
      name: "redo",
      title: "Redo",
      description: "Redo steps taken back with undo.",
      inputSchema: object({ steps: { type: "integer", description: "How many steps (default 1)." } }),
      execute: (input) => {
        const steps = readInt(input.steps, "steps", 1, 200, 1);
        const redone: string[] = [];
        while (redone.length < steps && editor.canRedo) {
          const label = editor.redoLabel!;
          if (!editor.redo()) break;
          redone.push(label);
        }
        return JSON.stringify({ redone, undo: editor.undoLabel, redo: editor.redoLabel });
      },
    },

    shapesTool(),

    {
      name: "set_mirror",
      title: "Set mirror",
      description:
        "Turn mirror planes on or off. Each enabled plane reflects edits and selections across the middle of the " +
        "volume on that axis, so one call builds both halves of a symmetric model. This is an editor setting the " +
        "user also controls; turn off planes you turned on.",
      inputSchema: object({ x: { type: "boolean" }, y: { type: "boolean" }, z: { type: "boolean" } }),
      execute: (input) => {
        AXES.forEach((name, axis) => {
          if (typeof input[name] === "boolean") editor.setMirror(axis as Axis, input[name] as boolean);
        });
        return JSON.stringify({ mirror: AXES.filter((_, a) => editor.mirror[a]) });
      },
    },
  ];

  tools.push({
    name: "set_workplane",
    title: "Set workplane",
    description:
      "Move the workplane: the layer of cells (axis = level) where the user's add, box and shape tools place voxels " +
      "when there is nothing to build on, drawn as a grid. With clip, it also slices the model, hiding cells " +
      "beyond it: \"below\" shows the level and lower, \"above\" the level and higher, \"only\" just the level. " +
      "Hidden cells can't be edited or selected, so turn clipping off before editing elsewhere. Use it to show the " +
      "user a cross-section or to set up where they draw. This is an editor setting, not part of the document, " +
      "and not undoable.",
    inputSchema: object({
      axis: axisSchema("The plane's normal. Changing it keeps the level unless you give one."),
      level: { type: "integer", description: "The layer of cells, from 0 to size - 1 on the axis. Clamped." },
      clip: enumSchema(CLIPS, "off shows everything."),
      reset: { type: "boolean", description: "Back to the floor (y = 0) with clipping off, before anything else." },
    }),
    execute: (input) => {
      if (input.reset === true) editor.resetWorkplane();
      const change: Partial<Workplane> = {};
      if (input.axis !== undefined) change.axis = readAxis(input.axis, "axis");
      if (input.level !== undefined) change.level = readInt(input.level, "level", -MAX_SIZE, MAX_SIZE);
      if (input.clip !== undefined) change.clip = CLIP_MODES[CLIPS.indexOf(readEnum(input.clip, CLIPS, "clip"))];
      editor.setWorkplane(change);
      return JSON.stringify({ workplane: workplaneInfo() });
    },
  });

  if (view) {
    tools.push({
      name: "set_view",
      title: "Set view",
      description:
        "Point the camera so the user (or a screenshot) can see the model: an axis view or the three-quarter " +
        "iso view, zoomed to fit, in perspective or orthographic projection.",
      inputSchema: object({
        view: enumSchema(CAMERA_VIEWS, "front looks down -Z; top looks down -Y."),
        fit: { type: "boolean", description: "Zoom to fit the model. Defaults to true." },
        projection: enumSchema(["perspective", "orthographic"], "Leave unset to keep the current projection."),
      }),
      execute: (input) => {
        if (input.projection !== undefined) {
          editor.setProjection(readEnum(input.projection, ["perspective", "orthographic"] as const, "projection"));
        }
        if (input.view !== undefined) view.setView(readEnum(input.view, CAMERA_VIEWS, "view"));
        if (input.fit !== false) view.fit();
        return JSON.stringify({ projection: editor.projection });
      },
    });
  }

  // a view-only document (a shared link without edit access, a lost connection) still takes
  // selections, views and new local documents, but nothing that changes it
  const changesDocument = (tool: AgentTool, input: Input) =>
    !LOCAL_TOOLS.has(tool.name) &&
    !(tool.name === "edit_layer" && LOCAL_LAYER_ACTIONS.includes(input.action as never)) &&
    !(tool.name === "edit_frames" && input.action === "select") &&
    !(tool.name === "edit_animation_tags" && input.action === "select");
  return tools.map((tool) => ({
    ...tool,
    execute: (input: Input) => {
      if (editor.readOnly && changesDocument(tool, input)) {
        fail(`${editor.readOnly}: the model can't be changed right now. Reading and selecting still work.`);
      }
      return tool.execute(input);
    },
  }));
}

const LOCAL_TOOLS = new Set([
  "get_document",
  "get_projection",
  "get_voxels",
  "select",
  "undo",
  "redo",
  "set_mirror",
  "set_view",
  "set_workplane",
  "new_document",
]);
const LOCAL_LAYER_ACTIONS = ["select", "show", "hide", "lock", "unlock"] as const;

/** The integers from `a` to `b`, inclusive, in that order. */
function range(a: number, b: number): number[] {
  const step = a <= b ? 1 : -1;
  return Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => a + i * step);
}
