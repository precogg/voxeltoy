// The session's shape layers (docs/vector-raster.md): their steps, the step being placed or
// changed with handles, baking and override layers, and the output resolution.

import { batch, untrack } from "solid-js";
import type { DrawPhase, OperandEdit, PendingShape } from "./editor";
import type { EditorInternals } from "./editor-internals";
import { resampleMask, resampleRaster } from "./evaluate";
import { MAX_SIZE, newGen, newLayerId, type DocOp } from "./ops";
import {
  clipBox,
  defaultForward,
  MAX_PATH_POINTS,
  insideShape,
  presetChange,
  presetEntry,
  SHAPE_KINDS,
  shapeName,
  shapeOrientations,
  turnCorner,
  turnDirection,
  turnVector,
  type Direction,
  type PathPoint,
  type ShapeDraft,
  type ShapeKind,
  type ShapePreset,
} from "./shapes";
import { signal } from "./signal";
import {
  boxStep,
  cellsToSource,
  checkSource,
  checkStepName,
  newStepId,
  findStep,
  isResolution,
  reshape,
  resolutionChoices as choicesFor,
  sameSource,
  snapSource,
  SourceError,
  sourceOutline,
  sourceToCells,
  updateStep,
  type ShapeOptions,
  type ShapeSource,
  type Step,
  type StepFill,
  type StepMode,
  type StepShape,
} from "./source";
import type { Axis, Box, Layer, Preview, Ray, Vec3 } from "./types";

export class EditorShapes {
  private _operandEdit = signal<OperandEdit | null>(null);
  /** The path being drawn, a point per tap, until it is finished. */
  private _drawingPath = signal<{ layerId: string; stepId: string } | null>(null);
  /** The selected path step's point that the inspector shows. */
  private _pathPoint = signal<number | null>(null);
  /** Whether the selected step is being edited in place (its points or setting handles). */
  private _editing = signal(false);
  /** The cell box an "edit" draft started from, so faces nobody dragged keep their exact source coordinates. */
  operandBase: Box | null = null;
  private draftQueued = false;
  private draftMemo: {
    draft: ShapeDraft;
    edit: OperandEdit;
    shape: ShapeSource;
    kind: ShapePreset;
    result: { layerId: string; shape: ShapeSource } | null;
  } | null = null;

  constructor(private readonly s: EditorInternals) {}

  private get ed() {
    return this.s.editor;
  }

  shapeBlocker(layer?: Layer): string | null {
    const readOnly = this.ed.readOnly;
    if (readOnly) return readOnly;
    if (layer?.locked) return "Layer is locked";
    if (layer && !layer.visible) return "Layer is hidden";
    return null;
  }

  resolutionBlocker(): string | null {
    if (this.s.doc.resolutionLocked) return "This editor keeps models at their resolution";
    return this.ed.readOnly;
  }

  get resolutionChoices(): number[] {
    if (this.resolutionBlocker()) return [this.ed.resolution];
    return choicesFor(this.ed.size, this.ed.resolution, MAX_SIZE);
  }

  resolutionLoses(resolution: number): boolean {
    const old = untrack(() => this.ed.resolution);
    if (resolution >= old) return false;
    const size = untrack(() => this.ed.size);
    return untrack(() => this.ed.layers).some((l) => !l.shape && resampleRaster(l.data, l.coverage, size, resolution / old).lossy);
  }

  setResolution(resolution: number): boolean {
    const old = untrack(() => this.ed.resolution);
    if (resolution === old) return false;
    if (this.s.refuse(untrack(() => this.resolutionBlocker()))) return false;
    if (!untrack(() => this.resolutionChoices).includes(resolution)) {
      const size = untrack(() => this.ed.size).map((n) => (n * resolution) / old);
      this.ed.notify(
        isResolution(resolution) && size.every(Number.isInteger)
          ? `At ${resolution}× the model would be ${size.join(" × ")} cells; the most is ${MAX_SIZE} a side`
          : "Resolution is 1, 2, 4 or 8 cells per unit",
      );
      return false;
    }
    this.s.settlePending("commit", { shape: "cancel" });
    const selection = this.s.selection;
    const next = resampleMask(selection, untrack(() => this.ed.size), resolution / old);
    const label = `Resolution ${resolution}×`;
    return this.ed.transact(label, () => {
      // undo brings the selection back once the grid it fits is back; redo brings the resampled one
      this.s.local(label, { undo: () => this.s.setSelectionState(selection), redo: () => {} });
      if (!this.s.apply(label, { t: "resolution", from: old, to: resolution, fromGen: this.s.doc.gen, toGen: newGen() })) return false;
      this.s.setSelectionState(next);
      this.s.local(label, { undo: () => {}, redo: () => this.s.setSelectionState(next) });
      return true;
    });
  }

