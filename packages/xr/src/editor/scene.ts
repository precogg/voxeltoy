// The scene around the stage, in the headset: when the model being edited is a library scene's
// stage (a level's course), its instances show where they stand on it, and with Move a hand picks
// one up and puts it down (held, or along its ray onto a surface), drags its path's stops, and
// places new ones from the Objects window. Every change goes through the library, so it is on the
// same history as the stage's voxels and shows on the page too.

import { createEffect, createRoot, createSignal, untrack } from "solid-js";
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Ray,
  SphereGeometry,
  Vector3,
  type Object3D,
} from "three";
import type { VoxelDocument } from "@voxeltoy/core/document";
import type { LibraryEditor } from "@voxeltoy/core/library";
import type { Field, InstanceKind } from "@voxeltoy/core/scene-kinds";
import { invertMat, transformPoint, type Mat4 } from "@voxeltoy/core/scene-math";
import type { Box, Vec3 } from "@voxeltoy/core/types";
import { Mesher } from "@voxeltoy/three/mesher";
import type { XRHand } from "../input";
import type { FocusedHit, Hit, Interaction, Reach, Router, Target, Trigger } from "../interaction";
import type { XRMenuItem } from "../menu";

/** A hand's pinch (a controller's grip) this close to an object's box (metres) takes hold of it; once at it, until `GRAB_LEAVE`. */
const GRAB_REACH = 0.015;
const GRAB_LEAVE = 0.03;
/** A path stop's handle: this big in the room (metres), taken from this close. */
const STOP_RADIUS = 0.008;
const STOP_REACH = 0.025;
/** A ray takes a stop from this far off its handle's middle (metres). */
const STOP_RAY = 0.015;

const ACCENT = 0x4f7cff;
const WHITE = 0xffffff;

/** Something in the scene a hand is at: an object, or one of the selected object's path stops. */
type SceneHit = { kind: "instance"; id: string } | { kind: "stop"; id: string; field: string; index: number };

/** A hit on an object or a stop, saying whose: what lights. */
type SceneTargetHit = Hit & { id: string };

export interface SceneViewHost {
  router: Router;
  /** Whether the palette has Move on: only then do hands work the scene. */
  moving(): boolean;
  isPaletteHand(hand: XRHand): boolean;
  notify(message: string): void;
}

/** A points field's handles: the instance's frame for relative fields, the world otherwise. */
const pointsFrame = (library: LibraryEditor, id: string, field: Field): Mat4 =>
  field.type === "points" && field.relative ? untrack(() => library.worldMatrix(id)) : new Matrix4().toArray();

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number");

/**
 * The library scene's instances about the stage, in the stage's voxel space (`group` goes in it):
 * their meshes (one geometry per model and frame), boxes for kinds without a model, outlines for
 * the selection and what a hand is at, and the selected one's path stops. As a target, it offers
 * hands the objects and stops while Move is on, and while placing, the surface under the ray.
 */
export class SceneView implements Target {
  /** World units in the stage's voxel space: put it in the voxel group. */
  readonly group = new Group();
  private meshes = new Group();
  private outlines = new Group();
  private handles = new Group();
  private ghost: LineSegments;
  private mesher = new Mesher();
  private material = new MeshBasicMaterial({ vertexColors: true });
  private stopMaterial = new MeshBasicMaterial({ color: ACCENT, depthTest: false, transparent: true });
  private chosenMaterial = new MeshBasicMaterial({ color: WHITE, depthTest: false, transparent: true });
  private stopGeometry = new SphereGeometry(1, 16, 8);
  private geometries = new Map<string, { geometry: BufferGeometry; doc: VoxelDocument; version: number; palette: readonly number[] }>();
  private disposeRoot: () => void = () => {};
  private hot = new Set<string>();
  private _placing = createSignal<string | null>(null);
  /** The path stop last taken, so Delete stop acts on it. */
  private _stop = createSignal<{ id: string; field: string; index: number } | null>(null);
  /** Where the hands put what they dragged: what the stops' handles are drawn at, between rebuilds. */
  private stops: { id: string; field: string; index: number; mesh: Mesh }[] = [];

