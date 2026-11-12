import { untrack } from "solid-js";
import { toolOp, type BrushOp, type CustomTool, type Editor, type PendingShape, type VoxelOp } from "./editor";
import { cellCoord } from "./grid";
import { depthHandle, faceRegion } from "./extrude";
import { dominantAxis, rayLayerCell, rayPlane, type Hit } from "./raycast";
import { floodMask, type SelectMode } from "./selection";
import { snapSource, sourceOutline, type StepMode } from "./source";
import {
  clipBox,
  defaultHeight,
  draftHeight,
  moveFace,
  paramHandles,
  pathHandles,
  rayAxisParam,
  rayHitShape,
  shapeHandles,
  shiftInside,
  withHeight,
  type Direction,
  type ParamHandleId,
  type ShapeDraft,
  type ShapeHandle,
} from "./shapes";
import type { Axis, Box, BuiltinToolId, GizmoHandle, PointerInput, Preview, Ray, ToolId, Vec3 } from "./types";

/**
 * What a 2D tool does to a pixel's column: the pencil fills it from the workplane ("add"), Erase and
 * Paint change its front voxel, and the depth brush pulls its front out by one ("raise").
 */
type PixelOp = VoxelOp | "raise";

/** How a vector layer shows a shape being drawn that adds, cuts, intersects or paints. */
const STEP_PREVIEW: Record<StepMode, Preview["kind"]> = { add: "add", cut: "erase", intersect: "select", paint: "paint" };

type Gesture =
  | { kind: "free"; op: VoxelOp; axis: Axis; layer: number; last: Vec3; normal?: Vec3 }
  | { kind: "surface"; op: VoxelOp }
  /**
   * `fromPlane`: a selection started on the workplane, where a tap counts as a tap on empty space.
   * `columns`: in 2D, the box selects whole columns along the workplane's axis.
   */
  | {
      kind: "box";
      op: BrushOp;
      mode: SelectMode;
      axis: Axis;
      layer: number;
      anchor: Vec3;
      current: Vec3;
      fromPlane?: boolean;
      columns?: boolean;
      normal?: Vec3;
    }
  /** selecting the voxels the pointer passes over, or in 2D the columns; applied on release */
  | { kind: "select"; mode: SelectMode; cells: Map<number, Vec3>; columns?: boolean }
  /** dragging floating content in the plane of the face that was grabbed */
  | { kind: "float-move"; start: Vec3; axis: Axis; plane: number; p0: Vec3; lifted: boolean }
  /** drawing a shape's base; it becomes the pending shape on release */
  | {
      kind: "shape";
      op: BrushOp;
      axis: Axis;
      layer: number;
      grow: Direction;
      anchor: Vec3;
      current: Vec3;
      square: boolean;
      fromPlane?: boolean;
    }
  /** dragging one face of the pending shape's box along its axis */
  | { kind: "shape-face"; start: ShapeDraft; handle: ShapeHandle; point: Vec3; axis: Axis; s0: number }
  /** sliding the pending shape in the plane across `axis` through the point grabbed */
  | { kind: "shape-move"; start: ShapeDraft; axis: Axis; plane: number; p0: Vec3 }
  /**
   * placing a path's point (just added, or grabbed): it slides across `axis` through where it was,
   * whole cells at a time; the add and the drag are one undo step
   */
  | { kind: "path-point"; layerId: string; stepId: string; index: number; axis: Axis; plane: number; p0: Vec3; start: Vec3; moved: boolean; tap: boolean }
  /** dragging a selected step's settings handle along its axis, one undo step */
  | { kind: "shape-param"; id: ParamHandleId; layerId: string; stepId: string; point: Vec3; axis: Axis; sign: 1 | -1; s0: number; d0: number }
  /** turning the pending shape in quarter turns with the gizmo's ring; `stroke` when it is a step being changed */
  | { kind: "shape-turn"; start: ShapeDraft; axis: Axis; center: Vec3; a0: number; turns: number; stroke: boolean }
  /** pulling a face out or pushing it in; `fresh` when this press started the extrusion */
  | { kind: "extrude"; point: Vec3; s0: number; d0: number; fresh: boolean; moved: boolean }
  /** sliding floating content along one axis with the gizmo's arrow */
  | { kind: "gizmo-move"; axis: Axis; center: Vec3; s0: number; start: Vec3; lifted: boolean }
  /** turning floating content in quarter turns with the gizmo's ring */
  | { kind: "gizmo-rotate"; axis: Axis; center: Vec3; a0: number; turns: number; lifted: boolean }
  /** a 2D stroke: each pixel the pointer passes is drawn once */
  | { kind: "pixels"; op: PixelOp; last: Vec3; seen: Set<number>; normal?: Vec3 }
  /** dragging the workplane along its axis by its arrow */
  | { kind: "workplane"; point: Vec3; s0: number; start: number }
  /** a press while drawing a vector layer's shape (see `Draw`); `moved` once it left the cell it started on */
  | { kind: "draw"; moved: boolean; ray: Ray }
  /** a custom tool's gesture */
  | { kind: "custom"; tool: CustomTool }
  | { kind: "done" };

/**
 * A vector layer's shape being drawn with the shape tool. With a mouse it takes three clicks: the
 * origin, the footprint (which follows the pointer), the height (likewise); a drag at the first
 * click sets the footprint in one go. By touch, a tap drops a default-size shape and a drag sets
 * its footprint, at a default height. Each change shows live; the shape is made at the end.
 */
interface Draw {
  step: StepMode;
  /** the axis the shape grows along, and the cell layer across it the footprint is drawn in */
  axis: Axis;
  layer: number;
  grow: Direction;
  anchor: Vec3;
  current: Vec3;
  square: boolean;
  mouse: boolean;
  phase: "footprint" | "height";
  /** the height, once the pointer has set it */
  height?: number;
  /** in the height phase: where the height is measured along `grow`, from `s0` at `h0` */
  point?: Vec3;
  s0?: number | null;
  h0?: number;
}

interface Target {
  cell: Vec3;
  normal: Vec3;
  /** The existing voxel the target was derived from, if any. */
  voxel?: Vec3;
}

const STROKE_LABELS: Record<VoxelOp, string> = { add: "Draw voxels", erase: "Erase voxels", paint: "Paint voxels" };

/** Two taps on a selected shape within this many milliseconds edit it in place. */
const DOUBLE_TAP_MS = 400;

/** A tap with the shape brush places a shape this many cells across. */
const TAP_SHAPE_SIZE = 7;

/**
 * Turns pointer rays into edits. Pointer input arrives as rays in voxel space, so
 * this knows nothing about cameras or the DOM.
 */
export class ToolController {
  private gesture: Gesture | null = null;
  private draw: Draw | null = null;
  /** The last tap on a selected shape's body, to tell a double tap (which edits it in place). */
  private lastTap: { stepId: string; time: number } | null = null;
  private colorCache: { key: string; cells: Vec3[] } | null = null;
  private extrudeCache: { key: string; face: Set<number>; preview: Preview | null } | null = null;

  constructor(private editor: Editor) {}

  /**
   * Alt picks a color with any tool. The brush also takes Qubicle's modifiers:
   * Shift adds and Ctrl / Cmd erases.
   */
  private toolFor(input: PointerInput): ToolId {
    if (input.alt) return "pick";
    const tool = this.editor.tool;
    if (tool === "brush") return input.shift ? "add" : input.mod ? "erase" : tool;
    return tool;
  }

