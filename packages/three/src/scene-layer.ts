// A scene's instances in a Viewport: their meshes (one geometry per model, shared by every
// instance of it), the ground, selection outlines and a gizmo, and the pointer gestures that pick,
// drag and turn them. See docs/scenes.md.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  TorusGeometry,
  Vector2,
} from "three";
import { createEffect, createRoot, untrack } from "solid-js";
import type { VoxelDocument } from "@voxeltoy/core/document";
import { raycastVolume } from "@voxeltoy/core/raycast";
import type { LibraryEditor } from "@voxeltoy/core/library";
import { IDENTITY_QUAT, decomposeMat, invertMat, matFromTransform, multiplyQuat, quatFromEuler, quatUpTo, transformDirection, transformPoint, type Mat4, type Quat } from "@voxeltoy/core/scene-math";

import type { Box, PointerInput, Ray, Vec3 } from "@voxeltoy/core/types";
import { FieldHandles } from "./field-handles";
import { Mesher } from "./mesher";

import type { PointerLayer, Viewport, ViewportTheme } from "./viewport";

const AXIS_COLORS = ["#e5484d", "#30a46c", "#3e7cf7"];
/** The gizmo, in CSS pixels, as the model editor's. */
const GIZMO = { arrowFrom: 22, arrowTo: 78, head: 16, headRadius: 6, shaft: 1.75, ring: 56, tube: 1.75 };
const TAP_SLOP = 6;
const TOUCH_REACH = 24;
const MOUSE_REACH = 10;
/** Two taps on one instance this close together open it. */
const DOUBLE_TAP_MS = 350;

type Handle = `move-${0 | 1 | 2}` | "rotate-1";

type Drag =
  | { kind: "field" }
  | {
      kind: "move";
      start: Vec3;
      height: number;
      starts: Map<string, Vec3>;
      moved: boolean;
      x: number;
      y: number;
      /** The instance grabbed, where its origin was, and the grab point's offset from it. */
      primary: string;
      origin: Vec3;
      grab: Vec3;
      /** The dragged instances and what hangs from them: not surfaces to land on. */
      exclude: Set<string>;
    }
  | { kind: "axis"; axis: 0 | 1 | 2; origin: Vec3; t0: number; starts: Map<string, Vec3>; moved: boolean }
  | { kind: "rotate"; center: Vec3; a0: number; starts: Map<string, Quat>; moved: boolean };

export interface SceneLayerOptions {
  /** Two taps on an instance: open its model, for example. */
  onOpen?: (instance: string) => void;
  /**
   * Draw the scene as context around a model edited in place: dimmed, never picked, without
   * the instance being edited (its editor draws it).
   */
  context?: boolean;
  /**
   * Around a model being edited, only the selected instances' gizmo and handles take pointers:
   * touches elsewhere go to the model's tools, and instances are chosen from the scene tree.
   */
  handlesOnly?: boolean;
  /**
   * With `handlesOnly`: whether a touch on an instance picks and drags it after all, as on a
   * scene of its own. Around a stage, the model editor's view tool does: one finger on an
   * object selects it, anywhere else orbits, and the voxel tools still go through objects.
   */
  pickWhen?: () => boolean;
}

