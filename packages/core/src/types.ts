import type { ParamHandleId, ShapeHandle } from "./shapes";
import type { ShapeSource } from "./source";

export type Vec3 = [number, number, number];

/** A JSON value: what hosts keep in documents, layers, scenes and instances. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Axis = 0 | 1 | 2;

export const AXIS_NAMES = ["X", "Y", "Z"] as const;

/**
 * Raster layers take orbit, select, move, extrude, add, erase, brush, fill and pick; vector layers
 * take orbit, select, shape (draws `Editor.shapePreset`), pen (draws paths) and fill (recolors a shape).
 */
export type BuiltinToolId = "orbit" | "select" | "move" | "extrude" | "add" | "erase" | "brush" | "fill" | "pick" | "shape" | "pen";
/** A built-in tool, or the id of a `CustomTool` given to the Editor. */
export type ToolId = BuiltinToolId | (string & {});
export type BrushMode = "voxel" | "box" | "face" | "shape";
/** The select tool's brushes: the content brushes, plus a magic wand by color. */
export type SelectBrush = BrushMode | "color";
export type FillMode = "connected" | "all";
export type ProjectionMode = "perspective" | "orthographic";
/** Axis-aligned camera views, plus the default three-quarter view. Front looks down -Z. */
export type CameraView = "front" | "back" | "left" | "right" | "top" | "bottom" | "iso";

/**
 * A layer's content is one of three kinds of source (see docs/vector-raster.md):
 *
 * - a legacy raster: `data` only. Nonzero cells are solid; zero is unset and shows what is below.
 * - an override raster: `data` plus `coverage`. A covered cell replaces what is below, even with
 *   0 (covered empty cuts lower layers); an uncovered cell is unset (and its `data` is 0).
 * - a shape (procedural) layer: `shape`, a stack of steps in source space. Its `data`
 *   is empty (length 0): shape layers have no raster cells, and their voxels are evaluated.
 */
export interface Layer {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  readonly locked: boolean;
  /** One byte per cell, x-major. 0 = empty, otherwise a palette index. Empty (length 0) for a shape layer. */
  readonly data: Uint8Array;
  /** Override rasters: one byte per cell, 1 = covered. */
  readonly coverage?: Uint8Array;
  /** Shape layers: the geometry the layer's voxels are evaluated from. */
  readonly shape?: ShapeSource;
  /** How the layer combines with what is below; unset is its kind's. See docs/pipeline.md. */
  readonly blend?: import("./evaluate").Blend;
  /** Where the layer acts (1), the same in every frame; elsewhere it does nothing. Unset: everywhere. */
  readonly mask?: Uint8Array;
  readonly effects?: readonly import("./effects").Effect[];
  /** The group the layer is in, by id. */
  readonly group?: string;
  /** What a host means by this layer (saved as the layer's "data"). Voxeltoy keeps it as it is. */
  readonly hostData?: Json;
  /** Keys a newer app or another host saved on this layer, kept so the file comes out intact. */
  readonly extra?: Readonly<Record<string, Json>>;
}

export type SliceMode = "-" | "+" | "=";

export interface Slice {
  axis: Axis;
  level: number;
  /** Show coordinates <= level (-), >= level (+), or == level (=). */
  mode: SliceMode;
}

/** Clipping by the workplane: off, or one of the slice modes. */
export type WorkplaneClip = "none" | SliceMode;

/**
 * Where new voxels go when there is nothing to build against: the layer of cells `axis = level`.
 * It is also the slice: with `clip` other than "none", it hides what is on one side of it.
 */
export interface Workplane {
  axis: Axis;
  level: number;
  clip: WorkplaneClip;
}

export interface Ray {
  origin: Vec3;
  /** Normalized direction. */
  dir: Vec3;
}

export interface PointerInput {
  ray: Ray;
  /**
   * The pointer hovers between presses (a mouse), so a tool can take several clicks with a preview
   * that follows it; otherwise (a finger, a pen) each gesture is one press.
   */
  hover?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Ctrl (Cmd on a Mac). */
  mod?: boolean;
  /** The handle under the pointer, found by the viewport in screen space. */
  handle?: Handle;
}

/** The transform gizmo's handles: an arrow that slides along an axis, or a ring that turns around it. */
export type GizmoHandle = `${"move" | "rotate"}-${Axis}`;

/**
 * Something to drag that isn't voxels: a pending shape's handle, a pending extrusion's depth, the
 * transform gizmo, or the workplane's arrow.
 */
export type Handle = ShapeHandle | ParamHandleId | GizmoHandle | "depth" | "workplane";

