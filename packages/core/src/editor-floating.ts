// Floating content in a session: what a move, rotate, flip, duplicate or paste lifts, until it
// is applied or cancelled, and the clipboard copies go to. See docs/selection.md.

import { untrack } from "solid-js";
import type { VoxelClipboard } from "./clipboard";
import type { EditorInternals } from "./editor-internals";
import { mirror, quarterTurn } from "./grid";
import { nearestColor } from "./palette";
import { raycastVolume, type Hit } from "./raycast";
import { extractBlock, flipBlock, maskBounds, rotateBlock, type Block, type Floating } from "./selection";
import { signal } from "./signal";
import type { Axis, Ray, Vec3 } from "./types";

export class EditorFloating {
  private _floating = signal<Floating | null>(null);
  /** Source cells hidden while floating content is moved; they are erased when it is applied. */
  lifted: { data: Uint8Array; mask: Uint8Array } | null = null;
  /** Where the floating content was lifted from, to tell whether applying changes anything. */
  private floatOrigin: Vec3 = [0, 0, 0];
  /** Twice the floating content's center when it was lifted, to measure how far it has moved. */
  private floatHome: Vec3 = [0, 0, 0];
  /** Twice the floating content's center, so four quarter turns land where they started. */
  private floatPivot: Vec3 = [0, 0, 0];

  get floating(): Floating | null {
    return this._floating.get();
  }

  get floatingDelta(): Vec3 | null {
    const f = this.floating;
    if (!f) return null;
    return f.offset.map((n, a) => Math.trunc((2 * n + f.size[a] - this.floatHome[a]) / 2)) as Vec3;
  }

  /** A new document: nothing floating. */
  reset() {
    this.lifted = null;
    this._floating.set(null);
  }

  constructor(
    private readonly s: EditorInternals,
    private readonly clipboard: VoxelClipboard,
  ) {}

  private get ed() {
    return this.s.editor;
  }

  copy(): boolean {
    this.s.settle();
    const box = this.ed.selectionBounds();
    const layer = this.ed.activeLayer;
    if (!box || !layer) {
      this.ed.notify("Nothing selected");
      return false;
    }
    if (layer.shape) {
      this.ed.notify("Shape layers have no voxels to copy");
      return false;
    }
    this.clipboard.set({
      block: extractBlock(layer.data, this.s.selection, this.ed.size, box, layer.coverage),
      offset: [...box.min],
      palette: this.ed.palette,
    });
    return true;
  }

  cut(): boolean {
    if (!this.copy()) return false;
    // cutting from an override leaves its cells unset, so what is below shows through
    this.s.editSelection("Cut", () => 0, (state) => (state >= 0 ? -1 : null));
    return true;
  }

  paste(): boolean {
    this.s.settle();
    const clip = untrack(() => this.clipboard.clip);
    if (!clip) return false;
    if (this.s.refuse(this.s.prepareEdit())) return false;
    // copied from another document: match colors by value
    const palette = this.ed.palette;
    const remap = new Map<number, number>();
    const voxels = clip.block.voxels.map((v) => {
      if (!v || palette[v] === clip.palette[v]) return v;
      let to = remap.get(v);
      if (to === undefined) remap.set(v, (to = nearestColor(palette, clip.palette[v] ?? 0)));
      return to;
    });
    this.startFloat({ ...clip.block, voxels }, clip.offset, "paste", true);
    return true;
  }

  duplicateSelection(): boolean {
    if (this.s.selectedCount === 0) {
      this.ed.notify("Nothing selected");
      return false;
    }
    this.s.settle();
    return !!this.lift("duplicate");
  }

  moveSelection(delta: Vec3) {
    const f = untrack(() => this.floating) ?? this.lift("move");
    if (f) this.setFloatingOffset([f.offset[0] + delta[0], f.offset[1] + delta[1], f.offset[2] + delta[2]]);
  }

  rotateSelection(axis: Axis, turns = 1) {
    turns = ((Math.round(turns) % 4) + 4) % 4;
    let f = untrack(() => this.floating) ?? this.lift("move");
    if (!f) return;
    for (let i = 0; i < turns; i++) {
      const block = rotateBlock(f, axis);
      this.s.orientValues(block.voxels, quarterTurn(axis));
      const offset = block.size.map((n, a) => Math.floor((this.floatPivot[a] - n) / 2)) as Vec3;
      f = this.placeFloat({ ...f, ...block, offset, turned: true }, false);
    }
  }

  flipSelection(axis: Axis) {
    const f = untrack(() => this.floating) ?? this.lift("move");
    if (!f) return;
    const block = flipBlock(f, axis);
    this.s.orientValues(block.voxels, mirror(axis));
    this.placeFloat({ ...f, ...block, turned: true }, false);
  }