  constructor(
    readonly library: LibraryEditor,
    readonly stage: string,
    private host: SceneViewHost,
  ) {
    this.group.matrixAutoUpdate = false;
    this.group.add(this.meshes, this.outlines, this.handles);
    this.ghost = boxLines({ min: [0, 0, 0], max: [1, 1, 1] }, WHITE, 0.9);
    this.ghost.visible = false;
    this.ghost.matrixAutoUpdate = false;
    this.group.add(this.ghost);
    createRoot((dispose) => {
      this.disposeRoot = dispose;
      createEffect(() => {
        // the stage's grid is the view's space: world units go in it by the inverse of where the stage is
        const local = library.modelLocal(stage);
        library.document(stage).size;
        this.group.matrix.fromArray(invertMat(local));
        this.group.matrixWorldNeedsUpdate = true;
      });
      createEffect(() => {
        for (const m of library.allModels) {
          if (m.id === stage) continue;
          const d = library.document(m.id);
          d.version;
          d.contentVersion;
          d.palette;
        }
        for (const i of library.instances) library.modelFor(i.id);
        this.rebuildMeshes();
      });
      createEffect(() => {
        library.instances;
        library.selection;
        library.kinds;
        this.rebuildOutlines();
        this.rebuildStops();
      });
      createEffect(() => {
        this._stop[0]();
        this.rebuildStops();
      });
    });
  }

  /** The kind being placed by the drawing hand (from the Objects window), if any. */
  get placing() {
    return this._placing[0]();
  }

  /** Place `kind` where the drawing hand points next, again and again until it stops (null). */
  setPlacing(kind: string | null) {
    this._placing[1](kind);
    if (kind) this.host.notify(`Point and pinch where ${untrack(() => this.library.kindInfo(kind))?.label ?? "it"} goes`);
  }

  /** The selected instance's path fields: what Add stop and Delete stop act on. */
  pathFields(): Field[] {
    const sel = this.library.selection;
    if (sel.length !== 1) return [];
    const inst = this.library.instance(sel[0]);
    return (this.library.kind(inst?.kind)?.fields ?? []).filter((f) => f.type === "points");
  }

  /** Add a stop after the one last taken (or the last), two steps along from it. */
  addStop() {
    const id = untrack(() => this.library.selection)[0];
    const field = untrack(() => this.pathFields())[0];
    if (!id || !field) return;
    const list = this.points(id, field.key);
    const v = untrack(() => this._stop[0]());
    const index = v?.id === id && v.field === field.key && v.index < list.length ? v.index : list.length - 1;
    const from = list[index] ?? ([0, 0, 0] as Vec3);
    const step = untrack(() => this.library.snapStepFor(id)) ?? 1;
    list.splice(index + 1, 0, [from[0] + step * 2, from[1], from[2]]);
    if (this.library.setData(id, { [field.key]: list }, "Add stop")) this._stop[1]({ id, field: field.key, index: index + 1 });
  }

  /** Delete the stop last taken, or the last. A path keeps one. */
  deleteStop() {
    const id = untrack(() => this.library.selection)[0];
    const field = untrack(() => this.pathFields())[0];
    if (!id || !field) return;
    const list = this.points(id, field.key);
    if (list.length < 2) return this.host.notify("A path keeps at least one stop");
    const v = untrack(() => this._stop[0]());
    const index = v?.id === id && v.field === field.key && v.index < list.length ? v.index : list.length - 1;
    this._stop[1](null);
    this.library.setData(id, { [field.key]: list.filter((_, i) => i !== index) }, "Delete stop");
  }

  // #region Target

  hit(hand: XRHand, prev: Reach | null): Hit | null {
    if (!hand.tracking || !this.host.moving() || this.host.isPaletteHand(hand)) return null;
    if (untrack(() => this.placing)) return this.placeHit(hand);
    const found = this.find(hand, prev);
    if (!found) return null;
    const { at, reach, distance, point } = found;
    const hit: SceneTargetHit = { target: this, reach, distance, point, id: at.id, press: (h, t) => this.press(h, t, at, reach) };
    return hit;
  }

  focus(hits: readonly FocusedHit[]) {
    const hot = new Set<string>();
    for (const { hit } of hits) {
      const id = (hit as Partial<SceneTargetHit>).id;
      if (id) hot.add(id);
    }
    if (hot.size === this.hot.size && [...hot].every((id) => this.hot.has(id))) return;
    this.hot = hot;
    this.rebuildOutlines();
  }