  /** Returns true if the tool claimed the pointer (otherwise the viewport may orbit). */
  down(input: PointerInput): boolean {
    const ed = this.editor;
    const tool = this.toolFor(input);
    this.gesture = null;

    if (ed.pickingWorkplane) return this.pickWorkplane(input);
    if (input.handle === "workplane") return this.grabWorkplane(input);
    // the second and third clicks of a shape being drawn
    if (this.drawing()) return this.drawDown(input);

    // while a shape or extrusion is pending or content is floating, the pointer adjusts it (or orbits)
    const shape = input.alt ? null : ed.pendingShape;
    if (shape) {
      if (this.grabShape(input, shape)) return true;
      // with a shape layer's box selected, the shape tools can still pick another box or draw a step
      if (shape.operand !== "edit") return false;
      // editing in place, only the shape's own handles take the pointer (the Pen still adds points)
      if (shape.editing && !ed.drawingPath) return false;
    }
    if (!input.alt && ed.activeLayer?.shape) return this.shapeLayerDown(input, tool);
    if (!input.alt && ed.pendingExtrusion && this.grabExtrusion(input)) return true;
    if (!input.alt && isGizmoHandle(input.handle)) return this.grabGizmo(input, input.handle);
    if (!input.alt && ed.floating) return this.grabFloating(input, false);

    const custom = ed.customTool(tool);
    if (custom) {
      if (!custom.down(input, ed)) return false;
      this.gesture = { kind: "custom", tool: custom };
      return true;
    }

    switch (tool as BuiltinToolId) {
      case "orbit":
      // vector tools draw only on vector layers (above); here the pointer orbits
      case "shape":
      case "pen":
        return false;

      case "select":
        return this.selectDown(input);

      case "move": {
        // the selection, or with nothing selected, the active layer
        const hit = ed.hasSelection ? ed.pickSelection(input.ray) : ed.pickActive(input.ray);
        if (!hit) return false;
        this.gesture = { kind: "done" };
        if (!ed.liftSelection()) return true;
        return this.grabFloating(input, true) || true;
      }

      case "extrude": {
        // seen head-on a face can't be pulled; in 2D, the tool is a depth brush instead
        if (ed.mode2D) return this.pixelsDown(input, "raise");
        const hit = ed.pickActive(input.ray);
        if (!hit) return false;
        this.gesture = { kind: "done" };
        if (!ed.startExtrusion(hit.cell, hit.normal)) return true;
        const point = pointAt(input.ray, hit.distance);
        const s0 = rayAxisParam(input.ray, point, dominantAxis(hit.normal));
        this.gesture = { kind: "extrude", point, s0: s0 ?? 0, d0: 0, fresh: true, moved: false };
        return true;
      }

      case "pick": {
        const hit = ed.pickVisible(input.ray);
        if (!hit) return false;
        ed.setColor(ed.composite[ed.index(...hit.cell)]);
        if (!input.alt && ed.tool === "pick") ed.setTool(ed.previousTool === "pick" ? "add" : ed.previousTool);
        this.gesture = { kind: "done" };
        ed.setPreview(null);
        return true;
      }

      case "fill": {
        const hit = ed.pickActive(input.ray);
        if (!hit) return false;
        ed.fill(hit.cell, ed.color, input.shift ? "all" : ed.fillMode);
        this.gesture = { kind: "done" };
        return true;
      }

      case "add":
      case "erase":
      case "brush": {
        const op = toolOp(tool)!;
        if (ed.mode2D && (ed.brush === "voxel" || ed.brush === "box")) return this.pixelsDown(input, op);
        const target = op === "add" ? this.addTarget(input.ray) : this.surfaceTarget(input.ray);
        if (!target) return this.notOwned(input);

        const blocker = ed.editBlocker();
        if (blocker) {
          ed.notify(blocker);
          this.gesture = { kind: "done" };
          return true;
        }

        const axis = dominantAxis(target.normal);
        const layer = target.cell[axis];

        if (ed.brush === "face") {
          ed.applyCells(this.faceCells(target, op), op, ed.color, target.normal);
          this.gesture = { kind: "done" };
          ed.setPreview(null);
          return true;
        }

        if (ed.brush === "box") {
          this.gesture = { kind: "box", op, mode: "add", axis, layer, anchor: target.cell, current: target.cell, normal: target.normal };
          this.updatePreview();
          return true;
        }

        if (ed.brush === "shape") {
          // added shapes grow out of the surface; erased and painted ones into it
          const sign = (op === "add" ? target.normal[axis] : -target.normal[axis]) as 1 | -1;
          const grow = { axis, sign };
          const square = !!input.shift !== ed.shapeUniform;
          this.gesture = { kind: "shape", op, axis, layer, grow, anchor: target.cell, current: target.cell, square };
          this.updatePreview();
          return true;
        }

        ed.beginStroke(op === "add" ? "Add voxels" : op === "erase" ? "Erase voxels" : "Paint voxels");
        ed.applyCells([target.cell], op, ed.color, target.normal);
        this.gesture =
          op === "paint" ? { kind: "surface", op } : { kind: "free", op, axis, layer, last: target.cell, normal: target.normal };
        ed.setPreview(null);
        return true;
      }
    }
  }

  move(input: PointerInput) {
    const ed = this.editor;
    const g = this.gesture;
    if (!g) return this.hover(input);

    switch (g.kind) {
      case "custom":
        g.tool.move?.(input, ed);
        return;
      case "draw": {
        const d = this.draw;
        if (!d) return;
        g.ray = input.ray;
        this.followFootprint(input);
        if (d.current.some((n, a) => n !== d.anchor[a])) g.moved = true;
        return;
      }
      case "pixels": {
        const hit = this.workplaneTarget(input.ray);
        if (!hit) return;
        const line = lineCells(g.last, hit.cell);
        g.last = hit.cell;
        this.drawPixels(g, line);
        return;
      }
      case "workplane": {
        const s = rayAxisParam(input.ray, g.point, ed.workplane.axis);
        if (s !== null) ed.setWorkplane({ level: g.start + Math.round(s - g.s0) });
        return;
      }
      case "free": {
        const hit = rayLayerCell(input.ray, g.axis, g.layer, ed.size);
        if (!hit || !ed.inSlice(hit.cell)) return;
        const cells = lineCells(g.last, hit.cell);
        g.last = hit.cell;
        ed.applyCells(cells, g.op, ed.color, g.normal);
        return;
      }
      case "surface": {
        const hit = ed.pickActive(input.ray);
        if (hit) ed.applyCells([hit.cell], g.op);
        return;
      }
      case "select": {
        const hit = g.columns ? this.workplaneTarget(input.ray) : ed.pickVisible(input.ray);
        if (!hit) return;
        g.cells.set(ed.index(...hit.cell), hit.cell);
        this.updatePreview();
        return;
      }
      case "float-move": {
        const p = planePoint(input.ray, g.axis, g.plane);
        if (!p) return;
        const delta: Vec3 = [0, 0, 0];
        for (let a = 0; a < 3; a++) if (a !== g.axis) delta[a] = Math.round(p[a] - g.p0[a]);
        if (input.shift) {
          // lock to the axis moved along most
          const keep = dominantAxis(delta);
          for (let a = 0; a < 3; a++) if (a !== keep) delta[a] = 0;
        }
        ed.setFloatingOffset([g.start[0] + delta[0], g.start[1] + delta[1], g.start[2] + delta[2]]);
        return;
      }
      case "extrude": {
        const ext = ed.pendingExtrusion;
        const s = ext && rayAxisParam(input.ray, g.point, ext.normal.axis);
        if (!ext || s === null) return;
        const depth = g.d0 + Math.round(s - g.s0) * ext.normal.sign;
        if (depth === ext.depth) return;
        g.moved = true;
        ed.setExtrusionDepth(depth);
        return;
      }
      case "gizmo-move": {
        const s = rayAxisParam(input.ray, g.center, g.axis);
        if (s === null) return;
        const offset = [...g.start] as Vec3;
        offset[g.axis] += Math.round(s - g.s0);
        ed.setFloatingOffset(offset);
        return;
      }
      case "gizmo-rotate": {
        const a = ringAngle(input.ray, g.axis, g.center);
        if (a === null) return;
        // the nearest quarter turn from where the ring was grabbed
        const turns = Math.round(Math.atan2(Math.sin(a - g.a0), Math.cos(a - g.a0)) / (Math.PI / 2));
        if (turns === g.turns) return;
        ed.rotateSelection(g.axis, turns - g.turns);
        g.turns = turns;
        return;
      }
      case "box":
      case "shape": {
        const hit = rayLayerCell(input.ray, g.axis, g.layer, ed.size);
        if (!hit) return;
        g.current = hit.cell;
        if (g.kind === "shape") g.square = !!input.shift !== ed.shapeUniform;
        this.updatePreview();
        return;
      }
      case "shape-face": {
        const s = rayAxisParam(input.ray, g.point, g.axis);
        if (s === null) return;
        ed.setPendingShape({ ...g.start, box: moveFace(g.start.box, g.handle, Math.round(s - g.s0), ed.size) });
        return;
      }
      case "shape-move": {
        const p = planePoint(input.ray, g.axis, g.plane);
        if (!p) return;
        const { min, max } = g.start.box;
        const box: Box = { min: [...min], max: [...max] };
        for (let a = 0; a < 3; a++) {
          if (a === g.axis) continue;
          const d = Math.round(p[a] - g.p0[a]);
          box.min[a] += d;
          box.max[a] += d;
        }
        ed.setPendingShape({ ...g.start, box: shiftInside(box, ed.size) });
        return;
      }
      case "path-point": {
        const p = planePoint(input.ray, g.axis, g.plane);
        if (!p) return;
        const r = ed.resolution;
        const at = [...g.start] as Vec3;
        for (let a = 0; a < 3; a++) if (a !== g.axis) at[a] += Math.round(p[a] - g.p0[a]) / r;
        if (!g.moved && at.every((n, a) => n === g.start[a])) return;
        g.moved = true;
        ed.movePathPoint(g.layerId, g.stepId, g.index, at);
        return;
      }
      case "shape-param": {
        const s = rayAxisParam(input.ray, g.point, g.axis);
        const step = ed.shapeStack(g.layerId)?.find((st) => st.id === g.stepId);
        if (s === null || !step) return;
        const handle = paramHandles(step.shape).find((h) => h.id === g.id);
        if (!handle) return;
        // whole voxels at a time, then the setting snapped to what the shape takes
        const cells = Math.round((s - g.s0) * g.sign);
        const setting = handle.settingAt(g.d0 + cells / ed.resolution);
        for (const key of Object.keys(setting) as (keyof typeof setting)[]) {
          const v = setting[key] as number;
          (setting as Record<string, number>)[key] = key === "taper" ? Math.round(v * 8) / 8 : snapSource(v);
        }
        ed.setStepShape(g.layerId, g.stepId, setting);
        return;
      }
      case "shape-turn": {
        const a = ringAngle(input.ray, g.axis, g.center);
        if (a === null) return;
        const turns = Math.round(Math.atan2(Math.sin(a - g.a0), Math.cos(a - g.a0)) / (Math.PI / 2));
        if (turns === g.turns) return;
        ed.turnPendingShape(g.axis, turns - g.turns);
        g.turns = turns;
        return;
      }
    }
  }

