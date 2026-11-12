import { batch, untrack } from "solid-js";
import { VoxelClipboard } from "./clipboard";
import { cellCoord, mirror, quarterTurn } from "./grid";
import { EditorFrames, now } from "./editor-frames";
import { EditorExtrusion } from "./editor-extrusion";
import { EditorFloating } from "./editor-floating";
import { EditorShapes } from "./editor-shapes";
import type { EditorInternals } from "./editor-internals";
import { signal } from "./signal";
import { type AnimationTag, ticksToMs, totalTicks } from "./animation";
import { defaultDocument, DEFAULT_SIZE, isFlatDocument, layerKind, VoxelDocument, type DocumentListener, type LayerKind } from "./document";
import { composeCell, composeLayers, hasEffects, sameBlend, stageTree, type Blend } from "./evaluate";
import { effectColors, mapEffectColors, type Effect } from "./effects";
import { type Extrusion } from "./extrude";
import { entryOf, History, invertEntry, Transaction, type Entry, type LocalChange } from "./history";
import { applyOp, isStructural, MAX_SIZE, newGen, newLayerId, OpError, randomId, type DocOp } from "./ops";
import { DEFAULT_PALETTE, MAX_COLORS, nearestColor } from "./palette";
import {
  defaultOrigin,
  markerAt,
  newMarkerId,
  placeMarker as placeMarkerShape,
  sameMarkers,
  snapMarker,
  snapMarkerShape,
  translateMarkerShape,
  type Marker,
  type MarkerKey,
  type MarkerPlacement,
  type MarkerShape,
} from "./markers";
import { dominantAxis, raycastVolume, type Hit } from "./raycast";
import {
  combineMask,
  countMask,
  floodMask,
  growMask,
  maskBounds,
  shrinkMask,
  type Floating,
  type SelectMode,
} from "./selection";
import {
  baseAxes,
  boxExtent,
  defaultHeight,
  draftHeight,
  paramHandles,
  paramsOf,
  pathHandles,
  presetEntry,
  presetOf,
  rotateDraft,
  shapeCells,
  SHAPE_PRESET_IDS,
  turnDraft,
  withHeight,
  type Direction,
  type ParamHandleId,
  type ShapeDraft,
  type ShapeKind,
  type ShapeParams,
  type ShapePreset,
  type ShapeSpec,
} from "./shapes";
import {
  mapMaterials,
  type ShapeOptions,
  type StepFill,
  type Step,
  type StepMode,
} from "./source";
import { ToolController } from "./tools";
import { SpatialBrush } from "./spatial-brush";
import type {
  AnimationFrame,
  Axis,
  Box,
  BrushMode,
  DocumentData,
  OnionSkin,
  FillMode,
  Json,
  Layer,
  PointerInput,
  Preview,
  ProjectionMode,
  Ray,
  SelectBrush,
  Slice,
  ToolId,
  Vec3,
  Workplane,
} from "./types";

export type VoxelOp = "add" | "erase" | "paint";
/** What a brush stroke does: change voxels, or change the selection. */
export type BrushOp = VoxelOp | "select";

/** The voxel op a content tool performs: Add adds, Erase erases and the brush paints. Null for other tools. */
export function toolOp(tool: ToolId): VoxelOp | null {
  return tool === "add" ? "add" : tool === "erase" ? "erase" : tool === "brush" ? "paint" : null;
}

/** The shape brush's shape while it is being placed; `op` follows the current tool. */
export interface PendingShape extends ShapeSpec, ShapeDraft {
  hollow: boolean;
  op: BrushOp;
  /** Set when the draft is a shape layer's box rather than a brush: see `operandEdit`. */
  operand?: OperandEditMode;
  /** Set while a vector layer's new shape is being drawn: see `OperandEdit.drawing`. */
  drawing?: DrawPhase;
  /** Set while the shape is edited in place (`Editor.editingShape`): its box has no handles then. */
  editing?: boolean;
}

/**
 * Where drawing a vector layer's shape is: its footprint follows the pointer, then (with a mouse)
 * its height does. Until it is made, the shape shows live without handles.
 */
export type DrawPhase = "footprint" | "height";

/**
 * Placing or changing a shape layer step's box with handles: "step" places the box of a new step
 * on top of the stack (applied with `commitShape`); "edit" changes an existing step, one undo step per drag.
 */
export type OperandEditMode = "step" | "edit";

export interface OperandEdit {
  mode: OperandEditMode;
  layerId: string;
  /** "edit": the step being changed. */
  stepId: string | null;
  /** "step": what the new step does. */
  step?: StepMode;
  /** "step": the shape is being drawn with the shape tool, and is made when the drawing ends. */
  drawing?: DrawPhase;
}

// What a layer holds, whether a document is flat, the default size: the document's, kept here
// for everything that imports them from the editor.
export { DEFAULT_SIZE, isFlatDocument, layerKind, type LayerKind };

const OP_LABELS: Record<VoxelOp, string> = { add: "Add", erase: "Erase", paint: "Paint" };

/** A document edit made in this editor (including undo and redo), as shared ops. */
export interface LocalEdit {
  id: string;
  label: string;
  ops: DocOp[];
}


/**
 * A tool an application adds. The editor routes pointer input to it while it is the current
 * tool (`setTool(id)`); it edits through the editor's methods, so its changes are undoable.
 */
export interface CustomTool {
  id: string;
  /** The pointer went down. Return true to take the gesture; otherwise the viewport orbits. */
  down(input: PointerInput, editor: Editor): boolean;
  move?(input: PointerInput, editor: Editor): void;
  up?(editor: Editor): void;
  /** The gesture was abandoned (a second finger, Escape). Defaults to reverting the stroke. */
  cancel?(editor: Editor): void;
  /** What the tool would do under a hovering pointer, or null. */
  hover?(input: PointerInput, editor: Editor): Preview | null;
}

export interface EditorOptions {
  /** Where copies go. Editors given the same one paste each other's copies; by default each has its own. */
  clipboard?: VoxelClipboard;
  /** Preserve application metadata when Add replaces a hidden voxel. */
  replaceHiddenValue?: (current: number, value: number) => number;
  /** Tools beyond the built-in ones. */
  tools?: CustomTool[];
  /**
   * For applications whose voxel values encode a direction: the value after the voxel turns or
   * mirrors, given how directions move. Applied when a selection or layer is rotated or flipped.
   */
  transformValue?: (value: number, direction: (normal: Vec3) => Vec3) => number;
  /**
   * For applications whose voxel values encode a direction: the value Add places, given the
   * outward normal of the face it was placed against (the workplane's, facing the camera,
   * when there was none). Spikes placed on a wall point out of it.
   */
  placeValue?: (value: number, normal: Vec3) => number;
  /**
   * Keep the resolution at 1×, for applications whose values or decals address whole cells.
   * Implied by `transformValue` and `replaceHiddenValue`.
   */
  lockResolution?: boolean;
  /**
   * Send undo steps to a history this editor is part of (a scene's), instead of its own. The
   * host holds each step and takes it back with `takeBack`. See docs/scenes.md.
   */
  history?: HistoryHost;
  /**
   * Edit this document instead of one of the editor's own (a scene's model). Its options win
   * over `lockResolution`.
   */
  document?: VoxelDocument;
}

/** A history an editor's undo steps go to when it is part of something bigger, such as a scene. */
export interface HistoryHost {
  /** A committed step from `editor`, to keep. Undoing it later goes through `editor.takeBack`. */
  record(editor: Editor, entry: Entry): void;
  undo(): boolean;
  redo(): boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** The label of the step `undo` (or `redo`) would take back. */
  readonly undoLabel?: string | null;
  readonly redoLabel?: string | null;
}


/** What `Editor.takeBack` did. */
export interface TakeBack {
  /** False if the document can't change right now (read-only); nothing happened. */
  done: boolean;
  /** The entry that takes the inversion back in turn, or null if nothing could be taken back. */
  inverse: Entry | null;
}

/** A visible voxel under the pointer, and the face it was hit on. */
export interface HoverHit {
  cell: Vec3;
  normal: Vec3;
}
export { MAX_SIZE };

/**
 * Where the old volume's corner lands when it grows or shrinks from `old` to `size`, keeping the
 * `anchor` point (per axis 0 low side, 0.5 middle, 1 high side) in place. Shifts are whole steps of `step`.
 */
export function resizeOffset(old: Vec3, size: Vec3, anchor: Vec3, step = 1): Vec3 {
  return old.map((n, i) => {
    const a = Math.max(0, Math.min(1, Number.isFinite(anchor[i]) ? anchor[i] : 0.5));
    return step * Math.floor(((size[i] - n) * a) / step) || 0;
  }) as Vec3;
}

const SHAPE_TOOLS: readonly ToolId[] = ["add", "erase", "brush", "select"];

/** The tools a vector layer takes. Raster layers take the others, and orbit and select too. */
export const VECTOR_TOOLS: readonly ToolId[] = ["orbit", "select", "shape", "pen", "fill"];

/** What the Pen draws: a round tube, an upright wall or a flat slab through its points. */
export type PenProfile = "tube" | "wall" | "slab";

/** 2D mode's state: which side of the workplane the view looks from. */
export interface Mode2D {
  side: 1 | -1;
}

/** The floor, unclipped: where voxels go by default. */
export const DEFAULT_WORKPLANE: Workplane = { axis: 1, level: 0, clip: "none" };

function sliceContains(slice: Slice, coordinate: number) {
  if (slice.mode === "=") return coordinate === slice.level;
  return slice.mode === "+" ? coordinate >= slice.level : coordinate <= slice.level;
}

/** What the marker bar is placing: a marker by id, or the model's origin. */
export const ORIGIN = "origin";

/** What to do with unfinished work (floating content, an extrusion, a shape being placed) when the frame changes. */
export type PendingPolicy = "commit" | "cancel";

/**
 * The headless editor: an editing session on a document (`doc`, a `VoxelDocument`). It owns the
 * selection, editing state (tool, color, mirror, workplane and slice, pending shape, floating
 * content), undo history and the composite the view draws; the document's state reads through
 * it too. All state is exposed through reactive getters; all changes go through methods.
 * See docs/editor-architecture.md.
 *
 *   const editor = new Editor()
 *   editor.setTool("add")
 *   editor.setVoxel([0, 0, 0], 3)
 *   editor.transact("Wall", () => { ... })   // one undo step
 *   editor.undo()
 */
export class Editor {
  /** The document being edited. */
  readonly doc: VoxelDocument;
  private _activeLayerId = signal("");

  private _hiddenValues = signal<ReadonlySet<number>>(new Set());
  /** One byte per cell: 1 = hidden by `hideCells`. Empty until something is hidden. */
  private hiddenCells = new Uint8Array(0);
  private _hiddenCellCount = signal(0);
  private _hiddenCellsShown = signal(false);
  private replaceHiddenValue?: EditorOptions["replaceHiddenValue"];

  private _tool = signal<ToolId>("add");
  private _previousTool = signal<ToolId>("add");
  private _brush = signal<BrushMode>("voxel");
  private _fillMode = signal<FillMode>("connected");
  private _shapePreset = signal<ShapePreset>("box");
  private _shapeMode = signal<StepMode>("add");
  private _penProfile = signal<PenProfile>("tube");
  private _penSmooth = signal(false);
  private _shapeHollow = signal(false);
  private _shapeFromCenter = signal(false);
  private _shapeUniform = signal(false);
  private _shapeDraft = signal<ShapeDraft | null>(null);
  private _color = signal(1);
  private _mirror = signal<[boolean, boolean, boolean]>([false, false, false]);
  private _workplane = signal<Workplane>(DEFAULT_WORKPLANE);
  private _pickingWorkplane = signal(false);
  private _mode2D = signal<Mode2D | null>(null);
  private _thickness = signal(1);
  private _bothSides = signal(false);
  private _depthColors = signal(false);
  private _showClipped = signal(true);
  private _preview = signal<Preview | null>(null);
  private _projection = signal<ProjectionMode>("perspective");
  private _toast = signal<{ message: string; id: number } | null>(null);
  private _selectBrush = signal<SelectBrush>("box");
  private _selectMode = signal<SelectMode>("replace");
  private _markerEditing = signal(false);
  /** The marker the marker bar places, or `ORIGIN`; null when none is chosen. */
  private _markerTarget = signal<string | null>(null);
  private _markersShown = signal(false);
  /** Why the document can't be changed right now (a view-only link, a lost connection), or null. */
  private _readOnly = signal<string | null>(null);
  /** Bumped (at most once per microtask) whenever the selection mask changes. */
  private _selectionVersion = signal(0);

  /** Bumped (at most once per microtask) whenever visible geometry changes. */
  private _geometryVersion = signal(0);

  /** Topmost visible, in-slice value per cell. What you see is what you pick. */
  composite = new Uint8Array(0);
  /** What the clip hides: the value each clipped cell would show, 0 elsewhere. See `clippedBehind`. */
  clipped = new Uint8Array(0);

  readonly history = new History();
  readonly tools: ToolController;
  /** A brush at a point in voxel space, empty space included (a headset controller's tip). See `SpatialBrush`. */
  readonly spatial: SpatialBrush;
  private historyHost?: HistoryHost;

  private tx: Transaction | null = null;
  private stroke: Transaction | null = null;
  private geometryQueued = false;

  /** One byte per cell, like a layer: 1 = selected. */
  private selection: Uint8Array = new Uint8Array(0);
  private selectedCount = 0;
  private selectionQueued = false;
  private readonly clipboard: VoxelClipboard;
  private clipNoticeAt = 0;
  /** A marker (or the origin) being dragged across the model. */
  private markerDrag: { target: string } | null = null;
  /**
   * What the session shows but hasn't recorded: a palette color a picker is trying, a marker being
   * dragged. Overlays on the document, never written to it, so other views and saves don't see them.
   */
  private _palettePreview = signal<{ index: number; color: number } | null>(null);
  private _markerPreview = signal<{ target: string; shape: MarkerShape } | null>(null);
  private previewed: {
    palette?: { from: readonly number[]; preview: object; value: readonly number[] };
  } = {};
  private editListeners = new Set<(edit: LocalEdit) => void>();
  private loadListeners = new Set<(origin: string) => void>();
  private stopListening: () => void;

  private customTools = new Map<string, CustomTool>();
  private transformValue: EditorOptions["transformValue"];
  private placeValue: EditorOptions["placeValue"];
  private _hover = signal<HoverHit | null>(null);

  /** What the session's parts reach in it beyond the public API. */
  private readonly internals: EditorInternals;
  private readonly anim: EditorFrames;
  private readonly shapes: EditorShapes;
  private readonly extrusions: EditorExtrusion;
  private readonly floats: EditorFloating;

  constructor(doc?: DocumentData, options: EditorOptions = {}) {
    for (const tool of options.tools ?? []) this.customTools.set(tool.id, tool);
    this.transformValue = options.transformValue;
    this.placeValue = options.placeValue;
    this.replaceHiddenValue = options.replaceHiddenValue;
    this.historyHost = options.history;
    this.clipboard = options.clipboard ?? new VoxelClipboard();
    this.tools = new ToolController(this);
    this.spatial = new SpatialBrush(this);
    this.internals = this.createInternals();
    this.anim = new EditorFrames(this.internals);
    this.shapes = new EditorShapes(this.internals);
    this.extrusions = new EditorExtrusion(this.internals);
    this.floats = new EditorFloating(this.internals, this.clipboard);
    const lockResolution = !!(options.lockResolution || options.transformValue || options.replaceHiddenValue);
    if (options.document) {
      this.doc = options.document;
      if (lockResolution) this.doc.lockResolution();
    } else {
      this.doc = new VoxelDocument(doc, { lockResolution });
    }
    this.stopListening = this.doc.listen(this.docListener);
    // start the session on the document as it is
    this.sessionLoaded(untrack(() => this.doc.toData()).activeLayer);
  }

  private createInternals(): EditorInternals {
    const doc = () => this.doc;
    const selection = () => this.selection;
    const selectedCount = () => this.selectedCount;
    return {
      editor: this,
      get doc() {
        return doc();
      },
      apply: (label, op) => this.apply(label, op),
      write: (data, index, value) => this.write(data, index, value),
      local: (label, change) => this.local(label, change),
      blocked: () => this.blocked(),
      refuse: (reason) => this.refuse(reason),
      settlePending: (policy, options) => this.settlePending(policy, options),
      rebuildComposite: () => this.rebuildComposite(),
      settle: () => this.settle(),
      get selection() {
        return selection();
      },
      setSelectionState: (mask) => this.setSelectionState(mask),
      shapeDraft: this._shapeDraft,
      preview: this._preview,
      activeLayerId: this._activeLayerId,
      refreshShape: () => this.refreshShape(),
      writeState: (layer, i, state) => this.writeState(layer, i, state),
      prepareEdit: () => this.prepareEdit(),
      get selectedCount() {
        return selectedCount();
      },
      editSelection: (label, map, override) => this.editSelection(label, map, override),
      orientValues: (voxels, direction) => this.orientValues(voxels, direction),
      setSelection: (next, label) => this.setSelection(next, label),
    };
  }

  /** Stop following the document: for a session that is put away (a scene's model, closed). */
  dispose() {
    this.cancelPointer();
    this.stopListening();
  }

  /** What the session does as the document changes under it. */
  private docListener: DocumentListener = {
    willReplace: (what) => {
      // a whole new document: the session starts over when it hears (`sessionLoaded`), but a stroke
      // under way is taken back now, into the arrays it wrote, not the ones coming in
      if (what === "load") return this.cancelPointer();
      // what was pending belonged to the arrays going away; a stroke stays (see `reconcile`)
      this.settlePending("cancel", { stroke: false });
    },
    changed: (change) => {
      switch (change.kind) {
        case "layers":
          this.layersChanged(change.before);
          return;
        case "grid": {
          const size = untrack(() => this.doc.size);
          this.setSelectionState(new Uint8Array(size[0] * size[1] * size[2]));
          const plane = untrack(() => this.workplane);
          if (plane.level >= size[plane.axis]) this._workplane.set({ ...plane, level: size[plane.axis] - 1 });
          return;
        }
        case "palette":
          if (untrack(() => this.color) >= untrack(() => this.palette).length) this._color.set(untrack(() => this.palette).length - 1);
          this.queueGeometry();
          return;
        case "load":
          this.sessionLoaded(change.data.activeLayer);
          for (const listener of this.loadListeners) listener(change.origin);
          return;
        case "meta":
          return;
      }
    },
    cell: (data, index) => {
      if (!data[index] && this.hiddenCells[index] && !this.stackValue(index)) {
        this.hiddenCells[index] = 0;
        this._hiddenCellCount.set(untrack(() => this.hiddenCellCount) - 1);
      }
      this.updateCompositeCell(index);
    },
  };

