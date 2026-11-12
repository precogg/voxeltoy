import { createSignal, onCleanup } from "solid-js";
import type { Editor } from "@voxeltoy/core/editor";
import { DOCUMENT_ACCEPT, exportPalette, exportVox, openFile, pickFile, saveDocument, saveFile } from "./files";
import { PALETTE_FILE_ACCEPT } from "@voxeltoy/core/palette";
import { dominantAxis } from "@voxeltoy/core/raycast";
import type { SelectMode } from "@voxeltoy/core/selection";
import { presetOf, type ShapeKind, type ShapeParams, type ShapePreset } from "@voxeltoy/core/shapes";
import type { Axis, ToolId, Vec3, WorkplaneClip } from "@voxeltoy/core/types";
import { exportGlb } from "@voxeltoy/three/export";
import type { MenuNeed, XRMenus } from "@voxeltoy/xr/menu";
import type { XROptions } from "@voxeltoy/xr/editor/session";
import { watchXRMode, type XRMode } from "@voxeltoy/xr/support";
import type { Viewport } from "@voxeltoy/three/viewport";
import type { Dialog } from "./context";
import { exportFrameSequence, exportSpriteSheet, exportVoxelVolumes } from "./export-animation";
import type { IconName, IconSource } from "./icons";

export interface Action {
  /** Stands for it: its key in the actions (set by `createActions`, or by the editor for a host's). */
  id?: string;
  label: string;
  icon?: IconSource;
  /** e.g. "mod+z", "shift+1", "a" */
  kbd?: string;
  /** When the shortcut applies; otherwise the key is left alone. */
  when?: () => boolean;
  /** Whether its button is enabled, where that differs from `when` (undo and redo: whether there's history). */
  enabled?: () => boolean;
  run(): void;
  /** What it needs of the view offering it (see `MenuNeed`): the headset view leaves out what it can't do. */
  needs?: readonly MenuNeed[];
}

/** Give each action its key as its id, where it has none. */
export function nameActions<T extends Record<string, Action>>(actions: T): T {
  for (const [id, action] of Object.entries(actions)) action.id ??= id;
  return actions;
}

/** A tool's button in the toolbar, and its shortcut. */
/**
 * What a host gives the headset view (`XROptions`), beyond what the editor view supplies itself
 * (the editor, the mode, the model's mesh, the menus): a scene's library, the palette's colors and
 * tools, life size, its own additions.
 */
export type HeadsetOptions = Omit<XROptions, "editor" | "mode" | "modelGeometry" | "onEnd" | "menus">;

export interface ToolButton {
  id: ToolId;
  label: string;
  icon: IconSource;
  kbd?: string;
}

export const TOOLS: ToolButton[] = [
  { id: "orbit", label: "Orbit", icon: "orbit", kbd: "h" },
  { id: "select", label: "Select", icon: "select", kbd: "m" },
  { id: "move", label: "Move", icon: "move", kbd: "v" },
  { id: "extrude", label: "Extrude", icon: "extrude", kbd: "u" },
  { id: "add", label: "Add", icon: "add", kbd: "a" },
  { id: "erase", label: "Erase", icon: "erase", kbd: "e" },
  { id: "brush", label: "Brush", icon: "paint", kbd: "b" },
  { id: "fill", label: "Fill", icon: "fill", kbd: "g" },
  { id: "pick", label: "Pick color", icon: "pick", kbd: "i" },
];

/**
 * A vector layer's tools besides its shapes: Orbit and Select (as on raster layers, Select picking
 * a shape), the Pen (paths) and Fill (tap a shape to give it the current color).
 */
export const VECTOR_TOOLS: ToolButton[] = [
  { id: "orbit", label: "Orbit", icon: "orbit", kbd: "h" },
  { id: "select", label: "Select", icon: "select", kbd: "m" },
  { id: "pen", label: "Pen", icon: "pen", kbd: "p" },
  { id: "fill", label: "Fill", icon: "fill", kbd: "g" },
];

/** A shape a vector layer's toolbar draws: a button that arms the shape tool with its preset. */
export interface ShapeButton {
  id: ShapePreset;
  label: string;
  icon: IconName;
  kbd?: string;
}

/** The shapes on a vector layer's toolbar, with their number keys. */
export const TOOLBAR_SHAPES: ShapeButton[] = [
  { id: "box", label: "Box", icon: "cube", kbd: "1" },
  { id: "cylinder", label: "Cylinder", icon: "cylinder", kbd: "2" },
  { id: "sphere", label: "Sphere", icon: "sphere", kbd: "3" },
  { id: "cone", label: "Cone", icon: "cone", kbd: "4" },
  { id: "torus", label: "Torus", icon: "torus", kbd: "5" },
];