  shapeStack(layerId = this.ed.activeLayerId): readonly Step[] | null {
    return this.ed.layer(layerId)?.shape?.steps ?? null;
  }

  get operandEdit(): OperandEdit | null {
    return this._operandEdit.get();
  }

  get selectedStep(): { layerId: string; step: Step; index: number } | null {
    const edit = this.operandEdit;
    if (edit?.mode !== "edit" || !edit.stepId) return null;
    const steps = this.shapeStack(edit.layerId);
    const index = steps?.findIndex((s) => s.id === edit.stepId) ?? -1;
    if (!steps || index < 0) return null;
    return { layerId: edit.layerId, step: steps[index], index };
  }

  addBoxLayer(box: { min: Vec3; max: Vec3 }, material = this.ed.color, name?: string): string | null {
    if (this.s.refuse(this.shapeBlocker())) return null;
    let shape: ShapeSource;
    try {
      shape = checkSource({ steps: [boxStep(box.min.map(snapSource) as Vec3, box.max.map(snapSource) as Vec3, material)] }, this.ed.palette.length);
    } catch (e) {
      if (!(e instanceof SourceError)) throw e;
      this.ed.notify(e.message);
      return null;
    }
    this.s.settle();
    this.endOperandEdit();
    const id = newLayerId();
    const index = this.ed.layers.findIndex((l) => l.id === this.ed.activeLayerId) + 1;
    if (!this.s.apply("New vector layer", { t: "layer.add", index, layer: { id, name: name ?? this.nextShapeName(), shape } })) return null;
    this.s.activeLayerId.set(id);
    return id;
  }

  newShapeLayer(): string | null {
    if (this.s.refuse(this.shapeBlocker())) return null;
    this.s.settle();
    this.endOperandEdit();
    const id = newLayerId();
    const index = this.ed.layers.findIndex((l) => l.id === this.ed.activeLayerId) + 1;
    if (!this.s.apply("New vector layer", { t: "layer.add", index, layer: { id, name: this.nextShapeName(), shape: { steps: [] } } })) return null;
    this.s.activeLayerId.set(id);
    // an empty layer is for drawing on
    this.ed.setShapeTool(this.ed.shapeKind === "path" ? "box" : this.ed.shapePreset);
    return id;
  }

  startStep(mode: StepMode, draft: ShapeDraft, drawing?: DrawPhase): boolean {
    const layer = this.ed.activeLayer;
    if (!layer?.shape) {
      this.ed.notify("Select a vector layer to add to");
      return false;
    }
    if (this.s.refuse(this.shapeBlocker(layer))) return false;
    this.beginOperandEdit({ mode: "step", layerId: layer.id, stepId: null, step: mode, ...(drawing ? { drawing } : {}) });
    this.ed.setPendingShape(draft);
    return true;
  }

  setDrawPhase(phase: DrawPhase) {
    const edit = untrack(() => this._operandEdit.get());
    if (edit?.drawing && edit.drawing !== phase) this._operandEdit.set({ ...edit, drawing: phase });
  }

  addStep(
    layerId: string,
    mode: StepMode,
    box: { min: Vec3; max: Vec3 },
    material = this.ed.color,
    options: ShapeOptions & { keep?: boolean; kind?: ShapeKind | ShapePreset } = {},
  ): string | null {
    const layer = this.ed.layer(layerId);
    if (!layer?.shape) {
      this.ed.notify("Select a vector layer to add to");
      return null;
    }
    const keep = options.keep ?? mode === "intersect";
    // a preset's settings, then what was asked for on top
    const { kind: name, ...rest } = options;
    const resolved = name !== undefined && SHAPE_KINDS.includes(name as ShapeKind) ? { kind: name as ShapeKind } : presetChange(name ?? "box");
    const step = boxStep(box.min.map(snapSource) as Vec3, box.max.map(snapSource) as Vec3, material, mode, { ...resolved, ...rest, keep });
    const label = `${{ add: "Add", cut: "Cut", intersect: "Intersect", paint: "Paint" }[mode]} ${shapeName(step.shape.kind, step.shape).toLowerCase()}`;
    return this.changeShape(label, layer, { steps: [...layer.shape.steps, step] }) ? step.id : null;
  }

  setStepMode(layerId: string, stepId: string, mode: StepMode): boolean {
    return this.changeStep("Change step", layerId, stepId, (s) => (s.mode === mode ? s : { ...s, mode }));
  }

  setStepKeep(layerId: string, stepId: string, keep: boolean): boolean {
    return this.changeStep(keep ? "Keep colors" : "Paint over", layerId, stepId, (s) => {
      if (!s.keep === !keep) return s;
      const { keep: _, ...rest } = s;
      return keep ? { ...rest, keep: true } : rest;
    });
  }