  /** The layer list changed: the active layer stays if it can, else the one below it takes over. */
  private layersChanged(before: readonly Layer[]) {
    const layers = untrack(() => this.layers);
    const activeId = untrack(() => this.activeLayerId);
    if (!layers.some((l) => l.id === activeId)) {
      const index = before.findIndex((l) => l.id === activeId);
      this._activeLayerId.set(index < 0 ? layers[layers.length - 1].id : layers[Math.max(0, Math.min(layers.length - 1, index - 1))].id);
    }
    this.rebuildComposite();
  }

  /** A whole new document: everything in progress and every view setting tied to the old one starts over. */
  private sessionLoaded(activeLayer: number) {
    this.stopMarkerEdit();
    this._palettePreview.set(null);
    this.tools.cancel();
    this.stroke = null;
    this.tx = null;
    this.shapes.operandBase = null;
    this.hiddenCells = new Uint8Array(0);
    this._hiddenCellCount.set(0);
    const layers = untrack(() => this.layers);
    const palette = untrack(() => this.palette);
    this.setSelectionState(new Uint8Array(this.voxelCount()));
    batch(() => {
      this.floats.reset();
      this.extrusions.reset();
      this.shapes.clearEdit();
      this.anim.reset();
      this._activeLayerId.set(layers[Math.min(layers.length - 1, Math.max(0, activeLayer))].id);
      this._workplane.set(DEFAULT_WORKPLANE);
      this._pickingWorkplane.set(false);
      this._mode2D.set(null);
      this._preview.set(null);
      this._shapeDraft.set(null);
      if (untrack(() => this.color) >= palette.length) this._color.set(1);
    });
    this.history.clear();
    this.rebuildComposite();
  }

  // #region State

  get name() {
    return this.doc.name;
  }
  /** The visible voxel and face under a hovering pointer. */
  get hover(): HoverHit | null {
    return this._hover.get();
  }
  /** The custom tool with this id, if the editor has one. */
  customTool(id: string): CustomTool | undefined {
    return this.customTools.get(id);
  }
  get size(): Vec3 {
    return this.doc.size;
  }
  /** The document's palette, with the color a picker is previewing, if one is. */
  get palette(): readonly number[] {
    const palette = this.doc.palette;
    const preview = this._palettePreview.get();
    if (!preview || preview.index >= palette.length) return palette;
    if (this.previewed.palette?.from !== palette || this.previewed.palette.preview !== preview) {
      const next = [...palette];
      next[preview.index] = preview.color;
      this.previewed.palette = { from: palette, preview, value: next };
    }
    return this.previewed.palette.value;
  }
  get layers(): readonly Layer[] {
    return this.doc.layers;
  }
  get activeLayerId() {
    return this._activeLayerId.get();
  }
  /** A layer by id. */
  layer(id: string | null | undefined): Layer | undefined {
    if (id == null) return undefined;
    return this.doc.layer(id);
  }
  get activeLayer(): Layer | undefined {
    const id = this.activeLayerId;
    return this.layer(id);
  }
  get tool() {
    return this._tool.get();
  }
  get previousTool() {
    return this._previousTool.get();
  }
  get brush() {
    return this._brush.get();
  }
  get fillMode() {
    return this._fillMode.get();
  }
  /** What the shape tools draw: a preset such as "box" or "cone" (see `SHAPE_PRESETS`). */
  get shapePreset(): ShapePreset {
    return this._shapePreset.get();
  }
  /** The kind of shape the shape tools draw (a box, cylinder, cone or pyramid is a "prism"). */
  get shapeKind(): ShapeKind {
    return presetEntry(this._shapePreset.get()).kind;
  }
  /** The settings the shapes the tools draw start with: a prism's sides and taper, an arch's sweep. */
  get shapeParams(): ShapeParams {
    return presetEntry(this._shapePreset.get()).params;
  }
  get shapeHollow() {
    return this._shapeHollow.get();
  }
  /** What a new shape on a vector layer does to those below it: add, cut, intersect or paint. UI state. */
  get shapeMode(): StepMode {
    return this._shapeMode.get();
  }
  /** What the Pen draws on a vector layer. UI state. */
  get penProfile(): PenProfile {
    return this._penProfile.get();
  }
  /** Whether the Pen draws a smooth curve through its points. UI state. */
  get penSmooth(): boolean {
    return this._penSmooth.get();
  }
  /** Shapes are drawn out from where the drag starts, in both directions, instead of from a corner. */
  get shapeFromCenter() {
    return this._shapeFromCenter.get();
  }
  /** Shapes are drawn with a square base. Shift does the opposite while it is held. */
  get shapeUniform() {
    return this._shapeUniform.get();
  }
  /** The shape being placed with the shape brush (or a shape layer's box being edited), until it is applied or cancelled. */
  get pendingShape(): PendingShape | null {
    const draft = this._shapeDraft.get();
    const operand = this.shapes.operandEdit;
    if (operand) {
      if (!draft) return null;
      const mode = operand.step ?? this.selectedStep?.step.mode;
      const step = operand.mode === "step" ? null : this.selectedStep?.step.shape;
      const kind = step ? step.kind : this.shapeKind;
      const params = step ? paramsOf(step) : this.shapeParams;
      const op = mode === "cut" ? "erase" : mode === "paint" ? "paint" : "add";
      // a path the Pen is drawing is handled like one edited in place: its points, not its box
      const pen = this.shapes.drawingPath?.stepId === operand.stepId;
      const phase = operand.drawing ? { drawing: operand.drawing } : this.shapes.editingShape || pen ? { editing: true } : {};
      return { ...draft, kind, params, hollow: false, op, operand: operand.mode, ...phase };
    }
    const op = this.tool === "select" ? "select" : toolOp(this.tool);
    if (!draft || !op) return null;
    return { ...draft, kind: this.shapeKind, params: this.shapeParams, hollow: this.shapeHollow, op };
  }
  /** The select tool's brush. Separate from the content brush, so each tool keeps its own. */
  get selectBrush() {
    return this._selectBrush.get();
  }
  /** How select gestures combine with the current selection. */
  get selectMode() {
    return this._selectMode.get();
  }
  get selectionVersion() {
    return this._selectionVersion.get();
  }
  get hasSelection() {
    this._selectionVersion.get();
    return this.selectedCount > 0;
  }
  get selectionCount() {
    this._selectionVersion.get();
    return this.selectedCount;
  }
  /** The selection mask, one byte per cell (x-major). Read-only: change it through the select methods. */
  get selectionMask(): Uint8Array {
    this._selectionVersion.get();
    return this.selection;
  }
  /** Content lifted by a move, rotate, flip, duplicate or paste, until it is applied or cancelled. */
  get floating(): Floating | null {
    return this.floats.floating;
  }
  /** How far the floating content's center has moved since it was lifted, in whole cells. */
  get floatingDelta(): Vec3 | null {
    return this.floats.floatingDelta;
  }
  /** The face being extruded with the extrude tool, until it is applied or cancelled. */
  get pendingExtrusion(): Extrusion | null {
    return this.extrusions.pendingExtrusion;
  }
  /**
   * What the transform gizmo surrounds: floating content, or what the move tool would lift (the
   * selection, or with nothing selected, the active layer's voxels). Null when there is no gizmo.
   */
  get transformBox(): Box | null {
    if (this.markerEditing || this.pendingExtrusion) return null;
    // a shape being placed or changed turns with the gizmo's rings
    const shape = this.pendingShape;
    if (shape) return shape.op === "select" || shape.drawing || shape.editing ? null : shape.box;
    const f = this.floating;
    if (f) return { min: [...f.offset], max: f.offset.map((n, a) => n + f.size[a] - 1) as Vec3 };
    if (this.tool !== "move") return null;
    if (this.hasSelection) return this.selectionBounds();
    this.geometryVersion;
    const layer = this.activeLayer;
    if (!layer || this.editBlocker()) return null;
    return maskBounds(layer.data, this.size);
  }
  get canPaste() {
    return this.clipboard.clip !== null;
  }
  /** Whether taps on the model place the marker bar's target (a marker or the origin), instead of using the tool. */
  get markerEditing() {
    return this._markerEditing.get();
  }
  /** The marker the marker bar places, or `ORIGIN`; null when none is chosen. */
  get markerTarget(): string | null {
    const target = this._markerTarget.get();
    return target === ORIGIN || (target && this.doc.marker(target)) ? target : null;
  }
  /** Whether the viewport shows markers when the marker bar is closed. View state, not saved. */
  get markersShown() {
    return this._markersShown.get();
  }
  /** The palette index new voxels are painted with. */
  get color() {
    return this._color.get();
  }
  get mirror(): readonly [boolean, boolean, boolean] {
    return this._mirror.get();
  }
  /** Where new voxels go when there is nothing to build against; also the slice. See docs/workplane.md. */
  get workplane(): Workplane {
    return this._workplane.get();
  }
  /** The workplane while it clips, as a slice; null when clip is off. */
  get slice(): Slice | null {
    const { axis, level, clip } = this.workplane;
    return clip === "none" ? null : { axis, level, mode: clip };
  }
  get preview() {
    return this._preview.get();
  }
  get projection() {
    return this._projection.get();
  }
  get toast() {
    return this._toast.get();
  }
  get geometryVersion() {
    return this._geometryVersion.get();
  }
  /** Bumped whenever anything saved in the document changes. */
  get documentVersion() {
    return this.doc.version;
  }
  get canUndo() {
    return this.pendingUndoLabel !== null || (this.historyHost ? this.historyHost.canUndo : this.history.canUndo);
  }
  get canRedo() {
    return this.historyHost ? this.historyHost.canRedo : this.history.canRedo;
  }
  /** The document's stable identity. Kept by saving; New gives a new one. */
  get docId() {
    return this.doc.docId;
  }
  /** Goes up with every committed change to the document, undo, redo and remote edits included. */
  get revision() {
    return this.doc.revision;
  }
  /** Host data by namespace. Change it with `setHostData`. */
  get hostData(): Readonly<Record<string, Json>> {
    return this.doc.hostData;
  }
  /** Why the document can't be changed right now, or null when it can. Selection and view state still can. */
  get readOnly() {
    return this._readOnly.get();
  }

  /** Make the document view-only (with the reason people see when they try to edit), or editable again with null. */
  setReadOnly(reason: string | null) {
    if (reason === untrack(() => this.readOnly)) return;
    if (reason) {
      this.settlePending("cancel");
      this.stopMarkerEdit();
    }
    this._readOnly.set(reason);
  }

  /** Say why the document can't change, if it can't. */
  private blocked(): boolean {
    const reason = untrack(() => this.readOnly);
    if (reason) this.notify(reason);
    return !!reason;
  }

  setName(name: string) {
    name = name.trim() || "Untitled";
    if (name === untrack(() => this.name)) return;
    this.apply("Rename model", { t: "name", before: "", after: name });
  }

  setTool(tool: ToolId) {
    this.stopMarkerEdit();
    if (tool === this.tool) return;
    this.endOperandEdit();
    this.tools.cancel();
    this.applyExtrusion();
    batch(() => {
      this._previousTool.set(this.tool);
      this._tool.set(tool);
      this._preview.set(null);
      // A pending shape follows the tools whose brush is "shape" (so it can switch between
      // adding and selecting), and survives a trip to the color picker.
      const shaping = SHAPE_TOOLS.includes(tool) ? this.brushFor(tool) === "shape" : tool === "pick";
      if (!shaping) this._shapeDraft.set(null);
    });
    this.refreshShape();
  }

  setBrush(brush: BrushMode) {
    const brushShape = untrack(() => !this.shapes.operandEdit && this._shapeDraft.get());
    if (brush !== "shape" && this.tool !== "select" && brushShape) this.cancelShape();
    this._brush.set(brush);
  }

  setSelectBrush(brush: SelectBrush) {
    const brushShape = untrack(() => !this.shapes.operandEdit && this._shapeDraft.get());
    if (brush !== "shape" && this.tool === "select" && brushShape) this.cancelShape();
    this._selectBrush.set(brush);
  }

  setSelectMode(mode: SelectMode) {
    this._selectMode.set(mode);
    this.refreshShape();
  }

  private brushFor(tool: ToolId): SelectBrush {
    return tool === "select" ? this.selectBrush : this.brush;
  }

  /**
   * Choose what the shape tools draw: a preset ("box", "cone", "arch", ...) or a kind, which draws
   * its plain form ("prism" draws a box). A shape being placed takes it too.
   */
  setShapeKind(kind: ShapeKind | ShapePreset) {
    const preset: ShapePreset = SHAPE_PRESET_IDS.includes(kind as ShapePreset) ? (kind as ShapePreset) : (presetOf(kind as ShapeKind) ?? "box");
    const next = presetEntry(preset);
    let draft = untrack(() => (this.shapes.operandEdit ? null : this._shapeDraft.get()));
    if (draft) {
      // a height nobody adjusted stays sensible for the new shape (a torus wants a thin tube)
      const [u, v] = baseAxes(draft);
      const ext = boxExtent(draft.box);
      if (draftHeight(draft) === defaultHeight(this.shapeKind, ext[u], ext[v], this.shapeParams)) {
        draft = withHeight(draft, defaultHeight(next.kind, ext[u], ext[v], next.params), this.size);
      }
    }
    batch(() => {
      this._shapePreset.set(preset);
      if (draft) this._shapeDraft.set(draft);
    });
    this.refreshShape();
    // a shape layer step being placed takes the new shape
    if (untrack(() => this.shapes.operandEdit)?.mode === "step") this.shapes.queueDraft();
  }

  /**
   * Arm a vector layer's shape tool with a preset ("box", "cylinder", ...): `setTool("shape")` and
   * `setShapeKind(preset)` in one. A path preset ("tube", "wall", "slab") arms the Pen instead.
   */
  setShapeTool(preset: ShapePreset) {
    if (presetEntry(preset).kind === "path") {
      this.setPenProfile(preset as PenProfile);
      this.setTool("pen");
      return;
    }
    this.setShapeKind(preset);
    this.setTool("shape");
  }

  setShapeMode(mode: StepMode) {
    this._shapeMode.set(mode);
  }

  setPenProfile(profile: PenProfile) {
    this._penProfile.set(profile);
  }

  setPenSmooth(smooth: boolean) {
    this._penSmooth.set(smooth);
  }

  setShapeHollow(hollow: boolean) {
    this._shapeHollow.set(hollow);
    this.refreshShape();
  }

  setShapeFromCenter(fromCenter: boolean) {
    this._shapeFromCenter.set(fromCenter);
  }

  setShapeUniform(uniform: boolean) {
    this._shapeUniform.set(uniform);
  }

  /**
   * Set (or clear) the shape being placed. The shape brush does this as you draw and
   * drag handles; scripts can too, or skip straight to `placeShape`.
   */
  setPendingShape(draft: ShapeDraft | null) {
    this._shapeDraft.set(draft);
    if (untrack(() => this.shapes.operandEdit)) {
      if (!draft) this.shapes.clearEdit();
      this.shapes.queueDraft();
    }
    if (draft) this.refreshShape();
    else this._preview.set(null);
  }

  /** Turn the pending shape (or a shape layer step being placed) to its next 90° orientation. */
  /**
   * Turn the pending shape a quarter turn `turns` times about `axis`, around its middle: a shape
   * being placed turns as a draft; a shape layer's selected step turns in the document, one undo
   * step each (or one per `beginStroke` / `endStroke`).
   */
  turnPendingShape(axis: Axis, turns: number) {
    const edit = untrack(() => this.shapes.operandEdit);
    if (edit?.mode === "edit") {
      const selected = untrack(() => this.selectedStep);
      if (selected) this.shapes.rotateStepAbout(selected.layerId, selected.step.id, axis, turns);
      return;
    }
    const draft = untrack(() => this._shapeDraft.get());
    if (draft) this.setPendingShape(turnDraft(this.shapeKind, draft, axis, turns, this.size));
  }

  /**
   * Turn a step a quarter turn `turns` times about a world `axis`, around its box's middle, as one
   * undo step: its box's extents across the axis swap, and which way it points (and a wedge's
   * slope, and a limb's corner) turns with it.
   */
  rotateStepAbout(layerId: string, stepId: string, axis: Axis, turns = 1): boolean {
    return this.shapes.rotateStepAbout(layerId, stepId, axis, turns);
  }

  rotatePendingShape() {
    const edit = untrack(() => this.shapes.operandEdit);
    if (edit?.mode === "edit") {
      const selected = untrack(() => this.selectedStep);
      if (selected) this.rotateStep(selected.layerId, selected.step.id);
      return;
    }
    const draft = untrack(() => this._shapeDraft.get());
    if (draft) this.setPendingShape(rotateDraft(this.shapeKind, draft, this.size));
  }

  /** Apply the pending shape to the active layer (or the selection) as one undo step. */
  commitShape(): boolean {
    this.tools.cancel();
    const shape = untrack(() => this.pendingShape);
    if (!shape) return false;
    if (shape.operand) return this.shapes.commitOperand();
    if (shape.op === "select") {
      this.selectShape(shape);
      this.setPendingShape(null);
      return true;
    }
    if (this.refuse(this.prepareEdit())) return false;
    const normal: Vec3 = [0, 0, 0];
    normal[shape.grow.axis] = shape.grow.sign;
    this.placeShape(shape, shape.op, this.color, normal);
    this.setPendingShape(null);
    return true;
  }

  cancelShape() {
    this.tools.cancel();
    this.shapes.operandBase = null;
    this.setPendingShape(null);
  }

  /** Apply a shape directly (mirrored like any brush). Returns the number of changed voxels. */
  placeShape(spec: ShapeSpec, op: VoxelOp = "add", value = this.color, normal?: Vec3): number {
    return this.transact(`${OP_LABELS[op]} ${spec.kind}`, () => this.applyCells(shapeCells(spec), op, value, normal));
  }