  up() {
    const ed = this.editor;
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    if (g.kind === "custom") {
      g.tool.up?.(ed);
    } else if (g.kind === "draw") {
      const d = this.draw;
      // a finger makes the shape as it lifts; a mouse goes on to the height after a drag, or
      // after a click lets the footprint follow the pointer to the next one
      if (d && !d.mouse) this.finishDraw();
      else if (d && g.moved) this.toHeight(g.ray);
    } else if ((g.kind === "box" || g.kind === "shape") && g.fromPlane && g.anchor.every((n, a) => n === g.current[a])) {
      // a tap on the workplane is a tap on empty space: it deselects, as it would off the model
      ed.setPreview(null);
      ed.pointerTap();
    } else if (g.kind === "box" && g.columns && g.op === "select") {
      ed.selectColumns(boxOf(g.anchor, g.current), g.mode);
      ed.setPreview(null);
    } else if (g.kind === "box" && g.columns) {
      // a rectangle of pixels, drawn as one edit
      ed.beginStroke(STROKE_LABELS[g.op as VoxelOp]);
      this.drawPixels({ op: g.op as VoxelOp, seen: new Set(), normal: g.normal }, boxCells(boxOf(g.anchor, g.current)));
      ed.endStroke();
      ed.setPreview(null);
    } else if (g.kind === "box") {
      const cells = boxCells(boxOf(g.anchor, g.current));
      if (g.op === "select") ed.selectCells(cells, g.mode);
      else ed.applyCells(cells, g.op, ed.color, g.normal);
      ed.setPreview(null);
    } else if (g.kind === "select") {
      const cells = [...g.cells.values()];
      ed.selectCells(g.columns ? cells.flatMap((c) => boxCells(ed.columnBox(cellBox(c)))) : cells, g.mode);
      ed.setPreview(null);
    } else if (g.kind === "shape") {
      ed.setPendingShape(this.drawnShape(g));
    } else if (g.kind === "extrude") {
      // a tap on a face repeats the last depth, so a row of taps extrudes a row of faces alike
      if (g.fresh && !g.moved) ed.setExtrusionDepth(ed.lastExtrusionDepth);
    } else if (g.kind === "shape-param") {
      ed.endStroke();
    } else if (g.kind === "path-point") {
      ed.endStroke();
      // a tap on a point picks it for the panel
      if (g.tap && !g.moved) ed.selectPathPoint(g.index);
    } else if (g.kind === "shape-turn") {
      // a step's turns are already in the document; the drag is one undo step
      if (g.stroke) ed.endStroke();
    } else if ((g.kind === "shape-face" || g.kind === "shape-move") && ed.pendingShape?.operand === "edit") {
      const shape = ed.pendingShape;
      const still = g.start.box.min.every((n, a) => n === shape.box.min[a]) && g.start.box.max.every((n, a) => n === shape.box.max[a]);
      // a shape layer's box records each drag as one undo step
      ed.commitShape();
      // a double tap on the shape edits it in place
      const step = ed.selectedStep?.step.id;
      if (g.kind === "shape-move" && still && step) {
        const time = Date.now();
        const twice = this.lastTap?.stepId === step && time - this.lastTap.time < DOUBLE_TAP_MS;
        this.lastTap = twice ? null : { stepId: step, time };
        if (twice) ed.editShape();
      }
    } else if (
      g.kind === "shape-face" ||
      g.kind === "shape-move" ||
      g.kind === "float-move" ||
      g.kind === "gizmo-move" ||
      g.kind === "gizmo-rotate" ||
      g.kind === "workplane"
    ) {
      // the pending shape or floating content is already up to date
    } else {
      ed.endStroke();
    }
  }

  /** Abort the gesture in progress, and a shape being drawn. Adjusting a pending shape reverts just that adjustment. */
  cancel() {
    this.cancelDraw();
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    if (g.kind === "shape-face" || g.kind === "shape-move") {
      this.editor.setPendingShape(g.start);
      return;
    }
    if (g.kind === "shape-param" || g.kind === "path-point") {
      this.editor.cancelStroke();
      return;
    }
    if (g.kind === "shape-turn") {
      if (g.stroke) this.editor.cancelStroke();
      else this.editor.setPendingShape(g.start);
      return;
    }
    if (g.kind === "float-move" || g.kind === "gizmo-move") {
      // content this drag lifted goes back; content that was already floating returns to where it was
      if (g.lifted) this.editor.cancelTransform();
      else this.editor.setFloatingOffset(g.start);
      return;
    }
    if (g.kind === "workplane") {
      this.editor.setWorkplane({ level: g.start });
      return;
    }
    if (g.kind === "gizmo-rotate") {
      if (g.lifted) this.editor.cancelTransform();
      else this.editor.rotateSelection(g.axis, -g.turns);
      return;
    }
    if (g.kind === "extrude") {
      if (g.fresh) this.editor.cancelExtrusion();
      else this.editor.setExtrusionDepth(g.d0);
      return;
    }
    if (g.kind === "custom" && g.tool.cancel) {
      g.tool.cancel(this.editor);
      this.editor.setPreview(null);
      return;
    }
    this.editor.cancelStroke();
    this.editor.setPreview(null);
  }