  liftSelection(): Floating | null {
    return untrack(() => this.floating) ?? this.lift("move");
  }

  setFloatingOffset(offset: Vec3) {
    const f = untrack(() => this.floating);
    if (f) this.placeFloat({ ...f, offset }, true);
  }

  applyTransform(): boolean {
    const f = untrack(() => this.floating);
    if (!f) return false;
    const layer = this.ed.layer(f.layerId);
    const unchanged = f.kind === "move" && !f.turned && f.offset.every((n, a) => n === this.floatOrigin[a]);
    if (!layer || unchanged) {
      this.cancelTransform();
      return false;
    }
    if (layer.locked) {
      this.ed.notify("Layer is locked");
      return false;
    }
    const lifted = this.lifted;
    this.lifted = null;
    this._floating.set(null);
    const label =
      f.kind === "paste" ? "Paste" : f.kind === "duplicate" ? "Duplicate" : f.turned ? "Transform selection" : "Move selection";
    this.ed.transact(label, () => {
      const { data } = layer;
      if (lifted) {
        // an override's lifted cells become unset, revealing what is beneath
        for (let i = 0; i < data.length; i++) if (lifted.mask[i]) this.s.writeState(layer, i, -1);
      }
      const next = f.selects ? new Uint8Array(this.ed.voxelCount()) : null;
      const [ex, ey, ez] = f.size;
      let k = 0;
      for (let z = 0; z < ez; z++)
        for (let y = 0; y < ey; y++)
          for (let x = 0; x < ex; x++, k++) {
            if (!f.mask[k] && !f.voxels[k]) continue;
            const c: Vec3 = [f.offset[0] + x, f.offset[1] + y, f.offset[2] + z];
            if (!this.ed.inBounds(c)) continue;
            const i = this.ed.index(...c);
            // covered empties land too (on an override); unset cells leave what is there
            if (f.voxels[k] || (f.coverage?.[k] && layer.coverage)) this.s.writeState(layer, i, f.voxels[k]);
            if (next && f.mask[k]) next[i] = 1;
          }
      if (next) this.s.setSelection(next, label);
    });
    this.s.rebuildComposite();
    return true;
  }

  cancelTransform() {
    if (!untrack(() => this.floating)) return;
    this.lifted = null;
    this._floating.set(null);
    this.s.rebuildComposite();
  }

  pickFloating(ray: Ray): Hit | null {
    const f = untrack(() => this.floating);
    if (!f) return null;
    const [ox, oy, oz] = f.offset;
    const local: Ray = { origin: [ray.origin[0] - ox, ray.origin[1] - oy, ray.origin[2] - oz], dir: ray.dir };
    const hit = raycastVolume(local, f.size, (i) => f.mask[i] !== 0 || f.voxels[i] !== 0);
    return hit && { ...hit, cell: [hit.cell[0] + ox, hit.cell[1] + oy, hit.cell[2] + oz] };
  }

  lift(kind: "move" | "duplicate"): Floating | null {
    if (this.s.refuse(this.s.prepareEdit())) return null;
    const layer = this.ed.activeLayer!;
    const selects = this.s.selectedCount > 0;
    const region = selects ? this.s.selection : (layer.coverage ?? layer.data).map((v) => (v ? 1 : 0));
    const box = maskBounds(region, this.ed.size);
    if (!box) {
      this.ed.notify("Nothing to move");
      return null;
    }
    const block = extractBlock(layer.data, region, this.ed.size, box, layer.coverage);
    if (kind === "move") {
      this.lifted = { data: layer.data, mask: region.slice() };
      this.s.rebuildComposite();
    }
    return this.startFloat(block, box.min, kind, selects);
  }

  startFloat(block: Block, offset: Vec3, kind: Floating["kind"], selects: boolean): Floating {
    this.floatOrigin = [...offset];
    this.floatHome = offset.map((n, a) => 2 * n + block.size[a]) as Vec3;
    return this.placeFloat(
      { layerId: this.ed.activeLayerId, ...block, offset: [...offset], kind, selects, turned: false },
      true,
    );
  }

  /** Set the floating content, nudged inside the volume. `recenter` re-derives the turning pivot. */
  placeFloat(f: Floating, recenter: boolean): Floating {
    const size = this.ed.size;
    const offset = f.offset.map((n, a) => {
      const room = size[a] - f.size[a];
      return room >= 0 ? Math.max(0, Math.min(room, n)) : Math.max(room, Math.min(0, n));
    }) as Vec3;
    if (recenter || offset.some((n, a) => n !== f.offset[a])) {
      this.floatPivot = offset.map((n, a) => 2 * n + f.size[a]) as Vec3;
    }
    const next = { ...f, offset };
    this._floating.set(next);
    return next;
  }
}