  moveStep(layerId: string, stepId: string, index: number): boolean {
    const layer = this.ed.layer(layerId);
    const steps = layer?.shape?.steps;
    const from = steps ? steps.findIndex((s) => s.id === stepId) : -1;
    if (!layer || !steps || from < 0) return false;
    const to = Math.max(0, Math.min(steps.length - 1, Math.round(index)));
    if (to === from) return true;
    const next = [...steps];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return this.changeShape("Reorder steps", layer, { steps: next });
  }

  setStepName(layerId: string, stepId: string, name: string): boolean {
    let next: string | undefined;
    try {
      next = checkStepName(name);
    } catch (e) {
      if (!(e instanceof SourceError)) throw e;
      this.ed.notify(e.message);
      return false;
    }
    return this.changeStep("Rename step", layerId, stepId, (s) => {
      if (s.name === next) return s;
      const { name: _, ...rest } = s;
      return next ? { ...rest, name: next } : rest;
    });
  }

  duplicateStep(layerId: string, stepId: string): string | null {
    const layer = this.ed.layer(layerId);
    const steps = layer?.shape?.steps;
    const index = steps ? steps.findIndex((s) => s.id === stepId) : -1;
    if (!layer || !steps || index < 0) return null;
    const copy = { ...steps[index], id: newStepId() };
    const next = [...steps];
    next.splice(index + 1, 0, copy);
    if (!this.changeShape("Duplicate step", layer, { steps: next })) return null;
    this.selectStep(copy.id, layerId);
    return copy.id;
  }

  removeStep(layerId: string, stepId: string): boolean {
    const layer = this.ed.layer(layerId);
    const steps = layer?.shape?.steps;
    if (!layer || !steps || !steps.some((s) => s.id === stepId)) return false;
    const ok = this.changeShape("Remove step", layer, { steps: steps.filter((s) => s.id !== stepId) });
    this.syncOperand();
    return ok;
  }

  selectStep(stepId: string | null, layerId = this.ed.activeLayerId): boolean {
    if (!stepId) {
      this.endOperandEdit();
      return true;
    }
    const layer = this.ed.layer(layerId);
    if (!layer?.shape || !findStep(layer.shape, stepId)) return false;
    if (layerId !== this.ed.activeLayerId) this.ed.selectLayer(layerId);
    // another step: whatever path was being drawn is finished, its point let go, and editing in place left
    if (untrack(() => this._drawingPath.get())?.stepId !== stepId) this._drawingPath.set(null);
    if (untrack(() => this.selectedStep)?.step.id !== stepId) {
      this._pathPoint.set(null);
      this._editing.set(false);
    }
    this.beginOperandEdit({ mode: "edit", layerId, stepId });
    this.syncOperand();
    return true;
  }

  pickStep(ray: Ray): Step | null {
    const layer = this.ed.activeLayer;
    const steps = layer?.shape?.steps;
    const hit = steps && this.ed.pickVisible(ray);
    if (!layer || !steps || !hit) return null;
    if (!this.ed.layerValues(layer)[this.ed.index(...hit.cell)]) return null;
    const m = this.ed.resolution;
    const center = hit.cell.map((n) => (n + 0.5) / m) as Vec3;
    const holds = (s: Step) => {
      const cells = sourceToCells(s.shape, m);
      if (!hit.cell.every((n, a) => n >= cells.min[a] && n <= cells.max[a])) return false;
      return insideShape(s.shape)(center);
    };
    const top = (modes: StepMode[]) => [...steps].reverse().find((s) => modes.includes(s.mode) && holds(s)) ?? null;
    return top(["add", "paint"]) ?? top(["intersect"]);
  }

  get drawingPath(): { layerId: string; stepId: string } | null {
    return this._drawingPath.get();
  }

  get editingShape(): { layerId: string; stepId: string } | null {
    if (!this._editing.get()) return null;
    const s = this.selectedStep;
    return s ? { layerId: s.layerId, stepId: s.step.id } : null;
  }

  editShape(stepId?: string, layerId = this.ed.activeLayerId): boolean {
    if (stepId && !this.selectStep(stepId, layerId)) return false;
    if (!untrack(() => this.selectedStep)) return false;
    batch(() => {
      this._drawingPath.set(null);
      this._editing.set(true);
    });
    return true;
  }

  stopEditingShape() {
    batch(() => {
      this._editing.set(false);
      this._pathPoint.set(null);
    });
  }