  /** What `hand` is at: a stop of the selected instance first, then an object. */
  private find(hand: XRHand, prev: Reach | null): { at: SceneHit; reach: Reach; distance: number; point: Vector3 } | null {
    const toRoom = this.group.matrixWorld;
    const metres = new Vector3().setFromMatrixScale(toRoom).x || 1;
    const fromRoom = toRoom.clone().invert();
    const handle = hand.handle;
    // the stops: held at the pinch, or along the ray
    let best: { at: SceneHit; reach: Reach; distance: number; point: Vector3 } | null = null;
    const better = (reach: Reach, distance: number) => !best || (reach === "grab" && best.reach !== "grab") || (reach === best.reach && distance < best.distance);
    for (const s of this.stops) {
      const p = new Vector3().setFromMatrixPosition(s.mesh.matrixWorld);
      const d = p.distanceTo(handle);
      const at: SceneHit = { kind: "stop", id: s.id, field: s.field, index: s.index };
      if (d < (prev === "grab" ? STOP_REACH * 1.4 : STOP_REACH)) {
        if (better("grab", d)) best = { at, reach: "grab", distance: d, point: p };
        continue;
      }
      const along = p.clone().sub(hand.ray.origin).dot(hand.ray.direction);
      if (along > 0 && hand.ray.distanceToPoint(p) < STOP_RAY && better("ray", along)) best = { at, reach: "ray", distance: along, point: p };
    }
    if (best) return best;

    // the objects: a pinch at one's box takes it (one without a model, near its sides: a zone holds
    // other things); a ray takes the nearest object it meets, and a box without a model only when
    // nothing with one is in the way
    const local = handle.clone().applyMatrix4(fromRoom);
    const ray = new Ray(hand.ray.origin.clone().applyMatrix4(fromRoom), hand.ray.direction.clone().transformDirection(fromRoom));
    const reach = (prev === "grab" ? GRAB_LEAVE : GRAB_REACH) / metres;
    let grab: { id: string; d: number } | null = null;
    let modeled: { id: string; t: number } | null = null;
    let empty: { id: string; t: number } | null = null;
    for (const inst of untrack(() => this.library.instances)) {
      if (inst.parent && !untrack(() => this.library.modelFor(inst.id))) continue;
      if (!untrack(() => this.library.isShown(inst.id)) || untrack(() => this.library.isGroup(inst.id))) continue;
      const wb = untrack(() => this.library.worldBox(inst.id));
      if (!wb) continue;
      const box = new Box3(new Vector3(...wb.min), new Vector3(...wb.max));
      const hasModel = !!untrack(() => this.library.modelFor(inst.id));
      const outside = box.distanceToPoint(local);
      const d = hasModel ? outside : outside > 0 ? outside : Math.min(...[0, 1, 2].map((a) => Math.min(local.getComponent(a) - box.min.getComponent(a), box.max.getComponent(a) - local.getComponent(a))));
      if (d < reach && (!grab || d < grab.d)) grab = { id: inst.id, d };
      if (box.containsPoint(ray.origin)) continue;
      const p = ray.intersectBox(box, new Vector3());
      if (!p) continue;
      const t = p.distanceTo(ray.origin);
      if (hasModel && (!modeled || t < modeled.t)) modeled = { id: inst.id, t };
      if (!hasModel && (!empty || t < empty.t)) empty = { id: inst.id, t };
    }
    if (grab) return { at: { kind: "instance", id: grab.id }, reach: "grab", distance: grab.d * metres, point: handle.clone() };
    const pick = modeled ?? empty;
    if (!pick) return null;
    const point = ray.at(pick.t, new Vector3()).applyMatrix4(toRoom);
    return { at: { kind: "instance", id: pick.id }, reach: "ray", distance: point.distanceTo(hand.ray.origin), point };
  }

  private press(hand: XRHand, trigger: Trigger, at: SceneHit, reach: Reach): Interaction | boolean {
    if (trigger === "poke") return false;
    const { library } = this;
    if (untrack(() => library.isLocked(at.id))) {
      this.host.notify("That object is locked");
      return true;
    }
    if (at.kind === "stop") {
      this._stop[1]({ id: at.id, field: at.field, index: at.index });
      return new DragStop(this, hand, at, reach === "grab" ? "grab" : "ray");
    }
    if (untrack(() => library.selection).join() !== at.id) library.select([at.id]);
    return new DragInstance(this, hand, at.id, reach === "grab" ? "grab" : "ray");
  }

