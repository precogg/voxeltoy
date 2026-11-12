// Handles from a kind's fields (docs/scenes.md, "Fields, inspector and handles"): a point is a dot
// to drag, a path's vertices drag and split, a size has face arrows, a radius a ring, a ref a line
// to its target. Every drag is one undo step; a second finger puts the start value back.

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Vector2,
} from "three";
import { createSignal, untrack } from "solid-js";
import type { LibraryEditor } from "@voxeltoy/core/library";
import type { Field } from "@voxeltoy/core/scene-kinds";
import { invertMat, transformDirection, transformPoint, translationMat, multiplyMat, type Mat4 } from "@voxeltoy/core/scene-math";
import type { Json, Ray, Vec3 } from "@voxeltoy/core/types";

/** What a pointer is over: one of a field's handles. */
export interface FieldHit {
  field: Field;
  /** A path vertex, or for a split, the vertex the new one goes after. */
  index?: number;
  part: "point" | "vertex" | "split" | "size" | "radius";
  /** For a size handle: which axis it pulls. */
  axis?: 0 | 1 | 2;
}

/** What the handles need from the layer that draws them. */
export interface FieldHandleHost {
  scene: LibraryEditor;
  /** Where a world point is on screen, in client pixels. */
  screenOf(p: Vec3): { x: number; y: number } | null;
  requestRender(): void;
  accent(): string;
  /** A ghost of an instance's model at a world matrix, or null if it has none. */
  ghost(id: string, matrix: Mat4): Mesh | null;
}

const AXES = ["x", "y", "z"] as const;

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

/** Where a ray meets the level plane y = `height`, or null. */
function onLevel(ray: Ray, height: number): Vec3 | null {
  if (Math.abs(ray.dir[1]) < 1e-6) return null;
  const t = (height - ray.origin[1]) / ray.dir[1];
  return t > 0 ? (ray.origin.map((o, a) => o + ray.dir[a] * t) as Vec3) : null;
}

/** The parameter along the line p0 + t·u (u unit) closest to a ray. */
function lineParam(ray: Ray, p0: Vec3, u: Vec3): number | null {
  const v = ray.dir;
  const w0 = p0.map((o, a) => o - ray.origin[a]) as Vec3;
  const b = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const denom = 1 - b * b;
  if (denom < 1e-6) return null;
  const d = u[0] * w0[0] + u[1] * w0[1] + u[2] * w0[2];
  const e = v[0] * w0[0] + v[1] * w0[1] + v[2] * w0[2];
  return (b * e - d) / denom;
}