  hover(input: PointerInput | null) {
    const ed = this.editor;
    // between a mouse's clicks, the shape being drawn follows the pointer
    if (this.drawing()) {
      if (input && !this.gesture) {
        if (this.draw!.phase === "footprint") this.followFootprint(input);
        else this.followHeight(input);
      }
      return;
    }
    // a vector layer's shape tool and Pen show where they would start even with a shape selected
    const drawingTool = !!ed.activeLayer?.shape && (ed.tool === "shape" || ed.tool === "pen") && !input?.alt;
    if (this.gesture || (ed.pendingShape && !(drawingTool && ed.pendingShape.operand === "edit")) || ed.floating || ed.pendingExtrusion) return;
    if (!input) return ed.setPreview(null);

    if (ed.pickingWorkplane) {
      const hit = ed.pickVisible(input.ray);
      return ed.setPreview(hit && { kind: "pick", boxes: [this.workplaneSlab(hit.cell, hit.normal)] });
    }

    const tool = this.toolFor(input) as BuiltinToolId;
    let preview: Preview | null = null;

    const custom = ed.customTool(tool);
    if (ed.activeLayer?.shape && !input.alt) {
      preview = this.shapeLayerHover(input, tool);
    } else if (custom) {
      preview = custom.hover?.(input, ed) ?? null;
    } else if (tool === "select" && ed.mode2D && ed.selectBrush !== "face" && ed.selectBrush !== "color") {
      const plane = this.workplaneTarget(input.ray);
      const kind = ed.selectPreviewKind(this.selectModeFor(input));
      if (plane) preview = { kind, boxes: [ed.columnBox(cellBox(plane.cell))] };
    } else if (tool === "select") {
      const hit = ed.pickVisible(input.ray);
      if (hit) {
        const kind = ed.selectPreviewKind(this.selectModeFor(input));
        const target = { cell: hit.cell, normal: hit.normal, voxel: hit.cell };
        if (ed.selectBrush === "face") preview = { kind, boxes: [], cells: this.faceCells(target, "select") };
        else if (ed.selectBrush === "color") preview = { kind, boxes: [], cells: this.colorCells(hit.cell) };
        else preview = { kind, boxes: [cellBox(hit.cell)] };
      } else if (ed.selectBrush === "box" || ed.selectBrush === "shape") {
        const plane = this.workplaneTarget(input.ray);
        if (plane) preview = { kind: ed.selectPreviewKind(this.selectModeFor(input)), boxes: [cellBox(plane.cell)] };
      }
    } else if (tool === "pick") {
      const hit = ed.pickVisible(input.ray);
      if (hit) preview = { kind: "pick", boxes: [cellBox(hit.cell)] };
    } else if (tool === "fill") {
      const hit = ed.pickActive(input.ray);
      if (hit) preview = { kind: "paint", boxes: [cellBox(hit.cell)] };
    } else if (ed.mode2D && (tool === "extrude" || (toolOp(tool) && (ed.brush === "voxel" || ed.brush === "box")))) {
      const pixel = this.workplaneTarget(input.ray);
      const op: PixelOp = tool === "extrude" ? "raise" : toolOp(tool)!;
      const cells = pixel ? this.pixelCells(op, pixel.cell) : [];
      if (cells.length) {
        const kind = op === "raise" ? "add" : op;
        preview = { kind, boxes: op === "add" ? [this.pencilBox(cellBox(pixel!.cell))] : cells.map(cellBox) };
      }
    } else if (tool === "extrude") {
      // what a tap would do: the face, pulled (or pushed) by the last depth
      const hit = ed.pickActive(input.ray);
      if (hit) return ed.setPreview(this.extrudeHover(hit));
    } else if (toolOp(tool)) {
      const op = toolOp(tool)!;
      const target = op === "add" ? this.addTarget(input.ray) : this.surfaceTarget(input.ray);
      if (target) {
        const cells = ed.brush === "face" ? this.faceCells(target, op) : [target.cell];
        preview = { kind: op, boxes: cells.map(cellBox) };
      }
    }

    // shape layers don't mirror
    if (ed.activeLayer?.shape) return ed.setPreview(preview);
    ed.setPreview(
      preview && {
        ...preview,
        boxes: ed.mirrorBoxes(preview.boxes),
        cells: preview.cells && ed.mirrorCells(preview.cells).filter((c) => ed.inBounds(c)),
      },
    );
  }

  private updatePreview() {
    const ed = this.editor;
    const g = this.gesture;
    if (g?.kind === "box") {
      const kind = g.op === "select" ? ed.selectPreviewKind(g.mode) : g.op;
      const box = boxOf(g.anchor, g.current);
      const shown = !g.columns ? box : g.op === "add" ? this.pencilBox(box) : ed.columnBox(box);
      ed.setPreview({ kind, boxes: ed.mirrorBoxes([shown]) });
    } else if (g?.kind === "select") {
      const cells = ed.mirrorCells([...g.cells.values()]).filter((c) => ed.inBounds(c));
      ed.setPreview({ kind: ed.selectPreviewKind(g.mode), boxes: [], cells });
    } else if (g?.kind === "shape") {
      const draft = this.drawnShape(g);
      ed.setPreview(ed.shapePreview({ ...draft, kind: ed.shapeKind, hollow: ed.shapeHollow }, g.op));
    }
  }

  /**
   * The shape a base drag describes: the base as drawn, with a default height for the shape. A tap
   * (the base a single cell) makes a default-size base, unless `tapSize` is false.
   */
  private drawnShape(g: { axis: Axis; grow: Direction; anchor: Vec3; current: Vec3; square: boolean }, tapSize = true): ShapeDraft {
    const ed = this.editor;
    const min = [...g.anchor] as Vec3;
    const max = [...g.anchor] as Vec3;
    const axes = [((g.axis + 1) % 3) as Axis, ((g.axis + 2) % 3) as Axis];
    const tap = tapSize && axes.every((a) => g.current[a] === g.anchor[a]);
    const deltas = axes.map((a) => g.current[a] - g.anchor[a]);
    if (g.square) {
      const n = Math.max(...deltas.map(Math.abs));
      deltas.forEach((d, i) => (deltas[i] = d < 0 ? -n : n));
    }
    axes.forEach((a, i) => {
      if (tap) {
        min[a] -= (TAP_SHAPE_SIZE - 1) / 2;
        max[a] += (TAP_SHAPE_SIZE - 1) / 2;
      } else if (ed.shapeFromCenter) {
        // the start is the middle: the base reaches as far the other way
        min[a] = g.anchor[a] - Math.abs(deltas[i]);
        max[a] = g.anchor[a] + Math.abs(deltas[i]);
      } else {
        min[a] = Math.min(g.anchor[a], g.anchor[a] + deltas[i]);
        max[a] = Math.max(g.anchor[a], g.anchor[a] + deltas[i]);
      }
    });
    const box = clipBox({ min, max }, ed.size);
    const [u, v] = axes;
    const kind = ed.shapeKind;
    const height = defaultHeight(kind, box.max[u] - box.min[u] + 1, box.max[v] - box.min[v] + 1);
    return withHeight({ box, up: g.grow, grow: g.grow }, height, ed.size);
  }