  /** Placing: the surface the drawing hand's ray meets, and a press puts the kind there. */
  private placeHit(hand: XRHand): Hit | null {
    const spot = this.placeSpot(hand);
    if (!spot) return null;
    const kind = untrack(() => this.placing)!;
    return {
      target: this,
      reach: "ray",
      distance: spot.room.distanceTo(hand.ray.origin),
      point: spot.room,
      press: (_, t) => {
        if (t === "poke") return false;
        this.library.addInstance(null, { kind, position: spot.position, align: true });
        return true;
      },
    };
  }

  /** Where a kind being placed would go along `hand`'s ray: the world position, its cell and the point the ray meets in the room. */
  private placeSpot(hand: XRHand): { position: Vec3; cell: Box; room: Vector3 } | null {
    const kind = untrack(() => this.placing);
    if (!kind) return null;
    const { library } = this;
    const rule = untrack(() => library.kind(kind))?.snap;
    const step = (rule?.step !== undefined ? rule.step * untrack(() => library.stageVoxel) : untrack(() => library.snapStep)) || untrack(() => library.stageVoxel);
    const land = this.landing(hand, new Set(), kind, step);
    if (!land) return null;
    const origin = untrack(() => library.latticeOrigin());
    const p = land.at;
    const cell = p.map((n, a) => origin[a] + Math.floor((n - origin[a]) / step) * step) as Vec3;
    const y = origin[1] + Math.round((p[1] - origin[1]) / step) * step;
    const room = new Vector3(...land.hit).applyMatrix4(this.group.matrixWorld);
    return { position: [cell[0] + step / 2, y, cell[2] + step / 2], cell: { min: [cell[0], y, cell[2]], max: [cell[0] + step, y + step, cell[2] + step] }, room };
  }

  /**
   * Where something of `kind` lands along `hand`'s ray (world units): on the top the ray meets; on
   * a wall or a ceiling only for a kind that stands out of faces; otherwise down from the cell the
   * face opens onto, onto the top below it. `hit` is where the ray met the surface.
   */
  landing(hand: XRHand, exclude: ReadonlySet<string>, kind: string | undefined, step: number): { at: Vec3; hit: Vec3 } | null {
    const hit = this.surface(hand, exclude);
    if (!hit) return null;
    if (hit.normal[1] > 0.5) return { at: [...hit.point] as Vec3, hit: hit.point };
    const off = hit.point.map((n, a) => n + hit.normal[a] * step * 0.5) as Vec3;
    if (untrack(() => this.library.kind(kind))?.snap?.faces) return { at: off, hit: hit.point };
    const below = untrack(() => this.library.surfaceAt({ origin: off, dir: [0, -1, 0] }, exclude));
    return below && below.normal[1] > 0.5 ? { at: [...below.point] as Vec3, hit: hit.point } : null;
  }

  // #endregion

  // #region Helpers for the interactions

  /** A point in the room in world units. */
  toWorld(p: Vector3): Vec3 {
    const v = p.clone().applyMatrix4(this.group.matrixWorld.clone().invert());
    return [v.x, v.y, v.z];
  }

  /** `hand`'s ray in world units. */
  worldRay(hand: XRHand): { origin: Vec3; dir: Vec3 } {
    const inv = this.group.matrixWorld.clone().invert();
    const o = hand.ray.origin.clone().applyMatrix4(inv);
    const d = hand.ray.direction.clone().transformDirection(inv);
    return { origin: [o.x, o.y, o.z], dir: [d.x, d.y, d.z] };
  }

  /** The surface `hand`'s ray meets (stage voxels, objects but `exclude`, the ground), in world units. */
  surface(hand: XRHand, exclude: ReadonlySet<string>) {
    return untrack(() => this.library.surfaceAt(this.worldRay(hand), exclude));
  }

  /** A points field's stops, copied. */
  points(id: string, key: string): Vec3[] {
    const value = untrack(() => this.library.settings(id))[key];
    return Array.isArray(value) ? value.filter(isVec3).map((p) => [...p] as Vec3) : [];
  }

  // #endregion

  // #region Drawing