  /**
   * The cells of the shape being edited in place, at the values the model shows there (zero
   * elsewhere): what stays bright while everything else dims. Null when nothing is edited, or for a
   * cut, which is empty space.
   */
  editingVolume(): Uint8Array | null {
    const edit = this.editingShape;
    const selected = edit && this.selectedStep;
    if (!selected || selected.step.mode === "cut") return null;
    const { shape } = selected.step;
    const m = this.ed.resolution;
    const size = this.ed.size;
    const composite = this.ed.composite;
    const box = clipBox(sourceToCells(shape, m), size);
    const inside = insideShape(shape);
    const out = new Uint8Array(composite.length);
    for (let z = box.min[2]; z <= box.max[2]; z++)
      for (let y = box.min[1]; y <= box.max[1]; y++)
        for (let x = box.min[0]; x <= box.max[0]; x++) {
          const i = x + size[0] * (y + size[1] * z);
          if (composite[i] && inside([(x + 0.5) / m, (y + 0.5) / m, (z + 0.5) / m])) out[i] = composite[i];
        }
    return out;
  }

  get selectedPathPoint(): number | null {
    const index = this._pathPoint.get();
    const points = this.selectedStep?.step.shape.points;
    return index !== null && points && index < points.length ? index : null;
  }

  selectPathPoint(index: number | null) {
    this._pathPoint.set(index);
  }

  /** Stop adding points to the path being drawn; it stays selected, and the Pen gives way to Select. */
  finishPath() {
    const drawing = untrack(() => this._drawingPath.get());
    this._drawingPath.set(null);
    if (!drawing || untrack(() => this.ed.tool) !== "pen") return;
    this.ed.setTool("select");
    this.selectStep(drawing.stepId, drawing.layerId);
  }

  /** Esc while drawing a path: a path of one point is dropped (its tap undone); a longer one is finished. */
  cancelPath() {
    const drawing = untrack(() => this._drawingPath.get());
    if (!drawing) return;
    const step = this.shapeStack(drawing.layerId)?.find((s) => s.id === drawing.stepId);
    if ((step?.shape.points?.length ?? 0) > 1) return this.finishPath();
    this._drawingPath.set(null);
    // its one tap made it: take that back, or failing that remove it
    if (untrack(() => this.ed.history.undoLabel) === "Add point") this.ed.undo();
    else if (step) this.removeStep(drawing.layerId, step.id);
  }

  /**
   * Start a path on the active shape layer at `at` (source units): a new step of the shape the
   * tools draw (a tube, wall or slab), with one point, selected and taking a point per tap
   * (`addPathPoint`) until `finishPath`.
   */
  startPath(mode: StepMode, at: Vec3): string | null {
    const layer = this.ed.activeLayer;
    if (!layer?.shape) {
      this.ed.notify("Select a vector layer to add to");
      return null;
    }
    const point = at.map(snapSource) as Vec3;
    const params = { ...presetEntry(this.ed.penProfile).params, ...(this.ed.penSmooth ? { smooth: true } : {}) };
    const id = this.addStep(layer.id, mode, { min: point, max: point }, this.ed.color, { ...params, kind: "path", points: [{ at: point }] });
    if (!id) return null;
    this.selectStep(id, layer.id);
    batch(() => {
      this._drawingPath.set({ layerId: layer.id, stepId: id });
      this._pathPoint.set(0);
    });
    return id;
  }

  private changePoints(label: string, layerId: string, stepId: string, change: (points: PathPoint[]) => PathPoint[] | null): boolean {
    const step = this.shapeStack(layerId)?.find((s) => s.id === stepId);
    if (step?.shape.kind !== "path") {
      this.ed.notify("That isn't a path");
      return false;
    }
    const points = change([...(step.shape.points ?? [])]);
    if (!points) return false;
    return this.changeStep(label, layerId, stepId, (s) => ({ ...s, shape: reshape(s.shape, { points }) }));
  }

  addPathPoint(layerId: string, stepId: string, at: Vec3, index?: number): boolean {
    let placed = -1;
    const ok = this.changePoints("Add point", layerId, stepId, (points) => {
      if (points.length >= MAX_PATH_POINTS) {
        this.ed.notify(`A path has at most ${MAX_PATH_POINTS} points`);
        return null;
      }
      placed = index === undefined ? points.length : Math.max(0, Math.min(points.length, Math.round(index)));
      points.splice(placed, 0, { at: at.map(snapSource) as Vec3 });
      return points;
    });
    if (ok) this._pathPoint.set(placed);
    return ok;
  }

  movePathPoint(layerId: string, stepId: string, index: number, at: Vec3): boolean {
    return this.changePoints("Move point", layerId, stepId, (points) => {
      if (!points[index]) return null;
      points[index] = { ...points[index], at: at.map(snapSource) as Vec3 };
      return points;
    });
  }