export interface Box {
  min: Vec3;
  max: Vec3;
}

export interface Preview {
  kind: "add" | "erase" | "paint" | "pick" | "select" | "deselect";
  /** Inclusive cell ranges. */
  boxes: Box[];
  /** Individual cells, drawn as a ghost of the result (for shapes). */
  cells?: Vec3[];
  /** Palette index the ghost cells are drawn with. */
  value?: number;
  /** Per-cell palette indices, parallel to `cells`, overriding `value`. */
  values?: number[];
  /** Boxes drawn as outlines only. */
  outlines?: Box[];
  /** Dashed lines, in grid units: where the Pen's next segment would go. */
  lines?: [Vec3, Vec3][];
}

export interface DocumentLayer {
  /** A stable id, kept in shared documents. Files leave it out, and opening one makes new ids. */
  id?: string;
  name: string;
  visible: boolean;
  locked: boolean;
  /** Empty (length 0) for a shape layer. */
  data: Uint8Array;
  coverage?: Uint8Array;
  shape?: ShapeSource;
  blend?: import("./evaluate").Blend;
  mask?: Uint8Array;
  effects?: import("./effects").Effect[];
  /** The group the layer is in, by id. */
  group?: string;
  /** A host's data for the layer; see `Layer.hostData`. */
  hostData?: Json;
  /** Unknown keys from the file, kept as they are. */
  extra?: Record<string, Json>;
}

/** A whole document, independent of editor state. */
export interface DocumentData {
  /**
   * A stable identity, kept by saving and exporting and replaced by New; see docs/scenes.md.
   * Documents without one get one when they are opened.
   */
  docId?: string;
  /** Goes up with every committed change (undo and redo too): it says the document changed. */
  revision?: number;
  /** Host data by namespace (saved as "data"). Voxeltoy keeps it as it is. */
  hostData?: Record<string, Json>;
  /** Unknown top-level keys from the file, kept as they are. */
  extra?: Record<string, Json>;
  name: string;
  size: Vec3;
  /** The grid's generation, kept in shared documents. See `ResizeOp`. */
  gen?: string;
  /** palette[0] is reserved for "empty"; voxel value v uses palette[v]. 0xRRGGBB. */
  palette: number[];
  /**
   * Output cells per source unit along each axis: a power of two, 1 when unset. `size` is in
   * output cells, so the source region is `size / resolution`.
   */
  resolution?: number;
  layers: DocumentLayer[];
  activeLayer: number;
  /** Ticks per second of the animation; 12 when unset. See docs/animation.md. */
  tags?: import("./animation").AnimationTag[];
  fps?: number;
  /**
   * The animation's frames, in order. Unset means one frame lasting one tick, whose voxels are the
   * layers' `data`.
   */
  frames?: DocumentFrame[];
  /** Index into `frames` of the frame being edited. The layers' `data` is that frame's voxels. */
  activeFrame?: number;
  /** Named points and volumes that aren't voxels; keys name frames by id. See docs/pipeline.md. */
  markers?: import("./markers").Marker[];
  /** The point the model is placed by, in source units. Unset: the center of the floor. */
  origin?: Vec3;
  /** Layer groups: isolated stages of the pipeline that layers (and groups) name. See docs/pipeline.md. */
  groups?: LayerGroup[];
}

/**
 * A group of layers: an isolated stage whose content is its members composed from empty, then its
 * effects, then its blend onto what is below. It sits where its lowest member is.
 */
export interface LayerGroup {
  readonly id: string;
  readonly name: string;
  /** Saved, but not undoable, like a layer's. */
  readonly visible: boolean;
  readonly blend?: import("./evaluate").Blend;
  readonly effects?: readonly import("./effects").Effect[];
  /** The group it is in, by id. */
  readonly group?: string;
}

/** One pose of an animated document. */
export interface DocumentFrame {
  /** A stable id, kept in shared documents and files. */
  id?: string;
  /** How many ticks (1 / fps seconds) the pose lasts: a whole number from 1. */
  duration: number;
  /** Each layer's voxels in this frame, parallel to `layers`. Empty (length 0) for a shape layer. */
  cels: Uint8Array[];
}

/** What the timeline shows of a frame. */
export interface AnimationFrame {
  readonly id: string;
  readonly duration: number;
}

/** 3D onion skins: the neighboring poses, drawn faintly around the one being edited. */
export interface OnionSkin {
  enabled: boolean;
  /** Ghost the active layer only, or every visible layer. */
  scope: "active-layer" | "visible";
  /** 0 to 1. */
  opacity: number;
  /** Compare the first and last frames as neighbors. */
  loop: boolean;
}