  /**
   * On a vector layer the tools work on its stack of shapes: Select picks the shape under the
   * pointer (its handles then shape it), the shape tool draws a new one (`shapePreset`) that adds
   * to, cuts out of, intersects with or paints what is below it (`shapeMode`), the Pen draws a
   * path a point per tap, and Fill gives the shape tapped the current color.
   */
  private shapeLayerDown(input: PointerInput, tool: ToolId): boolean {
    const ed = this.editor;
    if (tool === "orbit") return false;
    if (tool === "select") {
      const step = ed.pickStep(input.ray);
      if (!step) return false;
      this.gesture = { kind: "done" };
      ed.selectStep(step.id);
      return true;
    }
    if (tool === "fill") return this.fillStep(input);
    if (tool !== "shape" && tool !== "pen") {
      // a voxel tool: say why it does nothing here, rather than orbit
      if (!ed.pickVisible(input.ray)) return false;
      this.gesture = { kind: "done" };
      ed.notify(ed.editBlocker() ?? "Voxel tools work on raster layers; this is a vector layer");
      return true;
    }
    const mode = ed.shapeMode;
    const target = this.vectorTarget(input.ray, mode);
    if (!target) return false;
    this.gesture = { kind: "done" };
    const blocker = ed.shapeBlocker(ed.activeLayer);
    if (blocker) {
      ed.notify(blocker);
      return true;
    }
    if (tool === "pen") return this.drawPathPoint(input, mode, target);
    ed.endOperandEdit();
    const axis = dominantAxis(target.normal);
    // added shapes grow out of the surface; the others into the model, or up off the workplane
    const sign = (mode === "add" || !target.voxel ? target.normal[axis] : -target.normal[axis]) as 1 | -1;
    const anchor = target.cell;
    const draw: Draw = {
      step: mode,
      axis,
      layer: anchor[axis],
      grow: { axis, sign },
      anchor,
      current: anchor,
      square: !!input.shift !== ed.shapeUniform,
      mouse: !!input.hover,
      phase: "footprint",
    };
    ed.setPreview(null);
    if (!ed.startStep(mode, this.drawDraft(draw), "footprint")) return true;
    this.draw = draw;
    this.gesture = { kind: "draw", moved: false, ray: input.ray };
    return true;
  }

  /** Whether a shape is being drawn; one dropped meanwhile (by undo, say) is forgotten. */
  private drawing(): boolean {
    if (this.draw && !untrack(() => this.editor.operandEdit)?.drawing) this.draw = null;
    return !!this.draw;
  }

  /** A press while drawing (a mouse's second or third click): it sets the footprint, then makes the shape. */
  private drawDown(input: PointerInput): boolean {
    const d = this.draw!;
    this.gesture = { kind: "done" };
    if (d.phase === "footprint") {
      this.followFootprint(input);
      this.toHeight(input.ray);
    } else {
      this.followHeight(input);
      this.finishDraw();
    }
    return true;
  }

  /** The footprint's far corner follows the pointer across the layer it is drawn in. */
  private followFootprint(input: PointerInput) {
    const d = this.draw!;
    d.square = !!input.shift !== this.editor.shapeUniform;
    const hit = rayLayerCell(input.ray, d.axis, d.layer, this.editor.size);
    if (hit) d.current = hit.cell;
    this.showDraw();
  }

  /** The footprint is set; from here the pointer raises or lowers the shape from its default height. */
  private toHeight(ray: Ray) {
    const d = this.draw!;
    const draft = this.drawDraft(d);
    d.phase = "height";
    d.h0 = d.height ?? draftHeight(draft);
    d.point = d.current.map((n) => n + 0.5) as Vec3;
    // looking straight along the axis a height can't be told; the next click makes it as it is
    d.s0 = rayAxisParam(ray, d.point, d.grow.axis);
    this.editor.setDrawPhase("height");
  }

  private followHeight(input: PointerInput) {
    const d = this.draw!;
    const s = d.point && rayAxisParam(input.ray, d.point, d.grow.axis);
    if (s === null || s === undefined || d.s0 === null || d.s0 === undefined) return;
    d.height = Math.max(1, d.h0! + Math.round((s - d.s0) * d.grow.sign));
    this.showDraw();
  }

  /** What a drawing describes: its footprint, at the height set or the shape's default one. */
  private drawDraft(d: Draw): ShapeDraft {
    // a finger's tap drops a default-size shape; a mouse's footprint starts a cell across
    const base = this.drawnShape(d, !d.mouse);
    return d.height === undefined ? base : withHeight(base, d.height, this.editor.size);
  }

  private showDraw() {
    if (this.draw) this.editor.setPendingShape(this.drawDraft(this.draw));
  }

  /** Make the shape being drawn, as one undo step, and go back to Select holding it. */
  private finishDraw() {
    const d = this.draw;
    if (!d) return;
    const draft = this.drawDraft(d);
    this.draw = null;
    this.editor.setPendingShape(draft);
    this.editor.commitShape();
  }

  /** Stop drawing, dropping the shape. */
  private cancelDraw() {
    if (!this.draw) return;
    this.draw = null;
    if (untrack(() => this.editor.operandEdit)?.drawing) this.editor.cancelShape();
  }

  /**
   * Where a vector layer's shape or point starts: an added shape against the model or on the
   * workplane, like Add; the others on the model's surface, or on the workplane off it.
   */
  private vectorTarget(ray: Ray, mode: StepMode): Target | null {
    if (mode === "add") return this.addTarget(ray);
    const hit = this.editor.pickVisible(ray);
    return hit ? { cell: hit.cell, normal: hit.normal, voxel: hit.cell } : this.workplaneTarget(ray);
  }

  /** Fill on a vector layer: the shape tapped takes the current color, as one undo step. A cut has none. */
  private fillStep(input: PointerInput): boolean {
    const ed = this.editor;
    const step = ed.pickStep(input.ray);
    if (!step) return false;
    this.gesture = { kind: "done" };
    if (step.mode === "cut") {
      ed.notify("A cut has no color");
      return true;
    }
    ed.setStepMaterial(ed.activeLayerId, step.id, ed.color);
    return true;
  }

  /**
   * A tap with a path preset: the path being drawn gets a point at the cell tapped (or a new path
   * starts there), which a drag then slides along the surface it was put on. One undo step.
   */
  private drawPathPoint(input: PointerInput, mode: StepMode, target: Target): boolean {
    const ed = this.editor;
    const r = ed.resolution;
    const at = target.cell.map((n) => (n + 0.5) / r) as Vec3;
    const drawing = ed.drawingPath;
    const layer = ed.activeLayer!;
    // nothing in progress to cancel when the new path is selected
    this.gesture = null;
    ed.beginStroke("Add point");
    let stepId: string | null;
    let index = 0;
    if (drawing && drawing.layerId === layer.id && ed.shapeStack(layer.id)?.some((s) => s.id === drawing.stepId)) {
      stepId = drawing.stepId;
      index = ed.shapeStack(layer.id)!.find((s) => s.id === stepId)!.shape.points?.length ?? 0;
      if (!ed.addPathPoint(layer.id, stepId, at)) stepId = null;
    } else {
      stepId = ed.startPath(mode, at);
    }
    if (!stepId) {
      ed.cancelStroke();
      return true;
    }
    const placed = ed.shapeStack(layer.id)!.find((s) => s.id === stepId)!.shape.points![index].at.map((n) => n * r) as Vec3;
    this.dragPathPoint(input, layer.id, stepId, index, placed, dominantAxis(target.normal), false);
    return true;
  }

  /** Start sliding a path's point (in grid units at `point`) across `axis`; a stroke is open for it. */
  private dragPathPoint(input: PointerInput, layerId: string, stepId: string, index: number, point: Vec3, axis: Axis, tap: boolean) {
    const ed = this.editor;
    const p0 = planePoint(input.ray, axis, point[axis]) ?? point;
    const start = ed.shapeStack(layerId)?.find((s) => s.id === stepId)?.shape.points?.[index]?.at ?? point.map((n) => n / ed.resolution);
    this.gesture = { kind: "path-point", layerId, stepId, index, axis, plane: point[axis], p0, start: [...start] as Vec3, moved: false, tap };
  }