/** The shapes in the toolbar's More ▾ grid. */
export const MORE_SHAPES: ShapeButton[] = [
  { id: "pyramid", label: "Pyramid", icon: "pyramid" },
  { id: "hexagon", label: "Hex prism", icon: "hexagon" },
  { id: "capsule", label: "Capsule", icon: "capsule" },
  { id: "wedge", label: "Wedge", icon: "wedge" },
  { id: "diamond", label: "Diamond", icon: "diamond" },
  { id: "arch", label: "Arch", icon: "arch" },
];

/** The tools that only look, which is all a view-only document offers. */
export const VIEW_TOOLS: readonly ToolId[] = ["orbit", "select", "pick"];

/** The shapes to pick from: presets of the kinds (a box, cylinder, cone, pyramid and hex prism are all prisms). */
export const SHAPES: { id: ShapePreset; label: string; icon: IconName }[] = [
  { id: "box", label: "Box", icon: "cube" },
  { id: "cylinder", label: "Cylinder", icon: "cylinder" },
  { id: "cone", label: "Cone", icon: "cone" },
  { id: "pyramid", label: "Pyramid", icon: "pyramid" },
  { id: "hexagon", label: "Hex prism", icon: "hexagon" },
  { id: "sphere", label: "Sphere", icon: "sphere" },
  { id: "capsule", label: "Capsule", icon: "capsule" },
  { id: "wedge", label: "Wedge", icon: "wedge" },
  { id: "diamond", label: "Diamond", icon: "diamond" },
  { id: "torus", label: "Torus", icon: "torus" },
  { id: "arch", label: "Arch", icon: "arch" },
  { id: "limb", label: "Limb", icon: "limb" },
  { id: "tube", label: "Tube", icon: "tube" },
  { id: "wall", label: "Wall", icon: "wall" },
  { id: "slab", label: "Slab", icon: "slab" },
];

/** The icon for a shape: its preset's, or for a prism no preset matches, a cylinder's or a box's. */
export function shapeIcon(kind: ShapeKind, params: ShapeParams = {}): IconName {
  const preset = presetOf(kind, params);
  if (preset) return SHAPES.find((s) => s.id === preset)!.icon;
  if (kind === "prism") return params.taper ? (params.sides ? "pyramid" : "cone") : params.sides ? "hexagon" : "cylinder";
  return SHAPES.find((s) => s.id === kind)?.icon ?? "cube";
}

export const SELECT_MODES: { id: SelectMode; label: string; icon: IconName; hint?: string }[] = [
  { id: "replace", label: "Replace", icon: "selectReplace" },
  { id: "add", label: "Add", icon: "selectAdd", hint: "Shift" },
  { id: "subtract", label: "Subtract", icon: "selectSubtract", hint: "Ctrl" },
  { id: "intersect", label: "Intersect", icon: "selectIntersect" },
];