let dotTexture: CanvasTexture | null = null;
function dot(): CanvasTexture {
  if (dotTexture) return dotTexture;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#fff";
  g.beginPath();
  g.arc(16, 16, 13, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = "#000";
  g.globalAlpha = 0.35;
  g.stroke();
  dotTexture = new CanvasTexture(canvas);
  return dotTexture;
}

export class FieldHandles {
  readonly group = new Group();
  /** The path vertex last touched, so Delete point and the inspector act on it. */
  private _vertex = createSignal<{ instance: string; field: string; index: number } | null>(null);
  private drag: { hit: FieldHit; id: string; height: number; grab: Vec3 } | null = null;
  /** Each drawn handle's world position, for hit testing. */
  private spots: { hit: FieldHit; p: Vec3 }[] = [];

  constructor(private host: FieldHandleHost) {}

  get vertex() {
    return this._vertex[0]();
  }

  selectVertex(v: { instance: string; field: string; index: number } | null) {
    this._vertex[1](v);
    this.rebuild();
  }

  /** The instance whose handles show: the only one selected, with fields. */
  private target(): { id: string; fields: Field[] } | null {
    const scene = this.host.scene;
    const selection = untrack(() => scene.selection);
    if (selection.length !== 1) return null;
    const inst = untrack(() => scene.instance(selection[0]));
    const fields = untrack(() => scene.kind(inst?.kind)?.fields) ?? [];
    return inst && !untrack(() => scene.isLocked(inst.id)) && fields.length ? { id: inst.id, fields } : null;
  }

  /** Field space to world: the instance's frame for relative fields, sizes and radii; the world otherwise. */
  private frame(id: string, field: Field): Mat4 {
    const relative = field.type === "size" || field.type === "radius" || ((field.type === "point" || field.type === "points") && field.relative);
    return relative ? untrack(() => this.host.scene.worldMatrix(id)) : translationMat([0, 0, 0]);
  }

  /** Dispose what the handles own; ghosts share their model's geometry and material. */
  private clear() {
    this.group.traverse((o) => {
      const m = o as Mesh;
      if ((m.userData as { ghost?: boolean }).ghost) return;
      m.geometry?.dispose();
      (m.material as MeshBasicMaterial | undefined)?.dispose?.();
    });
    this.group.clear();
  }

  rebuild() {
    this.clear();
    this.spots = [];
    const target = this.target();
    if (!target) return this.host.requestRender();
    const { id, fields } = target;
    const scene = this.host.scene;
    const settings = untrack(() => scene.settings(id));
    const origin = transformPoint(untrack(() => scene.worldMatrix(id)), [0, 0, 0]);
    const dots: Vec3[] = [];
    const small: Vec3[] = [];
    const segments: number[] = [];
    const vertex = untrack(() => this.vertex);
    const chosen: Vec3[] = [];

    for (const field of fields) {
      const value = settings[field.key];
      const m = this.frame(id, field);
      if (field.type === "point" && field.handle !== false && isVec3(value)) {
        const p = transformPoint(m, value);
        dots.push(p);
        this.spots.push({ hit: { field, part: "point" }, p });
      } else if (field.type === "points" && Array.isArray(value)) {
        const pts = (value as Json[]).filter(isVec3).map((v) => transformPoint(m, v as Vec3));
        pts.forEach((p, i) => {
          const isChosen = vertex?.instance === id && vertex.field === field.key && vertex.index === i;
          (isChosen ? chosen : dots).push(p);
          this.spots.push({ hit: { field, part: "vertex", index: i }, p });
        });
        const display = field.display ?? "path";
        const pairs = display === "points" ? 0 : display === "loop" && pts.length > 2 ? pts.length : pts.length - 1;
        for (let i = 0; i < pairs; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          segments.push(...a, ...b);
          const mid = a.map((n, k) => (n + b[k]) / 2) as Vec3;
          small.push(mid);
          this.spots.push({ hit: { field, part: "split", index: i }, p: mid });
        }
        if (field.ghost) {
          // the model, faintly, at each stop: where it will be
          const world = untrack(() => scene.meshMatrix(id));
          for (const p of pts) {
            const ghost = this.host.ghost(id, multiplyMat(translationMat(p.map((n, k) => n - origin[k]) as Vec3), world));
            if (ghost) this.group.add(ghost);
          }
        }
      } else if (field.type === "size") {
        const size = isVec3(value) ? value : ([1, 1, 1] as Vec3);
        for (const a of field.axes.map((x) => AXES.indexOf(x)) as (0 | 1 | 2)[]) {
          const local: Vec3 = [0, 0, 0];
          local[a] = field.anchor === "min" ? size[a] : size[a] / 2;
          const p = transformPoint(m, local);
          dots.push(p);
          this.spots.push({ hit: { field, part: "size", axis: a }, p });
          segments.push(...transformPoint(m, [0, 0, 0]), ...p);
        }
      } else if (field.type === "radius" && typeof value === "number") {
        const ring: Vec3[] = [];
        for (let i = 0; i <= 48; i++) {
          const t = (i / 48) * Math.PI * 2;
          ring.push(transformPoint(m, [Math.cos(t) * value, 0, Math.sin(t) * value]));
        }
        for (let i = 1; i < ring.length; i++) segments.push(...ring[i - 1], ...ring[i]);
        const p = transformPoint(m, [value, 0, 0]);
        dots.push(p);
        this.spots.push({ hit: { field, part: "radius" }, p });
      } else if (field.type === "ref" && typeof value === "string" && untrack(() => scene.instance(value))) {
        const to = transformPoint(untrack(() => scene.worldMatrix(value)), [0, 0, 0]);
        segments.push(...origin, ...to);
      }
    }

    const accent = this.host.accent();
    const points = (list: Vec3[], size: number, color: string, opacity = 1) => {
      if (!list.length) return;
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(new Float32Array(list.flat()), 3));
      const p = new Points(g, new PointsMaterial({ size, sizeAttenuation: false, map: dot(), color, transparent: true, opacity, depthTest: false, depthWrite: false, alphaTest: 0.1 }));
      p.renderOrder = 13;
      this.group.add(p);
    };
    if (segments.length) {
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(new Float32Array(segments), 3));
      const lines = new LineSegments(g, new LineBasicMaterial({ color: accent, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false }));
      lines.renderOrder = 12;
      this.group.add(lines);
    }
    points(small, 9, accent, 0.6);
    points(dots, 14, accent);
    points(chosen, 18, "#ffffff");
    this.host.requestRender();
  }

  /** The handle within `reach` CSS pixels of a client point, nearest first. */
  hit(x: number, y: number, reach: number): FieldHit | null {
    const pointer = new Vector2(x, y);
    let best: FieldHit | null = null;
    let bestDistance = reach;
    for (const spot of this.spots) {
      const s = this.host.screenOf(spot.p);
      if (!s) continue;
      // splits sit between vertices: a little harder to grab, so vertices win when they are close
      const d = pointer.distanceTo(new Vector2(s.x, s.y)) + (spot.hit.part === "split" ? 4 : 0);
      if (d < bestDistance) {
        best = spot.hit;
        bestDistance = d;
      }
    }
    return best;
  }

  /** Start dragging a handle. Splitting a path inserts the new vertex first. */
  begin(hit: FieldHit, ray: Ray) {
    const target = this.target();
    if (!target) return false;
    const { id } = target;
    const scene = this.host.scene;
    scene.beginStroke(`Change ${hit.field.label ?? hit.field.key}`);
    let index = hit.index;
    if (hit.part === "split" && hit.index !== undefined) {
      const pts = (untrack(() => scene.settings(id))[hit.field.key] as Vec3[]).map((p) => [...p] as Vec3);
      const a = pts[hit.index];
      const b = pts[(hit.index + 1) % pts.length];
      pts.splice(hit.index + 1, 0, a.map((n, k) => (n + b[k]) / 2) as Vec3);
      scene.setData(id, { [hit.field.key]: pts });
      index = hit.index + 1;
    }
    const spot = this.spots.find((s) => s.hit.field === hit.field && s.hit.part === hit.part && s.hit.index === hit.index && s.hit.axis === hit.axis);
    const p = spot?.p ?? transformPoint(untrack(() => scene.worldMatrix(id)), [0, 0, 0]);
    const at = onLevel(ray, p[1]) ?? p;
    this.drag = { hit: { ...hit, part: hit.part === "split" ? "vertex" : hit.part, index }, id, height: p[1], grab: at.map((n, k) => n - p[k]) as Vec3 };
    if (hit.field.type === "points" && index !== undefined) this._vertex[1]({ instance: id, field: hit.field.key, index });
    return true;
  }

  move(ray: Ray) {
    const drag = this.drag;
    if (!drag) return;
    const { hit, id } = drag;
    const scene = this.host.scene;
    const field = hit.field;
    const m = this.frame(id, field);
    const inv = invertMat(m);
    const step = untrack(() => scene.snapStepFor(id));
    // round away float noise, so stored settings read as the numbers they are
    const tidy = (n: number) => Math.round(n * 1e6) / 1e6 || 0;
    const snap = (n: number, s = step) => tidy(s ? Math.round(n / s) * s : n);
    const scale = Math.hypot(m[0], m[1], m[2]) || 1;
    let value: Json | undefined;
    if (hit.part === "point" || hit.part === "vertex") {
      const at = onLevel(ray, drag.height);
      if (!at) return;
      const local = transformPoint(inv, at.map((n, k) => n - drag.grab[k]) as Vec3).map((n, k) => (k === 1 ? tidy(n) : snap(n))) as Vec3;
      if (hit.part === "point") value = local;
      else {
        const pts = (untrack(() => scene.settings(id))[field.key] as Vec3[]).map((p) => [...p] as Vec3);
        pts[hit.index!] = local;
        value = pts;
      }
    } else if (hit.part === "size" && field.type === "size") {
      const axisDir: Vec3 = [0, 0, 0];
      axisDir[hit.axis!] = 1;
      const u = transformDirection(m, axisDir);
      const len = Math.hypot(...u) || 1;
      const t = lineParam(ray, transformPoint(m, [0, 0, 0]), u.map((n) => n / len) as Vec3);
      if (t === null) return;
      const local = t / scale;
      let n = field.anchor === "min" ? local : 2 * local;
      n = snap(n, field.step ?? step);
      n = Math.max(field.min ?? (field.step ?? step ?? 0.01), Math.min(field.max ?? Infinity, n));
      const size = untrack(() => scene.settings(id))[field.key];
      const next = (isVec3(size) ? [...size] : [1, 1, 1]) as Vec3;
      next[hit.axis!] = n;
      value = next;
    } else if (hit.part === "radius" && field.type === "radius") {
      const origin = transformPoint(m, [0, 0, 0]);
      const at = onLevel(ray, origin[1]);
      if (!at) return;
      let r = Math.hypot(at[0] - origin[0], at[2] - origin[2]) / scale;
      r = snap(r);
      value = Math.max(field.min ?? 0, Math.min(field.max ?? Infinity, r));
    }
    if (value !== undefined) scene.setData(id, { [field.key]: value }, `Change ${field.label ?? field.key}`);
  }

  end() {
    if (this.drag) this.host.scene.endStroke();
    this.drag = null;
  }

  cancel() {
    if (this.drag) this.host.scene.cancelStroke();
    this.drag = null;
  }

  /** Delete a path's vertex: the one last touched, or its last. A path keeps at least one. */
  deleteVertex(instance: string, key: string) {
    const scene = this.host.scene;
    const pts = untrack(() => scene.settings(instance))[key];
    if (!Array.isArray(pts) || pts.length < 2) return false;
    const v = untrack(() => this.vertex);
    const index = v?.instance === instance && v.field === key && v.index < pts.length ? v.index : pts.length - 1;
    const next = pts.filter((_, i) => i !== index);
    this._vertex[1](null);
    return scene.setData(instance, { [key]: next }, "Delete point");
  }

  /** Add a vertex after the last touched (or the last), a step along from it. */
  addVertex(instance: string, key: string) {
    const scene = this.host.scene;
    const pts = untrack(() => scene.settings(instance))[key];
    const list = Array.isArray(pts) ? (pts as Json[]).filter(isVec3).map((p) => [...(p as Vec3)] as Vec3) : [];
    const v = untrack(() => this.vertex);
    const index = v?.instance === instance && v.field === key && v.index < list.length ? v.index : list.length - 1;
    const from = list[index] ?? ([0, 0, 0] as Vec3);
    const step = untrack(() => scene.snapStepFor(instance)) ?? 1;
    list.splice(index + 1, 0, [from[0] + step * 2, from[1], from[2]]);
    this._vertex[1]({ instance, field: key, index: index + 1 });
    return scene.setData(instance, { [key]: list }, "Add point");
  }

  dispose() {
    this.clear();
  }
}