  /** Each frame: stops' handles stay the same size in the room, and the placing ghost follows the drawing hand. */
  frame(hands: readonly XRHand[]) {
    const metres = new Vector3().setFromMatrixScale(this.group.matrixWorld).x || 1;
    for (const s of this.stops) s.mesh.scale.setScalar(STOP_RADIUS / metres);
    const hand = untrack(() => this.placing) && this.host.moving() ? hands.find((h) => h.tracking && !this.host.isPaletteHand(h) && !this.host.router.captureOf(h)) : undefined;
    const spot = hand ? this.placeSpot(hand) : null;
    this.ghost.visible = !!spot;
    if (spot) {
      const { min, max } = spot.cell;
      this.ghost.matrix.makeScale(max[0] - min[0], max[1] - min[1], max[2] - min[2]).setPosition(min[0], min[1], min[2]);
      this.ghost.matrixWorldNeedsUpdate = true;
    }
  }

  private geometryFor(model: string, frame: string | null): BufferGeometry | null {
    let doc: VoxelDocument;
    try {
      doc = this.library.document(model);
    } catch {
      return null;
    }
    const showing = frame ?? untrack(() => doc.openFrameId);
    const key = `${model}|${showing}`;
    const version = untrack(() => doc.contentVersion);
    const palette = untrack(() => doc.palette);
    const cached = this.geometries.get(key);
    if (cached && cached.doc === doc && cached.version === version && cached.palette === palette) return cached.geometry;
    const size = untrack(() => doc.size);
    const volume = untrack(() => doc.volume(showing));
    if (volume.length !== size[0] * size[1] * size[2]) return cached?.geometry ?? null;
    const geometry = this.mesher.build(volume, size, palette);
    cached?.geometry.dispose();
    this.geometries.set(key, { geometry, doc, version, palette });
    return geometry;
  }

  private rebuildMeshes() {
    const { library } = this;
    this.meshes.clear();
    for (const inst of untrack(() => library.instances)) {
      const model = untrack(() => library.modelFor(inst.id));
      if (inst.scene !== undefined) {
        // a scene placed whole: what it holds, as it stands
        if (!untrack(() => library.isShown(inst.id))) continue;
        for (const c of untrack(() => library.placedContents(inst.id))) this.addMesh(c.model, c.frame, c.matrix);
        continue;
      }
      if (!model || model === this.stage || !untrack(() => library.isShown(inst.id))) continue;
      this.addMesh(model, untrack(() => library.frameOf(inst.id)), untrack(() => library.meshMatrix(inst.id)));
    }
    const models = new Set(untrack(() => library.allModels).map((m) => m.id));
    for (const [key, g] of this.geometries) {
      if (models.has(key.split("|")[0])) continue;
      g.geometry.dispose();
      this.geometries.delete(key);
    }
  }