  /** What placing (or selecting) a shape would look like. */
  shapePreview(spec: ShapeSpec, op: BrushOp): Preview {
    const select = op === "select";
    return {
      kind: select ? this.selectPreviewKind() : op,
      boxes: [],
      cells: this.mirrorCells(shapeCells(spec)).filter((c) => this.inBounds(c) && (!select || this.inSlice(c))),
      value: this.color,
      outlines: this.mirrorBoxes([spec.box]),
    };
  }

  /** Redraw the pending shape's preview after something it depends on changed. */
  private refreshShape() {
    const shape = untrack(() => this.pendingShape);
    if (shape?.operand) this._preview.set(this.shapes.operandPreview(shape));
    else if (shape) this._preview.set(this.shapePreview(shape, shape.op));
  }

  setProjection(projection: ProjectionMode) {
    if (projection === this.projection) return;
    this.cancelPointer();
    this._projection.set(projection);
  }

  setFillMode(mode: FillMode) {
    this._fillMode.set(mode);
  }

  setColor(index: number) {
    if (index >= 1 && index < this.palette.length) this._color.set(index);
    this.refreshShape();
  }

  setMirror(axis: Axis, on: boolean) {
    const next = [...this.mirror] as [boolean, boolean, boolean];
    next[axis] = on;
    this._mirror.set(next);
    this.refreshShape();
  }

  toggleMirror(axis: Axis) {
    this.setMirror(axis, !this.mirror[axis]);
  }

  /** Move the workplane or change its clip. The level is clamped to the volume. */
  setWorkplane(change: Partial<Workplane>) {
    const prev = this.workplane;
    const next = { ...prev, ...change };
    const max = this.size[next.axis] - 1;
    next.level = Math.max(0, Math.min(max, Math.round(next.level)));
    if (next.axis === prev.axis && next.level === prev.level && next.clip === prev.clip) return;
    this._workplane.set(next);
    // only clipping changes what is visible
    if (prev.clip !== "none" || next.clip !== "none") this.rebuildComposite();
  }

  /** Back to the floor, unclipped. */
  resetWorkplane() {
    this.setWorkplane(DEFAULT_WORKPLANE);
  }

  /** Put the workplane against a face: across its normal, on the layer of cells just outside it. The clip stays. */
  setWorkplaneFromFace(cell: Vec3, normal: Vec3) {
    const axis = dominantAxis(normal);
    this.setWorkplane({ axis, level: cell[axis] + Math.sign(normal[axis]) });
  }

  /**
   * 2D mode: the view looks straight along the workplane's axis from `side`, and selecting picks
   * whole columns of cells (within what the clip shows). See docs/2d-mode.md.
   */
  get mode2D(): Mode2D | null {
    return this._mode2D.get();
  }

  /** Look at the model as a 2D image along the workplane's axis, from its + or − side. */
  enter2D(side: 1 | -1 = 1) {
    const now = untrack(() => this.mode2D);
    if (now?.side === side) return;
    this._mode2D.set({ side });
    this.setPreview(null);
  }

  exit2D() {
    if (!untrack(() => this.mode2D)) return;
    this._mode2D.set(null);
    this.setPreview(null);
  }

  /**
   * Select whole columns along the workplane's axis: every cell whose other two coordinates fall in
   * `box`, within what the clip shows. `box`'s extent along the axis is ignored.
   */
  selectColumns(box: Box, mode: SelectMode = this.selectMode) {
    this.selectBox(this.columnBox(box), mode);
  }

  /** A box stretched through the whole volume along the workplane's axis. */
  columnBox({ min, max }: Box): Box {
    const axis = this.workplane.axis;
    const column: Box = { min: [...min], max: [...max] };
    column.min[axis] = 0;
    column.max[axis] = this.size[axis] - 1;
    return column;
  }

  /** How many cells deep the 2D pencil fills each column, from the workplane toward the viewer. */
  get thickness() {
    return this._thickness.get();
  }

  setThickness(thickness: number) {
    this._thickness.set(Math.max(1, Math.min(MAX_SIZE, Math.round(thickness))));
  }

  /** Whether the 2D pencil fills its thickness on both sides of the workplane, like Kenney Shape's symmetric depth. */
  get bothSides() {
    return this._bothSides.get();
  }

  setBothSides(bothSides: boolean) {
    this._bothSides.set(bothSides);
  }

  /** Whether 2D mode tints each pixel by how near its front voxel is. A view setting. */
  get depthColors() {
    return this._depthColors.get();
  }

  setDepthColors(on: boolean) {
    this._depthColors.set(on);
  }

  /** Whether what the clip hides on the far side of the workplane is drawn faintly, for context. A view setting. */
  get showClipped() {
    return this._showClipped.get();
  }

  setShowClipped(on: boolean) {
    this._showClipped.set(on);
  }

  /**
   * What the clip hides behind the workplane, seen from `side` of it: the clipped cells on the far
   * side, with the values they would show. Null when nothing is clipped.
   */
  clippedBehind(side: 1 | -1): Uint8Array | null {
    const { axis, level, clip } = this.workplane;
    if (clip === "none") return null;
    const [sx, sy] = this.size;
    const out = new Uint8Array(this.clipped.length);
    let any = false;
    for (let i = 0; i < out.length; i++) {
      if (!this.clipped[i]) continue;
      const v = axis === 0 ? i % sx : axis === 1 ? Math.floor(i / sx) % sy : Math.floor(i / (sx * sy));
      if (side > 0 ? v < level : v > level) {
        out[i] = this.clipped[i];
        any = true;
      }
    }
    return any ? out : null;
  }

  /**
   * The cells the 2D pencil fills in a pixel's column: from the workplane toward the viewer for
   * `thickness` cells, or that far on both sides of it. `pixel` is any cell of the column.
   */
  pencilCells(pixel: Vec3, side: 1 | -1 = untrack(() => this.mode2D)?.side ?? 1): Vec3[] {
    const { axis, level } = this.workplane;
    const reach = this.thickness - 1;
    const near = level + side * reach;
    const far = this.bothSides ? level - side * reach : level;
    const cells: Vec3[] = [];
    for (let d = Math.max(0, Math.min(near, far)); d <= Math.min(this.size[axis] - 1, Math.max(near, far)); d++) {
      const c = [...pixel] as Vec3;
      c[axis] = d;
      cells.push(c);
    }
    return cells;
  }

  /**
   * The model as a 2D image: what is visible (clip included) looking along `axis` from `side`.
   * Pixels are indexed `u + width * v`, where u and v are the next two axes after `axis`
   * (`(axis + 1) % 3` and `(axis + 2) % 3`). `color` is the front voxel's palette index (0 for
   * none), `depth` its coordinate along `axis` (-1 for none), and `thickness` how many cells of the
   * column are filled.
   */
  project(axis: Axis = this.workplane.axis, side: 1 | -1 = this.mode2D?.side ?? 1) {
    const size = this.size;
    const u = ((axis + 1) % 3) as Axis;
    const v = ((axis + 2) % 3) as Axis;
    const width = size[u];
    const height = size[v];
    const color = new Uint8Array(width * height);
    const depth = new Int16Array(width * height).fill(-1);
    const thickness = new Uint16Array(width * height);
    const composite = this.composite;
    const c: Vec3 = [0, 0, 0];
    for (let iv = 0; iv < height; iv++) {
      for (let iu = 0; iu < width; iu++) {
        const p = iu + width * iv;
        c[u] = iu;
        c[v] = iv;
        for (let k = 0; k < size[axis]; k++) {
          // front to back
          c[axis] = side > 0 ? size[axis] - 1 - k : k;
          const value = composite[this.index(...c)];
          if (!value) continue;
          thickness[p]++;
          if (depth[p] < 0) {
            depth[p] = c[axis];
            color[p] = value;
          }
        }
      }
    }
    return { axis, side, u, v, width, height, color, depth, thickness };
  }

  /** Whether the next tap on a face puts the workplane against it. */
  get pickingWorkplane() {
    return this._pickingWorkplane.get();
  }

  /** Make the next tap on a face put the workplane against it, instead of using the tool. */
  startWorkplanePick() {
    this._pickingWorkplane.set(true);
    this.setPreview(null);
  }

  cancelWorkplanePick() {
    this._pickingWorkplane.set(false);
    this.setPreview(null);
  }