export function createActions(
  editor: Editor,
  viewport: () => Viewport | undefined,
  dialog: () => Dialog,
  setDialog: (d: Dialog) => void,
  tools: readonly ToolButton[] = TOOLS,
  /** Whether to offer shape layers, override layers and resolutions. */
  shapes: () => boolean = () => true,
  /** Whether the workplane panel is open, and how to open or close it. */
  workplanePanel: { open: () => boolean; setOpen: (open: boolean) => void } = { open: () => false, setOpen: () => {} },
  /** Whether the timeline is open, and how to open or close it. */
  timelinePanel: { open: () => boolean; setOpen: (open: boolean) => void } = { open: () => false, setOpen: () => {} },
  /** What the headset view gets: the menus it shows (the page's own), and the host's options. */
  headsetOptions?: () => HeadsetOptions & { menus?: XRMenus },
) {
  const attempt = (fn: () => Promise<unknown>) => () => {
    fn().catch((e: Error) => editor.notify(e.message || "Something went wrong"));
  };

  const mirror = (axis: Axis): Action => ({
    label: `Mirror ${"XYZ"[axis]}`,
    kbd: "xyz"[axis],
    run: () => editor.toggleMirror(axis),
  });

  const workplaneStep = (delta: number) => () => editor.setWorkplane({ level: editor.workplane.level + delta });

  const clip = (mode: WorkplaneClip, label: string): Action => ({
    label,
    run: () => editor.setWorkplane({ clip: mode }),
  });

  const selected = () => editor.hasSelection;
  /** A shape is selected on the active vector layer (not one being drawn): the shape commands apply to it. */
  const shapeSelected = () => editor.activeLayerKind === "shape" && !!editor.selectedStep && !editor.pendingShape?.drawing;
  /** A shape is selected and not being edited in place: the commands on the whole shape apply. */
  const shapeHeld = () => shapeSelected() && !editor.editingShape;
  const editing = () => !!editor.editingShape;
  const pointPicked = () => editing() && editor.selectedPathPoint !== null;
  /** Run with the selected shape: its layer, id, place in the stack and the stack's size. */
  const withShape = (fn: (layerId: string, stepId: string, index: number, count: number) => void) => () => {
    const s = editor.selectedStep;
    if (s) fn(s.layerId, s.step.id, s.index, editor.shapeStack(s.layerId)?.length ?? 0);
  };
  const shapeIndex = () => editor.selectedStep?.index ?? -1;
  const shapeCount = () => (editor.selectedStep && editor.shapeStack(editor.selectedStep.layerId)?.length) || 0;
  /** The active layer is a vector layer: its tools and shortcuts, not the voxel ones. */
  const vector = () => editor.activeLayerKind === "shape";
  const raster = () => !vector();
  const transformable = () => !!editor.floating || editor.hasSelection;

  /** The world axes closest to screen right and up, with the direction along each. */
  const screenAxes = () => {
    const camera = viewport()?.orbit.camera;
    if (!camera) return null;
    camera.updateMatrixWorld();
    const m = camera.matrixWorld.elements;
    const screenRight: Vec3 = [m[0], m[1], m[2]];
    const screenUp: Vec3 = [m[4], m[5], m[6]];
    const right = dominantAxis(screenRight);
    screenUp[right] = 0;
    const up = dominantAxis(screenUp);
    return { right, rightSign: Math.sign(screenRight[right]), up, upSign: Math.sign(screenUp[up]) };
  };

  /** Nudge the selection the way an arrow points on screen, along the closest world axis. */
  const nudge = (right: number, up: number) => () => {
    const axes = screenAxes();
    if (!axes) return;
    const delta: Vec3 = [0, 0, 0];
    if (right) delta[axes.right] = axes.rightSign * right;
    if (up) delta[axes.up] = axes.upSign * up;
    editor.moveSelection(delta);
  };

  /** In 2D, the selection moves toward you (or away) along the view; in 3D, up (or down). */
  const depth = (toward: number) => () => {
    const delta: Vec3 = [0, 0, 0];
    const mode = editor.mode2D;
    if (mode) delta[editor.workplane.axis] = mode.side * toward;
    else delta[1] = toward;
    editor.moveSelection(delta);
  };

  /** In 2D, turn the selection a quarter counterclockwise on screen (clockwise with negative turns). */
  const turnOnScreen = (turns: number) => {
    const mode = editor.mode2D;
    if (mode) editor.rotateSelection(editor.workplane.axis, turns * mode.side);
  };

  /** Mirror the selection left to right, or top to bottom, as it looks on screen. */
  const flipOnScreen = (vertical: boolean) => {
    const axes = screenAxes();
    if (axes) editor.flipSelection(vertical ? (axes.up as Axis) : (axes.right as Axis));
  };

  const rotateSelection = (axis: Axis, turns = 1): Action => ({
    label: `Rotate ${turns < 0 ? "−" : ""}90° around ${"XYZ"[axis]}`,
    // Y, the vertical axis, gets the shortcuts; it is the turn people want most. In 2D they turn on screen.
    kbd: axis === 1 ? (turns < 0 ? "shift+r" : "r") : undefined,
    when: transformable,
    run: () => (axis === 1 && editor.mode2D ? turnOnScreen(turns) : editor.rotateSelection(axis, turns)),
  });

  const extruding = () => !!editor.pendingExtrusion;

  /** Move the frame being edited one place earlier or later. */
  const shiftFrame = (delta: number) => () => editor.moveFrame(editor.activeFrameId, editor.activeFrameIndex + delta);
  /** Make the frame being edited last one tick longer or shorter. */
  const hold = (delta: number) => () => {
    const frame = editor.frames[editor.activeFrameIndex];
    if (frame) editor.setFrameDuration(frame.id, frame.duration + delta);
  };

  /** Change the resolution, asking first when coarsening would merge raster detail. */
  const resolution = (m: number): Action => ({
    label: `${m}×`,
    run: () => {
      if (
        editor.resolutionLoses(m) &&
        !confirm(`At ${m}× some raster detail will be merged into larger voxels. Undo brings it back. Continue?`)
      ) {
        return;
      }
      editor.setResolution(m);
      viewport()?.fit();
    },
  });

  const editingOperand = () => editor.operandEdit?.mode === "edit";

  const flipSelection = (axis: Axis): Action => ({
    label: `Flip ${"XYZ"[axis]}`,
    when: transformable,
    run: () => editor.flipSelection(axis),
  });

  // a headset (WebXR) view, where the browser has one; its code loads when it opens
  const [headset, setHeadset] = createSignal<XRMode | null>(null);
  onCleanup(watchXRMode(setHeadset));
  let inHeadset = false;

  const actions = {
    undo: { label: "Undo", icon: "undo", kbd: "mod+z", run: () => editor.undo() },
    redo: { label: "Redo", icon: "redo", kbd: "mod+shift+z", run: () => editor.redo() },
    redoAlt: { label: "Redo", kbd: "mod+y", run: () => editor.redo() },

    newDocument: { label: "New…", needs: ["dialog"], run: () => setDialog("new") },
    open: {
      label: "Open…",
      needs: ["files"],
      kbd: "mod+o",
      run: attempt(async () => {
        const file = await pickFile(DOCUMENT_ACCEPT);
        if (!file) return;
        await openFile(editor, file);
        viewport()?.fit();
      }),
    },
    save: { label: "Save", kbd: "mod+s", needs: ["files"], run: attempt(() => saveDocument(editor)) },
    exportVox: { label: "MagicaVoxel (.vox)", needs: ["files"], run: attempt(() => exportVox(editor)) },
    enterHeadset: {
      label: "Open in headset",
      needs: ["page"],
      when: () => !!headset(),
      run: attempt(async () => {
        const mode = headset();
        if (inHeadset || !mode) return;
        inHeadset = true;
        try {
          const { enterXR } = await import("@voxeltoy/xr/editor/session");
          const vp = viewport();
          await enterXR({
            editor,
            mode,
            modelGeometry: vp && (() => vp.modelGeometry),
            ...headsetOptions?.(),
            onEnd: () => (inHeadset = false),
          });
        } catch (e) {
          inHeadset = false;
          throw e;
        }
      }),
    },
    exportGlb: {
      label: "glTF, one mesh (.glb)",
      needs: ["files"],
      run: attempt(async () => {
        const vp = viewport();
        if (vp) await saveFile(await exportGlb(vp, editor), `${editor.name}.glb`, "glTF model");
      }),
    },
    exportPng: {
      label: "Image (.png)",
      needs: ["files"],
      run: attempt(async () => {
        const vp = viewport();
        if (vp) await saveFile(await vp.screenshot(), `${editor.name}.png`, "PNG image");
      }),
    },
    exportFrames: {
      label: "Frames (.png sequence)",
      needs: ["files"],
      run: attempt(async () => {
        const vp = viewport();
        if (vp) await exportFrameSequence(vp, editor);
      }),
    },
    exportSpriteSheet: {
      label: "Sprite sheet (.png)",
      needs: ["files"],
      run: attempt(async () => {
        const vp = viewport();
        if (vp) await exportSpriteSheet(vp, editor);
      }),
    },
    exportVolumes: {
      label: "Voxel volumes (.voxeltoyvol)",
      needs: ["files"],
      run: attempt(() => exportVoxelVolumes(editor)),
    },
    resize: { label: "Resize volume…", needs: ["dialog"], run: () => setDialog("resize") },
    shortcuts: { label: "Keyboard shortcuts", kbd: "?", needs: ["dialog", "keyboard"], run: () => setDialog("shortcuts") },

    loadPalette: {
      label: "Load palette file…",
      needs: ["files"],
      run: attempt(async () => {
        const file = await pickFile(PALETTE_FILE_ACCEPT);
        if (file) await openFile(editor, file);
      }),
    },
    exportPaletteGpl: { label: "GIMP (.gpl)", needs: ["files"], run: attempt(() => exportPalette(editor, "gpl")) },
    exportPaletteHex: { label: "Hex list (.hex)", needs: ["files"], run: attempt(() => exportPalette(editor, "hex")) },
    exportPalettePal: { label: "JASC (.pal)", needs: ["files"], run: attempt(() => exportPalette(editor, "pal")) },
    exportPalettePng: { label: "Image (.png)", needs: ["files"], run: attempt(() => exportPalette(editor, "png")) },

    fit: { label: "Zoom to fit", icon: "fit", kbd: "f", run: () => viewport()?.fit() },
    fitAlt: { label: "Zoom to fit", kbd: "shift+1", run: () => viewport()?.fit() },
    zoomIn: { label: "Zoom in", kbd: "=", run: () => viewport()?.zoomBy(0.8) },
    zoomOut: { label: "Zoom out", kbd: "-", run: () => viewport()?.zoomBy(1.25) },
    toggleProjection: {
      label: "Orthographic",
      kbd: "o",
      run: () => editor.setProjection(editor.projection === "perspective" ? "orthographic" : "perspective"),
    },

    brushVoxel: { label: "Voxel brush", kbd: "1", when: raster, run: () => editor.setBrush("voxel") },
    brushBox: { label: "Box brush", kbd: "2", when: raster, run: () => editor.setBrush("box") },
    brushFace: { label: "Face brush", kbd: "3", when: raster, run: () => editor.setBrush("face") },
    brushShape: { label: "Shape brush", kbd: "4", when: raster, run: () => editor.setBrush("shape") },
    // a vector layer's shapes take the number keys; the Pen takes P before play does
    ...(Object.fromEntries(
      [...TOOLBAR_SHAPES, ...MORE_SHAPES].map((s) => [
        `shape-${s.id}`,
        { label: s.label, icon: s.icon, kbd: s.kbd, when: vector, run: () => editor.setShapeTool(s.id) } satisfies Action,
      ]),
    ) as Record<`shape-${ShapePreset}`, Action>),
    toolPen: { label: "Pen", icon: "pen", kbd: "p", when: vector, run: () => editor.setTool("pen") },

    // first: Enter finishes the path being drawn
    finishPath: {
      label: "Done",
      icon: "check",
      kbd: "enter",
      when: () => !!editor.drawingPath,
      run: () => editor.finishPath(),
    },
    // before applyShape: Enter edits the selected shape in place, and again leaves it
    doneEditing: {
      label: "Done",
      icon: "check",
      kbd: "enter",
      when: editing,
      run: () => editor.stopEditingShape(),
    },
    editShape: {
      label: "Edit",
      kbd: "enter",
      when: () => shapeHeld() && editingOperand(),
      run: () => editor.editShape(),
    },
    deletePoint: {
      label: "Delete point",
      icon: "trash",
      kbd: "backspace",
      when: pointPicked,
      run: () => {
        const s = editor.selectedStep;
        const i = editor.selectedPathPoint;
        if (s && i !== null) editor.removePathPoint(s.layerId, s.step.id, i);
      },
    },
    applyShape: {
      label: "Apply shape",
      icon: "check",
      kbd: "enter",
      when: () => !!editor.pendingShape && editor.pendingShape.operand !== "edit",
      run: () => editor.commitShape(),
    },
    cancelShape: { label: "Cancel shape", icon: "close", run: () => editor.cancelShape() },
    rotateShape: {
      label: "Rotate shape",
      icon: "rotate",
      kbd: "r",
      when: () => !!editor.pendingShape && !editor.pendingShape.drawing,
      run: () => editor.rotatePendingShape(),
    },

    selectAll: { label: "Select all", kbd: "mod+a", run: () => editor.selectAll() },
    deselect: { label: "Deselect", icon: "close", kbd: "mod+shift+a", run: () => editor.deselect() },
    invertSelection: { label: "Invert", kbd: "mod+shift+i", run: () => editor.invertSelection() },
    growSelection: { label: "Grow", run: () => editor.growSelection() },
    shrinkSelection: { label: "Shrink", run: () => editor.shrinkSelection() },
    selectConnected: { label: "Connected voxels", run: () => editor.selectConnected() },

    // a selected shape's commands come before the selection's, whose keys they share
    duplicateShape: {
      label: "Duplicate",
      icon: "copy",
      kbd: "mod+d",
      when: shapeHeld,
      run: withShape((layer, step) => editor.duplicateStep(layer, step)),
    },
    deleteShape: { label: "Delete", icon: "trash", kbd: "backspace", when: shapeHeld, run: withShape((layer, step) => editor.removeStep(layer, step)) },
    deleteShapeAlt: { label: "Delete", kbd: "delete", when: shapeHeld, run: withShape((layer, step) => editor.removeStep(layer, step)) },
    moveShapeUp: {
      label: "Move up",
      when: shapeSelected,
      enabled: () => shapeIndex() < shapeCount() - 1,
      run: withShape((layer, step, index) => editor.moveStep(layer, step, index + 1)),
    },
    moveShapeDown: {
      label: "Move down",
      when: shapeSelected,
      enabled: () => shapeIndex() > 0,
      run: withShape((layer, step, index) => editor.moveStep(layer, step, index - 1)),
    },

    copy: { label: "Copy", kbd: "mod+c", when: selected, run: () => editor.copy() },
    cut: { label: "Cut", kbd: "mod+x", when: selected, run: () => editor.cut() },
    paste: { label: "Paste", kbd: "mod+v", when: () => editor.canPaste, run: () => editor.paste() },
    duplicate: { label: "Duplicate", icon: "copy", kbd: "mod+d", when: selected, run: () => editor.duplicateSelection() },
    deleteSelection: {
      label: "Delete",
      icon: "trash",
      kbd: "backspace",
      when: selected,
      run: () => editor.deleteSelection(),
    },
    deleteSelectionAlt: { label: "Delete", kbd: "delete", when: selected, run: () => editor.deleteSelection() },
    fillSelection: { label: "Fill with color", run: () => editor.fillSelection() },
    recolorSelection: { label: "Recolor", run: () => editor.recolorSelection() },
    copyToLayer: { label: "Copy to new layer", run: () => editor.selectionToLayer() },
    moveToLayer: { label: "Move to new layer", run: () => editor.selectionToLayer({ move: true }) },

    rotateSelectionX: rotateSelection(0),
    rotateSelectionY: rotateSelection(1),
    rotateSelectionYBack: rotateSelection(1, -1),
    rotateSelectionZ: rotateSelection(2),
    flipSelectionX: flipSelection(0),
    flipSelectionY: flipSelection(1),
    flipSelectionZ: flipSelection(2),
    // before the nudges: with an extrusion pending, up and down change its depth
    extrudeMore: {
      label: "Pull out one more",
      icon: "plus",
      kbd: "arrowup",
      when: extruding,
      run: () => editor.setExtrusionDepth((editor.pendingExtrusion?.depth ?? 0) + 1),
    },
    extrudeLess: {
      label: "Push in one more",
      icon: "minus",
      kbd: "arrowdown",
      when: extruding,
      run: () => editor.setExtrusionDepth((editor.pendingExtrusion?.depth ?? 0) - 1),
    },
    applyExtrusion: { label: "Apply", icon: "check", kbd: "enter", when: extruding, run: () => editor.applyExtrusion() },
    cancelExtrusion: { label: "Cancel", icon: "close", run: () => editor.cancelExtrusion() },
    nudgeLeft: { label: "Move left", kbd: "arrowleft", when: transformable, run: nudge(-1, 0) },
    nudgeRight: { label: "Move right", kbd: "arrowright", when: transformable, run: nudge(1, 0) },
    nudgeUp: { label: "Move up", kbd: "arrowup", when: transformable, run: nudge(0, 1) },
    nudgeDown: { label: "Move down", kbd: "arrowdown", when: transformable, run: nudge(0, -1) },
    raise: { label: "Raise", kbd: "pageup", when: transformable, run: depth(1) },
    lower: { label: "Lower", kbd: "pagedown", when: transformable, run: depth(-1) },
    rotateLeft: { label: "Rotate left", when: transformable, run: () => turnOnScreen(1) },
    rotateRight: { label: "Rotate right", when: transformable, run: () => turnOnScreen(-1) },
    flipHorizontal: { label: "Flip horizontal", when: transformable, run: () => flipOnScreen(false) },
    flipVertical: { label: "Flip vertical", when: transformable, run: () => flipOnScreen(true) },
    towardYou: { label: "Move toward you", when: transformable, run: depth(1) },
    awayFromYou: { label: "Move away", when: transformable, run: depth(-1) },
    applyTransform: {
      label: "Apply",
      icon: "check",
      kbd: "enter",
      when: () => !!editor.floating,
      run: () => editor.applyTransform(),
    },
    cancelTransform: { label: "Cancel", icon: "close", run: () => editor.cancelTransform() },

    mirrorX: mirror(0),
    mirrorY: mirror(1),
    mirrorZ: mirror(2),

    toggle2D: {
      label: "2D view",
      icon: "flat",
      kbd: "d",
      run: () => {
        if (editor.mode2D) editor.exit2D();
        else editor.enter2D(viewport()?.workplaneSide() ?? 1);
      },
    },
    toggleDepthColors: {
      label: "Depth colors",
      run: () => editor.setDepthColors(!editor.depthColors),
    },
    toggleShowClipped: {
      label: "Show clipped faintly",
      run: () => editor.setShowClipped(!editor.showClipped),
    },
    toggleWorkplane: {
      label: "Workplane",
      icon: "slice",
      kbd: "w",
      run: () => {
        if (workplanePanel.open()) editor.cancelWorkplanePick();
        workplanePanel.setOpen(!workplanePanel.open());
      },
    },
    pickWorkplane: {
      label: "Pick a face",
      icon: "target",
      run: () => {
        if (editor.pickingWorkplane) return editor.cancelWorkplanePick();
        editor.startWorkplanePick();
        editor.notify("Tap a face to put the workplane on it");
      },
    },
    faceWorkplane: {
      label: "Face the workplane",
      run: () => {
        editor.setProjection("orthographic");
        viewport()?.viewAlong(editor.workplane.axis);
      },
    },
    workplaneUp: { label: "Move workplane up", kbd: "]", run: workplaneStep(1) },
    workplaneDown: { label: "Move workplane down", kbd: "[", run: workplaneStep(-1) },
    resetWorkplane: { label: "Reset workplane", run: () => editor.resetWorkplane() },
    clipOff: clip("none", "Show everything"),
    clipBelow: clip("-", "Show the workplane and below"),
    clipAbove: clip("+", "Show the workplane and above"),
    clipOnly: clip("=", "Show only the workplane"),

    newLayer: { label: "New layer", kbd: "mod+shift+n", run: () => editor.createLayer() },

    toggleTimeline: {
      label: "Timeline",
      icon: "film",
      kbd: "t",
      run: () => timelinePanel.setOpen(!timelinePanel.open()),
    },
    playPause: {
      label: "Play",
      icon: "play",
      kbd: "p",
      when: () => editor.isAnimated,
      run: () => editor.togglePlay(),
    },
    previousFrame: { label: "Previous frame", icon: "previous", kbd: ",", run: () => editor.previousFrame() },
    nextFrame: { label: "Next frame", icon: "next", kbd: ".", run: () => editor.nextFrame() },
    newAnimationTag: {
      label: "New tag here",
      run: () => {
        let n = 1;
        while (editor.tags.some(t => t.name === `Tag ${n}`)) n++;
        const id = editor.createTag(`Tag ${n}`, editor.activeFrameId, editor.activeFrameId);
        if (id) editor.setActiveTag(id);
      },
    },
    deleteAnimationTag: {
      label: "Delete tag",
      run: () => { if (editor.activeTagId) editor.removeTag(editor.activeTagId); },
    },
    duplicateFrame: {
      label: "Duplicate frame",
      icon: "duplicateFrame",
      kbd: "alt+n",
      run: () => {
        editor.insertFrame({ content: "duplicate" });
        timelinePanel.setOpen(true);
      },
    },
    blankFrame: {
      label: "New blank frame",
      run: () => {
        editor.insertFrame({ content: "blank" });
        timelinePanel.setOpen(true);
      },
    },
    deleteFrame: { label: "Delete frame", run: () => editor.removeFrames([editor.activeFrameId]) },
    moveFrameLeft: { label: "Move frame left", run: shiftFrame(-1) },
    moveFrameRight: { label: "Move frame right", run: shiftFrame(1) },
    holdLonger: { label: "Hold one tick longer", icon: "plus", run: hold(1) },
    holdShorter: { label: "Hold one tick shorter", icon: "minus", run: hold(-1) },
    copyLayerToNext: {
      label: "Copy layer to next frame",
      run: () => {
        const next = editor.frames[editor.activeFrameIndex + 1];
        if (!next) return editor.notify("This is the last frame");
        if (editor.copyCel(next.id)) editor.notify("Copied to the next frame");
      },
    },
    toggleOnion: {
      label: "Onion skin",
      icon: "onion",
      needs: ["onion-skin"],
      kbd: "shift+o",
      run: () => editor.setOnionSkin({ enabled: !editor.onionSkin.enabled }),
    },

    newShapeLayer: { label: "Vector layer", icon: "pen", kbd: "shift+b", when: shapes, run: () => editor.newShapeLayer() },
    clearOverride: { label: "Clear override", run: () => editor.clearOverride() },
    convertToOverride: { label: "Convert to override layer", run: () => editor.convertToOverride() },
    bakeShapeLayer: { label: "Bake layer to voxels", run: () => editor.bakeShapeLayer() },
    resolution1: resolution(1),
    resolution2: resolution(2),
    resolution4: resolution(4),
    resolution8: resolution(8),

    editMarkers: {
      label: "Markers and origin…",
      icon: "target",
      needs: ["markers"],
      kbd: "shift+m",
      run: () => {
        editor.startMarkerEdit();
        editor.notify(editor.markerTarget ? "Tap the model to place it" : "Choose a marker or the origin, or add one");
      },
    },
    doneMarkers: {
      label: "Done",
      icon: "check",
      kbd: "enter",
      when: () => editor.markerEditing,
      run: () => editor.stopMarkerEdit(),
    },
    groupLayer: {
      label: "Group layer",
      kbd: "mod+g",
      run: () => editor.createGroup(),
    },
    toggleMarkers: {
      label: "Show markers",
      needs: ["markers"],
      run: () => editor.setMarkersShown(!editor.markersShown),
    },

    escape: {
      label: "Cancel",
      kbd: "escape",
      run: () => {
        if (dialog()) return setDialog(null);
        // take back the innermost thing in progress: a gesture, a shape or extrusion, floating content, then the selection
        editor.cancelPointer();
        if (editor.pickingWorkplane) editor.cancelWorkplanePick();
        else if (editor.markerEditing) editor.stopMarkerEdit();
        // a path being drawn is finished, and stays selected; one of a single point is dropped
        else if (editor.drawingPath) editor.cancelPath();
        // editing in place: let go of the picked point, then back to the shape selected
        else if (editor.editingShape) {
          if (editor.selectedPathPoint !== null) editor.selectPathPoint(null);
          else editor.stopEditingShape();
        }
        else if (editor.operandEdit) editor.endOperandEdit();
        else if (editor.pendingShape) editor.cancelShape();
        else if (editor.pendingExtrusion) editor.cancelExtrusion();
        else if (editor.floating) editor.cancelTransform();
        else editor.deselect();
      },
    },
  } satisfies Record<string, Action>;

  // voxel tools' keys do nothing on a vector layer (orbit, select and fill are on both)
  const toolActions = Object.fromEntries(
    tools.map((t) => [
      `tool-${t.id}`,
      { label: t.label, icon: t.icon, kbd: t.kbd, when: VECTOR_TOOLS.some((v) => v.id === t.id) ? undefined : raster, run: () => editor.setTool(t.id) },
    ]),
  ) as Record<`tool-${ToolId}`, Action>;

  return nameActions({ ...actions, ...toolActions });
}