  /** What a tool would do on a vector layer: the shape Select or Fill would take, or the cell a shape or point starts from. */
  private shapeLayerHover(input: PointerInput, tool: ToolId): Preview | null {
    const ed = this.editor;
    if (tool === "select" || tool === "fill") {
      const step = ed.pickStep(input.ray);
      if (!step || (tool === "fill" && step.mode === "cut")) return null;
      return { kind: tool === "fill" ? "paint" : "select", boxes: [], outlines: [sourceOutline(step.shape, ed.resolution)] };
    }
    if (tool === "shape" || tool === "pen") {
      const target = this.vectorTarget(input.ray, ed.shapeMode);
      if (!target) return null;
      const preview: Preview = { kind: STEP_PREVIEW[ed.shapeMode], boxes: [cellBox(target.cell)] };
      // drawing a path: a dashed line from its last point to where the next would go
      const drawing = tool === "pen" ? ed.drawingPath : null;
      const last = drawing && ed.shapeStack(drawing.layerId)?.find((s) => s.id === drawing.stepId)?.shape.points?.at(-1);
      if (last) preview.lines = [[last.at.map((n) => n * ed.resolution) as Vec3, target.cell.map((n) => n + 0.5) as Vec3]];
      return preview;
    }
    return null;
  }

  /** Shift adds and Ctrl / Cmd subtracts, as shortcuts for the select mode. */
  private selectModeFor(input: PointerInput): SelectMode {
    return input.shift ? "add" : input.mod ? "subtract" : this.editor.selectMode;
  }

  /** The select tool takes the same brushes as add / erase / brush, aimed at visible voxels. */
  private selectDown(input: PointerInput): boolean {
    const ed = this.editor;
    if (ed.mode2D && ed.selectBrush !== "face" && ed.selectBrush !== "color") return this.selectColumnsDown(input);
    const voxel = ed.pickVisible(input.ray);
    // a box or shape can start on the workplane, so a selection doesn't have to start on a voxel
    const onPlane = !voxel && (ed.selectBrush === "box" || ed.selectBrush === "shape");
    const hit = voxel ?? (onPlane ? this.workplaneTarget(input.ray) : null);
    if (!hit) return false;
    const mode = this.selectModeFor(input);
    const target: Target = { cell: hit.cell, normal: hit.normal, voxel: hit.cell };
    const axis = dominantAxis(hit.normal);
    const layer = hit.cell[axis];
    ed.setPreview(null);

    switch (ed.selectBrush) {
      case "face":
        ed.selectCells(this.faceCells(target, "select"), mode);
        this.gesture = { kind: "done" };
        return true;
      case "color":
        ed.selectColor(hit.cell, ed.fillMode, mode);
        this.gesture = { kind: "done" };
        return true;
      case "box":
        this.gesture = { kind: "box", op: "select", mode, axis, layer, anchor: hit.cell, current: hit.cell, fromPlane: onPlane };
        break;
      case "shape": {
        // like erasing, the shape grows into the surface; from the workplane, it grows toward you
        const grow = { axis, sign: (onPlane ? hit.normal[axis] : -hit.normal[axis]) as 1 | -1 };
        this.gesture = {
          kind: "shape",
          op: "select",
          axis,
          layer,
          grow,
          anchor: hit.cell,
          current: hit.cell,
          square: !!input.shift !== ed.shapeUniform,
          fromPlane: onPlane,
        };
        break;
      }
      case "voxel":
        this.gesture = { kind: "select", mode, cells: new Map([[ed.index(...hit.cell), hit.cell]]) };
        break;
    }
    this.updatePreview();
    return true;
  }

  /**
   * 2D selection: a pixel stands for its whole column. The box and shape brushes draw a rectangle of
   * columns and the voxel brush paints them; both start anywhere on the grid, voxels or not.
   */
  private selectColumnsDown(input: PointerInput): boolean {
    const ed = this.editor;
    const hit = this.workplaneTarget(input.ray);
    if (!hit) return false;
    const mode = this.selectModeFor(input);
    const { axis, level } = ed.workplane;
    ed.setPreview(null);
    if (ed.selectBrush === "voxel") {
      this.gesture = { kind: "select", mode, cells: new Map([[ed.index(...hit.cell), hit.cell]]), columns: true };
    } else {
      this.gesture = {
        kind: "box",
        op: "select",
        mode,
        axis,
        layer: level,
        anchor: hit.cell,
        current: hit.cell,
        fromPlane: true,
        columns: true,
      };
    }
    this.updatePreview();
    return true;
  }

  /**
   * Start a 2D stroke: a pixel stands for its column. The voxel brush draws the pixels the pointer
   * passes, the box brush a rectangle of them. Off the grid, the pointer pans.
   */
  private pixelsDown(input: PointerInput, op: PixelOp): boolean {
    const ed = this.editor;
    const hit = this.workplaneTarget(input.ray);
    if (!hit) return false;
    ed.setPreview(null);
    const blocker = ed.editBlocker();
    if (blocker) {
      ed.notify(blocker);
      this.gesture = { kind: "done" };
      return true;
    }
    const { axis, level } = ed.workplane;
    if (op !== "raise" && ed.brush === "box") {
      this.gesture = { kind: "box", op, mode: "add", axis, layer: level, anchor: hit.cell, current: hit.cell, columns: true, normal: hit.normal };
      this.updatePreview();
      return true;
    }
    ed.beginStroke(op === "raise" ? "Raise voxels" : STROKE_LABELS[op]);
    const g = { kind: "pixels" as const, op, last: hit.cell, seen: new Set<number>(), normal: hit.normal };
    this.gesture = g;
    this.drawPixels(g, [hit.cell]);
    return true;
  }

  /** Apply a 2D tool to pixels it hasn't touched yet in this stroke. */
  private drawPixels(g: { op: PixelOp; seen: Set<number>; normal?: Vec3 }, pixels: Vec3[]) {
    const ed = this.editor;
    const fresh = pixels.filter((p) => {
      const i = ed.index(...p);
      if (g.seen.has(i)) return false;
      g.seen.add(i);
      return true;
    });
    if (!fresh.length) return;
    if (g.op !== "raise") {
      ed.applyCells(fresh.flatMap((p) => this.pixelCells(g.op, p)), g.op as VoxelOp, ed.color, g.normal);
      return;
    }
    // the raised front keeps the color it had
    const byColor = new Map<number, Vec3[]>();
    for (const p of fresh) {
      const front = this.frontVoxel(p);
      const [cell] = this.pixelCells("raise", p);
      if (!front || !cell) continue;
      const value = ed.composite[ed.index(...front)];
      byColor.set(value, [...(byColor.get(value) ?? []), cell]);
    }
    for (const [value, cells] of byColor) ed.applyCells(cells, "add", value);
  }

  /** The cells a 2D tool changes in a pixel's column. */
  private pixelCells(op: PixelOp, pixel: Vec3): Vec3[] {
    const ed = this.editor;
    if (op === "add") return ed.pencilCells(pixel);
    const front = this.frontVoxel(pixel);
    if (!front) return [];
    if (op !== "raise") return [front];
    const { axis } = ed.workplane;
    const out = [...front] as Vec3;
    out[axis] += ed.mode2D?.side ?? 1;
    return ed.inBounds(out) && ed.inSlice(out) ? [out] : [];
  }

  /** The active layer's front voxel in a pixel's column, as the viewer sees it (within the clip). */
  private frontVoxel(pixel: Vec3): Vec3 | null {
    const ed = this.editor;
    const { axis } = ed.workplane;
    const side = ed.mode2D?.side ?? 1;
    const origin: Vec3 = [pixel[0] + 0.5, pixel[1] + 0.5, pixel[2] + 0.5];
    origin[axis] = side > 0 ? ed.size[axis] + 1 : -1;
    const dir: Vec3 = [0, 0, 0];
    dir[axis] = -side;
    return ed.pickActive({ origin, dir })?.cell ?? null;
  }

  /** A rectangle of pixels, as deep as the pencil fills it. */
  private pencilBox(box: Box): Box {
    const ed = this.editor;
    const { axis } = ed.workplane;
    const cells = ed.pencilCells(box.min);
    const out: Box = { min: [...box.min], max: [...box.max] };
    if (!cells.length) return out;
    out.min[axis] = cells[0][axis];
    out.max[axis] = cells[cells.length - 1][axis];
    return out;
  }