  /**
   * Where the workplane's drag handle sits: the middle of the edge of its grid nearest `eye` (the
   * camera), so it stays clear of the model.
   */
  workplaneHandle(eye: Vec3): Vec3 {
    const { axis } = this.workplane;
    const size = this.size;
    const center = size.map((n) => n / 2) as Vec3;
    center[axis] = this.workplaneFace;
    let best = center;
    let bestDistance = Infinity;
    for (const a of [(axis + 1) % 3, (axis + 2) % 3]) {
      for (const end of [0, size[a]]) {
        const p = [...center] as Vec3;
        p[a] = end;
        const distance = Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]);
        if (distance < bestDistance) {
          best = p;
          bestDistance = distance;
        }
      }
    }
    return best;
  }

  /** Slice by the workplane: `setSlice(s)` moves it to the slice and clips; `setSlice(null)` stops clipping. */
  setSlice(slice: Slice | null) {
    this.setWorkplane(slice ? { axis: slice.axis, level: slice.level, clip: slice.mode } : { clip: "none" });
  }

  /**
   * Where along its axis the workplane's grid lies: the exposed face of its layer while clipping,
   * otherwise its lower face (so the default is the floor).
   */
  get workplaneFace(): number {
    const { level, clip } = this.workplane;
    return level + (clip === "none" || clip === "+" ? 0 : 1);
  }

  setPreview(preview: Preview | null) {
    this._preview.set(preview);
  }

  notify(message: string) {
    this._toast.set({ message, id: (untrack(() => this._toast.get())?.id ?? 0) + 1 });
  }

  // #endregion

  // #region Geometry helpers

  index(x: number, y: number, z: number) {
    const [sx, sy] = this.size;
    return x + sx * (y + sy * z);
  }

  private coord(i: number): Vec3 {
    const [sx, sy] = this.size;
    return cellCoord(i, sx, sy);
  }

  inBounds(c: Vec3) {
    const s = this.size;
    return c[0] >= 0 && c[1] >= 0 && c[2] >= 0 && c[0] < s[0] && c[1] < s[1] && c[2] < s[2];
  }

  inSlice(c: Vec3) {
    const slice = this.slice;
    if (!slice) return true;
    const v = c[slice.axis];
    return sliceContains(slice, v);
  }

  /** Reflect cells across every enabled mirror plane. */
  mirrorCells(cells: Vec3[]): Vec3[] {
    let out = cells;
    const s = this.size;
    this.mirror.forEach((on, axis) => {
      if (!on) return;
      out = out.concat(
        out.map((c) => {
          const m = [...c] as Vec3;
          m[axis] = s[axis] - 1 - c[axis];
          return m;
        }),
      );
    });
    return out;
  }

  mirrorBoxes(boxes: Box[]): Box[] {
    let out = boxes;
    const s = this.size;
    this.mirror.forEach((on, axis) => {
      if (!on) return;
      out = out.concat(
        out.map((b) => {
          const min = [...b.min] as Vec3;
          const max = [...b.max] as Vec3;
          min[axis] = s[axis] - 1 - b.max[axis];
          max[axis] = s[axis] - 1 - b.min[axis];
          return { min, max };
        }),
      );
    });
    return out;
  }

  /** Values hidden from rendering and picking. UI state, never saved or undone. */
  get hiddenValues(): ReadonlySet<number> {
    return this._hiddenValues.get();
  }

  setHiddenValues(values: Iterable<number>) {
    this._hiddenValues.set(new Set(values));
    this.visibilityChanged();
  }

  isValueVisible(value: number): boolean {
    return value !== 0 && !this.hiddenValues.has(value);
  }

  /** How many cells `hideCells` has hidden. UI state, never saved or undone. */
  get hiddenCellCount(): number {
    return this._hiddenCellCount.get();
  }

  /** While true, hidden cells render, pick and edit as usual; they stay hidden. */
  get hiddenCellsShown(): boolean {
    return this._hiddenCellsShown.get();
  }

  setHiddenCellsShown(shown: boolean) {
    if (shown === untrack(() => this.hiddenCellsShown)) return;
    this._hiddenCellsShown.set(shown);
    this.visibilityChanged();
  }

  /** Whether the cell is hidden right now: by `hideCells` (unless shown) or by its value. */
  isCellHidden(c: Vec3, layerId = this.activeLayerId): boolean {
    if (!this.inBounds(c)) return false;
    const i = this.index(...c);
    const layer = this.layer(layerId);
    return this.cellHiddenAt(i) || (!!layer?.data[i] && !this.isValueVisible(layer.data[i]));
  }

  /** Whether `hideCells` hid the cell, even while hidden cells are shown. */
  isPositionHidden(c: Vec3): boolean {
    return this.inBounds(c) && this.hiddenCells[this.index(...c)] === 1;
  }

  /** Hide filled cells from rendering and picking, by position. Returns how many were newly hidden. */
  hideCells(cells: Vec3[]): number {
    this.ensureHiddenCells();
    let changed = 0;
    for (const c of cells) {
      if (!this.inBounds(c)) continue;
      const i = this.index(...c);
      if (this.hiddenCells[i] || !this.stackValue(i)) continue;
      this.hiddenCells[i] = 1;
      changed++;
    }
    if (changed) this.hiddenCellsChanged(changed);
    return changed;
  }

  /** Stop hiding cells by position. Returns how many were hidden. */
  showCells(cells: Vec3[]): number {
    let changed = 0;
    for (const c of cells) {
      if (!this.inBounds(c)) continue;
      const i = this.index(...c);
      if (!this.hiddenCells[i]) continue;
      this.hiddenCells[i] = 0;
      changed--;
    }
    if (changed) this.hiddenCellsChanged(changed);
    return -changed;
  }

  clearHiddenCells() {
    if (!untrack(() => this.hiddenCellCount)) return;
    this.hiddenCells.fill(0);
    this._hiddenCellCount.set(0);
    this.visibilityChanged();
  }

  /** Hidden by position right now (not while hidden cells are shown). */
  private cellHiddenAt(i: number): boolean {
    return this.hiddenCells[i] === 1 && !untrack(() => this.hiddenCellsShown);
  }

  /** Whether a cell holding `value` renders, picks and edits. */
  private visibleAt(i: number, value: number): boolean {
    return this.isValueVisible(value) && !this.cellHiddenAt(i);
  }

  private ensureHiddenCells() {
    const count = this.voxelCount();
    if (this.hiddenCells.length === count) return;
    this.hiddenCells = new Uint8Array(count);
    this._hiddenCellCount.set(0);
  }

  private hiddenCellsChanged(delta: number) {
    this._hiddenCellCount.set(untrack(() => this.hiddenCellCount) + delta);
    if (!untrack(() => this.hiddenCellsShown)) this.visibilityChanged();
  }

  private visibilityChanged() {
    this.rebuildComposite();
    this.setPreview(null);
    this._hover.set(null);
  }

  /** Raycast against everything visible (all visible layers, clipped by the slice). */
  pickVisible(ray: Ray): Hit | null {
    const composite = this.composite;
    return raycastVolume(ray, this.size, (i) => composite[i] !== 0);
  }

  /**
   * Raycast against the active layer only (clipped by the slice). An override layer edits what
   * is visible, so it picks everything visible; a shape layer has no voxels to pick.
   */
  pickActive(ray: Ray): Hit | null {
    const layer = this.activeLayer;
    if (!layer || !layer.visible || layer.shape) return null;
    if (layer.coverage) return this.pickVisible(ray);
    const { data } = layer;
    const [sx, sy] = this.size;
    const slice = this.slice;
    return raycastVolume(ray, this.size, (i) => {
      if (!this.visibleAt(i, data[i])) return false;
      if (!slice) return true;
      const c: Vec3 = cellCoord(i, sx, sy);
      return this.inSlice(c);
    });
  }

  // #endregion

  // #region Voxels

  /** A layer's value at a cell: its raster value, or for a shape layer, the evaluated one. 0 is empty or unset. */
  getVoxel(c: Vec3, layerId = this.activeLayerId): number {
    const layer = this.layer(layerId);
    if (!layer || !this.inBounds(c)) return 0;
    return this.layerValues(layer)[this.index(...c)] ?? 0;
  }

  /**
   * Set one cell of a raster layer (covered, on an override layer; 0 there is a covered empty).
   * Like every edit it refuses a hidden or locked layer, saying why. Returns whether it wrote.
   */
  setVoxel(c: Vec3, value: number, layerId = this.activeLayerId): boolean {
    // editing stops playback first, so the layer's voxels are the frame showing
    this.pause();
    const layer = this.layer(layerId);
    if (!layer || !this.inBounds(c) || layer.shape) return false;
    // the same guards as every other edit, for the layer it writes
    const reason = untrack(() => this.readOnly) ?? (!layer.visible ? "Layer is hidden" : layer.locked ? "Layer is locked" : null);
    if (this.refuse(reason)) return false;
    this.transact("Set voxel", () => this.writeState(layer, this.index(...c), value));
    return true;
  }

  /**
   * An override layer's cell: -1 when unset, 0 when covered empty, otherwise the covered color.
   * On a legacy raster layer, 0 is unset (-1). Read-only; edit through the brush methods.
   */
  getOverride(c: Vec3, layerId = this.activeLayerId): number {
    const layer = this.layer(layerId);
    if (!layer || !this.inBounds(c) || layer.shape) return -1;
    return this.rasterState(layer, this.index(...c));
  }

  /**
   * About to edit the active layer: stop playback (so the layer's voxels are the frame showing),
   * then say why it can't be edited, or null.
   */
  /** Say why not, when there is a reason not to go on. True when refused. */
  private refuse(reason: string | null): boolean {
    if (!reason) return false;
    this.notify(reason);
    return true;
  }

  private prepareEdit(): string | null {
    this.pause();
    return this.editBlocker();
  }

  /** Why the active layer can't be edited right now, if it can't. */
  editBlocker(): string | null {
    const readOnly = this.readOnly;
    if (readOnly) return readOnly;
    const layer = this.activeLayer;
    if (!layer) return "No layer selected";
    if (!layer.visible) return "Layer is hidden";
    if (layer.locked) return "Layer is locked";
    if (layer.shape) return `“${layer.name}” is a vector layer: voxel tools work on raster layers, or on an override layer above it`;
    return null;
  }

  /**
   * Apply a brush operation to cells on the active layer, reflected across enabled
   * mirror planes. "add" fills empty or hidden cells; "paint" only recolors visible filled ones.
   * While something is selected, only selected cells change.
   * An optional normal orients Add through `placeValue`; without it values stay literal.
   */
  applyCells(cells: Vec3[], op: VoxelOp, value = this.color, normal?: Vec3): number {
    if (op === "add" && this.placeValue && normal) value = this.placeValue(value, normal);
    const label = op === "add" ? "Add voxels" : op === "erase" ? "Erase voxels" : "Paint voxels";
    if (untrack(() => this.activeLayer)?.coverage) {
      // An override layer finds what to change in what is visible and covers the cells it writes:
      // Add covers cells with the color, Erase covers visible voxels with empty, and Paint
      // recolors visible voxels without adding any in empty space.
      return this.editOverride(label, cells, (state, shown, i) => {
        if (op === "add") {
          if (state > 0 && this.visibleAt(i, state)) return null;
          if (this.cellHiddenAt(i)) this.showCells([this.coord(i)]);
          return value;
        }
        if (op === "erase") return shown || state > 0 ? 0 : null;
        return shown ? value : null;
      });
    }
    const next = op === "add"
      ? (v: number, i: number) => {
        if (!v) return value;
        if (this.visibleAt(i, v)) return v;
        // adding where a cell is hidden by position brings it back
        if (this.cellHiddenAt(i)) this.showCells([this.coord(i)]);
        return this.isValueVisible(v) ? v : (this.replaceHiddenValue?.(v, value) ?? value);
      }
      : op === "erase" ? (v: number, i: number) => this.visibleAt(i, v) ? 0 : v
      : (v: number, i: number) => this.visibleAt(i, v) ? value : v;
    return this.editCells(label, cells, next);
  }

  /** Set cells of the active layer to `value` (0 erases), whatever they held. Mirrored and clipped like `applyCells`. */
  setCells(cells: Vec3[], value: number): number {
    const label = value ? "Set voxels" : "Erase voxels";
    if (untrack(() => this.activeLayer)?.coverage) return this.editOverride(label, cells, () => value);
    return this.editCells(label, cells, () => value);
  }

  /**
   * Rewrite cells of the active layer from their current values (0 for empty) with `map`.
   * Mirrored and clipped like `applyCells`; one undo step unless inside a stroke.
   */
  updateCells(label: string, cells: Vec3[], map: (value: number) => number): number {
    if (untrack(() => this.activeLayer)?.coverage) {
      // an unset cell that maps to empty stays unset, rather than cutting what is below
      return this.editOverride(label, cells, (state) => {
        const next = map(Math.max(0, state));
        return state < 0 && next === 0 ? null : next;
      });
    }
    return this.editCells(label, cells, map);
  }

  private editCells(label: string, cells: Vec3[], map: (value: number, index: number) => number): number {
    this.settle();
    if (this.refuse(this.prepareEdit())) return 0;
    const { data } = this.activeLayer!;
    const mask = this.selectedCount > 0 ? this.selection : null;
    let changed = 0;
    let clipped = 0;
    this.transact(label, () => {
      for (const c of this.mirrorCells(cells)) {
        if (!this.inBounds(c)) continue;
        const i = this.index(...c);
        if (mask && !mask[i]) {
          clipped++;
          continue;
        }
        const current = data[i];
        const next = map(current, i);
        if (next !== current) {
          this.write(data, i, next);
          changed++;
        }
      }
    });
    if (clipped && !changed) this.noteClipped();
    return changed;
  }

  /**
   * Edit cells of the active override layer, mirrored and clipped like `editCells`. `next` gets a
   * cell's state (-1 unset, 0 covered empty, else the covered color) and what is visible there,
   * and returns the new state, or null to leave it.
   */
  private editOverride(label: string, cells: Vec3[], next: (state: number, shown: number, index: number) => number | null): number {
    this.settle();
    if (this.refuse(this.prepareEdit())) return 0;
    const layer = this.activeLayer!;
    const mask = this.selectedCount > 0 ? this.selection : null;
    let changed = 0;
    let clipped = 0;
    this.transact(label, () => {
      const seen = new Set<number>();
      for (const c of this.mirrorCells(cells)) {
        if (!this.inBounds(c)) continue;
        const i = this.index(...c);
        if (seen.has(i)) continue;
        seen.add(i);
        if (mask && !mask[i]) {
          clipped++;
          continue;
        }
        const state = this.rasterState(layer, i);
        const to = next(state, this.composite[i], i);
        if (to !== null && this.writeState(layer, i, to)) changed++;
      }
    });
    if (clipped && !changed) this.noteClipped();
    return changed;
  }

  /** A raster cell's state: -1 unset, 0 covered empty, otherwise its color. A legacy layer's 0 is unset. */
  private rasterState(layer: Layer, i: number): number {
    if (layer.coverage) return layer.coverage[i] ? layer.data[i] : -1;
    return layer.data[i] || -1;
  }

  /** Set a raster cell's state (see `rasterState`). A legacy layer can't hold a covered empty, so 0 unsets it. Returns whether it changed. */
  private writeState(layer: Layer, i: number, state: number): boolean {
    const { data, coverage } = layer;
    if (!coverage) {
      const value = Math.max(0, state);
      if (data[i] === value) return false;
      this.write(data, i, value);
      return true;
    }
    const covered = state >= 0 ? 1 : 0;
    const value = Math.max(0, state);
    if (coverage[i] === covered && data[i] === value) return false;
    // values first when uncovering, coverage first when covering, so a nonzero value is always covered
    if (covered) {
      this.write(coverage, i, 1);
      this.write(data, i, value);
    } else {
      this.write(data, i, 0);
      this.write(coverage, i, 0);
    }
    return true;
  }

  /** Say why an edit did nothing, without repeating it for every cell of a stroke. */
  private noteClipped() {
    const now = Date.now();
    if (now - this.clipNoticeAt < 2000) return;
    this.clipNoticeAt = now;
    this.notify("Only the selection can be edited");
  }

  /**
   * Recolor the region of same-colored voxels at `seed` on the active layer.
   * "connected" floods face-adjacent voxels; "all" replaces the color everywhere.
   */
  fill(seed: Vec3, value = this.color, mode: FillMode = this.fillMode) {
    this.settle();
    if (this.refuse(this.prepareEdit())) return;
    const layer = this.activeLayer!;
    const { data } = layer;
    const [sx, sy, sz] = this.size;
    const mask = this.selectedCount > 0 ? this.selection : null;
    if (mask && this.inBounds(seed) && !mask[this.index(...seed)]) return this.noteClipped();
    const visible = (i: number) =>
      (!mask || mask[i] !== 0) && this.inSlice(cellCoord(i, sx, sy));

    if (layer.coverage) {
      // an override floods what is visible and covers it with the color, wherever it came from
      const shown = this.composite;
      this.transact("Fill", () => {
        for (const s of this.mirrorCells([seed])) {
          if (!this.inBounds(s)) continue;
          const start = this.index(...s);
          const target = shown[start];
          if (target === 0 || target === value) continue;
          const region =
            mode === "all"
              ? shown.map((v, i) => (v === target && visible(i) ? 1 : 0))
              : floodMask([start], this.size, (i) => shown[i] === target && visible(i));
          for (let i = 0; i < region.length; i++) if (region[i]) this.writeState(layer, i, value);
        }
      });
      return;
    }

    this.transact("Fill", () => {
      for (const s of this.mirrorCells([seed])) {
        if (!this.inBounds(s)) continue;
        const start = this.index(...s);
        const target = data[start];
        if (target === 0 || target === value) continue;

        if (mode === "all") {
          for (let i = 0; i < data.length; i++) {
            if (data[i] === target && visible(i)) this.write(data, i, value);
          }
          continue;
        }

        const stack = [start];
        this.write(data, start, value);
        while (stack.length) {
          const i = stack.pop()!;
          const x = i % sx;
          const y = Math.floor(i / sx) % sy;
          const z = Math.floor(i / (sx * sy));
          const neighbors = [
            x > 0 ? i - 1 : -1,
            x < sx - 1 ? i + 1 : -1,
            y > 0 ? i - sx : -1,
            y < sy - 1 ? i + sx : -1,
            z > 0 ? i - sx * sy : -1,
            z < sz - 1 ? i + sx * sy : -1,
          ];
          for (const n of neighbors) {
            if (n >= 0 && data[n] === target && visible(n)) {
              this.write(data, n, value);
              stack.push(n);
            }
          }
        }
      }
    });
  }

  // #endregion

  // #region History

  /** Run `fn` as a single undo step. Nested calls join the outer transaction. */
  transact<T>(label: string, fn: () => T): T {
    if (this.tx) return fn();
    // editing stops playback, on the frame showing
    this.pause();
    const tx = new Transaction(label, this.rawWrite, this.doc.target);
    this.tx = tx;
    try {
      return fn();
    } finally {
      this.tx = this.stroke;
      this.record(label, tx);
    }
  }

  /** Whether a stroke is under way (`beginStroke` without its `endStroke` or `cancelStroke` yet). */
  get stroking() {
    return this.stroke !== null;
  }

  /** Start a transaction that spans several events (e.g. a pointer drag). */
  beginStroke(label: string) {
    this.endStroke();
    this.pause();
    this.stroke = new Transaction(label, this.rawWrite, this.doc.target);
    this.tx = this.stroke;
  }

  endStroke() {
    const stroke = this.stroke;
    if (!stroke) return;
    this.stroke = null;
    this.tx = null;
    this.record(stroke.label, stroke);
  }

  /** Abandon the current stroke, reverting everything it changed. */
  cancelStroke() {
    const stroke = this.stroke;
    if (!stroke) return;
    this.stroke = null;
    this.tx = null;
    stroke.revert();
  }

  /** Put a finished transaction in the history, and tell listeners about its document ops. */
  private record(label: string, tx: Transaction) {
    if (tx.isEmpty) return;
    const items = tx.seal();
    const entry = entryOf(randomId("edit:"), label, items);
    if (this.historyHost) this.historyHost.record(this, entry);
    else this.history.push(entry);
    this.emit(entry);
  }

  private emit(entry: Entry) {
    const ops = entry.items.flatMap((item) => ("op" in item ? [item.op] : []));
    if (!ops.length) return;
    this.doc.commit();
    const edit: LocalEdit = { id: entry.id, label: entry.label, ops };
    for (const listener of this.editListeners) listener(edit);
  }

  /** Returns whether anything was undone. */
  undo(): boolean {
    // undo while placing a shape or moving content takes that back first; a box being edited
    // commits each drag, so there is nothing pending to take back between drags
    const shape = untrack(() => this.pendingShape);
    if (shape && shape.operand !== "edit") return this.cancelShape(), true;
    if (untrack(() => this.floating)) return this.cancelTransform(), true;
    if (untrack(() => this.pendingExtrusion)) return this.cancelExtrusion(), true;
    this.cancelPointer();
    return this.historyHost ? this.historyHost.undo() : this.step("undo");
  }

  /** Returns whether anything was redone. */
  redo(): boolean {
    this.dropTransient();
    return this.historyHost ? this.historyHost.redo() : this.step("redo");
  }

  /** Pending content takes precedence over history; existing shape edits are already recorded. */
  private get pendingUndoLabel(): string | null {
    const shape = this.pendingShape;
    if (shape && shape.operand !== "edit") return "Cancel shape";
    if (this.floating) return "Cancel move";
    if (this.pendingExtrusion) return "Cancel extrusion";
    return null;
  }

  /** The next action `undo` takes back, including pending content before recorded history. */
  get undoLabel(): string | null {
    return this.pendingUndoLabel ?? (this.historyHost ? (this.historyHost.undoLabel ?? null) : this.history.undoLabel);
  }

  get redoLabel(): string | null {
    return this.historyHost ? (this.historyHost.redoLabel ?? null) : this.history.redoLabel;
  }

  /** Drop what undo and redo can't carry across: a stroke under way, floating content, an extrusion. */
  private dropTransient() {
    this.cancelPointer();
    this.cancelTransform();
    this.cancelExtrusion();
  }

  /**
   * Settle or drop what is in progress, before something replaces what it is in (another frame,
   * a grid, a read-only document, closing): a stroke under way is taken back (unless `stroke` is
   * false) and a step's box edit ends; a shape being placed (`shape`, which defaults to `policy`),
   * floating content and an extrusion are applied ("commit") or dropped ("cancel").
   */
  private settlePending(policy: PendingPolicy, options: { shape?: PendingPolicy; stroke?: boolean } = {}) {
    if (options.stroke !== false) this.cancelPointer();
    this.endOperandEdit();
    if ((options.shape ?? policy) === "commit") {
      if (untrack(() => this.pendingShape)) this.commitShape();
    } else {
      this.cancelShape();
    }
    if (policy === "commit") {
      this.settle();
    } else {
      this.cancelTransform();
      this.cancelExtrusion();
    }
  }

  /**
   * Take back an entry this editor recorded, for a history host: what `undo` does with the
   * newest entry of its own history. `verb` words the notice when someone else's change is kept.
   */
  takeBack(entry: Entry, verb: "undo" | "redo" = "undo"): TakeBack {
    if (entry.items.some((item) => "op" in item) && this.blocked()) return { done: false, inverse: null };
    this.dropTransient();
    this.tools.cancel();
    this.pause();
    const { items, skipped } = invertEntry(this.doc.target, entry);
    this.anim.revealFrame(items);
    this.shapes.syncOperand();
    let inverse: Entry | null = null;
    if (items.length) {
      inverse = entryOf(randomId("edit:"), entry.label, items);
      this.emit(inverse);
    }
    if (skipped) {
      const all = !items.some((item) => "op" in item);
      this.notify(
        all
          ? `Couldn't ${verb} “${entry.label}”: someone else changed it`
          : `Some of “${entry.label}” was changed by someone else and kept`,
      );
    }
    return { done: true, inverse };
  }

  /**
   * Take back the newest undo (or redo) entry. In a shared document, parts someone else has
   * changed since stay as they are; the rest is taken back.
   */
  private step(from: "undo" | "redo"): boolean {
    const entry = this.history.peek(from);
    if (!entry) return false;
    const { done, inverse } = this.takeBack(entry, from);
    if (!done) return false;
    this.history.pop(from);
    if (inverse) this.history.pushTo(from === "undo" ? "redo" : "undo", inverse);
    return true;
  }

  /** Apply a document op as (part of) an undo step. Returns false, with a notice, if it doesn't fit. */
  private apply(label: string, op: DocOp): boolean {
    if (this.blocked()) return false;
    return this.transact(label, () => {
      try {
        applyOp(this.doc.target, op);
      } catch (e) {
        if (!(e instanceof OpError)) throw e;
        this.notify(e.message);
        return false;
      }
      this.tx!.push(op);
      return true;
    });
  }

  /** Record a change to local state (the selection) in the current undo step. */
  private local(label: string, change: LocalChange) {
    this.transact(label, () => this.tx!.pushLocal(change));
  }

  private write(data: Uint8Array, index: number, value: number) {
    const before = data[index];
    if (before === value) return;
    if (data === this.selection) {
      this.tx?.recordSelection(data, index, before);
    } else {
      // nothing should get here while read-only, but the document must not change if it does
      if (untrack(() => this.readOnly)) return;
      const owner = this.doc.ownerOf(data);
      if (this.tx && owner) this.tx.recordVoxel(data, owner.id, owner.frame, this.doc.gen, index, before, owner.channel);
    }
    this.rawWrite(data, index, value);
  }

  private rawWrite = (data: Uint8Array, index: number, value: number) => {
    if (data === this.selection) {
      if (!data[index] !== !value) this.selectedCount += value ? 1 : -1;
      data[index] = value;
      this.queueSelection();
      return;
    }
    // the document tells this session (and any other) what changed on screen
    this.doc.writeCell(data, index, value);
  };

  // #endregion

  // #region Shared documents

  /** Hear about each document edit made here, including undo and redo, as ops. Returns a function that stops. */
  onEdit(listener: (edit: LocalEdit) => void): () => void {
    this.editListeners.add(listener);
    return () => this.editListeners.delete(listener);
  }

  /**
   * Hear about each time the whole document is replaced, with the `origin` given to
   * `loadDocument` ("user" for new and open). Returns a function that stops.
   */
  onLoad(listener: (origin: string) => void): () => void {
    this.loadListeners.add(listener);
    return () => this.loadListeners.delete(listener);
  }

  /**
   * Apply document ops made elsewhere, without history or edit events. All or nothing: throws
   * an `OpError`, changing nothing, if they don't fit.
   */
  applyOps(ops: readonly DocOp[]) {
    this.doc.applyRemote(ops);
    this.afterOps(ops);
  }

  /** Take back ops applied earlier (newest first), without history or edit events. */
  revertOps(ops: readonly DocOp[]) {
    this.doc.revertRemote(ops);
    this.afterOps(ops);
  }

  /**
   * Change the document underneath what is in progress here, for `incoming` ops from elsewhere:
   * `fn` runs with an unfinished stroke lifted off, and the stroke then goes back on top. Ops
   * that could leave the stroke pointing at the wrong cells or colors cancel it instead.
   */
  reconcile(incoming: readonly DocOp[], fn: () => void) {
    const breaking = incoming.some(
      (op) => op.t === "resize" || op.t === "layer.remove" || op.t === "palette.replace" || op.t === "palette.remove",
    );
    if (this.stroke && breaking) this.cancelPointer();
    const restore = this.stroke ? this.stroke.lift() : null;
    try {
      fn();
    } finally {
      restore?.();
    }
  }

  /** Keep what depends on the document consistent after ops from elsewhere. */
  private afterOps(ops: readonly DocOp[]) {
    if (ops.some(isStructural)) {
      const ids = new Set(untrack(() => this.layers).map((l) => l.id));
      const floating = untrack(() => this.floating);
      if (floating && !ids.has(floating.layerId)) {
        this.cancelTransform();
        this.notify("Someone else deleted the layer you were moving");
      }
      const ext = untrack(() => this.pendingExtrusion);
      if (ext && !ids.has(ext.layerId)) this.cancelExtrusion();
    }
    const ext = untrack(() => this.pendingExtrusion);
    if (ext) this._preview.set(this.extrusionPreview(ext));
    this.shapes.syncOperand();
    this.refreshShape();
  }


  // #endregion

  // #region Selection

  /** Whether a cell is selected. */
  isSelected(c: Vec3) {
    return this.inBounds(c) && this.selection[this.index(...c)] !== 0;
  }

  /** Bounds of the selected cells, or null when nothing is selected. */
  selectionBounds(): Box | null {
    if (this.selectedCount === 0) return null;
    return maskBounds(this.selection, this.size);
  }

  /**
   * Select cells like a brush would: reflected across enabled mirror planes, and only
   * where the slice shows. `mode` defaults to the select tool's mode.
   */
  selectCells(cells: Vec3[], mode: SelectMode = this.selectMode, label?: string) {
    const incoming = new Uint8Array(this.voxelCount());
    for (const c of this.mirrorCells(cells)) {
      if (this.inBounds(c) && this.inSlice(c)) incoming[this.index(...c)] = 1;
    }
    this.selectMask(incoming, mode, label);
  }

  /** Select an inclusive box of cells. */
  selectBox({ min, max }: Box, mode: SelectMode = this.selectMode) {
    const cells: Vec3[] = [];
    for (let z = Math.max(0, min[2]); z <= Math.min(this.size[2] - 1, max[2]); z++)
      for (let y = Math.max(0, min[1]); y <= Math.min(this.size[1] - 1, max[1]); y++)
        for (let x = Math.max(0, min[0]); x <= Math.min(this.size[0] - 1, max[0]); x++) cells.push([x, y, z]);
    this.selectCells(cells, mode);
  }

  /** Select the cells a shape covers. */
  selectShape(spec: ShapeSpec, mode: SelectMode = this.selectMode) {
    this.selectCells(shapeCells(spec), mode, mode === "subtract" ? "Deselect" : `Select ${spec.kind}`);
  }

  /**
   * Select visible voxels by color, like a magic wand: the connected voxels of the color
   * at `seed`, or ("all") every voxel of that color.
   */
  selectColor(seed: Vec3, scope: FillMode = this.fillMode, mode: SelectMode = this.selectMode) {
    const composite = this.composite;
    const incoming = new Uint8Array(this.voxelCount());
    for (const s of this.mirrorCells([seed])) {
      if (!this.inBounds(s)) continue;
      const start = this.index(...s);
      const color = composite[start];
      if (!color) continue;
      if (scope === "all") {
        for (let i = 0; i < composite.length; i++) if (composite[i] === color) incoming[i] = 1;
      } else {
        const region = floodMask([start], this.size, (i) => composite[i] === color);
        for (let i = 0; i < region.length; i++) if (region[i]) incoming[i] = 1;
      }
    }
    this.selectMask(incoming, mode, mode === "subtract" ? "Deselect" : "Select color");
  }

  /** Combine a whole-volume mask (one byte per cell) with the selection. */
  selectMask(incoming: Uint8Array, mode: SelectMode = this.selectMode, label?: string) {
    if (incoming.length !== this.voxelCount()) throw new Error("Mask size doesn't match the volume");
    this.settle();
    this.setSelection(combineMask(this.selection, incoming, mode), label ?? (mode === "subtract" ? "Deselect" : "Select"));
  }

  /** Select every visible voxel. */
  selectAll() {
    this.settle();
    const composite = this.composite;
    const next = new Uint8Array(composite.length);
    for (let i = 0; i < next.length; i++) next[i] = composite[i] ? 1 : 0;
    this.setSelection(next, "Select all");
  }

  deselect() {
    this.settle();
    if (this.selectedCount === 0) return;
    this.setSelection(new Uint8Array(this.voxelCount()), "Deselect");
  }

  /** Select the visible voxels that aren't selected (empty cells drop out). */
  invertSelection() {
    this.settle();
    const composite = this.composite;
    const mask = this.selection;
    const next = new Uint8Array(mask.length);
    for (let i = 0; i < next.length; i++) next[i] = composite[i] && !mask[i] ? 1 : 0;
    this.setSelection(next, "Invert selection");
  }

  /** Add every cell touching the selection. */
  growSelection() {
    this.settle();
    this.setSelection(growMask(this.selection, this.size), "Grow selection");
  }

  /** Drop the selected cells on the selection's surface. */
  shrinkSelection() {
    this.settle();
    this.setSelection(shrinkMask(this.selection, this.size), "Shrink selection");
  }

  /** Add every visible voxel connected to a selected one, picking up whole objects. */
  selectConnected() {
    this.settle();
    const composite = this.composite;
    const mask = this.selection;
    const seeds: number[] = [];
    for (let i = 0; i < mask.length; i++) if (mask[i] && composite[i]) seeds.push(i);
    const next = floodMask(seeds, this.size, (i) => composite[i] !== 0);
    for (let i = 0; i < next.length; i++) next[i] |= mask[i];
    this.setSelection(next, "Select connected");
  }

  /** Raycast against the selected cells (including empty ones). */
  pickSelection(ray: Ray): Hit | null {
    if (this.selectedCount === 0) return null;
    const mask = this.selection;
    return raycastVolume(ray, this.size, (i) => mask[i] !== 0);
  }

  /** The preview kind for a select gesture in the current mode. */
  selectPreviewKind(mode: SelectMode = this.selectMode): Preview["kind"] {
    return mode === "subtract" ? "deselect" : "select";
  }

  /** Change the selection to `next`, recording only the cells that differ. */
  private setSelection(next: Uint8Array, label: string) {
    const mask = this.selection;
    this.transact(label, () => {
      for (let i = 0; i < mask.length; i++) if (mask[i] !== next[i]) this.write(mask, i, next[i]);
    });
  }

  /** Swap in a whole mask without history (new documents, resizing). */
  private setSelectionState(mask: Uint8Array) {
    this.selection = mask;
    this.selectedCount = countMask(mask);
    this.queueSelection();
  }

  // #endregion

  // #region Selected content

  /** Erase the selected voxels of the active layer. On an override layer, visible selected voxels are covered with empty. */
  deleteSelection(): number {
    return this.editSelection("Delete", () => 0, (state, shown) => (shown || state > 0 ? 0 : null));
  }

  /** Set every selected cell of the active layer to a color, filling empty ones. */
  fillSelection(value = this.color): number {
    return this.editSelection("Fill selection", () => value, () => value);
  }

  /** Repaint the selected voxels of the active layer. */
  recolorSelection(value = this.color): number {
    return this.editSelection("Recolor selection", (v) => (v ? value : 0), (_, shown) => (shown ? value : null));
  }

  /**
   * Take an override layer's cells back to unset, so what is below shows again: the selected
   * cells, or with nothing selected, the whole layer. Unlike Erase, it never cuts anything.
   */
  clearOverride(layerId = this.activeLayerId): number {
    this.settle();
    const layer = this.layer(layerId);
    if (!layer?.coverage) {
      this.notify("Only override layers can be cleared back to what is below");
      return 0;
    }
    if (this.blocked()) return 0;
    if (layer.locked) {
      this.notify("Layer is locked");
      return 0;
    }
    const mask = this.selectedCount > 0 ? this.selection : null;
    const coverage = layer.coverage;
    let changed = 0;
    this.transact("Clear override", () => {
      for (let i = 0; i < coverage.length; i++) {
        if (coverage[i] && (!mask || mask[i]) && this.writeState(layer, i, -1)) changed++;
      }
    });
    return changed;
  }

  /** Copy (or move) the selected voxels of the active layer to a new layer above it. */
  selectionToLayer({ move = false } = {}): string | null {
    this.settle();
    const source = this.activeLayer;
    if (!source || this.selectedCount === 0) {
      this.notify("Nothing selected");
      return null;
    }
    if (this.refuse(move ? this.editBlocker() : this.readOnly)) return null;
    const mask = this.selection;
    return this.transact(move ? "Move to new layer" : "Copy to new layer", () => {
      const id = this.createLayer();
      const target = this.layer(id);
      if (!target) return null;
      if (source.shape) return id;
      for (let i = 0; i < mask.length; i++) {
        const state = this.rasterState(source, i);
        if (!mask[i] || state < 0) continue;
        this.writeState(target, i, state);
        if (move) this.writeState(source, i, -1);
      }
      return id;
    });
  }

  /** Commit whatever is pending (floating content, an extrusion) before another edit. */
  private settle() {
    this.applyExtrusion();
    this.applyTransform();
  }

  /**
   * Finish what is in progress before the editor is put away (leaving a model edited in a
   * scene): a stroke under way is taken back; a shape being placed, floating content and an
   * extrusion are applied.
   */
  finishPending() {
    this.settlePending("commit");
  }

  /** Copy the selected voxels of the active layer. */
  copy(): boolean {
    return this.floats.copy();
  }

  cut(): boolean {
    return this.floats.cut();
  }

  /** Float the copied voxels where they were copied from, ready to move. Applying selects them. */
  paste(): boolean {
    return this.floats.paste();
  }

  /** Float a copy of the selected content in place, ready to move. */
  duplicateSelection(): boolean {
    return this.floats.duplicateSelection();
  }

  /** Move the selected content (or float it first) by whole cells. */
  moveSelection(delta: Vec3) {
    return this.floats.moveSelection(delta);
  }

  /**
   * Turn the selected content 90° around an axis, about the center of its bounds, `turns` times
   * (negative turns go the other way). A positive turn follows the right-hand rule: around Y, it
   * takes +X toward -Z.
   */
  rotateSelection(axis: Axis, turns = 1) {
    return this.floats.rotateSelection(axis, turns);
  }

  /** Mirror the selected content along an axis, in place. */
  flipSelection(axis: Axis) {
    return this.floats.flipSelection(axis);
  }

  /**
   * Lift the selected content of the active layer so it can be moved; with nothing
   * selected, the whole layer. Returns the floating content, or null if there is nothing to lift.
   */
  liftSelection(): Floating | null {
    return this.floats.liftSelection();
  }

  /** Place the floating content's corner, keeping it inside the volume where it fits. */
  setFloatingOffset(offset: Vec3) {
    return this.floats.setFloatingOffset(offset);
  }

  /** Commit the floating content (and the selection that travels with it) as one undo step. */
  applyTransform(): boolean {
    return this.floats.applyTransform();
  }

  /** Put floating content back where it came from (or drop a paste). */
  cancelTransform() {
    return this.floats.cancelTransform();
  }

  /** Raycast against the floating content and the selection travelling with it. */
  pickFloating(ray: Ray): Hit | null {
    return this.floats.pickFloating(ray);
  }

  /** Rewrite the selected cells of the active layer: `map` on a raster layer, `override` (as in `editOverride`) on an override layer. */
  private editSelection(
    label: string,
    map: (value: number) => number,
    override: (state: number, shown: number) => number | null,
  ): number {
    this.settle();
    if (this.selectedCount === 0) {
      this.notify("Nothing selected");
      return 0;
    }
    if (this.refuse(this.prepareEdit())) return 0;
    const layer = this.activeLayer!;
    const { data } = layer;
    const mask = this.selection;
    let changed = 0;
    if (layer.coverage) {
      this.transact(label, () => {
        for (let i = 0; i < mask.length; i++) {
          if (!mask[i]) continue;
          const next = override(this.rasterState(layer, i), this.composite[i]);
          if (next !== null && this.writeState(layer, i, next)) changed++;
        }
      });
      return changed;
    }
    this.transact(label, () => {
      for (let i = 0; i < mask.length; i++) {
        if (!mask[i]) continue;
        const next = map(data[i]);
        if (next !== data[i]) {
          this.write(data, i, next);
          changed++;
        }
      }
    });
    return changed;
  }

  // #endregion

  // #region Extrusion

  /**
   * The face the extrude tool takes from a voxel of the active layer: the connected, coplanar
   * voxels whose faces look along `normal` into empty space. While anything is selected, only
   * selected voxels count, so a selection marks out part of a face.
   */
  extrusionRegion(cell: Vec3, normal: Vec3): Vec3[] {
    return this.extrusions.extrusionRegion(cell, normal);
  }

  /**
   * Start extruding the face at `cell`, a voxel of the active layer, that looks along `normal`.
   * The extrusion stays pending, previewed, until it is applied or cancelled; `setExtrusionDepth`
   * pulls it out or pushes it in. Returns false, with a notice, if there is no face there.
   */
  startExtrusion(cell: Vec3, normal: Vec3, depth = 0): boolean {
    return this.extrusions.startExtrusion(cell, normal, depth);
  }

  /** How far the pending extrusion reaches: layers added in front of its face, or (negative) carved in. */
  setExtrusionDepth(depth: number) {
    return this.extrusions.setExtrusionDepth(depth);
  }

  /** The depth a new extrusion starts at when tapped: the last one applied, like SketchUp's double-click. */
  get lastExtrusionDepth() {
    return this.extrusions.lastExtrusionDepth;
  }

  /** Commit the pending extrusion as one undo step. The selection follows: it grows over added cells and drops carved ones. */
  applyExtrusion(): boolean {
    return this.extrusions.applyExtrusion();
  }

  cancelExtrusion() {
    return this.extrusions.cancelExtrusion();
  }

  /**
   * Extrude the face at `cell` that looks along `normal` by `depth` layers (negative carves) as
   * one undo step. Returns whether anything changed.
   */
  extrude(cell: Vec3, normal: Vec3, depth: number): boolean {
    return this.extrusions.extrude(cell, normal, depth);
  }

  /** What applying an extrusion would look like: added cells in the face's colors, or carved ones. */
  extrusionPreview(ext: Extrusion): Preview {
    return this.extrusions.extrusionPreview(ext);
  }

  /** Where the pending extrusion's depth handle is, in grid units. */
  extrusionHandle(): Vec3 | null {
    return this.extrusions.extrusionHandle();
  }

  /** Raycast against the pending extrusion: its face and the cells it adds or carves. */
  pickExtrusion(ray: Ray): Hit | null {
    return this.extrusions.pickExtrusion(ray);
  }

  // #endregion

  // #region Layers

  selectLayer(id: string) {
    if (id === this.activeLayerId || !this.layers.some((l) => l.id === id)) return;
    this.settle();
    this.endOperandEdit();
    this._activeLayerId.set(id);
  }

  /**
   * Add an empty layer above the active one and make it active. Returns its id, or null if the
   * document can't change. In a document with shape layers, new raster layers are override
   * layers, so they can erase shapes as well as add to them.
   */
  createLayer(name?: string): string | null {
    const id = newLayerId();
    const index = this.layers.findIndex((l) => l.id === this.activeLayerId) + 1;
    const coverage = !this.isFlat ? new Uint8Array(this.voxelCount()) : undefined;
    const layer = { id, name: name ?? this.nextLayerName(), ...(coverage ? { coverage } : {}) };
    if (!this.apply("New layer", { t: "layer.add", index, layer })) return null;
    this._activeLayerId.set(id);
    return id;
  }

  deleteLayer(id: string) {
    if (!this.layers.some((l) => l.id === id)) return;
    if (this.layers.length === 1) {
      this.clearLayer(id);
      return;
    }
    this.apply("Delete layer", { t: "layer.remove", id });
  }

  duplicateLayer(id: string) {
    const index = this.layers.findIndex((l) => l.id === id);
    if (index < 0) return;
    const source = this.layers[index];
    const copy = newLayerId();
    const layer = {
      id: copy,
      name: `${source.name} copy`,
      ...(source.shape
        ? { shape: source.shape }
        : this.isAnimated
          ? { cels: Object.fromEntries(this.frames.map((f) => [f.id, untrack(() => this.frameCel(f.id, id))])) }
          : { data: source.data.slice() }),
      ...(source.coverage ? { coverage: source.coverage.slice() } : {}),
      visible: source.visible,
      locked: source.locked,
      ...(source.hostData !== undefined ? { hostData: source.hostData } : {}),
      ...(source.extra ? { extra: { ...source.extra } } : {}),
    };
    if (this.apply("Duplicate layer", { t: "layer.add", index: index + 1, layer })) this._activeLayerId.set(copy);
  }

  /**
   * Set one namespace of the document's host data (null removes it), as one undo step. Hosts
   * keep what their app means by the document here; Voxeltoy saves it and leaves it alone.
   */
  setHostData(namespace: string, value: Json) {
    return this.apply("Change data", { t: "data", key: namespace, after: value });
  }

  /** Set a layer's host data (null removes it), as one undo step. */
  setLayerHostData(id: string, value: Json) {
    return this.apply("Change layer data", { t: "layer.data", id, after: value });
  }

  // #region Pipeline: blends, masks, effects, groups

  /** Layer groups: isolated stages that layers and groups name. See docs/pipeline.md. */
  get groups() {
    return this.doc.groups;
  }

  /** Set how a layer combines with what is below (null: its kind's), as one undo step. */
  setLayerBlend(id: string, blend: Blend | null): boolean {
    const layer = untrack(() => this.layer(id));
    if (!layer) return false;
    if (blend === null ? !layer.blend : layer.blend && sameBlend(layer.blend, blend)) return true;
    return this.apply("Change blend", { t: "layer.set", id, key: "blend", after: blend });
  }

  /** Replace a layer's effects (an empty list removes them), as one undo step. */
  setLayerEffects(id: string, effects: readonly Effect[]): boolean {
    if (!untrack(() => this.layer(id))) return false;
    return this.apply("Change effects", { t: "layer.set", id, key: "effects", after: effects.length ? [...effects] : null });
  }

  addLayerEffect(id: string, effect: Effect): boolean {
    const layer = untrack(() => this.layer(id));
    return !!layer && this.setLayerEffects(id, [...(layer.effects ?? []), effect]);
  }

  removeLayerEffect(id: string, index: number): boolean {
    const layer = untrack(() => this.layer(id));
    if (!layer?.effects?.[index]) return false;
    return this.setLayerEffects(id, layer.effects.filter((_, k) => k !== index));
  }

  /** Limit a layer to the selection: its mask becomes the selected cells. One undo step. */
  maskLayerToSelection(id = untrack(() => this.activeLayerId)): boolean {
    if (!untrack(() => this.hasSelection)) {
      this.notify("Select where the layer should act first");
      return false;
    }
    if (!untrack(() => this.layer(id))) return false;
    return this.apply("Mask layer", { t: "layer.mask", id, after: this.selection.slice() });
  }

  clearLayerMask(id = untrack(() => this.activeLayerId)): boolean {
    const layer = untrack(() => this.layer(id));
    if (!layer?.mask) return false;
    return this.apply("Clear mask", { t: "layer.mask", id, after: null });
  }

  /** Select a layer's mask, to see or change it (then Mask to selection again). */
  selectLayerMask(id = untrack(() => this.activeLayerId)): boolean {
    const layer = untrack(() => this.layer(id));
    if (!layer?.mask) return false;
    this.selectMask(layer.mask, "replace", "Select mask");
    return true;
  }

  /**
   * Put layers in a new group, as one undo step: it goes in the group the first of them is in, and
   * takes their place in the stack. Returns its id.
   */
  createGroup(layerIds: readonly string[] = [untrack(() => this.activeLayerId)], name?: string): string | null {
    const layers = untrack(() => this.layers).filter((l) => layerIds.includes(l.id));
    if (!layers.length) return null;
    const groups = untrack(() => this.doc.groups);
    const id = randomId("group:");
    const title = name?.trim() || `Group ${groups.length + 1}`;
    const parent = layers[0].group;
    const ok = this.transact("Group layers", () => {
      if (!this.apply("Group layers", { t: "group.add", index: groups.length, group: { id, name: title, visible: true, ...(parent ? { group: parent } : {}) } })) return false;
      for (const l of layers) if (!this.apply("Group layers", { t: "layer.set", id: l.id, key: "group", after: id })) return false;
      return true;
    });
    return ok ? id : null;
  }

  /** Move a layer into a group, or out of every group with null. One undo step. */
  setLayerGroup(id: string, group: string | null): boolean {
    const layer = untrack(() => this.layer(id));
    if (!layer) return false;
    if ((layer.group ?? null) === group) return true;
    return this.apply(group ? "Move to group" : "Take out of group", { t: "layer.set", id, key: "group", after: group });
  }

  renameGroup(id: string, name: string): boolean {
    return this.apply("Rename group", { t: "group.set", id, key: "name", after: name });
  }

  setGroupBlend(id: string, blend: Blend | null): boolean {
    return this.apply("Change blend", { t: "group.set", id, key: "blend", after: blend });
  }

  setGroupEffects(id: string, effects: readonly Effect[]): boolean {
    return this.apply("Change effects", { t: "group.set", id, key: "effects", after: effects.length ? [...effects] : null });
  }

  /** Move a group into another group, or to the top level with null. */
  setGroupParent(id: string, parent: string | null): boolean {
    return this.apply("Move group", { t: "group.set", id, key: "group", after: parent });
  }

  /** Show or hide a group: saved, but not undoable, like a layer's visibility. */
  setGroupVisible(id: string, visible: boolean) {
    this.doc.setGroupVisible(id, visible);
  }

  /** Take a group apart, as one undo step: what it held moves to the group it was in. */
  ungroup(id: string): boolean {
    return this.apply("Ungroup", { t: "group.remove", id });
  }

  /** Delete a group and every layer in it, at any depth, as one undo step. A model keeps at least one layer. */
  deleteGroup(id: string): boolean {
    const groups = untrack(() => this.doc.groups);
    const inside = (gid: string | undefined): boolean => {
      for (let at = gid, n = 0; at && n <= groups.length; at = groups.find((g) => g.id === at)?.group, n++) if (at === id) return true;
      return false;
    };
    const layers = untrack(() => this.layers).filter((l) => inside(l.group));
    if (layers.length >= untrack(() => this.layers).length) {
      this.notify("A model needs at least one layer outside the group");
      return false;
    }
    return this.transact("Delete group", () => {
      for (const l of layers) if (!this.apply("Delete group", { t: "layer.remove", id: l.id })) return false;
      // the deepest groups first, so each goes away empty
      const depth = (g: { group?: string }) => {
        let n = 0;
        for (let at = g.group; at && n <= groups.length; at = groups.find((x) => x.id === at)?.group) n++;
        return n;
      };
      const order = groups.filter((g) => inside(g.id)).sort((a, b) => depth(b) - depth(a));
      for (const g of order) if (!this.apply("Delete group", { t: "group.remove", id: g.id })) return false;
      return true;
    });
  }

  // #endregion

  // #region Markers and origin

  /** Named points and volumes that aren't voxels: mounts, colliders, hitboxes. See docs/pipeline.md. */
  get markers(): readonly Marker[] {
    return this.doc.markers;
  }

  marker(id: string): Marker | undefined {
    return this.doc.marker(id);
  }

  /** Where a marker is on a frame (the frame showing, by default). */
  markerAt(id: string, frame = untrack(() => this.displayFrameId)): MarkerPlacement | null {
    const marker = this.marker(id);
    return marker ? markerAt(marker, this.frames, frame) : null;
  }

  /**
   * Add a marker, as one undo step. A point snaps to half voxels. Returns its id, or null when it
   * doesn't fit (the editor says why).
   */
  addMarker(init: { shape: MarkerShape; name?: string; role?: string; data?: Json }): string | null {
    const id = newMarkerId();
    const count = untrack(() => this.markers).length;
    const base = init.role ? init.role[0].toUpperCase() + init.role.slice(1) : "Marker";
    const name = init.name?.trim() || `${base} ${count + 1}`;
    const marker: Marker = {
      id,
      name,
      shape: snapMarkerShape(init.shape, untrack(() => this.resolution)),
      ...(init.role ? { role: init.role } : {}),
      ...(init.data !== undefined && init.data !== null ? { data: init.data } : {}),
    };
    return this.apply("Add marker", { t: "marker.add", index: count, marker }) ? id : null;
  }

  /** Rename a marker, or change its role or host data (null clears a role or data), as one undo step. */
  updateMarker(id: string, change: { name?: string; role?: string | null; data?: Json }): boolean {
    const marker = untrack(() => this.marker(id));
    if (!marker) return false;
    const { role: _r, data: _d, ...rest } = marker;
    const role = change.role === undefined ? marker.role : change.role;
    const data = change.data === undefined ? marker.data : change.data;
    const after: Marker = {
      ...rest,
      ...(change.name !== undefined ? { name: change.name } : {}),
      ...(role ? { role } : {}),
      ...(data !== undefined && data !== null ? { data } : {}),
    };
    if (sameMarkers([after], [marker])) return true;
    return this.apply(change.name !== undefined ? "Rename marker" : "Change marker", { t: "marker.set", id, after });
  }

  /**
   * Move or reshape a marker, as one undo step. A keyed marker changes on the open frame only (a key
   * there); one without keys changes everywhere.
   */
  placeMarker(id: string, shape: MarkerShape): boolean {
    const marker = untrack(() => this.marker(id));
    if (!marker) return false;
    const after = placeMarkerShape(marker, untrack(() => this.activeFrameId), snapMarkerShape(shape, untrack(() => this.resolution)));
    if (sameMarkers([after], [marker])) return true;
    return this.apply("Move marker", { t: "marker.set", id, after });
  }

  /**
   * Key a marker per frame (it starts with a key on the open frame where it is now), or make it the
   * same in every frame again, where it is on the open frame. One undo step.
   */
  setMarkerKeyed(id: string, keyed: boolean): boolean {
    const marker = untrack(() => this.marker(id));
    if (!marker) return false;
    if (keyed === !!marker.keys?.length) return true;
    const frame = untrack(() => this.activeFrameId);
    const here = markerAt(marker, untrack(() => this.frames), frame).shape;
    const { keys: _, ...rest } = marker;
    const after: Marker = keyed ? { ...marker, keys: [{ frame, shape: here }] } : { ...rest, shape: here };
    return this.apply(keyed ? "Key marker per frame" : "Same marker in every frame", { t: "marker.set", id, after });
  }

  /** Hide a keyed marker from the open frame on (until its next key), or show it again. One undo step. */
  setMarkerHidden(id: string, hidden: boolean): boolean {
    const marker = untrack(() => this.marker(id));
    if (!marker) return false;
    const frame = untrack(() => this.activeFrameId);
    const placement = markerAt(marker, untrack(() => this.frames), frame);
    if (placement.hidden === hidden) return true;
    const keys = (marker.keys ?? []).filter((k) => k.frame !== frame);
    const key: MarkerKey = hidden ? { frame, hidden: true } : { frame, shape: placement.shape };
    return this.apply(hidden ? "Hide marker" : "Show marker", { t: "marker.set", id, after: { ...marker, keys: [...keys, key] } });
  }

  removeMarker(id: string): boolean {
    if (!untrack(() => this.marker(id))) return false;
    return this.apply("Delete marker", { t: "marker.remove", id });
  }

  /** The point the model is placed by and turns around, in source units: its own, or the center of its floor. */
  get origin(): Vec3 {
    return this.doc.origin ?? defaultOrigin(this.size, this.resolution);
  }

  /** Whether the model has its own origin rather than the center of its floor. */
  get hasOrigin(): boolean {
    return this.doc.origin !== null;
  }

  /** Move the model's origin (snapped to half voxels), or put it back at the center of its floor with null. One undo step. */
  setOrigin(origin: Vec3 | null): boolean {
    const next = origin ? snapMarker(origin, untrack(() => this.resolution)) : null;
    const now = untrack(() => this.doc.origin);
    if (next === null ? now === null : now !== null && next.every((n, a) => n === now[a])) return true;
    return this.apply(next ? "Move origin" : "Reset origin", { t: "origin", after: next });
  }

  // #endregion

  renameLayer(id: string, name: string) {

    name = name.trim();
    const layer = this.layer(id);
    if (!name || !layer || layer.name === name) return;
    this.apply("Rename layer", { t: "layer.set", id, key: "name", after: name });
  }

  /** Move a layer to `index` in bottom-to-top order. */
  moveLayer(id: string, index: number) {
    const from = this.layers.findIndex((l) => l.id === id);
    if (from < 0) return;
    index = Math.max(0, Math.min(this.layers.length - 1, index));
    if (index === from) return;
    this.apply("Reorder layers", { t: "layer.move", id, to: index });
  }

  /** Merge a layer into the one below it. */
  mergeDown(id: string) {
    const index = this.layers.findIndex((l) => l.id === id);
    if (index <= 0 || this.blocked()) return;
    const upper = this.layers[index];
    let lower = this.layers[index - 1];
    if (upper.shape || lower.shape) {
      this.notify("Shape layers can't be merged");
      return;
    }
    const label = "Merge down";
    this.transact(label, () => {
      // an override's covered empties need coverage below to keep cutting
      if (upper.coverage && !lower.coverage) {
        this.apply(label, { t: "layer.coverage", id: lower.id, after: lower.data.map((v) => (v ? 1 : 0)) });
        lower = this.layer(lower.id)!;
      }
      for (let i = 0; i < upper.data.length; i++) {
        const state = this.rasterState(upper, i);
        if (state >= 0) this.writeState(lower, i, state);
      }
      // the other frames merge too (animated layers are plain rasters)
      const open = untrack(() => this.doc.openFrameId);
      for (const f of this.isAnimated ? this.frames : []) {
        if (f.id === open) continue;
        const from = untrack(() => this.frameCel(f.id, upper.id));
        const into = untrack(() => this.frameCel(f.id, lower.id));
        for (let i = 0; i < from.length; i++) if (from[i]) this.write(into, i, from[i]);
      }
      this.apply(label, { t: "layer.remove", id });
    });
    this._activeLayerId.set(lower.id);
    this.rebuildComposite();
  }

  /** Empty a raster layer. An override layer is cleared back to unset everywhere (see `clearOverride`). */
  clearLayer(id = this.activeLayerId) {
    const layer = this.layer(id);
    if (!layer || this.blocked()) return;
    if (layer.shape) {
      this.notify("A vector layer can't be cleared; delete it, or delete its shapes");
      return;
    }
    if (layer.coverage) {
      this.transact("Clear layer", () => {
        for (let i = 0; i < layer.data.length; i++) if (layer.coverage![i]) this.writeState(layer, i, -1);
      });
      return;
    }
    this.transact("Clear layer", () => {
      for (let i = 0; i < layer.data.length; i++) if (layer.data[i]) this.write(layer.data, i, 0);
    });
  }

  setLayerVisible(id: string, visible: boolean) {
    this.updateLayerMeta(id, { visible });
  }

  setLayerLocked(id: string, locked: boolean) {
    this.updateLayerMeta(id, { locked });
  }

  // #region Marker bar

  /** Place markers and the origin by tapping or dragging on the model, until `stopMarkerEdit`. */
  startMarkerEdit(target: string | null = untrack(() => this.markerTarget)) {
    if (this.blocked()) return;
    this.cancelShape();
    this.settle();
    this.tools.cancel();
    batch(() => {
      this._preview.set(null);
      this._markerTarget.set(target);
      this._markerEditing.set(true);
    });
  }

  stopMarkerEdit() {
    if (!untrack(() => this.markerEditing)) return;
    this.cancelMarkerDrag();
    this._markerEditing.set(false);
  }

  /** Choose what the marker bar places: a marker's id, `ORIGIN`, or nothing. UI state. */
  selectMarker(target: string | null) {
    this.cancelMarkerDrag();
    this._markerTarget.set(target);
  }

  /** Show markers in the viewport while the marker bar is closed. */
  setMarkersShown(shown: boolean) {
    this._markersShown.set(shown);
  }

  /** Where a marker shows on the frame showing: with a drag's preview, if one is moving it. */
  shownMarker(id: string): MarkerPlacement | null {
    const preview = this._markerPreview.get();
    if (preview?.target === id) return { shape: preview.shape, hidden: false };
    const marker = this.marker(id);
    return marker ? markerAt(marker, this.frames, this.displayFrameId) : null;
  }

  /** Where the origin shows, in source units: with a drag's preview, if one is moving it. */
  get shownOrigin(): Vec3 {
    const preview = this._markerPreview.get();
    if (preview?.target === ORIGIN && preview.shape.kind === "point") return preview.shape.at;
    return this.origin;
  }

  /** The target's shape as the marker bar moves it: a marker's on the open frame, or the origin as a point. */
  private targetShape(target: string): MarkerShape | null {
    if (target === ORIGIN) return { kind: "point", at: untrack(() => this.origin) };
    const marker = untrack(() => this.marker(target));
    return marker ? markerAt(marker, untrack(() => this.frames), untrack(() => this.activeFrameId)).shape : null;
  }

  private placeTarget(target: string, shape: MarkerShape): boolean {
    if (target === ORIGIN) return shape.kind === "point" && this.setOrigin(shape.at);
    return this.placeMarker(target, shape);
  }

  /** Move the marker bar's target by `delta` voxels along an axis (half steps for points). */
  nudgeMarker(axis: Axis, delta: number): boolean {
    const target = untrack(() => this.markerTarget);
    const shape = target && this.targetShape(target);
    if (!target || !shape) return false;
    const move: Vec3 = [0, 0, 0];
    move[axis] = delta / untrack(() => this.resolution);
    return this.placeTarget(target, translateMarkerShape(shape, move));
  }

  /** Grow or shrink the marker bar's volume by whole voxels along an axis, from its far side. */
  resizeMarker(axis: Axis, delta: number): boolean {
    const target = untrack(() => this.markerTarget);
    const shape = target && this.targetShape(target);
    if (!target || !shape || shape.kind !== "volume") return false;
    const step = 1 / untrack(() => this.resolution);
    const max = [...shape.shape.max] as Vec3;
    max[axis] = Math.max(shape.shape.min[axis] + step, max[axis] + delta * step);
    return this.placeTarget(target, { kind: "volume", shape: { ...shape.shape, max } });
  }

  /**
   * Where the marker bar's target lands for a pointer: a point (or the origin) on the middle of the
   * face under it; a volume resting on that face, centered across it.
   */
  private markerAtPointer(input: PointerInput, target: string): MarkerShape | null {
    const hit = this.pickVisible(input.ray);
    const shape = this.targetShape(target);
    if (!hit || !shape) return null;
    const r = untrack(() => this.resolution);
    const face = hit.cell.map((n, a) => (n + 0.5 + hit.normal[a] / 2) / r) as Vec3;
    if (shape.kind === "point") return { ...shape, at: snapMarker(face, r) };
    const { min, max } = shape.shape;
    const center = face.map((n, a) => n + (hit.normal[a] * (max[a] - min[a])) / 2);
    const move = center.map((n, a) => Math.round((n - (min[a] + max[a]) / 2) * r) / r) as Vec3;
    return translateMarkerShape(shape, move);
  }

  private markerDown(input: PointerInput) {
    const target = untrack(() => this.markerTarget);
    if (!target) return false;
    const shape = this.markerAtPointer(input, target);
    if (!shape) return false;
    this.markerDrag = { target };
    this._markerPreview.set({ target, shape });
    return true;
  }

  private markerMove(input: PointerInput) {
    const drag = this.markerDrag;
    const shape = drag && this.markerAtPointer(input, drag.target);
    if (drag && shape) this._markerPreview.set({ target: drag.target, shape });
  }

  private markerUp() {
    const drag = this.markerDrag!;
    this.markerDrag = null;
    const preview = untrack(() => this._markerPreview.get());
    this._markerPreview.set(null);
    // the drag only previewed the marker; record it as one step
    if (preview) this.placeTarget(drag.target, preview.shape);
  }

  private cancelMarkerDrag() {
    if (!this.markerDrag) return;
    this.markerDrag = null;
    this._markerPreview.set(null);
  }

  // #endregion

  /** Flip the active layer across the center of the volume. */
  flipLayer(axis: Axis) {
    this.transformLayer("Flip layer", mirror(axis), (c, s) => {
      const out = [...c] as Vec3;
      out[axis] = s[axis] - 1 - c[axis];
      return out;
    });
  }

  /** Rotate the active layer 90° around an axis. The other two dimensions must match. */
  rotateLayer(axis: Axis) {
    const u = ((axis + 1) % 3) as Axis;
    const v = ((axis + 2) % 3) as Axis;
    if (this.size[u] !== this.size[v]) {
      this.notify(`Rotating around ${"XYZ"[axis]} needs equal ${"XYZ"[u]} and ${"XYZ"[v]} sizes`);
      return;
    }
    this.transformLayer("Rotate layer", quarterTurn(axis), (c, s) => {
      const out = [...c] as Vec3;
      out[u] = s[v] - 1 - c[v];
      out[v] = c[u];
      return out;
    });
  }

  /** Move the active layer's voxels by one cell. Voxels pushed outside are lost. */
  nudgeLayer(axis: Axis, direction: 1 | -1) {
    this.transformLayer("Move layer", (n) => n, (c) => {
      const out = [...c] as Vec3;
      out[axis] += direction;
      return out;
    });
  }

  /** Rewrite direction-encoding values in place, if the application has them. */
  private orientValues(voxels: Uint8Array, direction: (n: Vec3) => Vec3) {
    const transform = this.transformValue;
    if (!transform) return;
    const memo = new Map<number, number>();
    for (let i = 0; i < voxels.length; i++) {
      const v = voxels[i];
      if (!v) continue;
      let out = memo.get(v);
      if (out === undefined) memo.set(v, (out = transform(v, direction)));
      voxels[i] = out;
    }
  }

  private transformLayer(label: string, direction: (n: Vec3) => Vec3, map: (c: Vec3, size: Vec3) => Vec3) {
    this.settle();
    if (this.refuse(this.prepareEdit())) return;
    const layer = this.activeLayer!;
    const { data, coverage } = layer;
    const size = this.size;
    const after = new Uint8Array(data.length);
    const afterCoverage = coverage ? new Uint8Array(data.length) : null;
    const c: Vec3 = [0, 0, 0];
    for (c[2] = 0; c[2] < size[2]; c[2]++)
      for (c[1] = 0; c[1] < size[1]; c[1]++)
        for (c[0] = 0; c[0] < size[0]; c[0]++) {
          const from = this.index(...c);
          const value = data[from];
          if (coverage ? !coverage[from] : !value) continue;
          const to = map(c, size);
          if (!this.inBounds(to)) continue;
          after[this.index(...to)] = value;
          if (afterCoverage) afterCoverage[this.index(...to)] = 1;
        }
    this.orientValues(after, direction);
    this.transact(label, () => {
      for (let i = 0; i < after.length; i++) {
        if (afterCoverage) this.writeState(layer, i, afterCoverage[i] ? after[i] : -1);
        else if (data[i] !== after[i]) this.write(data, i, after[i]);
      }
    });
  }

  private updateLayerMeta(id: string, patch: Partial<Pick<Layer, "visible" | "locked">>) {
    this.doc.setLayerMeta(id, patch);
  }

  private nextLayerName() {
    let n = this.layers.length + 1;
    const names = new Set(this.layers.map((l) => l.name));
    while (names.has(`Layer ${n}`)) n++;
    return `Layer ${n}`;
  }

  // #endregion

  // #region Palette

  /** Show a palette color in this session without recording it (e.g. while dragging a picker). */
  previewPaletteColor(index: number, color: number) {
    if (index < 1 || index >= untrack(() => this.doc.palette).length || untrack(() => this.readOnly)) return;
    this._palettePreview.set({ index, color });
    this.queueGeometry();
  }

  /** Commit a palette color change as an undo step. `original` is the color before editing began. */
  setPaletteColor(index: number, color: number, original = untrack(() => this.doc.palette)[index]) {
    if (index < 1 || index >= untrack(() => this.doc.palette).length) return;
    // the preview was only this session's; the step goes from the document's color
    if (untrack(() => this._palettePreview.get())) {
      this._palettePreview.set(null);
      this.queueGeometry();
    }
    if (color === original) return;
    this.apply("Edit color", { t: "palette.set", index, after: color });
  }

  addPaletteColor(color: number): number {
    if (this.palette.length > MAX_COLORS) {
      this.notify("Palette is full");
      return this.color;
    }
    const index = this.palette.length;
    if (!this.apply("Add color", { t: "palette.add", index, color })) return this.color;
    this.setColor(index);
    return index;
  }

  /**
   * Replace the palette. Voxels keep their indices (so this is a palette swap);
   * voxels whose index falls outside the new palette are remapped to the nearest color.
   */
  loadPalette(colors: number[]) {
    colors = colors.slice(0, MAX_COLORS);
    if (colors.length === 0 || this.blocked()) return;
    const prev = this.palette;
    const next = [0, ...colors];
    this.transact("Load palette", () => {
      const remap = new Map<number, number>();
      for (const layer of this.layers) {
        for (const data of this.layerCels(layer)) {
          for (let i = 0; i < data.length; i++) {
            const v = data[i];
            if (v < next.length) continue;
            let to = remap.get(v);
            if (to === undefined) {
              to = nearestColor(next, prev[v] ?? 0);
              remap.set(v, to);
            }
            this.write(data, i, to);
          }
        }
        // shapes take their colors along, in the same step
        if (layer.shape) {
          const shape = mapMaterials(layer.shape, (m) => {
            if (m < next.length) return m;
            let to = remap.get(m);
            if (to === undefined) remap.set(m, (to = nearestColor(next, prev[m] ?? 0)));
            return to;
          });
          if (shape !== layer.shape) this.apply("Load palette", { t: "layer.shape", id: layer.id, after: shape });
        }
        // effects too
        const remapColor = (m: number) => {
          if (m < next.length) return m;
          let to = remap.get(m);
          if (to === undefined) remap.set(m, (to = nearestColor(next, prev[m] ?? 0)));
          return to;
        };
        if (layer.effects && effectColors(layer.effects).some((c) => c >= next.length)) {
          this.apply("Load palette", { t: "layer.set", id: layer.id, key: "effects", after: mapEffectColors(layer.effects, remapColor) });
        }
      }
      for (const g of untrack(() => this.doc.groups)) {
        if (!g.effects || !effectColors(g.effects).some((c) => c >= next.length)) continue;
        const effects = mapEffectColors(g.effects, (m) => (m < next.length ? m : (remap.get(m) ?? nearestColor(next, prev[m] ?? 0))));
        this.apply("Load palette", { t: "group.set", id: g.id, key: "effects", after: effects });
      }
      this.apply("Load palette", { t: "palette.replace", after: next });
    });
    if (this.color >= next.length) this.setColor(1);
  }


  // #endregion

  // #region Document

  newDocument(size: Vec3 = DEFAULT_SIZE, palette: number[] = DEFAULT_PALETTE.colors) {
    this.loadDocument(defaultDocument(size, palette));
  }

  /**
   * Replace the document, clearing history. Layers keep their ids when the document has valid,
   * distinct ones (a shared document); otherwise (a file) they get new ones. `origin` is passed
   * to `onLoad` listeners.
   */
  loadDocument(doc: DocumentData, origin = "user") {
    // the document checks and builds it; the session starts over when it hears (see `sessionLoaded`)
    this.doc.load(doc, origin);
  }



  /** The whole document. Layers carry their ids and the grid its generation, which files leave out. */
  getDocument(): DocumentData {
    // during playback, layers show another frame: the document holds the one being edited
    return this.doc.toData({ activeLayer: this.activeLayerId, activeFrame: this.activeFrameId });
  }


  /**
   * Resize the volume. X and Z stay centered; Y keeps its floor. Shapes move with the voxels.
   * `at` places the old volume's corner in the new one instead (negative crops that side), or
   * `{ anchor }` picks the point that stays put, per axis: 0 the low side, 0.5 the middle, 1 the high side
   * (the default is `[0.5, 0, 0.5]`). Above 1× resolution, sizes and shifts round to whole source units.
   */
  resize(size: Vec3, at?: Vec3 | { anchor: Vec3 }) {
    const m = this.resolution;
    size = size.map((n) => Math.max(m, Math.min(MAX_SIZE - (MAX_SIZE % m), Math.round(Math.floor(n) / m) * m))) as Vec3;
    const old = this.size;
    if (size.every((n, i) => n === old[i]) || this.blocked()) return;
    const offset: Vec3 = Array.isArray(at)
      ? (at.map((n) => m * Math.round(n / m)) as Vec3)
      : resizeOffset(old, size, at?.anchor ?? [0.5, 0, 0.5], m);
    this.cancelTransform();
    this.cancelExtrusion();
    const selection = this.selection;
    this.transact("Resize", () => {
      // undo brings the selection back, once the grid it fits is back
      this.local("Resize", { undo: () => this.setSelectionState(selection), redo: () => {} });
      this.apply("Resize", { t: "resize", from: [...old], to: size, offset, fromGen: this.doc.gen, toGen: newGen() });
    });
  }

  voxelCount() {
    return this.doc.voxelCount();
  }

  /** Bounding box of all filled voxels in visible layers, or null when empty. Not clipped by the slice or hidden cells. */
  contentBounds(): Box | null {
    return this.doc.contentBounds();
  }

  // #endregion

  // #region Animation

  /** The frames in order: each pose, and how many ticks it lasts. See docs/animation.md. */
  get frames(): readonly AnimationFrame[] {
    return this.doc.frames;
  }

  /** The frame being edited: the document's open frame. During playback, see `displayFrameId`. */
  get activeFrameId(): string {
    return this.doc.openFrameId;
  }

  /** The frame on screen: the one being edited, or during playback, the one playing. */
  get displayFrameId(): string {
    return this.anim.displayFrameId;
  }

  /** The position of the frame being edited, from 0. */
  get activeFrameIndex(): number {
    return this.anim.activeFrameIndex;
  }

  /** Whether there is more than one frame. */
  get isAnimated(): boolean {
    return this.frames.length > 1;
  }

  /** Named ranges of frames, each played forward, backward or back and forth. */
  get tags(): readonly AnimationTag[] {
    return this.doc.tags;
  }

  /** The tag playback is limited to, or null for every frame. */
  get activeTagId(): string | null {
    return this.anim.activeTagId;
  }

  /** Play only a tag's frames (or, with null, every frame). Not an edit. */
  setActiveTag(id: string | null) {
    this.anim.setActiveTag(id);
  }

  /** Name a range of frames, as one undo step. Returns the tag's id. */
  createTag(
    name: string,
    from = this.frames[0].id,
    to = this.frames[this.frames.length - 1].id,
    options: Pick<AnimationTag, "direction" | "repeat"> = { direction: "forward", repeat: 0 },
  ): string | null {
    return this.anim.createTag(name, from, to, options);
  }

  /** Change a tag, as one undo step. */
  updateTag(id: string, changes: Partial<Omit<AnimationTag, "id">>) {
    return this.anim.updateTag(id, changes);
  }

  /** Delete a tag (not its frames), as one undo step. */
  removeTag(id: string) {
    return this.anim.removeTag(id);
  }

  /** Ticks per second: a frame lasting `duration` ticks shows for `duration / fps` seconds. */
  get fps(): number {
    return this.doc.fps;
  }

  /** The whole loop's length in milliseconds. */
  get animationLength(): number {
    return ticksToMs(totalTicks(this.frames.map((f) => f.duration)), this.fps);
  }

  get playing(): boolean {
    return this.anim.playing;
  }

  get onionSkin(): OnionSkin {
    return this.anim.onionSkin;
  }

  /** Change how onion skins show. Local view state: not in history or the document. */
  setOnionSkin(change: Partial<OnionSkin>) {
    this.anim.setOnionSkin(change);
  }

  /**
   * The poses to ghost around the one being edited: the previous and next frames, or null where
   * there is none (or onion skins are off, or the animation is playing). The first and last
   * frames are neighbors only with `loop`.
   */
  get onionFrames(): { before: string | null; after: string | null } {
    return this.anim.onionFrames;
  }

  /** A layer's voxels in a frame. Read-only. Empty (length 0) for a shape layer. */
  frameCel(frameId: string, layerId = this.activeLayerId): Uint8Array {
    return this.doc.frameCel(frameId, layerId);
  }

  /**
   * A frame's visible layers (or all of them) composed into one volume, like `evaluate` for the
   * frame on screen. What onion skins, thumbnails and sequence exports use.
   */
  evaluateFrame(frameId: string, options: { allLayers?: boolean; layers?: readonly string[] } = {}): Uint8Array {
    return this.doc.evaluateFrame(frameId, options);
  }

  /**
   * Edit another frame. A stroke in progress is taken back; floating content and an extrusion
   * are committed to the frame they are in (`pending: "commit"`, the default) or dropped
   * ("cancel"); a shape being placed is dropped. Stops playback. Returns false if there is no
   * such frame.
   */
  setFrame(id: string, { pending = "commit" }: { pending?: PendingPolicy } = {}): boolean {
    return this.anim.setFrame(id, pending);
  }

  /** Edit the next frame, wrapping around to the first. */
  nextFrame() {
    this.anim.stepFrame(1);
  }

  /** Edit the previous frame, wrapping around to the last. */
  previousFrame() {
    this.anim.stepFrame(-1);
  }

  /**
   * Add a frame after `after` (the frame being edited) and edit it. "duplicate" copies every
   * layer's voxels and the duration, so the copy starts as the same pose; "blank" starts every
   * layer empty. Returns the new frame's id, or null.
   */
  insertFrame({ after, content = "duplicate" }: { after?: string; content?: "duplicate" | "blank" } = {}): string | null {
    return this.anim.insertFrame(after ?? untrack(() => this.activeFrameId), content);
  }

  /** Move a frame to `index` in playing order, with its voxels and timing. */
  moveFrame(id: string, index: number) {
    this.anim.moveFrame(id, index);
  }

  /**
   * Delete whole poses, as one undo step. The document keeps at least one frame: deleting every
   * frame is turned down (clear the layers instead). Returns how many were deleted.
   */
  removeFrames(ids: Iterable<string>): number {
    return this.anim.removeFrames(ids);
  }

  /** Make frames last `ticks` ticks each (a hold): a whole number from 1 to 999. */
  setFrameDuration(ids: string | Iterable<string>, ticks: number) {
    this.anim.setFrameDuration(ids, ticks);
  }

  /** Ticks per second for the whole animation: a whole number from 1 to 60. */
  setFps(fps: number) {
    this.anim.setFps(fps);
  }

  /**
   * Copy one layer's voxels from the frame being edited (or `from`) into another existing frame,
   * replacing what that frame had on the layer. Returns whether anything changed.
   */
  copyCel(to: string, { from, layerId }: { from?: string; layerId?: string } = {}): boolean {
    return this.anim.copyCel(to, from ?? untrack(() => this.activeFrameId), layerId ?? untrack(() => this.activeLayerId));
  }

  /**
   * Play the animation, looping, from the frame being edited. `time` is milliseconds on a
   * monotonic clock (`performance.now()` by default); `advance` must use the same clock.
   * Painting pauses playback; nothing about playing is saved or undoable.
   */
  play(time = now()) {
    this.anim.play(time);
  }

  /**
   * Show the frame due at `time`, while playing. Call it once per display frame (from
   * `requestAnimationFrame`); late calls skip poses rather than slow the animation down.
   */
  advance(time = now()) {
    this.anim.advance(time);
  }

  /** Stop playing. The frame showing becomes the frame being edited. */
  pause() {
    this.anim.pause();
  }

  togglePlay() {
    if (untrack(() => this.playing)) this.pause();
    else this.play();
  }

  /** Every voxel array of a raster layer, in every frame. */
  private layerCels(layer: Layer): Uint8Array[] {
    return this.doc.layerCels(layer);
  }

  // #endregion

  // #region Shape layers

  /** Output cells per source unit along each axis: 1, 2, 4 or 8. See docs/vector-raster.md. */
  get resolution() {
    return this.doc.resolution;
  }

  /** Whether the document is plain raster layers at 1×: no shape layers, override layers or other resolution. */
  get isFlat(): boolean {
    return this.doc.isFlat;
  }

  /** What the active layer holds: "raster", "override" or "shape". */
  get activeLayerKind(): LayerKind | null {
    const layer = this.activeLayer;
    return layer ? layerKind(layer) : null;
  }

  /** Keep the resolution where it is from now on, for hosts whose values or decals address whole cells. */
  lockResolution() {
    this.doc.lockResolution();
  }

  /**
   * The committed result: visible layers (or all of them) composed into one volume, without the
   * slice, hidden values or cells, floating content or a step being edited. What exports use.
   */
  evaluate(options: { allLayers?: boolean } = {}): Uint8Array {
    return this.doc.evaluate(options);
  }

  /** A layer's own values: a raster layer's voxels, or a shape layer's committed evaluation. Read-only. */
  layerValues(layer: Layer | string): Uint8Array {
    return this.doc.layerValues(layer);
  }

  /** The committed result as a document with one raster layer at 1× units, for flat exports. */
  flatDocument(): DocumentData {
    return this.doc.flatDocument();
  }

  /** Why shape layers can't be added or changed right now, or null. */
  shapeBlocker(layer?: Layer): string | null {
    return this.shapes.shapeBlocker(layer);
  }

  /** Why the resolution can't change right now, or null. */
  resolutionBlocker(): string | null {
    return this.shapes.resolutionBlocker();
  }

  /** The resolutions the document can change to: every one whose grid fits `MAX_SIZE` cells a side. */
  get resolutionChoices(): number[] {
    return this.shapes.resolutionChoices;
  }

  /** Whether changing to `resolution` would merge raster detail: coarsening blocks of cells that aren't all alike. */
  resolutionLoses(resolution: number): boolean {
    return this.shapes.resolutionLoses(resolution);
  }

  /**
   * Change the output resolution as one undo step. Shapes keep their source geometry; raster
   * layers and the selection are resampled (refining is exact, coarsening keeps each block's most
   * common state; `resolutionLoses` tells whether it would merge detail), and undo restores them
   * exactly. Cells hidden by position are shown again. Returns whether it changed.
   */
  setResolution(resolution: number): boolean {
    return this.shapes.setResolution(resolution);
  }

  /** A shape layer's steps, bottom first, each applied to the result of those below it. Null for a layer that isn't a shape layer. */
  shapeStack(layerId = this.activeLayerId): readonly Step[] | null {
    return this.shapes.shapeStack(layerId);
  }

  /** The shape layer step being placed or changed with handles, or null. */
  get operandEdit(): OperandEdit | null {
    return this.shapes.operandEdit;
  }

  /** The step selected for changing, or null. */
  /**
   * Handles on the canvas for the selected step's settings (a prism's taper and edge radius, a
   * torus's tube, a hollow shape's wall), at grid units: each moves along `along`. Empty when no
   * step is selected.
   */
  get shapeParamHandles(): { id: ParamHandleId; point: Vec3; along?: Direction }[] {
    const selected = this.selectedStep;
    if (!selected) return [];
    // only while editing it in place, or drawing it with the Pen
    if (!this.shapes.editingShape && this.shapes.drawingPath?.stepId !== selected.step.id) return [];
    const r = this.resolution;
    const { shape } = selected.step;
    // a path's points, and the middles of its segments where a tap adds one
    if (shape.kind === "path") return pathHandles(shape).map((h) => ({ id: h.id, point: h.point.map((n) => n * r) as Vec3 }));
    return paramHandles(shape).map((h) => ({ id: h.id, point: h.point.map((n) => n * r) as Vec3, along: h.along }));
  }

  get selectedStep(): { layerId: string; step: Step; index: number } | null {
    return this.shapes.selectedStep;
  }

  /**
   * Add a shape layer holding one box above the active layer, as one undo step, and make it
   * active. `box` is in source units (half-open, snapped to 1/8). Returns the layer's id.
   */
  addBoxLayer(box: { min: Vec3; max: Vec3 }, material = this.color, name?: string): string | null {
    return this.shapes.addBoxLayer(box, material, name);
  }

  /**
   * Add an empty vector layer (a shape layer with no steps) above the active layer, as one undo
   * step, make it active and arm its shape tool. Returns the layer's id.
   */
  newShapeLayer(): string | null {
    return this.shapes.newShapeLayer();
  }

  /**
   * Start placing a new step's box on the active shape layer, with handles (the pending shape):
   * what it does to the layer is previewed live. `commitShape` adds the step; `cancelShape` drops
   * it. `draft` is in output cells. The shape tool draws one with `drawing` set: no handles show,
   * and once it is made the tool goes back to Select with the new shape selected.
   */
  startStep(mode: StepMode, draft: ShapeDraft, drawing?: DrawPhase): boolean {
    return this.shapes.startStep(mode, draft, drawing);
  }

  /** @internal The shape tool's drawing moves on to its next phase. */
  setDrawPhase(phase: DrawPhase) {
    this.shapes.setDrawPhase(phase);
  }

  /**
   * Add a step to the top of a shape layer's stack, as one undo step: a shape inscribed in a box
   * (source units) that adds to, cuts out of, intersects with or paints everything below it in
   * the layer. `kind` defaults to a box; the shape options (`up`, `forward`, `shell`, `round`,
   * `roundTop`, `roundBottom`, `top`) are as `setStepShape` takes them. `keep` keeps the colors below where it
   * overlaps (an add then only fills empty cells); intersect keeps them unless told otherwise.
   * Returns the step's id.
   */
  addStep(
    layerId: string,
    mode: StepMode,
    box: { min: Vec3; max: Vec3 },
    material = this.color,
    options: ShapeOptions & { keep?: boolean; kind?: ShapeKind | ShapePreset } = {},
  ): string | null {
    return this.shapes.addStep(layerId, mode, box, material, options);
  }

  /** Change what a step does to the steps below it, as one undo step. */
  setStepMode(layerId: string, stepId: string, mode: StepMode): boolean {
    return this.shapes.setStepMode(layerId, stepId, mode);
  }

  /**
   * Whether a step keeps the colors below where it overlaps solid cells, as one undo step: an add
   * then only fills empty cells, and an intersect doesn't recolor what it keeps.
   */
  setStepKeep(layerId: string, stepId: string, keep: boolean): boolean {
    return this.shapes.setStepKeep(layerId, stepId, keep);
  }

  /** Move a step to `index` in the stack (0 = the bottom), as one undo step. */
  moveStep(layerId: string, stepId: string, index: number): boolean {
    return this.shapes.moveStep(layerId, stepId, index);
  }

  /**
   * Point a step's shape `up` (cones, pyramids and wedges any of six ways; cylinders, capsules and
   * tori along an axis), as one undo step. The box turns with it: a standing cylinder lies down
   * rather than being squashed into the same box.
   */
  pointStep(layerId: string, stepId: string, up: Direction): boolean {
    return this.shapes.pointStep(layerId, stepId, up);
  }

  /**
   * The path being drawn on a shape layer, a point per tap with the shape tools, until
   * `finishPath`. Null when none is.
   */
  get drawingPath(): { layerId: string; stepId: string } | null {
    return this.shapes.drawingPath;
  }

  /**
   * The selected shape when it is being edited in place: its points (a path) or its setting handles
   * (the others) are what the pointer works on, and the rest of the model dims. Null otherwise.
   */
  get editingShape(): { layerId: string; stepId: string } | null {
    return this.shapes.editingShape;
  }

  /**
   * Edit a shape in place (by default the selected one; otherwise select `stepId` first). Leaving,
   * with `stopEditingShape`, goes back to the shape selected. Neither is an undo step.
   */
  editShape(stepId?: string, layerId = this.activeLayerId): boolean {
    return this.shapes.editShape(stepId, layerId);
  }

  stopEditingShape() {
    this.shapes.stopEditingShape();
  }

  /** The cells of the shape being edited in place, at their shown values (zero elsewhere); null when none is. */
  editingVolume(): Uint8Array | null {
    return this.shapes.editingVolume();
  }

  /** The selected path's point the panel shows (its index), or null. */
  get selectedPathPoint(): number | null {
    return this.shapes.selectedPathPoint;
  }

  selectPathPoint(index: number | null) {
    this.shapes.selectPathPoint(index);
  }

  /**
   * Start a path on the active shape layer: a new step (a tube, wall or slab, as the tools draw)
   * with one point at `at` (source units), selected and drawing, as one undo step. Returns its id.
   */
  startPath(mode: StepMode, at: Vec3): string | null {
    return this.shapes.startPath(mode, at);
  }

  /** Stop adding points to the path being drawn: it stays selected, and the Pen gives way to Select. */
  finishPath() {
    this.shapes.finishPath();
  }

  /** Esc while drawing a path: one of a single point is dropped; a longer one is finished. */
  cancelPath() {
    this.shapes.cancelPath();
  }

  /** Add a point to a path at `at` (source units), at `index` (the end when unset), as one undo step. */
  addPathPoint(layerId: string, stepId: string, at: Vec3, index?: number): boolean {
    return this.shapes.addPathPoint(layerId, stepId, at, index);
  }

  /** Move a path's point to `at` (source units), as one undo step. */
  movePathPoint(layerId: string, stepId: string, index: number, at: Vec3): boolean {
    return this.shapes.movePathPoint(layerId, stepId, index, at);
  }

  /** Give a tube's point its own radius (source units), or with null the path's, as one undo step. */
  setPathPointRadius(layerId: string, stepId: string, index: number, radius: number | null): boolean {
    return this.shapes.setPathPointRadius(layerId, stepId, index, radius);
  }

  /** Take a point out of a path, as one undo step. A path keeps one point, a slab three. */
  removePathPoint(layerId: string, stepId: string, index: number): boolean {
    return this.shapes.removePathPoint(layerId, stepId, index);
  }

  /** Name a step, as one undo step. An empty name clears it, so the step goes by its mode and kind again. */
  setStepName(layerId: string, stepId: string, name: string): boolean {
    return this.shapes.setStepName(layerId, stepId, name);
  }

  /** Copy a step to just above itself and select the copy, as one undo step. Returns the copy's id. */
  duplicateStep(layerId: string, stepId: string): string | null {
    return this.shapes.duplicateStep(layerId, stepId);
  }

  /** Take a step out of a shape layer's stack, as one undo step. A layer with no steps shows nothing. */
  removeStep(layerId: string, stepId: string): boolean {
    return this.shapes.removeStep(layerId, stepId);
  }

  /**
   * Select a step of a shape layer to change it: its box's handles drag faces and corners, each
   * drag one undo step, and `setStepBox` sets it exactly. Null ends editing.
   */
  selectStep(stepId: string | null, layerId = this.activeLayerId): boolean {
    return this.shapes.selectStep(stepId, layerId);
  }

  /**
   * The step of the active shape layer that a visible voxel under the ray belongs to: the topmost
   * step that adds or paints there, else the topmost intersect around it. Null when the ray hits
   * nothing of the layer.
   */
  pickStep(ray: Ray): Step | null {
    return this.shapes.pickStep(ray);
  }

  /** Stop placing or changing a shape layer's step. A step being placed is dropped; changes already made stay. */
  endOperandEdit() {
    return this.shapes.endOperandEdit();
  }

  /**
   * Set a step's box, in source units (half-open, snapped to 1/8), as one undo step. Returns
   * false, with a notice, if it can't change.
   */
  setStepBox(layerId: string, stepId: string, box: { min: Vec3; max: Vec3 }): boolean {
    return this.shapes.setStepBox(layerId, stepId, box);
  }

  /** Give a step a palette color, as one undo step. */
  setStepMaterial(layerId: string, stepId: string, material = this.color): boolean {
    return this.shapes.setStepMaterial(layerId, stepId, material);
  }

  /**
   * Vary a step's color with position (see `StepFill`), from its material to `fill.to`, or with
   * null give it one color again. One undo step.
   */
  setStepFill(layerId: string, stepId: string, fill: StepFill | null): boolean {
    return this.shapes.setStepFill(layerId, stepId, fill);
  }

  /**
   * Change a step's shape, keeping its box: its kind or a preset ("cylinder" makes any prism
   * round and straight), where it points and `forward`, the wall `shell` (0 = solid) and
   * `openTop` / `openBottom`, a prism's `sides`, `taper` and `round`, `roundTop`, `roundBottom`
   * radii, a `sweep`, a torus's `tube`, or a limb's base `radius`, `tip` radius and the `corner`
   * it grows from (sizes in source units; 0 clears one). Options the kind doesn't take are dropped. One undo step.
   */
  setStepShape(layerId: string, stepId: string, change: ShapeOptions & { kind?: ShapeKind | ShapePreset }): boolean {
    return this.shapes.setStepShape(layerId, stepId, change);
  }

  /** Turn a wedge to face the next way around its `up`, as one undo step. */
  turnStep(layerId: string, stepId: string): boolean {
    return this.shapes.turnStep(layerId, stepId);
  }

  /**
   * Turn a step's shape to its next 90° orientation, as one undo step. Its box turns with it
   * around its center, so a standing cylinder lies down rather than being squashed.
   */
  rotateStep(layerId: string, stepId: string): boolean {
    return this.shapes.rotateStep(layerId, stepId);
  }

  /**
   * Turn a shape layer into an override layer holding the voxels it evaluates to, as one undo
   * step (undo brings the steps back). It keeps its place, id, name, part and children, and looks
   * the same: its voxels become covered cells and the rest stays unset. From then on it is edited
   * voxel by voxel.
   */
  bakeShapeLayer(layerId = this.activeLayerId): boolean {
    return this.shapes.bakeShapeLayer(layerId);
  }

  /**
   * Make a raster layer an override layer, as one undo step. Nothing it shows changes: its voxels
   * become covered and its empty cells stay unset; from then on, Erase cuts what is below.
   */
  convertToOverride(layerId = this.activeLayerId): boolean {
    return this.shapes.convertToOverride(layerId);
  }

  // #endregion

  // #region Input

  pointerDown(input: PointerInput): boolean {
    if (untrack(() => this.playing)) {
      // the first touch on the model only stops playback; off the model, the view still orbits
      if (this.tool === "orbit" || !this.pickVisible(input.ray)) return false;
      this.pause();
      return true;
    }
    if (untrack(() => this.markerEditing)) return this.markerDown(input);
    return this.tools.down(input);
  }

  pointerMove(input: PointerInput) {
    if (this.markerDrag) this.markerMove(input);
    else this.tools.move(input);
  }

  pointerUp() {
    if (this.markerDrag) this.markerUp();
    else this.tools.up();
  }

  pointerHover(input: PointerInput | null) {
    const hit = input && this.pickVisible(input.ray);
    const was = untrack(() => this.hover);
    const same = was && hit && was.cell.every((n, a) => n === hit.cell[a]) && was.normal.every((n, a) => n === hit.normal[a]);
    if (!same && (was || hit)) this._hover.set(hit && { cell: hit.cell, normal: hit.normal });
    if (untrack(() => this.markerEditing)) return;
    this.tools.hover(input);
  }

  /** Abort an in-progress gesture, reverting its changes. */
  cancelPointer() {
    this.cancelMarkerDrag();
    this.tools.cancel();
    // a stroke a script began
    this.cancelStroke();
  }

  /**
   * A tap on empty space (the viewport orbits on a drag there instead). It applies a pending
   * extrusion or floating content, or with the select tool in replace mode, deselects.
   */
  pointerTap() {
    if (untrack(() => this.markerEditing)) return;
    // a tap off the model stops picking the workplane
    if (untrack(() => this.pickingWorkplane)) return this.cancelWorkplanePick();
    if (untrack(() => this.shapes.editingShape)) {
      // editing in place: let go of the picked point, then go back to the shape selected
      if (untrack(() => this.shapes.selectedPathPoint) !== null) this.shapes.selectPathPoint(null);
      else this.shapes.stopEditingShape();
    } else if (untrack(() => this.shapes.operandEdit)?.mode === "edit") {
      this.endOperandEdit();
    } else if (untrack(() => this.pendingExtrusion)) {
      this.applyExtrusion();
    } else if (untrack(() => this.floating)) {
      this.applyTransform();
    } else if (this.tool === "select" && this.selectMode === "replace" && !untrack(() => this.pendingShape)) {
      this.deselect();
    }
  }

  // #endregion

  // #region Composite

  private rebuildComposite() {
    const count = this.voxelCount();
    if (this.hiddenCells.length && this.hiddenCells.length !== count) {
      this.hiddenCells = new Uint8Array(0);
      this._hiddenCellCount.set(0);
    }
    if (this.composite.length !== count) this.composite = new Uint8Array(count);
    if (this.clipped.length !== count) this.clipped = new Uint8Array(count);
    else this.clipped.fill(0);
    const composite = this.composite;
    const draft = this.shapes.draftShape();
    // during playback the view shows another frame than the one open in the document
    const showing = untrack(() => this.displayFrameId);
    const open = untrack(() => this.doc.openFrameId);
    const layers = untrack(() => this.layers);
    composeLayers(
      showing === open ? layers : layers.map((l) => (l.shape ? l : { ...l, data: untrack(() => this.doc.frameCel(showing, l.id)) })),
      this.grid(),

      {
        cache: this.doc.sourceCache,
        groups: untrack(() => this.doc.groups),
        shows: (i, v) => this.visibleAt(i, v),
        skip: this.floats.lifted ? { layer: this.liftedLayer()!, mask: this.floats.lifted.mask } : undefined,
        shapeOf: draft ? (layer) => ((layer as Layer).id === draft.layerId ? draft.shape : undefined) : undefined,
      },
      composite,
    );
    const slice = untrack(() => this.slice);
    if (slice) {
      const [sx, sy] = untrack(() => this.size);
      for (let i = 0; i < count; i++) {
        if (!composite[i]) continue;
        const c: Vec3 = cellCoord(i, sx, sy);
        const v = c[slice.axis];
        if (sliceContains(slice, v)) continue;
        this.clipped[i] = composite[i];
        composite[i] = 0;
      }
    }
    this.queueGeometry();
  }

  private liftedLayer(): Layer | undefined {
    const lifted = this.floats.lifted;
    return lifted ? untrack(() => this.layers).find((l) => l.data === lifted.data) : undefined;
  }

  private grid() {
    return this.doc.grid();
  }

  /**
   * The value the stack gives at one cell (`composeCell`). `filtered` applies what the display
   * hides (values, positions, lifted content, a box being edited), but never the slice. A stack
   * with effects has no value per cell on its own: this reads the document's composed volume, and
   * the display composes again as a whole (`updateCompositeCell`).
   */
  private stackValue(i: number, filtered = false): number {
    const layers = untrack(() => this.layers);
    const groups = untrack(() => this.doc.groups);
    if (hasEffects(layers, groups)) return this.doc.volume()[i];
    const lifted = filtered ? this.floats.lifted : null;
    const draft = filtered ? this.shapes.draftShape() : null;
    if (this.stageTreeCache?.layers !== layers || this.stageTreeCache.groups !== groups) {
      this.stageTreeCache = { layers, groups, tree: stageTree(layers, groups) };
    }
    return composeCell(this.stageTreeCache.tree, i, {
      include: (l) => l.visible !== false,
      valueOf: (l) => {
        const layer = l as Layer;
        if (!layer.shape) return layer.data[i];
        const shape = draft?.layerId === layer.id ? draft.shape : layer.shape;
        return this.doc.sourceCache.get(shape, this.grid(), layer.id)[i];
      },
      shows: filtered ? (index, v) => this.visibleAt(index, v) : undefined,
      skip: lifted ? (l) => lifted.data === l.data && lifted.mask[i] !== 0 : undefined,
    });
  }

  private stageTreeCache: { layers: readonly Layer[]; groups: readonly unknown[]; tree: ReturnType<typeof stageTree> } | null = null;
  private compositeQueued = false;

  private updateCompositeCell(i: number) {
    // effects reach across cells: compose the whole again, once, after this burst of writes
    if (hasEffects(untrack(() => this.layers), untrack(() => this.doc.groups))) {
      if (this.compositeQueued) return;
      this.compositeQueued = true;
      queueMicrotask(() => {
        this.compositeQueued = false;
        this.rebuildComposite();
      });
      return;
    }
    let value = 0;
    const slice = untrack(() => this.slice);
    let visible = true;
    if (slice) {
      const [sx, sy] = untrack(() => this.size);
      const c: Vec3 = cellCoord(i, sx, sy);
      const v = c[slice.axis];
      visible = sliceContains(slice, v);
    }
    const shown = this.stackValue(i, true);
    if (visible) value = shown;
    const clipped = visible ? 0 : shown;
    if (this.composite[i] !== value || this.clipped[i] !== clipped) {
      this.composite[i] = value;
      this.clipped[i] = clipped;
      this.queueGeometry();
    }
  }

  private queueGeometry() {
    if (this.geometryQueued) return;
    this.geometryQueued = true;
    queueMicrotask(() => {
      this.geometryQueued = false;
      this._geometryVersion.set(untrack(() => this.geometryVersion) + 1);
    });
  }

  private queueSelection() {
    if (this.selectionQueued) return;
    this.selectionQueued = true;
    queueMicrotask(() => {
      this.selectionQueued = false;
      this._selectionVersion.set(untrack(() => this.selectionVersion) + 1);
    });
  }



  // #endregion
}
