import type { Axis, Ray, Vec3 } from "./types";

export interface Hit {
  cell: Vec3;
  /** Outward normal of the face that was hit. */
  normal: Vec3;
  distance: number;
}

/**
 * Amanatides & Woo voxel traversal. `solid` receives a cell index into a
 * size[0] x size[1] x size[2] x-major volume.
 */
export function raycastVolume(ray: Ray, size: Vec3, solid: (index: number) => boolean): Hit | null {
  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.dir;

  // clip the ray to the volume bounds
  let tmin = 0;
  let tmax = Infinity;
  let enterAxis = -1;
  const o = [ox, oy, oz];
  const d = [dx, dy, dz];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) {
      if (o[a] < 0 || o[a] > size[a]) return null;
      continue;
    }
    let t0 = (0 - o[a]) / d[a];
    let t1 = (size[a] - o[a]) / d[a];
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > tmin) {
      tmin = t0;
      enterAxis = a;
    }
    tmax = Math.min(tmax, t1);
    if (tmin > tmax) return null;
  }

  const eps = 1e-6;
  const px = ox + dx * (tmin + eps);
  const py = oy + dy * (tmin + eps);
  const pz = oz + dz * (tmin + eps);

  let x = Math.min(size[0] - 1, Math.max(0, Math.floor(px)));
  let y = Math.min(size[1] - 1, Math.max(0, Math.floor(py)));
  let z = Math.min(size[2] - 1, Math.max(0, Math.floor(pz)));

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = Math.abs(1 / dx);
  const tDeltaY = Math.abs(1 / dy);
  const tDeltaZ = Math.abs(1 / dz);
  let tMaxX = dx !== 0 ? ((dx > 0 ? x + 1 : x) - ox) / dx : Infinity;
  let tMaxY = dy !== 0 ? ((dy > 0 ? y + 1 : y) - oy) / dy : Infinity;
  let tMaxZ = dz !== 0 ? ((dz > 0 ? z + 1 : z) - oz) / dz : Infinity;

  let axis = enterAxis;
  let t = tmin;
  const [sx, sy] = size;

  for (;;) {
    if (solid(x + sx * (y + sy * z))) {
      const normal: Vec3 = [0, 0, 0];
      if (axis === 0) normal[0] = -stepX;
      else if (axis === 1) normal[1] = -stepY;
      else if (axis === 2) normal[2] = -stepZ;
      else {
        // started inside a solid cell: face the camera along the dominant axis
        const a = dominantAxis(ray.dir);
        normal[a] = ray.dir[a] > 0 ? -1 : 1;
      }
      return { cell: [x, y, z], normal, distance: t };
    }

    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
      axis = 0;
      if (x < 0 || x >= size[0]) return null;
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
      axis = 1;
      if (y < 0 || y >= size[1]) return null;
    } else {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      axis = 2;
      if (z < 0 || z >= size[2]) return null;
    }
  }
}

/** Intersect a ray with the plane `axis = coord`. Returns the distance, or null. */
export function rayPlane(ray: Ray, axis: Axis, coord: number): number | null {
  const d = ray.dir[axis];
  if (Math.abs(d) < 1e-9) return null;
  const t = (coord - ray.origin[axis]) / d;
  return t > 0 ? t : null;
}

/**
 * The cell a ray crosses on the layer `axis = layer`, or null if outside the volume.
 * `offset` picks where within the layer the plane sits (0 = its lower face).
 */
export function rayLayerCell(
  ray: Ray,
  axis: Axis,
  layer: number,
  size: Vec3,
  offset = 0.5,
): { cell: Vec3; distance: number } | null {
  const t = rayPlane(ray, axis, layer + offset);
  if (t === null) return null;
  const cell: Vec3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    cell[a] = a === axis ? layer : Math.floor(ray.origin[a] + ray.dir[a] * t);
    if (cell[a] < 0 || cell[a] >= size[a]) return null;
  }
  return { cell, distance: t };
}

export function dominantAxis(v: Vec3): Axis {
  const ax = Math.abs(v[0]);
  const ay = Math.abs(v[1]);
  const az = Math.abs(v[2]);
  return ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
}
