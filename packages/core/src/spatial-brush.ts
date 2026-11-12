import { toolOp, type Editor, type VoxelOp } from "./editor";
import { signal } from "./signal";
import type { Vec3 } from "./types";

/** The largest brush, in cells across. */
export const MAX_SPATIAL_BRUSH = 16;

/**
 * A brush at a point in voxel space rather than at a surface a ray hits: it places, erases or
 * paints cells anywhere in the grid, empty space included. A headset's controller tip drives it;
 * so can a script.
 *
 * Points are in voxel units: cell (x, y, z) spans [x, x + 1) on each axis. The brush is a ball
 * `size` cells across. A stroke (`begin`, `to`..., `end`) fills every cell the ball sweeps
 * through, however far apart the samples are, and is one undo step. Edits go through
 * `Editor.applyCells`, so they follow the active layer, the selection and the mirror.
 */
export class SpatialBrush {
  private _size = signal(1);
  private op: VoxelOp | null = null;
  private value = 0;
  private _changed = 0;
  private last: Vec3 | null = null;
  private done = new Set<number>();

  constructor(private editor: Editor) {}

  /** Cells across the brush. UI state. */
  get size() {
    return this._size.get();
  }

  setSize(size: number) {
    this._size.set(Math.max(1, Math.min(MAX_SPATIAL_BRUSH, Math.round(size))));
  }

  /** Whether a stroke is under way. */
  get active() {
    return this.op !== null;
  }

  /**
   * The cells the brush covers at `point`, within the grid and unmirrored: what a preview shows.
   * An odd size centers on the cell the point is in, an even one on the nearest cell corner.
   */
  cells(point: Vec3, size = this.size): Vec3[] {
    const odd = size % 2 === 1;
    const center = point.map((v) => (odd ? Math.floor(v) + 0.5 : Math.round(v))) as Vec3;
    const r = size / 2;
    const r2 = r * r;
    const lo = center.map((c) => Math.floor(c - r)) as Vec3;
    const hi = center.map((c) => Math.ceil(c + r)) as Vec3;
    const out: Vec3[] = [];
    for (let z = lo[2]; z < hi[2]; z++) {
      for (let y = lo[1]; y < hi[1]; y++) {
        for (let x = lo[0]; x < hi[0]; x++) {
          const dx = x + 0.5 - center[0];
          const dy = y + 0.5 - center[1];
          const dz = z + 0.5 - center[2];
          if (dx * dx + dy * dy + dz * dz <= r2 + 1e-9 && this.editor.inBounds([x, y, z])) out.push([x, y, z]);
        }
      }
    }
    return out;
  }

  /**
   * Start a stroke at `point`. `op` defaults to the current tool's (Add adds, Erase erases, the
   * brush paints; any other tool adds), and `value` to the current color. Returns whether it
   * started: it doesn't while the active layer can't be edited, and the editor says why.
   */
  begin(point: Vec3, op: VoxelOp = toolOp(this.editor.tool) ?? "add", value = this.editor.color): boolean {
    this.cancel();
    this.editor.cancelPointer();
    const blocker = this.editor.editBlocker();
    if (blocker) {
      this.editor.notify(blocker);
      return false;
    }
    this.op = op;
    this.value = value;
    this._changed = 0;
    this.last = null;
    this.done.clear();
    this.editor.beginStroke(op === "add" ? "Add voxels" : op === "erase" ? "Erase voxels" : "Paint voxels");
    this.to(point);
    return true;
  }

  /** Move the brush to `point`, filling the cells between it and the last point. */
  to(point: Vec3) {
    const op = this.op;
    if (!op) return;
    // the editor took the stroke back (an undo, a document change): this one is over
    if (!this.editor.stroking) {
      this.reset();
      return;
    }
    const from = this.last ?? point;
    this.last = [...point];
    const fresh: Vec3[] = [];
    for (const p of segment(from, point)) {
      for (const c of this.cells(p)) {
        const i = this.editor.index(...c);
        if (this.done.has(i)) continue;
        this.done.add(i);
        fresh.push(c);
      }
    }
    if (fresh.length) this._changed += this.editor.applyCells(fresh, op, this.value);
  }

  /** Finish the stroke: what it changed becomes one undo step. */
  end() {
    if (!this.op) return;
    this.reset();
    this.editor.endStroke();
  }

  /** Abandon the stroke, taking back what it changed. */
  cancel() {
    if (!this.op) return;
    this.reset();
    this.editor.cancelStroke();
  }

  /** Cells the current (or last) stroke changed, mirrored ones included. */
  get changed() {
    return this._changed;
  }

  /** Brush the cells along a polyline of points, as one undo step. Returns how many cells changed. */
  stroke(points: Vec3[], op?: VoxelOp, value?: number): number {
    if (!points.length || !this.begin(points[0], op, value)) return 0;
    for (const p of points.slice(1)) this.to(p);
    this.end();
    return this._changed;
  }

  private reset() {
    this.op = null;
    this.last = null;
    this.done.clear();
  }
}

/** Points from `a` to `b` no more than a third of a cell apart, so a swept ball leaves no gaps. */
function* segment(a: Vec3, b: Vec3): Generator<Vec3> {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const steps = Math.max(1, Math.ceil(d * 3));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    yield [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
}
