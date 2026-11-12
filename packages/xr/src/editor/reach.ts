// How the drawing hand reaches the model's cells, beyond the brush tip in free space: along its ray
// to the face it points at (and across that face's layer as it moves), and a box from where the
// tip went down to where it is. And where the model goes for life size, and turning about the
// viewer. Plain math on cells and matrices, so it is tested on its own.

import { Matrix4, Quaternion, Vector3 } from "three";
import { raycastVolume } from "@voxeltoy/core/raycast";
import type { Vec3 } from "@voxeltoy/core/types";

/** How the drawing hand reaches cells: the brush tip in free space, its ray, or a box drawn with the tip. */
export type XRReach = "tip" | "ray" | "box";

/** What the palette's tools are: the voxel tools, and Move (the scene's objects) when there is a scene. */
export type XRTool = "add" | "erase" | "paint" | "move";

export type CellOp = "add" | "erase" | "paint";

/** Where a ray lands in the grid: the cell it changes, and the layer of cells a drag across stays on. */
export interface RayCell {
  cell: Vec3;
  /** The layer: cells whose `axis` coordinate is `level`. */
  axis: 0 | 1 | 2;
  level: number;
  /** Along the ray, in the ray's units. */
  distance: number;
}

const inGrid = (c: Vec3, size: Vec3) => c.every((n, a) => n >= 0 && n < size[a]);

/**
 * The cell a ray (in voxel units: cell (x, y, z) spans [x, x + 1)) would change: Add the empty
 * cell before the face it hits, Erase and Paint the cell it hits. Add with nothing in the way
 * lands on the grid's floor. Null when it changes nothing.
 */
export function rayCell(origin: Vec3, dir: Vec3, size: Vec3, solid: (index: number) => boolean, op: CellOp): RayCell | null {
  const hit = raycastVolume({ origin, dir }, size, solid);
  if (hit) {
    const axis = hit.normal.findIndex((n) => n !== 0) as 0 | 1 | 2;
    const cell = (op === "add" ? hit.cell.map((n, a) => n + hit.normal[a]) : [...hit.cell]) as Vec3;
    if (!inGrid(cell, size)) return null;
    return { cell, axis: axis < 0 ? 1 : axis, level: cell[axis < 0 ? 1 : axis], distance: hit.distance };
  }
  if (op !== "add" || dir[1] > -1e-6) return null;
  const t = -origin[1] / dir[1];
  if (t < 0) return null;
  const cell: Vec3 = [Math.floor(origin[0] + dir[0] * t), 0, Math.floor(origin[2] + dir[2] * t)];
  return inGrid(cell, size) ? { cell, axis: 1, level: 0, distance: t } : null;
}

/** Where a ray crosses a layer of cells (through their centers): the cell there, or null along the layer or off the grid (with a `size`). */
export function layerCell(origin: Vec3, dir: Vec3, axis: 0 | 1 | 2, level: number, size: Vec3 | null): Vec3 | null {
  if (Math.abs(dir[axis]) < 1e-6) return null;
  const t = (level + 0.5 - origin[axis]) / dir[axis];
  if (t < 0) return null;
  const cell = origin.map((o, a) => (a === axis ? level : Math.floor(o + dir[a] * t))) as Vec3;
  return !size || inGrid(cell, size) ? cell : null;
}

/** The cell a point is in, kept in the grid. */
export function clampCell(point: Vec3, size: Vec3): Vec3 {
  return point.map((n, a) => Math.max(0, Math.min(size[a] - 1, Math.floor(n)))) as Vec3;
}

/** The box two cells are corners of: its lowest and highest cells. */
export function cellBox(a: Vec3, b: Vec3): { min: Vec3; max: Vec3 } {
  return { min: a.map((n, i) => Math.min(n, b[i])) as Vec3, max: a.map((n, i) => Math.max(n, b[i])) as Vec3 };
}

/** Every cell in the box two cells are corners of. */
export function boxCells(a: Vec3, b: Vec3): Vec3[] {
  const { min, max } = cellBox(a, b);
  const out: Vec3[] = [];
  for (let z = min[2]; z <= max[2]; z++) for (let y = min[1]; y <= max[1]; y++) for (let x = min[0]; x <= max[0]; x++) out.push([x, y, z]);
  return out;
}

/**
 * Where to stand on a model at a point: the top of the column of cells there, from `cell` up
 * (a wall is climbed to its top), as a point on that top face's center, in voxel units.
 */
export function standOn(cell: Vec3, size: Vec3, solid: (index: number) => boolean): Vec3 {
  const [x, , z] = cell;
  let y = Math.max(0, Math.min(size[1] - 1, cell[1]));
  const at = (yy: number) => solid(x + size[0] * (yy + size[1] * z));
  while (y < size[1] && at(y)) y++;
  // an empty cell: drop to what is below it
  while (y > 0 && !at(y - 1)) y--;
  return [x + 0.5, y, z + 0.5];
}

/** How far the workspace is turned about the vertical: the heading of its X axis. */
export function workspaceYaw(workspace: Matrix4) {
  const x = new Vector3().setFromMatrixColumn(workspace, 0);
  return Math.atan2(-x.z, x.x);
}

/**
 * The workspace matrix that shows the model at `scale` metres a cell, upright and turned by `yaw`,
 * with the point `stand` (voxel units, inside a voxel group offset by `offset` in the workspace)
 * under `feet` in the room.
 */
export function lifeSize(stand: Vec3, offset: Vec3, scale: number, yaw: number, feet: Vector3): Matrix4 {
  const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);
  const local = new Vector3(stand[0] + offset[0], stand[1] + offset[1], stand[2] + offset[2]).multiplyScalar(scale).applyQuaternion(rotation);
  return new Matrix4().compose(feet.clone().sub(local), rotation, new Vector3(scale, scale, scale));
}

/** `workspace` turned by `angle` (radians, counterclockwise from above) about the vertical through `about`. */
export function turnAbout(workspace: Matrix4, about: Vector3, angle: number): Matrix4 {
  return new Matrix4()
    .makeTranslation(about.x, 0, about.z)
    .multiply(new Matrix4().makeRotationY(angle))
    .multiply(new Matrix4().makeTranslation(-about.x, 0, -about.z))
    .multiply(workspace);
}