export class SceneLayer implements PointerLayer {
  readonly group = new Group();
  /**
   * For hosts: draw into the scene, in world units (a preview of grown trees over their blocks).
   * Call `viewport.requestRender()` after changing it.
   */
  readonly overlay = new Group();
  /** Handles from the selected instance's fields. */
  readonly fields: FieldHandles;
  private ghostMaterial = new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.3, depthWrite: false });
  private mesher = new Mesher();
  private instanceGroup = new Group();
  private groundGroup = new Group();
  private outlineGroup = new Group();
  private gizmoGroup = new Group();
  private gizmoParts = new Map<Handle, Group>();
  /** One geometry per model and frame, rebuilt when its voxels change. Keyed `model|frame`. */
  private geometries = new Map<string, { geometry: BufferGeometry; source: object; palette: readonly number[]; version: number }>();
  /** Each drawn instance's mesh and the frame it shows, so the clock only swaps what changed. */
  private meshes = new Map<string, { mesh: Mesh; frame: string | null }>();
  /** What placed scenes draw: per placing instance, a mesh per model they hold, in `placedContents` order. */
  private placed = new Map<string, { mesh: Mesh; frame: string }[]>();
  /** The scene's clock: when it started, in `performance.now()` milliseconds. */
  private clockStart = performance.now();
  private clockFrame = 0;
  private material = new MeshBasicMaterial({ vertexColors: true });
  /** World units to the view's: the scene sits around the active model's grid. */
  private toView: Mat4 = matFromTransform([0, 0, 0], IDENTITY_QUAT, 1);
  private toWorld: Mat4 = matFromTransform([0, 0, 0], IDENTITY_QUAT, 1);
  private theme: ViewportTheme;
  private drag: Drag | null = null;
  private hoverHandle: Handle | null = null;
  private lastTap: { id: string; at: number } | null = null;
  private disposeRoot: () => void = () => {};
  private stopRender: () => void;

  constructor(
    readonly viewport: Viewport,
    readonly scene: LibraryEditor,
    theme: () => ViewportTheme,
    private options: SceneLayerOptions = {},
  ) {
    this.theme = untrack(theme);
    this.fields = new FieldHandles({
      scene,
      screenOf: (p) => this.screenOf(p),
      requestRender: () => viewport.requestRender(),
      accent: () => this.theme.accent,
      ghost: (id, matrix) => {
        const model = untrack(() => scene.modelFor(id));
        const geometry = model ? this.geometryFor(model, untrack(() => scene.frameOf(id))) : null;
        if (!geometry) return null;
        const mesh = new Mesh(geometry, this.ghostMaterial);
        mesh.userData.ghost = true;
        mesh.matrixAutoUpdate = false;
        mesh.matrix.fromArray(matrix);
        return mesh;
      },
    });
    this.group.add(this.groundGroup, this.instanceGroup, this.outlineGroup, this.overlay, this.fields.group, this.gizmoGroup);
    this.group.matrixAutoUpdate = false;
    viewport.scene.add(this.group);
    this.buildGizmo();
    if (options.context) {
      this.material.transparent = true;
      this.material.opacity = 0.4;
      this.material.depthWrite = false;
    }
    createRoot((dispose) => {
      this.disposeRoot = dispose;
      createEffect(() => {
        this.theme = theme();
        this.rebuildGround();
        this.rebuildOutlines();
      });
      createEffect(() => {
        scene.ground;
        scene.stageVoxel;
        scene.activeModel;
        this.rebuildGround();
      });
      createEffect(() => {
        // the view's space follows the active model, wherever it is in the scene
        this.toWorld = scene.viewMatrix;
        this.toView = invertMat(this.toWorld);
        this.group.matrix.fromArray(this.toView);
        this.group.matrixWorldNeedsUpdate = true;
        viewport.requestRender();
      });
      createEffect(() => {
        // every model's voxels, the instances and where they are
        for (const m of scene.allModels) {
          const d = scene.document(m.id);
          d.version;
          d.contentVersion;
          d.palette;
        }
        // the model being edited shows what its session does, strokes and all
        scene.activeEditor?.geometryVersion;
        scene.activeEditor?.palette;

        // models kinds supply, as they are built or arrive
        for (const i of scene.instances) scene.modelFor(i.id);
        scene.open;
        scene.stage;
        this.rebuildInstances();
        this.rebuildOutlines();
      });
      createEffect(() => {
        scene.selection;
        this.rebuildOutlines();
      });
      createEffect(() => {
        // the selected instance's handles follow its settings and where it is
        for (const id of scene.selection) scene.modelFor(id);
        scene.instances;
        scene.kinds;
        this.fields.vertex;
        if (!options.context) this.fields.rebuild();
      });
    });
    this.stopRender = viewport.onBeforeRender(() => this.placeGizmo());
    if (!options.context) viewport.setPointerLayer(this);
    // on a model's canvas, Zoom to fit frames the model; the scene alone frames the scene
    if (!untrack(() => scene.activeModel)) viewport.fitOverride = () => this.fit();
  }

  /** Show or hide everything the layer draws (the scene around a model being edited). */
  setShown(shown: boolean) {
    // a drag under way on what goes out of sight stops
    if (!shown && this.drag) this.cancel();
    this.group.visible = shown;
    this.viewport.requestRender();
  }

  /**
   * A picture of the view without the ground, outlines, field handles or gizmo, on a transparent background.
   * The viewport draws it at once, so they are only hidden for that one frame.
   */
  capture(): Promise<Blob> {
    const helpers = [this.groundGroup, this.outlineGroup, this.fields.group, this.gizmoGroup].filter((g) => g.visible);
    for (const g of helpers) g.visible = false;
    try {
      return this.viewport.screenshot();
    } finally {
      for (const g of helpers) g.visible = true;
      this.viewport.requestRender();
    }
  }

  /** Whether instances can be picked and moved now: not while the layer is hidden. */
  private get picking() {
    return !this.options.context && this.group.visible;
  }

  /** A ray in the view's space, in the world's. */
  private worldRay(ray: Ray): Ray {
    const origin = transformPoint(this.toWorld, ray.origin);
    const d = transformDirection(this.toWorld, ray.dir);
    const len = Math.hypot(...d) || 1;
    return { origin, dir: d.map((n) => n / len) as Vec3 };
  }

  /** Where a world point is on screen. */
  private screenOf(p: Vec3) {
    return this.viewport.screenPoint(transformPoint(this.toView, p));
  }

  /** World units per CSS pixel at a world point. */
  private pixelAt(p: Vec3) {
    const scale = Math.hypot(this.toWorld[0], this.toWorld[1], this.toWorld[2]) || 1;
    return this.viewport.worldPerPixel(transformPoint(this.toView, p)) * scale;
  }

  dispose() {
    this.fields.dispose();
    this.ghostMaterial.dispose();
    cancelAnimationFrame(this.clockFrame);
    this.clockFrame = 0;
    if (!this.options.context) this.viewport.setPointerLayer(null);
    if (this.viewport.fitOverride) this.viewport.fitOverride = null;
    this.stopRender();
    this.disposeRoot();
    this.viewport.scene.remove(this.group);
    this.instanceGroup.clear();
    for (const g of this.geometries.values()) g.geometry.dispose();
    this.geometries.clear();
    disposeTree(this.group);
    this.material.dispose();
  }

  // #region Drawing

  /**
   * A model's mesh in one frame, from its document. The model being edited is meshed from what
   * its session shows instead, so edits appear as they are made.
   */
  private geometryFor(model: string, frame: string | null): BufferGeometry | null {
    let doc: VoxelDocument;
    try {
      doc = this.scene.document(model);
    } catch {
      return null;
    }
    const showing = frame ?? untrack(() => doc.openFrameId);
    const session = untrack(() => this.scene.activeModel) === model ? untrack(() => this.scene.activeEditor) : null;
    const live = session && showing === untrack(() => session.displayFrameId) ? session : null;
    const key = `${model}|${live ? "live" : showing}`;
    const source = live ?? doc;
    const version = live ? untrack(() => live.geometryVersion) : untrack(() => doc.contentVersion);
    const palette = untrack(() => (live ?? doc).palette);
    const cached = this.geometries.get(key);
    if (cached && cached.source === source && cached.version === version && cached.palette === palette) return cached.geometry;
    const size = untrack(() => doc.size);
    const volume = live ? live.composite : untrack(() => doc.volume(showing));
    if (volume.length !== size[0] * size[1] * size[2]) return cached?.geometry ?? null;
    const geometry = this.mesher.build(volume, size, palette);
    cached?.geometry.dispose();
    this.geometries.set(key, { geometry, source, palette, version });
    return geometry;
  }

  /** Milliseconds on the scene's clock. */
  private get clock() {
    return performance.now() - this.clockStart;
  }

  /** Run the clock while anything loops: swap each looping instance's mesh when its frame changes. */
  private tick = () => {
    this.clockFrame = 0;
    if (!untrack(() => this.scene.animating)) return;
    const now = this.clock;
    let changed = false;
    for (const [id, entry] of this.meshes) {
      const frame = untrack(() => this.scene.frameOf(id, now));
      if (frame === entry.frame) continue;
      const model = untrack(() => this.scene.modelFor(id));
      const geometry = model ? this.geometryFor(model, frame) : null;
      if (!geometry) continue;
      entry.mesh.geometry = geometry;
      entry.frame = frame;
      changed = true;
    }
    // placed scenes play what they hold
    for (const [id, entries] of this.placed) {
      const contents = untrack(() => this.scene.placedContents(id, now));
      contents.forEach((c, k) => {
        const entry = entries[k];
        if (!entry || entry.frame === c.frame) return;
        const geometry = this.geometryFor(c.model, c.frame);
        if (!geometry) return;
        entry.mesh.geometry = geometry;
        entry.frame = c.frame;
        entry.mesh.matrix.fromArray(c.matrix);
        entry.mesh.matrixWorldNeedsUpdate = true;
        changed = true;
      });
    }
    if (changed) {
      // what hangs from a marker keyed per frame follows it
      for (const [id, entry] of this.meshes) {
        entry.mesh.matrix.fromArray(untrack(() => this.scene.meshMatrix(id, now)));
        entry.mesh.matrixWorldNeedsUpdate = true;
      }
      this.viewport.requestRender();
    }
    this.clockFrame = requestAnimationFrame(this.tick);
  };

  /** The frame each instance shows now, for exports of what is on screen. */
  frameShowing(id: string): string | undefined {
    return this.meshes.get(id)?.frame ?? untrack(() => this.scene.frameOf(id, this.clock)) ?? undefined;
  }

  private rebuildInstances() {
    const scene = this.scene;
    this.instanceGroup.clear();
    this.meshes.clear();
    this.placed.clear();
    const editing = untrack(() => scene.open?.instance);
    const now = this.clock;
    for (const inst of untrack(() => scene.instances)) {
      if (inst.scene !== undefined) {
        if (!untrack(() => scene.isShown(inst.id))) continue;
        const entries: { mesh: Mesh; frame: string }[] = [];
        for (const c of untrack(() => scene.placedContents(inst.id, now))) {
          const geometry = this.geometryFor(c.model, c.frame);
          if (!geometry) continue;
          const mesh = new Mesh(geometry, this.material);
          mesh.matrixAutoUpdate = false;
          mesh.matrix.fromArray(c.matrix);
          mesh.matrixWorldNeedsUpdate = true;
          this.instanceGroup.add(mesh);
          entries.push({ mesh, frame: c.frame });
        }
        this.placed.set(inst.id, entries);
        continue;
      }
      const model = untrack(() => scene.modelFor(inst.id));
      if (!model || inst.id === editing || !untrack(() => scene.isShown(inst.id))) continue;
      const frame = untrack(() => scene.frameOf(inst.id, now));
      const geometry = this.geometryFor(model, frame);
      if (!geometry) continue;
      const mesh = new Mesh(geometry, this.material);
      this.meshes.set(inst.id, { mesh, frame });
      mesh.matrixAutoUpdate = false;
      mesh.matrix.fromArray(untrack(() => scene.meshMatrix(inst.id, now)));
      mesh.matrixWorldNeedsUpdate = true;
      this.instanceGroup.add(mesh);
    }
    // models that left the scene take their meshes with them
    const models = new Set(untrack(() => scene.allModels).map((m) => m.id));
    for (const [key, g] of this.geometries) {
      if (models.has(key.split("|")[0])) continue;
      g.geometry.dispose();
      this.geometries.delete(key);
    }
    if (!this.clockFrame && untrack(() => scene.animating)) this.clockFrame = requestAnimationFrame(this.tick);
    this.viewport.requestRender();
  }

  private rebuildGround() {
    disposeTree(this.groundGroup);
    this.groundGroup.clear();
    const ground = untrack(() => this.scene.ground);
    // a model's canvas has its own floor
    if (!ground.visible || untrack(() => this.scene.activeModel)) return this.viewport.requestRender();
    const step = untrack(() => this.scene.stageVoxel);
    const [w, d] = ground.size;
    const minor: number[] = [];
    const major: number[] = [];
    const x0 = -w / 2;
    const z0 = -d / 2;
    for (let i = 0; i <= w; i++) (i % 8 === 0 || i === w ? major : minor).push((x0 + i) * step, 0, z0 * step, (x0 + i) * step, 0, (z0 + d) * step);
    for (let j = 0; j <= d; j++) (j % 8 === 0 || j === d ? major : minor).push(x0 * step, 0, (z0 + j) * step, (x0 + w) * step, 0, (z0 + j) * step);
    for (const [positions, color] of [
      [minor, this.theme.grid],
      [major, this.theme.gridStrong],
    ] as const) {
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
      this.groundGroup.add(new LineSegments(geometry, new LineBasicMaterial({ color })));
    }
    this.viewport.requestRender();
  }

  /** An instance's box in its own drawn space: its model's voxels (grid units), or its kind's bounds. */
  private localBox(id: string): { box: Box; matrix: Mat4 } | null {
    const scene = this.scene;
    const inst = untrack(() => scene.instance(id));
    if (!inst) return null;
    const model = untrack(() => scene.modelFor(id));
    if (model) {
      const doc = scene.document(model);
      const bounds = untrack(() => doc.contentBounds()) ?? { min: [0, 0, 0] as Vec3, max: untrack(() => doc.size).map((n) => n - 1) as Vec3 };
      return { box: { min: bounds.min, max: bounds.max.map((n) => n + 1) as Vec3 }, matrix: untrack(() => scene.meshMatrix(id)) };
    }
    const box = untrack(() => scene.instanceBounds(id));
    return box ? { box, matrix: untrack(() => scene.worldMatrix(id)) } : null;
  }

  private rebuildOutlines() {
    disposeTree(this.outlineGroup);
    this.outlineGroup.clear();
    const scene = this.scene;
    const selected = new Set(untrack(() => scene.selection));
    const editing = untrack(() => scene.open?.instance);
    for (const inst of untrack(() => scene.instances)) {
      if (inst.id === editing || !untrack(() => scene.isShown(inst.id))) continue;
      const isSelected = selected.has(inst.id);
      // instances without a model are only an outline; selected ones are outlined in the accent
      // groups draw only while selected
      if (!isSelected && (untrack(() => scene.modelFor(inst.id)) || untrack(() => scene.isGroup(inst.id)))) continue;
      const local = this.localBox(inst.id);
      if (!local) continue;
      const kind = inst.kind ? untrack(() => scene.kindInfo(inst.kind!)) : undefined;
      const color = isSelected ? this.theme.accent : kind?.color !== undefined ? `#${kind.color.toString(16).padStart(6, "0")}` : this.theme.gridStrong;
      const lines = boxLines(local.box, color, isSelected ? 0.95 : 0.7);
      lines.matrixAutoUpdate = false;
      lines.matrix.fromArray(local.matrix);
      this.outlineGroup.add(lines);
    }
    this.viewport.requestRender();
  }

  private buildGizmo() {
    const material = (color: string) => new MeshBasicMaterial({ color, transparent: true, depthTest: false, depthWrite: false });
    for (const axis of [0, 1, 2] as const) {
      const arrow = new Group();
      const length = GIZMO.arrowTo - GIZMO.arrowFrom;
      const shaft = new Mesh(new CylinderGeometry(GIZMO.shaft, GIZMO.shaft, length, 8), material(AXIS_COLORS[axis]));
      shaft.position.y = GIZMO.arrowFrom + length / 2;
      const head = new Mesh(new ConeGeometry(GIZMO.headRadius, GIZMO.head, 16), material(AXIS_COLORS[axis]));
      head.position.y = GIZMO.arrowTo + GIZMO.head / 2;
      arrow.add(shaft, head);
      if (axis === 0) arrow.rotation.z = -Math.PI / 2;
      if (axis === 2) arrow.rotation.x = Math.PI / 2;
      this.gizmoParts.set(`move-${axis}`, arrow);
    }
    const ring = new Group();
    ring.add(new Mesh(new TorusGeometry(GIZMO.ring, GIZMO.tube, 6, 96), material(AXIS_COLORS[1])));
    ring.rotation.x = Math.PI / 2;
    this.gizmoParts.set("rotate-1", ring);
    for (const part of this.gizmoParts.values()) {
      part.traverse((o) => (o.renderOrder = 12));
      this.gizmoGroup.add(part);
    }
    this.gizmoGroup.visible = false;
  }

  /** Where the gizmo sits: the first selected instance's origin. Null with nothing movable selected. */
  private gizmoCenter(): Vec3 | null {
    const scene = this.scene;
    const id = untrack(() => scene.selection).find((s) => !untrack(() => scene.instance(s))?.locked);
    if (!id) return null;
    return transformPoint(untrack(() => scene.worldMatrix(id)), [0, 0, 0]);
  }

  private placeGizmo() {
    const center = this.drag?.kind === "rotate" ? this.drag.center : this.picking ? this.gizmoCenter() : null;
    this.gizmoGroup.visible = !!center;
    if (!center) return;
    this.gizmoGroup.position.set(...center);
    this.gizmoGroup.scale.setScalar(this.pixelAt(center));
    const active = this.drag?.kind === "axis" ? (`move-${this.drag.axis}` as Handle) : this.drag?.kind === "rotate" ? "rotate-1" : this.hoverHandle;
    for (const [id, part] of this.gizmoParts) {
      part.visible = this.drag && this.drag.kind !== "move" ? id === active : !this.drag && (id !== "rotate-1" || this.canTurn());
      part.traverse((o) => {
        const m = (o as Mesh).material as MeshBasicMaterial | undefined;
        if (!m) return;
        const axis = id === "rotate-1" ? 1 : Number(id.split("-")[1]);
        m.color.set(AXIS_COLORS[axis]);
        if (id === active) m.color.lerp(new Color("#ffffff"), 0.35);
        m.opacity = id === active ? 1 : id.startsWith("rotate") ? 0.55 : 0.85;
      });
    }
  }

  // #endregion

  // #region Picking

  /** The nearest visible, unlocked instance a ray hits, and where. */
  pick(ray: Ray): { id: string; distance: number; point: Vec3 } | null {
    // a voxel first; failing that, the box around one's voxels, so a pole, a flag or a coin far
    // off can still be tapped, though a ray through it can pass between its voxels. Kinds with no
    // model (a zone, a trigger) are boxes that hold other things: they come in the second pass, so
    // what stands inside one is picked before it
    return this.pickPass(ray, false) ?? this.pickPass(ray, true);
  }

  private pickPass(ray: Ray, loose: boolean): { id: string; distance: number; point: Vec3 } | null {
    const scene = this.scene;
    let best: { id: string; distance: number; point: Vec3 } | null = null;
    for (const inst of untrack(() => scene.instances)) {
      // a group is picked through what it holds (or the outliner), never by its box
      if (untrack(() => scene.isGroup(inst.id) || !scene.isShown(inst.id) || scene.isLocked(inst.id))) continue;
      if (!loose && !untrack(() => scene.modelFor(inst.id)) && inst.scene === undefined) continue;
      const hit = this.pickInstance(inst.id, ray, loose);
      if (hit !== null && (!best || hit < best.distance)) {
        best = { id: inst.id, distance: hit, point: ray.origin.map((o, a) => o + ray.dir[a] * hit) as Vec3 };
      }
    }
    return best;
  }

  /** How far along a world ray it meets an instance, or null. */
  private pickInstance(id: string, ray: Ray, loose = false): number | null {
    const scene = this.scene;
    if (!loose && untrack(() => scene.placedScene(id))) return this.pickPlaced(id, ray);
    const model = untrack(() => scene.modelFor(id));
    const matrix = model ? untrack(() => scene.meshMatrix(id)) : untrack(() => scene.worldMatrix(id));
    const inv = invertMat(matrix);
    const origin = transformPoint(inv, ray.origin);
    const dirScaled = transformDirection(inv, ray.dir);
    const len = Math.hypot(...dirScaled) || 1;
    const dir = dirScaled.map((n) => n / len) as Vec3;
    let local: number | null = null;
    if (model && loose) {
      const doc = scene.document(model);
      const b = untrack(() => doc.contentBounds());
      if (b) local = slab({ origin, dir }, { min: b.min, max: b.max.map((n) => n + 1) as Vec3 });
    } else if (model) {
      const doc = scene.document(model);
      const size = untrack(() => doc.size);
      // the frame it shows now, as drawn
      const volume = untrack(() => doc.volume(this.frameShowing(id)));
      const hit = raycastVolume({ origin, dir }, size, (i) => volume[i] !== 0);
      local = hit ? hit.distance : null;
    } else {
      const box = untrack(() => scene.instanceBounds(id));
      if (box) local = slab({ origin, dir }, box);
    }
    // back into world distance
    return local === null ? null : local / len;
  }

  /** How far along a world ray it meets any voxel a placed scene draws, or null. */
  private pickPlaced(id: string, ray: Ray): number | null {
    let best: number | null = null;
    const entries = this.placed.get(id) ?? [];
    untrack(() => this.scene.placedContents(id, this.clock)).forEach((c, k) => {
      const inv = invertMat(c.matrix);
      const origin = transformPoint(inv, ray.origin);
      const dirScaled = transformDirection(inv, ray.dir);
      const len = Math.hypot(...dirScaled) || 1;
      const dir = dirScaled.map((n) => n / len) as Vec3;
      const doc = this.scene.document(c.model);
      const volume = untrack(() => doc.volume(entries[k]?.frame ?? c.frame));
      const hit = raycastVolume({ origin, dir }, untrack(() => doc.size), (i) => volume[i] !== 0);
      if (hit && (best === null || hit.distance / len < best)) best = hit.distance / len;
    });
    return best;
  }

  // #endregion

  // #region Pointers

  private reach(e: PointerEvent | null) {
    return e?.pointerType === "mouse" ? MOUSE_REACH : TOUCH_REACH;
  }

  /** The gizmo handle near a client point. */
  private handleAt(x: number, y: number, reach: number): Handle | null {
    const center = this.picking ? this.gizmoCenter() : null;
    if (!center) return null;
    const px = this.pixelAt(center);
    const pointer = new Vector2(x, y);
    let best: Handle | null = null;
    let bestDistance = reach;
    const consider = (id: Handle, points: (Vec3 | null)[]) => {
      const screen = points.map((p) => (p ? this.screenOf(p) : null));
      for (let i = 1; i < screen.length; i++) {
        const a = screen[i - 1];
        const b = screen[i];
        if (!a || !b) continue;
        const d = segmentDistance(pointer, new Vector2(a.x, a.y), new Vector2(b.x, b.y));
        if (d < bestDistance) {
          best = id;
          bestDistance = d;
        }
      }
    };
    for (const axis of [0, 1, 2] as const) {
      const along = (n: number) => {
        const p = [...center] as Vec3;
        p[axis] += n * px;
        return p;
      };
      consider(`move-${axis}`, [along(GIZMO.arrowFrom), along(GIZMO.arrowTo + GIZMO.head)]);
    }
    if (this.canTurn()) {
      const ring: Vec3[] = [];
      for (let i = 0; i <= 48; i++) {
        const t = (i / 48) * Math.PI * 2;
        ring.push([center[0] + Math.cos(t) * GIZMO.ring * px, center[1], center[2] + Math.sin(t) * GIZMO.ring * px]);
      }
      consider("rotate-1", ring);
    }
    return best;
  }

  /** Whether the selection may turn: not when a kind says it doesn't. */
  private canTurn() {
    const id = untrack(() => this.scene.selection)[0];
    return !id || untrack(() => this.scene.rotateRule(id)) !== "none";
  }

  private movable(): string[] {
    const scene = this.scene;
    return untrack(() => scene.selection).filter((id) => !untrack(() => scene.instance(id))?.locked);
  }

  down(viewInput: PointerInput, e: PointerEvent): boolean {
    if (!this.picking) return false;
    const input = { ...viewInput, ray: this.worldRay(viewInput.ray) };
    const scene = this.scene;
    // a field's handles are small and specific: they come first
    const field = this.fields.hit(e.clientX, e.clientY, this.reach(e));
    if (field && this.fields.begin(field, input.ray)) {
      this.drag = { kind: "field" };
      return true;
    }
    const handle = this.handleAt(e.clientX, e.clientY, this.reach(e));
    if (handle) {
      const ids = this.movable();
      const center = this.gizmoCenter()!;
      if (handle === "rotate-1") {
        const a0 = this.angleAt(input.ray, center);
        if (a0 === null) return false;
        scene.beginStroke("Turn");
        this.drag = { kind: "rotate", center, a0, starts: new Map(ids.map((id) => [id, [...untrack(() => scene.instance(id))!.rotation] as Quat])), moved: false };
      } else {
        const axis = Number(handle.split("-")[1]) as 0 | 1 | 2;
        const t0 = axisParam(input.ray, center, axis);
        if (t0 === null) return false;
        scene.beginStroke("Move");
        this.drag = { kind: "axis", axis, origin: center, t0, starts: this.positions(ids), moved: false };
      }
      this.viewport.requestRender();
      return true;
    }

    if (this.options.handlesOnly && !this.options.pickWhen?.()) return false;
    const hit = this.pick(input.ray);
    if (!hit) return false;
    const now = performance.now();
    if (this.lastTap?.id === hit.id && now - this.lastTap.at < DOUBLE_TAP_MS) {
      this.lastTap = null;
      this.options.onOpen?.(hit.id);
      return true;
    }
    this.lastTap = { id: hit.id, at: now };
    const selection = untrack(() => scene.selection);
    if (input.shift || input.mod) scene.toggleSelected(hit.id);
    else if (!selection.includes(hit.id)) scene.select([hit.id]);
    const ids = this.movable();
    if (!ids.includes(hit.id)) return true;
    // drag onto surfaces under the finger, or along a level plane through where it landed
    scene.beginStroke("Move");
    const origin = transformPoint(untrack(() => scene.worldMatrix(hit.id)), [0, 0, 0]);
    const exclude = new Set(untrack(() => scene.instances).filter((i) => ids.some((d) => this.hangsFrom(i.id, d))).map((i) => i.id));
    this.drag = {
      kind: "move",
      start: hit.point,
      height: hit.point[1],
      starts: this.positions(ids),
      moved: false,
      x: e.clientX,
      y: e.clientY,
      primary: hit.id,
      origin,
      grab: hit.point.map((n, a) => n - origin[a]) as Vec3,
      exclude,
    };
    return true;
  }

  /** Whether `id` is `ancestor` or hangs from it. */
  private hangsFrom(id: string, ancestor: string): boolean {
    for (let at: string | undefined = id, n = 0; at && n < 10000; n++) {
      if (at === ancestor) return true;
      at = untrack(() => this.scene.instance(at!))?.parent?.instance;
    }
    return false;
  }

  move(viewInput: PointerInput, e: PointerEvent) {
    const drag = this.drag;
    if (!drag) return;
    const input = { ...viewInput, ray: this.worldRay(viewInput.ray) };
    const scene = this.scene;
    if (drag.kind === "field") {
      this.fields.move(input.ray);
    } else if (drag.kind === "move") {
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) <= TAP_SLOP) return;
      const step = untrack(() => scene.snapStepFor(drag.primary));
      const snap = (n: number) => (step ? Math.round(n / step) * step : n);
      let delta: Vec3 | null = null;
      // onto the top of whatever is under the finger: a block, another instance, the ground
      const surface = untrack(() => scene.snap.surfaces) ? scene.surfaceAt(input.ray, drag.exclude) : null;
      const primary = untrack(() => scene.instance(drag.primary));
      if (surface && primary && !primary.parent && drag.starts.size === 1 && untrack(() => scene.kind(primary.kind)?.snap?.faces)) {
        // a kind that stands out of any face: onto it, turned to point out of it, its base on the face
        const n = surface.normal;
        const axis = (Math.abs(n[0]) > 0.5 ? 0 : Math.abs(n[1]) > 0.5 ? 1 : 2) as 0 | 1 | 2;
        const sign = n[axis] > 0 ? 1 : -1;
        const up = transformDirection(matFromTransform([0, 0, 0], primary.rotation, 1), [0, 1, 0]);
        const rotation = Math.round(up[axis]) === sign ? primary.rotation : quatUpTo(axis, sign);
        if (rotation !== primary.rotation) scene.setTransform(drag.primary, { rotation }, "Move");
        const point = [...surface.point] as Vec3;
        point[axis] = Math.round(point[axis] * 1e6) / 1e6;
        const position = scene.alignPosition(drag.primary, point, [axis !== 0, axis !== 1, axis !== 2]);
        drag.moved = true;
        scene.setTransform(drag.primary, { position }, "Move");
        this.viewport.requestRender();
        return;
      }
      if (surface && surface.normal[1] > 0.5) {
        const at: Vec3 = [surface.point[0] - drag.grab[0], surface.point[1], surface.point[2] - drag.grab[2]];
        // lined up with the stage's cells, as its kind says; an attached one snaps in the world
        const target: Vec3 = untrack(() => scene.instance(drag.primary))?.parent
          ? [snap(at[0]), at[1], snap(at[2])]
          : scene.alignPosition(drag.primary, at, [true, false, true]);
        // round away float noise, so a block top at 6 is 6
        delta = target.map((n, a) => Math.round((n - drag.origin[a]) * 1e6) / 1e6 || 0) as Vec3;
      } else {
        const t = rayLevel(input.ray, drag.height);
        if (t !== null) {
          const p = input.ray.origin.map((o, a) => o + input.ray.dir[a] * t) as Vec3;
          delta = [snap(p[0] - drag.start[0]), 0, snap(p[2] - drag.start[2])];
        }
      }
      if (!delta) return;
      drag.moved = true;
      this.applyOffsets(drag.starts, delta);
    } else if (drag.kind === "axis") {
      const t = axisParam(input.ray, drag.origin, drag.axis);
      if (t === null) return;
      const delta: Vec3 = [0, 0, 0];
      delta[drag.axis] = t - drag.t0;
      drag.moved = true;
      this.applyOffsets(drag.starts, scene.snapOffset(delta));
    } else {
      const a = this.angleAt(input.ray, drag.center);
      if (a === null) return;
      let deg = ((a - drag.a0) * 180) / Math.PI;
      const first = [...drag.starts.keys()][0];
      deg = first && untrack(() => scene.rotateRule(first)) === "quarter" ? Math.round(deg / 90) * 90 : scene.snapAngle(deg);
      drag.moved = true;
      const turn = quatFromEuler([0, deg, 0]);
      for (const [id, start] of drag.starts) {
        if (this.carried(id, drag.starts)) continue;
        // a turn about world up, in the frame the instance hangs in: parent⁻¹ · turn · parent · start
        const inst = untrack(() => scene.instance(id));
        const [px, py, pz, pw] = decomposeMat(untrack(() => scene.attachFrame(inst?.parent ?? null))).rotation;
        const local = multiplyQuat(multiplyQuat([-px, -py, -pz, pw], turn), [px, py, pz, pw]);
        scene.setTransform(id, { rotation: multiplyQuat(local, start) }, "Turn");
      }
    }
    this.viewport.requestRender();
  }

  up() {
    if (this.drag?.kind === "field") this.fields.end();
    else if (this.drag) this.scene.endStroke();
    this.drag = null;
    this.viewport.requestRender();
  }

  cancel() {
    if (this.drag?.kind === "field") this.fields.cancel();
    else if (this.drag) this.scene.cancelStroke();
    this.drag = null;
    this.viewport.requestRender();
  }

  tap() {
    // a tap on empty space clears the selection
    if (this.picking && untrack(() => this.scene.selection).length) this.scene.clearSelection();
  }

  hover(input: PointerInput | null, e: PointerEvent | null): boolean {
    if (!this.picking) input = null;
    if (input && e && this.fields.hit(e.clientX, e.clientY, this.reach(e))) return true;
    const handle = input && e ? this.handleAt(e.clientX, e.clientY, this.reach(e)) : null;
    if (handle !== this.hoverHandle) {
      this.hoverHandle = handle;
      this.viewport.requestRender();
    }
    const picks = !this.options.handlesOnly || !!this.options.pickWhen?.();
    return !!handle || (!!input && picks && !!this.pick(this.worldRay(input.ray)));
  }

  private positions(ids: readonly string[]): Map<string, Vec3> {
    return new Map(ids.map((id) => [id, [...untrack(() => this.scene.instance(id))!.position] as Vec3]));
  }

  /** Whether an instance hangs (at any depth) from another one being dragged, so moves with it already. */
  private carried(id: string, dragged: ReadonlyMap<string, unknown>): boolean {
    const parent = untrack(() => this.scene.instance(id))?.parent?.instance;
    return !!parent && [...dragged.keys()].some((other) => other !== id && this.hangsFrom(parent, other));
  }

  /** Put each dragged instance at its start plus a world offset, converted into its parent's frame. */
  private applyOffsets(starts: Map<string, Vec3>, delta: Vec3) {
    const scene = this.scene;
    for (const [id, start] of starts) {
      const inst = untrack(() => scene.instance(id));
      if (!inst || this.carried(id, starts)) continue;
      const inv = invertMat(untrack(() => scene.attachFrame(inst.parent)));
      const local = transformDirection(inv, delta);
      scene.setTransform(id, { position: start.map((n, a) => n + local[a]) as Vec3 });
    }
  }

  /** The angle around a vertical axis through `center` where a ray meets the level plane at its height. */
  private angleAt(ray: Ray, center: Vec3): number | null {
    const t = rayLevel(ray, center[1]);
    if (t === null) return null;
    const x = ray.origin[0] + ray.dir[0] * t - center[0];
    const z = ray.origin[2] + ray.dir[2] * t - center[2];
    // turning toward -Z from +X is positive about +Y
    return Math.atan2(-z, x);
  }

  // #endregion

  /** Frame every visible instance (or the ground, with none). */
  fit() {
    const scene = this.scene;
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const inst of untrack(() => scene.instances)) {
      if (untrack(() => scene.isGroup(inst.id) || !scene.isShown(inst.id))) continue;
      const local = this.localBox(inst.id);
      if (!local) continue;
      for (let c = 0; c < 8; c++) {
        const p = transformPoint(local.matrix, [
          c & 1 ? local.box.max[0] : local.box.min[0],
          c & 2 ? local.box.max[1] : local.box.min[1],
          c & 4 ? local.box.max[2] : local.box.min[2],
        ]);
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a], p[a]);
          max[a] = Math.max(max[a], p[a]);
        }
      }
    }
    if (!Number.isFinite(min[0])) {
      const [w, d] = untrack(() => scene.ground).size;
      const s = untrack(() => scene.stageVoxel);
      this.viewport.frameBox([(-w / 4) * s, 0, (-d / 4) * s], [(w / 4) * s, 4 * s, (d / 4) * s]);
      return;
    }
    // frame in the view's space
    const a = transformPoint(this.toView, min);
    const b = transformPoint(this.toView, max);
    this.viewport.frameBox(a.map((n, i) => Math.min(n, b[i])) as Vec3, a.map((n, i) => Math.max(n, b[i])) as Vec3);
  }
}