  setPathPointRadius(layerId: string, stepId: string, index: number, radius: number | null): boolean {
    return this.changePoints("Change point", layerId, stepId, (points) => {
      if (!points[index]) return null;
      const { radius: _, ...rest } = points[index];
      points[index] = radius ? { ...rest, radius: snapSource(radius) || 1 / 8 } : rest;
      return points;
    });
  }

  removePathPoint(layerId: string, stepId: string, index: number): boolean {
    const step = this.shapeStack(layerId)?.find((s) => s.id === stepId);
    const ok = this.changePoints("Delete point", layerId, stepId, (points) => {
      if (!points[index]) return null;
      const least = step?.shape.profile === "slab" ? 3 : 1;
      if (points.length <= least) {
        this.ed.notify(least === 1 ? "A path keeps at least one point; delete the shape instead" : "A slab keeps at least three points");
        return null;
      }
      points.splice(index, 1);
      return points;
    });
    if (ok) this._pathPoint.set(null);
    return ok;
  }

  endOperandEdit() {
    batch(() => {
      this._drawingPath.set(null);
      this._pathPoint.set(null);
      this._editing.set(false);
    });
    if (!untrack(() => this._operandEdit.get())) return;
    this.ed.tools.cancel();
    this.operandBase = null;
    batch(() => {
      this._operandEdit.set(null);
      this.s.shapeDraft.set(null);
      this.s.preview.set(null);
    });
    this.queueDraft();
  }

  beginOperandEdit(edit: OperandEdit) {
    this.s.settle();
    this.ed.tools.cancel();
    this.ed.stopMarkerEdit();
    this.operandBase = null;
    batch(() => {
      this.s.shapeDraft.set(null);
      this._operandEdit.set(edit);
    });
  }

  setStepBox(layerId: string, stepId: string, box: { min: Vec3; max: Vec3 }): boolean {
    const layer = this.ed.layer(layerId);
    if (!layer?.shape || !findStep(layer.shape, stepId)) {
      this.ed.notify("That step was deleted");
      return false;
    }
    const min = box.min.map(snapSource) as Vec3;
    const max = box.max.map(snapSource) as Vec3;
    if (max.some((n, a) => n <= min[a])) {
      this.ed.notify("A box must have some size on every axis");
      return false;
    }
    return this.changeStep("Change box", layerId, stepId, (s) => ({ ...s, shape: reshape(s.shape, { min, max }) }));
  }

  setStepMaterial(layerId: string, stepId: string, material = this.ed.color): boolean {
    return this.changeStep("Recolor step", layerId, stepId, (s) => (s.material === material ? s : { ...s, material }));
  }

  setStepFill(layerId: string, stepId: string, fill: StepFill | null): boolean {
    const step = this.shapeStack(layerId)?.find((s) => s.id === stepId);
    if (!step) return false;
    let next: Step;
    try {
      const { fill: _, ...rest } = step;
      next = checkSource({ steps: [fill ? { ...rest, fill } : rest] }, this.ed.palette.length).steps[0];
    } catch (e) {
      if (!(e instanceof SourceError)) throw e;
      this.ed.notify(e.message);
      return false;
    }
    return this.changeStep(fill ? "Change fill" : "One color", layerId, stepId, () => next);
  }

  setStepShape(layerId: string, stepId: string, request: ShapeOptions & { kind?: ShapeKind | ShapePreset }): boolean {
    const step = this.shapeStack(layerId)?.find((s) => s.id === stepId);
    if (!step) return false;
    // a preset brings the settings that make it one (a cylinder has no sides); a kind is just that kind
    const { kind: name, ...rest } = request;
    const change: ShapeOptions & { kind?: ShapeKind } =
      name === undefined || SHAPE_KINDS.includes(name as ShapeKind)
        ? { ...rest, ...(name ? { kind: name as ShapeKind } : {}) }
        : { ...presetChange(name), ...rest };
    let shape: StepShape;
    try {
      shape = checkSource({ steps: [{ ...step, shape: reshape(step.shape, change) }] }, Infinity).steps[0].shape;
    } catch (e) {
      if (!(e instanceof SourceError)) throw e;
      this.ed.notify(e.message);
      return false;
    }
    return this.changeStep("Change shape", layerId, stepId, (s) => ({ ...s, shape }));
  }

  turnStep(layerId: string, stepId: string): boolean {
    const step = this.shapeStack(layerId)?.find((s) => s.id === stepId);
    if (!step?.shape.forward || !step.shape.up) return false;
    const { up, forward } = step.shape;
    const around = ([0, 1, 2] as Axis[]).filter((a) => a !== up.axis).flatMap((axis) => [1, -1].map((sign) => ({ axis, sign }) as Direction));
    // a quarter turn each time: +u, +v, -u, -v
    const order = [around[0], around[2], around[1], around[3]];
    const i = order.findIndex((d) => d.axis === forward.axis && d.sign === forward.sign);
    return this.changeStep("Turn shape", layerId, stepId, (s) => ({ ...s, shape: reshape(s.shape, { forward: order[(i + 1) % 4] }) }));
  }