/** The built-in commands, plus any the host adds. */
export type Actions = ReturnType<typeof createActions> & Record<string, Action>;

// #region Keyboard

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

function eventCombo(e: KeyboardEvent): string {
  let key = e.key.toLowerCase();
  if (e.code.startsWith("Digit")) key = e.code.slice(5);
  else if (e.code.startsWith("Key")) key = e.code.slice(3).toLowerCase();
  // shift only matters for letters and digits; for punctuation it is part of the character
  const alnum = /^[a-z0-9]$/.test(key);
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey && (alnum || key.length > 1)) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

export function handleShortcut(actions: Actions, e: KeyboardEvent): boolean {
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
    return false;
  }
  const combo = eventCombo(e);
  for (const action of Object.values(actions) as Action[]) {
    if (action.kbd === combo && (action.when?.() ?? true)) {
      e.preventDefault();
      action.run();
      return true;
    }
  }
  return false;
}

/** Human-readable shortcut, e.g. "⌘⇧Z" or "Ctrl+Shift+Z". */
export function formatKbd(kbd: string): string {
  const parts = kbd.split("+");
  const names: Record<string, [string, string]> = {
    mod: ["⌘", "Ctrl"],
    shift: ["⇧", "Shift"],
    alt: ["⌥", "Alt"],
    escape: ["Esc", "Esc"],
    enter: ["↵", "Enter"],
    backspace: ["⌫", "Backspace"],
    delete: ["⌦", "Del"],
    arrowleft: ["←", "←"],
    arrowright: ["→", "→"],
    arrowup: ["↑", "↑"],
    arrowdown: ["↓", "↓"],
    pageup: ["PgUp", "PgUp"],
    pagedown: ["PgDn", "PgDn"],
  };
  const out = parts.map((p) => names[p]?.[isMac ? 0 : 1] ?? p.toUpperCase());
  return isMac ? out.join("") : out.join("+");
}

// #endregion