  private addMesh(model: string, frame: string | null, matrix: Mat4) {
    const geometry = this.geometryFor(model, frame);
    if (!geometry) return;
    const mesh = new Mesh(geometry, this.material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.fromArray(matrix);
    mesh.userData.shared = true;
    this.meshes.add(mesh);
  }

  /** Boxes for kinds without a model, in their color; the selection in the accent; what a hand is at in white. */
  private rebuildOutlines() {
    const { library } = this;
    disposeTree(this.outlines);
    this.outlines.clear();
    const selected = new Set(untrack(() => library.selection));
    for (const inst of untrack(() => library.instances)) {
      if (!untrack(() => library.isShown(inst.id))) continue;
      const isSelected = selected.has(inst.id);
      const isHot = this.hot.has(inst.id);
      const model = untrack(() => library.modelFor(inst.id));
      if (!isSelected && !isHot && (model || untrack(() => library.isGroup(inst.id)))) continue;
      const local = this.localBox(inst.id);
      if (!local) continue;
      const kind = inst.kind ? untrack(() => library.kindInfo(inst.kind!)) : undefined;
      const color = isSelected ? ACCENT : isHot ? WHITE : (kind?.color ?? 0x9aa0a6);
      const lines = boxLines(local.box, color, isSelected || isHot ? 0.95 : 0.6);
      lines.matrixAutoUpdate = false;
      lines.matrix.fromArray(local.matrix);
      this.outlines.add(lines);
    }
  }

  private localBox(id: string): { box: Box; matrix: Mat4 } | null {
    const { library } = this;
    const model = untrack(() => library.modelFor(id));
    if (model) {
      const doc = library.document(model);
      const b = untrack(() => doc.contentBounds()) ?? { min: [0, 0, 0] as Vec3, max: untrack(() => doc.size).map((n) => n - 1) as Vec3 };
      return { box: { min: b.min, max: b.max.map((n) => n + 1) as Vec3 }, matrix: untrack(() => library.meshMatrix(id)) };
    }
    const box = untrack(() => library.instanceBounds(id));
    return box ? { box, matrix: untrack(() => library.worldMatrix(id)) } : null;
  }

  /** The selected instance's path stops, and the path between them. */
  private rebuildStops() {
    disposeTree(this.handles, [this.stopGeometry, this.stopMaterial, this.chosenMaterial]);
    this.handles.clear();
    this.stops = [];
    const { library } = this;
    const sel = untrack(() => library.selection);
    if (sel.length !== 1 || untrack(() => library.isLocked(sel[0]))) return;
    const id = sel[0];
    const inst = untrack(() => library.instance(id));
    const fields = (untrack(() => library.kind(inst?.kind))?.fields ?? []).filter((f) => f.type === "points");
    const chosen = untrack(() => this._stop[0]());
    for (const field of fields) {
      const m = pointsFrame(library, id, field);
      const pts = this.points(id, field.key).map((p) => transformPoint(m, p));
      pts.forEach((p, index) => {
        const isChosen = chosen?.id === id && chosen.field === field.key && chosen.index === index;
        const mesh = new Mesh(this.stopGeometry, isChosen ? this.chosenMaterial : this.stopMaterial);
        mesh.position.set(...p);
        mesh.renderOrder = 6;
        this.handles.add(mesh);
        this.stops.push({ id, field: field.key, index, mesh });
      });
      const display = field.type === "points" ? (field.display ?? "path") : "points";
      const pairs = display === "points" ? 0 : display === "loop" && pts.length > 2 ? pts.length : pts.length - 1;
      const positions: number[] = [];
      for (let i = 0; i < pairs; i++) positions.push(...pts[i], ...pts[(i + 1) % pts.length]);
      if (positions.length) {
        const geometry = new BufferGeometry();
        geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
        this.handles.add(new LineSegments(geometry, new LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.9 })));
      }
    }
  }

  // #endregion

  dispose() {
    this.disposeRoot();
    disposeTree(this.outlines);
    disposeTree(this.handles, [this.stopGeometry, this.stopMaterial, this.chosenMaterial]);
    for (const g of this.geometries.values()) g.geometry.dispose();
    this.geometries.clear();
    this.material.dispose();
    this.stopGeometry.dispose();
    this.stopMaterial.dispose();
    this.chosenMaterial.dispose();
    this.ghost.geometry.dispose();
    (this.ghost.material as LineBasicMaterial).dispose();
    this.group.removeFromParent();
  }
}

/**
 * Carrying an object: held, it follows the hand, lined up with the stage's cells as its kind
 * snaps; along the ray, it lands on the surface the ray meets. One undo step.
 */
class DragInstance implements Interaction {
  private start: Vec3;
  private handStart: Vec3;

  constructor(
    private view: SceneView,
    hand: XRHand,
    private id: string,
    private mode: "grab" | "ray",
  ) {
    const { library } = view;
    library.beginStroke(`Move ${untrack(() => library.instance(id))?.name ?? "object"}`);
    this.start = this.origin();
    this.handStart = view.toWorld(hand.handle);
  }

  private origin(): Vec3 {
    return transformPoint(untrack(() => this.view.library.worldMatrix(this.id)), [0, 0, 0]);
  }

  update(hand: XRHand) {
    const { library } = this.view;
    let target: Vec3;
    if (this.mode === "grab") {
      const now = this.view.toWorld(hand.handle);
      target = this.start.map((n, a) => n + now[a] - this.handStart[a]) as Vec3;
    } else {
      const step = untrack(() => library.snapStepFor(this.id)) ?? untrack(() => library.stageVoxel);
      const land = this.view.landing(hand, new Set([this.id]), untrack(() => library.instance(this.id))?.kind, step);
      if (!land) return;
      target = land.at;
    }
    const inst = untrack(() => library.instance(this.id));
    if (!inst) return;
    if (!inst.parent) target = untrack(() => library.alignPosition(this.id, target));
    const at = this.origin();
    const delta = target.map((n, a) => n - at[a]) as Vec3;
    if (delta.some((n) => Math.abs(n) > 1e-6)) library.moveInstances([this.id], delta);
  }

  end() {
    this.view.library.endStroke();
  }

  cancel() {
    this.view.library.cancelStroke();
  }

