// The extrude tool's work in a session: the face it takes, the extrusion pending with a depth
// handle, and applying it. The geometry is in extrude.ts. See docs/extrusion.md.

import { batch, untrack } from "solid-js";
import type { EditorInternals } from "./editor-internals";
import { depthHandle, extrudeCells, faceBounds, faceRegion, type Extrusion } from "./extrude";
import { dominantAxis, raycastVolume, type Hit } from "./raycast";
import { signal } from "./signal";
import type { Layer, Preview, Ray, Vec3 } from "./types";

export class EditorExtrusion {
  private _extrusion = signal<Extrusion | null>(null);
  /** The depth a tap with the extrude tool uses: the last one applied. */
  private _lastExtrusionDepth = 1;

  get pendingExtrusion(): Extrusion | null {
    return this._extrusion.get();
  }

  /** A new document: nothing pending. */
  reset() {
    this._extrusion.set(null);
  }

  constructor(private readonly s: EditorInternals) {}

  private get ed() {
    return this.s.editor;
  }

  extrusionRegion(cell: Vec3, normal: Vec3): Vec3[] {
    const layer = this.ed.activeLayer;
    if (!layer || !this.ed.inBounds(cell)) return [];
    const axis = dominantAxis(normal);
    const sign = normal[axis] > 0 ? 1 : -1;
    // an override layer extrudes the faces you see, wherever they came from
    const data = this.extrusionSource(layer);
    const mask = this.s.selectedCount > 0 ? this.s.selection : null;
    return faceRegion(cell, axis, this.ed.size, (c) => {
      const i = this.ed.index(...c);
      if (!data[i] || (mask && !mask[i]) || !this.ed.inSlice(c)) return false;
      const front = [...c] as Vec3;
      front[axis] += sign;
      return !this.ed.inBounds(front) || !data[this.ed.index(...front)];
    });
  }

  startExtrusion(cell: Vec3, normal: Vec3, depth = 0): boolean {
    this.s.settle();
    if (this.s.refuse(this.s.prepareEdit())) return false;
    const base = this.extrusionRegion(cell, normal);
    if (!base.length) {
      const clipped = this.s.selectedCount > 0 && !this.ed.isSelected(cell);
      this.ed.notify(clipped ? "Only the selection can be edited" : "There's no face to extrude there");
      return false;
    }
    const axis = dominantAxis(normal);
    this._extrusion.set({ layerId: this.ed.activeLayerId, normal: { axis, sign: normal[axis] > 0 ? 1 : -1 }, base, depth: 0 });
    this.setExtrusionDepth(depth);
    return true;
  }

  setExtrusionDepth(depth: number) {
    const ext = untrack(() => this.pendingExtrusion);
    if (!ext) return;
    const reach = this.ed.size[ext.normal.axis];
    const next = { ...ext, depth: Math.max(-reach, Math.min(reach, Math.round(depth))) };
    batch(() => {
      this._extrusion.set(next);
      this.s.preview.set(this.extrusionPreview(next));
    });
  }

  get lastExtrusionDepth() {
    return this._lastExtrusionDepth;
  }

  applyExtrusion(): boolean {
    const ext = untrack(() => this.pendingExtrusion);
    if (!ext) return false;
    const layer = this.ed.layer(ext.layerId);
    if (layer?.locked) {
      this.ed.notify("Layer is locked");
      return false;
    }
    this.cancelExtrusion();
    if (!layer || ext.depth === 0) return false;
    this._lastExtrusionDepth = ext.depth;
    const data = this.extrusionSource(layer);
    const { cells, values } = this.extrusionResult(ext, data);
    const pulling = ext.depth > 0;
    const mask = this.s.selectedCount > 0 ? this.s.selection : null;
    let changed = 0;
    this.ed.transact(pulling ? "Extrude" : "Carve", () => {
      cells.forEach((c, k) => {
        const i = this.ed.index(...c);
        if (layer.coverage) {
          // pulling covers empty cells with the face's colors; carving covers visible ones with empty
          const next = pulling ? (this.ed.composite[i] ? null : values[k]) : this.ed.composite[i] ? 0 : null;
          if (next !== null && this.s.writeState(layer, i, next)) changed++;
        } else {
          const next = pulling ? data[i] || values[k] : 0;
          if (next !== data[i]) {
            this.s.write(data, i, next);
            changed++;
          }
        }
        if (mask) this.s.write(mask, i, pulling ? 1 : 0);
      });
    });
    return changed > 0;
  }

  cancelExtrusion() {
    if (!untrack(() => this.pendingExtrusion)) return;
    batch(() => {
      this._extrusion.set(null);
      this.s.preview.set(null);
    });
  }

  extrude(cell: Vec3, normal: Vec3, depth: number): boolean {
    if (!this.startExtrusion(cell, normal, depth)) return false;
    return this.applyExtrusion();
  }

  extrusionPreview(ext: Extrusion): Preview {
    const layer = this.ed.layer(ext.layerId);
    const data = layer && this.extrusionSource(layer);
    const { cells, values } = data ? this.extrusionResult(ext, data) : { cells: [], values: [] };
    // the face's outline, stretched to where it is pulled or pushed
    const { axis, sign } = ext.normal;
    const box = faceBounds(ext);
    const face = box.min[axis];
    const far = ext.depth > 0 ? face + sign * ext.depth : face - sign * Math.max(0, -ext.depth - 1);
    box.min[axis] = Math.max(0, Math.min(face, far));
    box.max[axis] = Math.min(this.ed.size[axis] - 1, Math.max(face, far));
    return {
      kind: ext.depth < 0 ? "erase" : "add",
      boxes: [],
      cells,
      values,
      outlines: this.ed.mirrorBoxes([box]),
    };
  }

  extrusionHandle(): Vec3 | null {
    const ext = this.pendingExtrusion;
    return ext && depthHandle(ext);
  }

  pickExtrusion(ray: Ray): Hit | null {
    const ext = untrack(() => this.pendingExtrusion);
    const layer = ext && this.ed.layer(ext.layerId);
    const data = layer && this.extrusionSource(layer);
    if (!ext || !data) return null;
    const cells = new Set([...ext.base, ...this.extrusionResult(ext, data).cells].map((c) => this.ed.index(...c)));
    return raycastVolume(ray, this.ed.size, (i) => cells.has(i));
  }

  /** What the extrude tool reads for a layer: its voxels, or for an override layer, the visible ones. */
  extrusionSource(layer: Layer): Uint8Array {
    return layer.coverage ? this.ed.composite : layer.data;
  }

  /** The cells an extrusion changes, mirrored like any brush, and the colors they take. */
  extrusionResult(ext: Extrusion, data: Uint8Array) {
    const { cells, values } = extrudeCells(ext, this.ed.size, (c) => data[this.ed.index(...c)]);
    const mirrored = this.ed.mirrorCells(cells);
    // mirrorCells appends reflected copies in order, so each copy's color repeats with it
    return { cells: mirrored, values: mirrored.map((_, k) => values[k % values.length]) };
  }
}