  rotateStep(layerId: string, stepId: string): boolean {
    const step = this.shapeStack(layerId)?.find((s) => s.id === stepId);
    if (step?.shape.kind === "limb") {
      // a limb keeps its box and grows from the next corner: around the bottom, then the top
      const order = [0, 1, 5, 4, 2, 3, 7, 6];
      const next = order[(order.indexOf(step.shape.corner ?? 0) + 1) % 8];
      return this.changeStep("Rotate shape", layerId, stepId, (s) => ({ ...s, shape: reshape(s.shape, { corner: next || 0 }) }));
    }
    const turns = step ? shapeOrientations(step.shape.kind) : [];
    if (!step || !turns.length) return false;
    const from = step.shape.up ?? { axis: 1, sign: 1 };
    const i = turns.findIndex((d) => d.axis === from.axis && d.sign === from.sign);
    return this.pointStep(layerId, stepId, turns[(i + 1) % turns.length]);
  }

  rotateStepAbout(layerId: string, stepId: string, axis: Axis, turns: number): boolean {
    const step = this.shapeStack(layerId)?.find((s) => s.id === stepId);
    if (!step) return false;
    const q = ((turns % 4) + 4) % 4;
    if (q === 0) return true;
    const { shape } = step;
    if (shape.kind === "path") {
      // the points turn about the box's middle, back onto the lattice
      const center = shape.min.map((n, a) => (n + shape.max[a]) / 2) as Vec3;
      const points = (shape.points ?? []).map((p) => ({
        ...p,
        at: turnVector(p.at.map((n, a) => n - center[a]) as Vec3, axis, q).map((n, a) => snapSource(n + center[a])) as Vec3,
      }));
      return this.changeStep("Turn shape", layerId, stepId, (s) => ({ ...s, shape: reshape(s.shape, { points }) }));
    }
    const min = [...shape.min] as Vec3;
    const max = [...shape.max] as Vec3;
    if (q % 2) {
      // the extents across the axis swap around the box's middle, on the lattice
      const u = ((axis + 1) % 3) as Axis;
      const w = ((axis + 2) % 3) as Axis;
      for (const [a, b] of [[u, w], [w, u]] as const) {
        const center = (shape.min[a] + shape.max[a]) / 2;
        min[a] = snapSource(center - (shape.max[b] - shape.min[b]) / 2);
        max[a] = min[a] + (shape.max[b] - shape.min[b]);
      }
    }
    const change: { -readonly [K in keyof ShapeOptions]: ShapeOptions[K] } & { min: Vec3; max: Vec3 } = { min, max };
    const turns3 = shapeOrientations(shape.kind);
    if (shape.up || turns3.length) {
      let up = turnDirection(shape.up ?? { axis: 1, sign: 1 }, axis, q);
      // shapes that point along an axis either way keep pointing its + way
      if (turns3.length && turns3.every((d) => d.sign > 0)) up = { axis: up.axis, sign: 1 };
      change.up = up;
    }
    // where a slope, a sweep or a polygon's flat side faces turns too
    if (shape.forward || turns3.length) change.forward = turnDirection(shape.forward ?? defaultForward(shape.up ?? { axis: 1, sign: 1 }), axis, q);
    if (shape.kind === "limb") change.corner = turnCorner(shape.corner ?? 0, axis, q);
    return this.changeStep("Turn shape", layerId, stepId, (s) => ({ ...s, shape: reshape(s.shape, change) }));
  }

  pointStep(layerId: string, stepId: string, up: Direction): boolean {
    const step = this.shapeStack(layerId)?.find((s) => s.id === stepId);
    if (!step) return false;
    const turns = shapeOrientations(step.shape.kind);
    // shapes that point both ways along an axis take its + direction
    const axisOnly = turns.length > 0 && turns.every((d) => d.sign > 0);
    if (axisOnly) up = { axis: up.axis, sign: 1 };
    if (!turns.some((d) => d.axis === up.axis && d.sign === up.sign)) {
      this.ed.notify(turns.length ? "That shape can't point that way" : "That shape looks the same every way");
      return false;
    }
    const { shape } = step;
    const from = shape.up ?? { axis: 1, sign: 1 };
    if (from.axis === up.axis && from.sign === up.sign) return true;
    const min = [...shape.min] as Vec3;
    const max = [...shape.max] as Vec3;
    if (up.axis !== from.axis) {
      // swap the two extents around the box's center, on the lattice
      for (const [a, b] of [[from.axis, up.axis], [up.axis, from.axis]] as const) {
        const center = (shape.min[a] + shape.max[a]) / 2;
        const half = (shape.max[b] - shape.min[b]) / 2;
        min[a] = snapSource(center - half);
        max[a] = min[a] + (shape.max[b] - shape.min[b]);
      }
    }
    return this.changeStep("Rotate shape", layerId, stepId, (s) => ({ ...s, shape: reshape(shape, { min, max, up }) }));
  }