/** Where a ray meets the level plane y = `height`, as a distance along it; null if it never does. */
function rayLevel(ray: Ray, height: number): number | null {
  if (Math.abs(ray.dir[1]) < 1e-6) return null;
  const t = (height - ray.origin[1]) / ray.dir[1];
  return t > 0 ? t : null;
}

/** The parameter along an axis line through `origin` closest to a ray. */
function axisParam(ray: Ray, origin: Vec3, axis: 0 | 1 | 2): number | null {
  const u: Vec3 = [0, 0, 0];
  u[axis] = 1;
  const v = ray.dir;
  const w0 = origin.map((o, a) => o - ray.origin[a]) as Vec3;
  const b = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const denom = 1 - b * b;
  if (denom < 1e-6) return null;
  const d = u[0] * w0[0] + u[1] * w0[1] + u[2] * w0[2];
  const e = v[0] * w0[0] + v[1] * w0[1] + v[2] * w0[2];
  return (b * e - d) / denom;
}

/** Where a ray enters a box, as a distance, or null. */
function slab(ray: Ray, box: Box): number | null {
  let t0 = 0;
  let t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    const o = ray.origin[a];
    const d = ray.dir[a];
    if (Math.abs(d) < 1e-12) {
      if (o < box.min[a] || o > box.max[a]) return null;
      continue;
    }
    let near = (box.min[a] - o) / d;
    let far = (box.max[a] - o) / d;
    if (near > far) [near, far] = [far, near];
    t0 = Math.max(t0, near);
    t1 = Math.min(t1, far);
    if (t0 > t1) return null;
  }
  return t0;
}

function segmentDistance(p: Vector2, a: Vector2, b: Vector2) {
  const ab = b.clone().sub(a);
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / Math.max(1e-9, ab.lengthSq())));
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

/** A box's edges as lines, drawn through everything so a buried selection still shows. */
function boxLines(box: Box, color: string, opacity: number) {
  const { min: a, max: b } = box;
  const c = (i: number) => [i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]];
  const edges: number[] = [];
  for (const [p, q] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) edges.push(...c(p), ...c(q));
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(edges), 3));
  const lines = new LineSegments(geometry, new LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false }));
  lines.renderOrder = 5;
  return lines;
}

/** Dispose what a group's children own. Instance meshes share their geometry and material, so they are cleared first. */
function disposeTree(group: Group) {
  group.traverse((o) => {
    const m = o as Mesh;
    m.geometry?.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}