  resume(hand: XRHand) {
    this.start = this.origin();
    this.handStart = this.view.toWorld(hand.handle);
  }
}

/** Dragging a path's stop: held, it follows the hand; along the ray, it slides at its height. Snapped to the object's step. */
class DragStop implements Interaction {
  private start: Vec3;
  private handStart: Vec3;

  constructor(
    private view: SceneView,
    hand: XRHand,
    private at: { id: string; field: string; index: number },
    private mode: "grab" | "ray",
  ) {
    const { library } = view;
    const field = this.field();
    library.beginStroke(`Change ${field?.label ?? at.field}`);
    const m = field ? pointsFrame(library, at.id, field) : new Matrix4().toArray();
    this.start = transformPoint(m, view.points(at.id, at.field)[at.index] ?? [0, 0, 0]);
    this.handStart = view.toWorld(hand.handle);
  }

  private field(): Field | undefined {
    const { library } = this.view;
    const inst = untrack(() => library.instance(this.at.id));
    return untrack(() => library.kind(inst?.kind))?.fields?.find((f) => f.key === this.at.field);
  }

  update(hand: XRHand) {
    const { library } = this.view;
    const field = this.field();
    if (!field) return;
    let world: Vec3;
    if (this.mode === "grab") {
      const now = this.view.toWorld(hand.handle);
      world = this.start.map((n, a) => n + now[a] - this.handStart[a]) as Vec3;
    } else {
      const { origin, dir } = this.view.worldRay(hand);
      if (Math.abs(dir[1]) < 1e-6) return;
      const t = (this.start[1] - origin[1]) / dir[1];
      if (t <= 0) return;
      world = [origin[0] + dir[0] * t, this.start[1], origin[2] + dir[2] * t];
    }
    const inv = invertMat(pointsFrame(library, this.at.id, field));
    const step = untrack(() => library.snapStepFor(this.at.id));
    const tidy = (n: number) => Math.round(n * 1e6) / 1e6 || 0;
    const local = transformPoint(inv, world).map((n) => tidy(step ? Math.round(n / step) * step : n)) as Vec3;
    const pts = this.view.points(this.at.id, this.at.field);
    const was = pts[this.at.index];
    if (!was || was.every((n, a) => n === local[a])) return;
    pts[this.at.index] = local;
    library.setData(this.at.id, { [this.at.field]: pts }, `Change ${field.label ?? field.key}`);
  }

  end() {
    this.view.library.endStroke();
  }

  cancel() {
    this.view.library.cancelStroke();
  }

  resume(hand: XRHand) {
    const field = this.field();
    const m = field ? pointsFrame(this.view.library, this.at.id, field) : new Matrix4().toArray();
    this.start = transformPoint(m, this.view.points(this.at.id, this.at.field)[this.at.index] ?? this.start);
    this.handStart = this.view.toWorld(hand.handle);
  }
}

/** The Objects window's kinds, as menu items: grouped kinds in a submenu each, the rest after. */
export function kindMenu(kinds: readonly InstanceKind[], choose: (kind: InstanceKind) => void): XRMenuItem[] {
  const item = (k: InstanceKind): XRMenuItem => ({ id: `kind:${k.id}`, label: k.label, onSelect: () => choose(k) });
  const groups = new Map<string, InstanceKind[]>();
  for (const k of kinds) if (k.group) groups.set(k.group, [...(groups.get(k.group) ?? []), k]);
  return [
    ...[...groups].map(([label, list]) => ({ id: `group:${label}`, label, detail: String(list.length), items: () => list.map(item) })),
    ...kinds.filter((k) => !k.group).map(item),
  ];
}

/** A box's edges, in world units. */
function boxLines(box: Box, color: number, opacity: number): LineSegments {
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const c = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const edges = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(edges.flatMap((i) => c[i])), 3));
  return new LineSegments(geometry, new LineBasicMaterial({ color, transparent: true, opacity }));
}

/** Dispose what a group's children own, but what is shared. */
function disposeTree(group: Object3D, shared: readonly object[] = []) {
  group.traverse((o) => {
    if (o === group) return;
    const mesh = o as Partial<Mesh>;
    if (mesh.geometry && !shared.includes(mesh.geometry)) mesh.geometry.dispose();
    const material = mesh.material;
    if (material) for (const m of Array.isArray(material) ? material : [material]) if (!shared.includes(m)) m.dispose();
  });
}