  changeStep(label: string, layerId: string, stepId: string, change: (step: Step) => Step): boolean {
    const layer = this.ed.layer(layerId);
    if (!layer?.shape || !findStep(layer.shape, stepId)) return false;
    return this.changeShape(label, layer, updateStep(layer.shape, stepId, change));
  }

  changeShape(label: string, layer: Layer, shape: ShapeSource): boolean {
    if (this.s.refuse(this.shapeBlocker(layer))) return false;
    if (layer.shape && sameSource(layer.shape, shape)) return true;
    try {
      shape = checkSource(shape, this.ed.palette.length);
    } catch (e) {
      if (!(e instanceof SourceError)) throw e;
      this.ed.notify(e.message);
      return false;
    }
    return this.s.apply(label, { t: "layer.shape", id: layer.id, after: shape });
  }

  bakeShapeLayer(layerId = this.ed.activeLayerId): boolean {
    const layer = this.ed.layer(layerId);
    if (!layer?.shape) return false;
    if (this.s.refuse(this.shapeBlocker(layer))) return false;
    this.s.settle();
    this.endOperandEdit();
    const data = this.ed.layerValues(layer).slice();
    const index = this.ed.layers.indexOf(layer);
    const active = this.ed.activeLayerId;
    const keepActive = () => this.s.activeLayerId.set(active);
    const label = "Bake to voxels";
    return this.ed.transact(label, () => {
      // removing the layer moves the active layer away; put it back after undo and redo
      this.s.local(label, { undo: keepActive, redo: () => {} });
      const remove: DocOp = { t: "layer.remove", id: layer.id };
      if (!this.s.apply(label, remove)) return false;
      const ok = this.s.apply(label, {
        t: "layer.add",
        index,
        layer: {
          id: layer.id,
          name: layer.name,
          data,
          coverage: data.map((v) => (v ? 1 : 0)),
          visible: layer.visible,
          locked: layer.locked,
          ...(layer.hostData !== undefined ? { hostData: layer.hostData } : {}),
          ...(layer.extra ? { extra: { ...layer.extra } } : {}),
        },
      });
      keepActive();
      this.s.local(label, { undo: () => {}, redo: keepActive });
      return ok;
    });
  }

  convertToOverride(layerId = this.ed.activeLayerId): boolean {
    const layer = this.ed.layer(layerId);
    if (!layer || layer.shape || layer.coverage) return false;
    if (this.s.refuse(this.shapeBlocker())) return false;
    return this.s.apply("Convert to override layer", { t: "layer.coverage", id: layer.id, after: layer.data.map((v) => (v ? 1 : 0)) });
  }

  /** Commit the pending box: add the new step, or record the drag. */
  commitOperand(): boolean {
    const edit = untrack(() => this._operandEdit.get());
    const draft = untrack(() => this.s.shapeDraft.get());
    if (!edit || !draft) return false;
    if (edit.mode === "step") {
      const id = this.addStep(edit.layerId, edit.step ?? "add", cellsToSource(draft.box, this.ed.resolution), this.ed.color, {
        ...this.ed.shapeParams,
        kind: this.ed.shapeKind,
        up: draft.up,
        ...(draft.forward ? { forward: draft.forward } : {}),
      });
      if (!id) return false;
      // drawn with the shape tool: you are holding it, with Select
      if (edit.drawing) this.ed.setTool("select");
      this.selectStep(id, edit.layerId);
      return true;
    }
    const layer = this.ed.layer(edit.layerId);
    const step = layer?.shape && edit.stepId ? findStep(layer.shape, edit.stepId) : null;
    if (!layer || !step) {
      this.endOperandEdit();
      return false;
    }
    const ok = this.setStepBox(layer.id, step.id, this.draftSource(draft.box, step.shape));
    this.syncOperand();
    return ok;
  }

  /** The source box a draft describes. Faces still where an "edit" draft started keep their exact source coordinates. */
  draftSource(box: Box, shape: StepShape | null): { min: Vec3; max: Vec3 } {
    const src = cellsToSource(box, untrack(() => this.ed.resolution));
    const base = this.operandBase;
    if (shape && base) {
      for (let a = 0; a < 3; a++) {
        if (box.min[a] === base.min[a]) src.min[a] = shape.min[a];
        if (box.max[a] === base.max[a]) src.max[a] = shape.max[a];
      }
    }
    return src;
  }