  /** Put the workplane against the face tapped, and go back to the tool. Off the model, the pointer orbits. */
  private pickWorkplane(input: PointerInput): boolean {
    const ed = this.editor;
    const hit = ed.pickVisible(input.ray);
    if (!hit) return false;
    ed.setWorkplaneFromFace(hit.cell, hit.normal);
    ed.cancelWorkplanePick();
    this.gesture = { kind: "done" };
    return true;
  }

  /** The layer of cells the workplane would take if picked from this face. */
  private workplaneSlab(cell: Vec3, normal: Vec3): Box {
    const ed = this.editor;
    const axis = dominantAxis(normal);
    const level = Math.max(0, Math.min(ed.size[axis] - 1, cell[axis] + Math.sign(normal[axis])));
    const min: Vec3 = [0, 0, 0];
    const max = ed.size.map((n) => n - 1) as Vec3;
    min[axis] = max[axis] = level;
    return { min, max };
  }

  /** Start sliding the workplane along its axis by its arrow. A tap leaves it where it is. */
  private grabWorkplane(input: PointerInput): boolean {
    const ed = this.editor;
    const point = ed.workplaneHandle(input.ray.origin);
    const s0 = rayAxisParam(input.ray, point, ed.workplane.axis);
    // seen head-on the arrow can't be dragged; the viewport hides it then
    if (s0 === null) return false;
    ed.setPreview(null);
    this.gesture = { kind: "workplane", point, s0, start: ed.workplane.level };
    return true;
  }

  /** Start dragging the floating content, if the pointer is on it. */
  private grabFloating(input: PointerInput, lifted: boolean): boolean {
    const ed = this.editor;
    const f = ed.floating;
    const hit = f && ed.pickFloating(input.ray);
    if (!f || !hit) return false;
    const axis = dominantAxis(hit.normal);
    const p0 = pointAt(input.ray, hit.distance);
    // slide in the plane of the face that was grabbed
    const plane = hit.cell[axis] + (hit.normal[axis] > 0 ? 1 : 0);
    this.gesture = { kind: "float-move", start: [...f.offset], axis, plane, p0, lifted };
    return true;
  }

  /**
   * Start adjusting the pending extrusion: its depth handle, or the extrusion itself. Anywhere
   * else applies it, so the press can start the next one.
   */
  private grabExtrusion(input: PointerInput): boolean {
    const ed = this.editor;
    const ext = ed.pendingExtrusion!;
    const axis = ext.normal.axis;
    let point: Vec3 | null = null;
    if (input.handle === "depth") point = depthHandle(ext);
    else {
      const hit = ed.pickExtrusion(input.ray);
      if (hit) point = pointAt(input.ray, hit.distance);
    }
    if (!point) {
      ed.applyExtrusion();
      return false;
    }
    const s0 = rayAxisParam(input.ray, point, axis);
    // looking straight along the face, a drag can't tell depth; the bar's buttons still can
    if (s0 === null) {
      this.gesture = { kind: "done" };
      return true;
    }
    this.gesture = { kind: "extrude", point, s0, d0: ext.depth, fresh: false, moved: false };
    return true;
  }

  /** Start sliding or turning the floating content (lifting it first) with the transform gizmo. */
  private grabGizmo(input: PointerInput, handle: GizmoHandle): boolean {
    const ed = this.editor;
    const lifted = !ed.floating;
    const f = ed.liftSelection();
    this.gesture = { kind: "done" };
    if (!f) return true;
    const center = f.offset.map((n, a) => n + f.size[a] / 2) as Vec3;
    const axis = Number(handle.split("-")[1]) as Axis;
    if (handle.startsWith("move")) {
      const s0 = rayAxisParam(input.ray, center, axis);
      if (s0 !== null) this.gesture = { kind: "gizmo-move", axis, center, s0, start: [...f.offset], lifted };
    } else {
      const a0 = ringAngle(input.ray, axis, center);
      if (a0 !== null) this.gesture = { kind: "gizmo-rotate", axis, center, a0, turns: 0, lifted };
    }
    return true;
  }

  /** The extrude tool's hover preview for the face under the pointer, cached while the pointer stays on that face. */
  private extrudeHover(hit: Hit): Preview | null {
    const ed = this.editor;
    const key = `${ed.activeLayerId}:${hit.normal.join()}:${ed.lastExtrusionDepth}:${ed.mirror.join()}:${ed.geometryVersion}:${ed.selectionVersion}`;
    const cache = this.extrudeCache;
    if (cache?.key === key && cache.face.has(ed.index(...hit.cell))) return cache.preview;
    const base = ed.extrusionRegion(hit.cell, hit.normal);
    const axis = dominantAxis(hit.normal);
    const normal = { axis, sign: hit.normal[axis] > 0 ? 1 : -1 } as const;
    const preview = base.length
      ? ed.extrusionPreview({ layerId: ed.activeLayerId, normal, base, depth: ed.lastExtrusionDepth })
      : null;
    this.extrudeCache = { key, face: new Set(base.map((c) => ed.index(...c))), preview };
    return preview;
  }

  /** Visible voxels the color brush would select from `seed` (cached while hovering). */
  private colorCells(seed: Vec3): Vec3[] {
    const ed = this.editor;
    const key = `${seed.join()}:${ed.fillMode}:${ed.geometryVersion}`;
    if (this.colorCache?.key === key) return this.colorCache.cells;
    const composite = ed.composite;
    const color = composite[ed.index(...seed)];
    const [sx, sy] = ed.size;
    const cells: Vec3[] = [];
    if (ed.fillMode === "all") {
      for (let i = 0; i < composite.length; i++) {
        if (composite[i] === color) cells.push(cellCoord(i, sx, sy));
      }
    } else {
      const region = floodMask([ed.index(...seed)], ed.size, (i) => composite[i] === color);
      for (let i = 0; i < region.length; i++) {
        if (region[i]) cells.push(cellCoord(i, sx, sy));
      }
    }
    this.colorCache = { key, cells };
    return cells;
  }

