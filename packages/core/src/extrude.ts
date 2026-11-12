import type { Direction } from "./shapes";
import type { Axis, Box, Vec3 } from "./types";

/** A face region being pulled out of (or pushed into) the active layer, until it is applied. */
export interface Extrusion {
  readonly layerId: string;
  /** The face's outward normal. */
  readonly normal: Direction;
  /** The voxels whose exposed faces make up the region. */
  readonly base: readonly Vec3[];
  /** Layers to add in front of the face; negative carves that many layers in, starting with the face itself. */
  readonly depth: number;
}

/** Faces this large stop growing, so a stray tap can't stall the editor. */
export const MAX_FACE_REGION = 65536;

/**
 * The face region at `seed`, like Qubicle's face tools: every cell reachable from the seed
 * through face-adjacent cells on its plane (perpendicular to `axis`) that pass `include`.
 */
export function faceRegion(seed: Vec3, axis: Axis, size: Vec3, include: (c: Vec3) => boolean): Vec3[] {
  if (!include(seed)) return [];
  const u = ((axis + 1) % 3) as Axis;
  const v = ((axis + 2) % 3) as Axis;
  const index = (c: Vec3) => c[0] + size[0] * (c[1] + size[1] * c[2]);
  const inBounds = (c: Vec3) => c.every((n, a) => n >= 0 && n < size[a]);
  const seen = new Set([index(seed)]);
  const region: Vec3[] = [];
  const stack: Vec3[] = [seed];
  while (stack.length && region.length < MAX_FACE_REGION) {
    const c = stack.pop()!;
    region.push(c);
    for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = [...c] as Vec3;
      next[u] += du;
      next[v] += dv;
      if (!inBounds(next)) continue;
      const i = index(next);
      if (seen.has(i)) continue;
      seen.add(i);
      if (include(next)) stack.push(next);
    }
  }
  return region;
}

/**
 * What an extrusion changes. Pulling out stacks copies of each face voxel in front of it, so the
 * face's colors run the length of the extrusion. Pushing in carves out each voxel's column,
 * starting at the face. Cells outside the volume are left out.
 */
export function extrudeCells(
  ext: Pick<Extrusion, "base" | "normal" | "depth">,
  size: Vec3,
  valueAt: (c: Vec3) => number,
): { cells: Vec3[]; values: number[] } {
  const { axis, sign } = ext.normal;
  const cells: Vec3[] = [];
  const values: number[] = [];
  const steps = Math.abs(ext.depth);
  for (const b of ext.base) {
    const value = valueAt(b);
    for (let k = 0; k < steps; k++) {
      const c = [...b] as Vec3;
      c[axis] += ext.depth > 0 ? sign * (k + 1) : -sign * k;
      if (c[axis] < 0 || c[axis] >= size[axis]) break;
      cells.push(c);
      values.push(value);
    }
  }
  return { cells, values };
}

/** Bounds of the face region, flattened onto the plane of its face. */
export function faceBounds(ext: Pick<Extrusion, "base" | "normal">): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const c of ext.base)
    for (let a = 0; a < 3; a++) {
      if (c[a] < min[a]) min[a] = c[a];
      if (c[a] > max[a]) max[a] = c[a];
    }
  return { min, max };
}

/** Where the depth handle sits: the middle of the region, on the plane the face has been pulled (or pushed) to. */
export function depthHandle(ext: Pick<Extrusion, "base" | "normal" | "depth">): Vec3 {
  const { min, max } = faceBounds(ext);
  const { axis, sign } = ext.normal;
  const point = min.map((n, a) => (n + max[a] + 1) / 2) as Vec3;
  // the face's own plane, then out along the normal
  point[axis] = (sign > 0 ? max[axis] + 1 : min[axis]) + sign * ext.depth;
  return point;
}