  /** The cells a box samples, clipped to the grid and at least one cell on each axis, for a draft. */
  draftCells(shape: StepShape): Box {
    const cells = clipBox(sourceToCells(shape, untrack(() => this.ed.resolution)), untrack(() => this.ed.size));
    for (let a = 0; a < 3; a++) if (cells.max[a] < cells.min[a]) cells.max[a] = cells.min[a];
    return cells;
  }

  /** Bring an "edit" draft back in line with its step after the document changed (an undo, a drag committed). */
  syncOperand() {
    const edit = untrack(() => this._operandEdit.get());
    if (!edit) return;
    const layer = untrack(() => this.ed.layer(edit.layerId));
    if (!layer?.shape) {
      this.endOperandEdit();
      return;
    }
    if (edit.mode !== "edit") return;
    const step = edit.stepId ? findStep(layer.shape, edit.stepId) : null;
    if (!step) {
      this.endOperandEdit();
      return;
    }
    const box = this.draftCells(step.shape);
    this.operandBase = box;
    const forward = step.shape.forward;
    this.s.shapeDraft.set({ box, up: step.shape.up ?? { axis: 1, sign: 1 }, grow: { axis: 1, sign: 1 }, ...(forward ? { forward } : {}) });
    this.s.refreshShape();
    this.queueDraft();
  }

  /** The shape source a draft shows in place of its layer's own: a step being changed, or one being placed. */
  draftShape(): { layerId: string; shape: ShapeSource } | null {
    const edit = untrack(() => this._operandEdit.get());
    const draft = untrack(() => this.s.shapeDraft.get());
    if (!edit || !draft) return null;
    const layer = untrack(() => this.ed.layer(edit.layerId));
    if (!layer?.shape) return null;
    const memo = this.draftMemo;
    const kind = untrack(() => this.ed.shapePreset);
    if (memo && memo.draft === draft && memo.edit === edit && memo.shape === layer.shape && memo.kind === kind) return memo.result;
    let result: { layerId: string; shape: ShapeSource } | null = null;
    const src = (shape: StepShape | null) => this.draftSource(draft.box, shape);
    if (edit.mode === "edit") {
      const step = edit.stepId ? findStep(layer.shape, edit.stepId) : null;
      if (step) {
        const { min, max } = src(step.shape);
        const next = updateStep(layer.shape, step.id, (s) => ({ ...s, shape: reshape(s.shape, { min, max }) }));
        result = sameSource(next, layer.shape) ? null : { layerId: layer.id, shape: next };
      }
    } else {
      const { min, max } = src(null);
      const mode = edit.step ?? "add";
      const step = boxStep(min, max, untrack(() => this.ed.color), mode, {
        id: "draft:step",
        keep: mode === "intersect",
        ...untrack(() => this.ed.shapeParams),
        kind: untrack(() => this.ed.shapeKind),
        up: draft.up,
        ...(draft.forward ? { forward: draft.forward } : {}),
      });
      result = { layerId: layer.id, shape: { steps: [...layer.shape.steps, step] } };
    }
    this.draftMemo = { draft, edit, shape: layer.shape, kind, result };
    return result;
  }

  /** What a step being placed or changed looks like: its exact outline. Its effect shows live in the model. */
  operandPreview(shape: PendingShape): Preview {
    const m = untrack(() => this.ed.resolution);
    const edit = untrack(() => this._operandEdit.get());
    const layer = edit ? untrack(() => this.ed.layer(edit.layerId)) : null;
    const step = layer?.shape && edit?.mode === "edit" && edit.stepId ? findStep(layer.shape, edit.stepId) : null;
    const outline = sourceOutline(this.draftSource(shape.box, step?.shape ?? null), m);
    const mode = edit?.step ?? step?.mode;
    return { kind: mode === "cut" ? "erase" : mode === "paint" ? "paint" : "add", boxes: [], outlines: [outline] };
  }

  /** Re-show the composite with the current draft, at most once per microtask. */
  queueDraft() {
    if (this.draftQueued) return;
    this.draftQueued = true;
    queueMicrotask(() => {
      this.draftQueued = false;
      this.s.rebuildComposite();
    });
  }

  nextShapeName() {
    let n = this.ed.layers.filter((l) => l.shape).length + 1;
    const names = new Set(this.ed.layers.map((l) => l.name));
    while (names.has(`Vector ${n}`)) n++;
    return `Vector ${n}`;
  }

  /** Stop placing or changing a step, without the cleanup `endOperandEdit` does (a new document, a pending shape cleared). */
  clearEdit() {
    this._operandEdit.set(null);
  }
}