  /**
   * Start adjusting the pending shape: a face handle moves that face along its axis, the gizmo's
   * ring turns it a quarter turn at a time, and the shape itself slides across the axis you look
   * along most, through the point grabbed.
   */
  private grabShape(input: PointerInput, shape: PendingShape): boolean {
    const ed = this.editor;
    const draft: ShapeDraft = { box: shape.box, up: shape.up, grow: shape.grow, ...(shape.forward ? { forward: shape.forward } : {}) };

    if (isGizmoHandle(input.handle)) {
      const axis = Number(input.handle.split("-")[1]) as Axis;
      const center = [0, 1, 2].map((a) => (draft.box.min[a] + draft.box.max[a] + 1) / 2) as Vec3;
      const a0 = input.handle.startsWith("rotate") ? ringAngle(input.ray, axis, center) : null;
      if (a0 === null) {
        this.gesture = { kind: "done" };
        return true;
      }
      // turning a step changes the document as it goes; the whole drag is one undo step
      const stroke = shape.operand === "edit";
      if (stroke) ed.beginStroke("Turn shape");
      this.gesture = { kind: "shape-turn", start: draft, axis, center, a0, turns: 0, stroke };
      return true;
    }

    // a step's points and setting handles: editing it in place, or drawing it with the Pen
    const selected = shape.operand === "edit" && (shape.editing || ed.drawingPath) ? ed.selectedStep : null;
    // a path's point: drag it; a segment's middle: a new point there, to drag
    const pathHandle = selected?.step.shape.kind === "path" && typeof input.handle === "string" ? /^(point|insert)-(\d+)$/.exec(input.handle) : null;
    if (selected && pathHandle) {
      const index = Number(pathHandle[2]);
      const handle = pathHandles(selected.step.shape).find((h) => h.id === input.handle);
      if (!handle) return false;
      // drawing with the Pen, a tap on the first point (with three or more) closes the path and finishes it
      const points = selected.step.shape.points ?? [];
      if (ed.drawingPath && pathHandle[1] === "point" && index === 0 && points.length >= 3 && ed.tool === "pen") {
        this.gesture = { kind: "done" };
        if (!selected.step.shape.closed) ed.setStepShape(selected.layerId, selected.step.id, { closed: true });
        ed.finishPath();
        return true;
      }
      ed.beginStroke(pathHandle[1] === "insert" ? "Add point" : "Move point");
      if (pathHandle[1] === "insert") ed.addPathPoint(selected.layerId, selected.step.id, handle.point, index);
      const grid = handle.point.map((n) => n * ed.resolution) as Vec3;
      this.dragPathPoint(input, selected.layerId, selected.step.id, index, grid, dominantAxis(input.ray.dir), pathHandle[1] === "point");
      return true;
    }
    const param = selected && paramHandles(selected.step.shape).find((h) => h.id === input.handle);
    if (selected && param) {
      const r = ed.resolution;
      const point = param.point.map((n) => n * r) as Vec3;
      const s0 = rayAxisParam(input.ray, point, param.along.axis);
      if (s0 === null) {
        this.gesture = { kind: "done" };
        return true;
      }
      ed.beginStroke("Change shape");
      this.gesture = {
        kind: "shape-param",
        id: param.id,
        layerId: selected.layerId,
        stepId: selected.step.id,
        point,
        axis: param.along.axis,
        sign: param.along.sign,
        s0,
        d0: param.distance,
      };
      return true;
    }

    // editing in place, the box has no handles and doesn't move
    if (shape.editing) return false;
    const handle = shapeHandles(draft).find((h) => h.id === input.handle);
    if (handle) {
      const axis = handle.normal.axis;
      const s0 = rayAxisParam(input.ray, handle.point, axis);
      // looking straight along the axis, a drag can't tell how far; the panel's fields still can
      this.gesture = s0 === null ? { kind: "done" } : { kind: "shape-face", start: draft, handle: handle.id, point: handle.point, axis, s0 };
      return true;
    }

    // a selected shape layer box slides with Select; Shape and Cut draw on it instead
    if (shape.operand === "edit" && this.toolFor(input) !== "select") return false;
    const distance = rayHitShape(input.ray, shape);
    if (distance === null) return false;
    const p0 = pointAt(input.ray, distance);
    const axis = dominantAxis(input.ray.dir);
    this.gesture = { kind: "shape-move", start: draft, axis, plane: p0[axis], p0 };
    return true;
  }

  /**
   * Erasing or painting a raster layer only reaches its own voxels. When the pointer is on a
   * visible voxel from another layer (a shape, say), say so instead of orbiting, and how to
   * edit it. Returns whether the gesture was taken.
   */
  private notOwned(input: PointerInput): boolean {
    const ed = this.editor;
    const layer = ed.activeLayer;
    if (!layer || layer.coverage || this.toolFor(input) === "add" || !ed.pickVisible(input.ray)) return false;
    if (layer.shape) {
      this.gesture = { kind: "done" };
      ed.notify(ed.editBlocker() ?? "");
      return true;
    }
    if (!ed.layers.some((l) => l.shape && l.visible)) return false;
    this.gesture = { kind: "done" };
    ed.notify(`That voxel isn't on “${layer.name}”. To erase or paint shapes, use an override layer (Layer menu › Convert to override)`);
    return true;
  }

  /** Where "add" would place a voxel: against visible geometry, else on the workplane, whichever is nearer. */
  private addTarget(ray: Ray): Target | null {
    const ed = this.editor;
    const hit = ed.pickVisible(ray);
    const plane = this.workplaneTarget(ray);

    if (hit && (!plane || hit.distance <= plane.distance)) {
      const cell = add(hit.cell, hit.normal);
      if (!ed.inBounds(cell) || !ed.inSlice(cell)) return null;
      return { cell, normal: hit.normal, voxel: hit.cell };
    }
    return plane;
  }

  /** The workplane cell under the ray, facing the camera. The ray meets it on the face its grid is drawn on. */
  private workplaneTarget(ray: Ray): (Target & { distance: number }) | null {
    const ed = this.editor;
    const { axis, level } = ed.workplane;
    const plane = rayLayerCell(ray, axis, level, ed.size, ed.workplaneFace - level);
    if (!plane) return null;
    const normal: Vec3 = [0, 0, 0];
    normal[axis] = ray.dir[axis] > 0 ? -1 : 1;
    return { cell: plane.cell, normal, distance: plane.distance };
  }

  /** The active layer's voxel under the ray (for erase / paint). */
  private surfaceTarget(ray: Ray): Target | null {
    const hit: Hit | null = this.editor.pickActive(ray);
    return hit && { cell: hit.cell, normal: hit.normal, voxel: hit.cell };
  }

  /**
   * Qubicle-style face brush: every voxel connected to the target's voxel that
   * shares its exposed, coplanar face.
   */
  private faceCells(target: Target, op: BrushOp): Vec3[] {
    const ed = this.editor;
    // selecting works on what's visible, and so does an override layer; editing a raster layer on its own voxels
    const data = op === "select" || ed.activeLayer?.coverage ? ed.composite : ed.activeLayer?.data;
    if (!target.voxel || !data) return [target.cell];
    const n = target.normal;
    const axis = dominantAxis(n);

    // Seed from the active layer's voxel. When adding against another layer's
    // voxel, fall back to a single cell.
    const solid = (c: Vec3) => ed.inBounds(c) && ed.inSlice(c) && !!data[ed.index(...c)] && !ed.isCellHidden(c);
    if (!solid(target.voxel)) return [target.cell];

    const exposed = (c: Vec3) => {
      const out = add(c, n);
      return !ed.inBounds(out) || !data[ed.index(...out)] || ed.isCellHidden(out);
    };
    const region = faceRegion(target.voxel, axis, ed.size, (c) => solid(c) && exposed(c));
    // the seed counts even if it is covered, as before
    if (!region.length) region.push(target.voxel);

    if (op !== "add") return region;
    return region.map((c) => add(c, n)).filter((c) => ed.inBounds(c));
  }
}

function isGizmoHandle(handle: PointerInput["handle"]): handle is GizmoHandle {
  return !!handle && (handle.startsWith("move-") || handle.startsWith("rotate-"));
}

/** The angle around `axis` (right-handed, from the next axis) at which a ray crosses the plane through `center`. */
function ringAngle(ray: Ray, axis: Axis, center: Vec3): number | null {
  const p = planePoint(ray, axis, center[axis]);
  if (!p) return null;
  const u = ((axis + 1) % 3) as Axis;
  const v = ((axis + 2) % 3) as Axis;
  return Math.atan2(p[v] - center[v], p[u] - center[u]);
}

function pointAt(ray: Ray, t: number): Vec3 {
  return [ray.origin[0] + ray.dir[0] * t, ray.origin[1] + ray.dir[1] * t, ray.origin[2] + ray.dir[2] * t];
}

/** Where a ray crosses the plane `axis = coord`. */
function planePoint(ray: Ray, axis: Axis, coord: number): Vec3 | null {
  const t = rayPlane(ray, axis, coord);
  return t === null ? null : pointAt(ray, t);
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function cellBox(c: Vec3): Box {
  return { min: c, max: c };
}

function boxOf(a: Vec3, b: Vec3): Box {
  return {
    min: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    max: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  };
}

function boxCells({ min, max }: Box): Vec3[] {
  const cells: Vec3[] = [];
  for (let z = min[2]; z <= max[2]; z++)
    for (let y = min[1]; y <= max[1]; y++) for (let x = min[0]; x <= max[0]; x++) cells.push([x, y, z]);
  return cells;
}

/** Cells along a line from a (exclusive) to b (inclusive), so fast drags leave no gaps. */
function lineCells(a: Vec3, b: Vec3): Vec3[] {
  const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2]));
  const cells: Vec3[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    cells.push([
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ]);
  }
  return cells;
}
