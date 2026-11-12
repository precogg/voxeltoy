import { BufferAttribute, BufferGeometry } from "three";
import type { Vec3 } from "@voxeltoy/core/types";
import { faceOcclusion } from "./ambient-occlusion";

/**
 * A picture on one face of a voxel: a tile of the decal atlas, drawn over the face so it reads
 * upright from outside. Applications use decals for what a palette color can't show, such as a
 * number on each face.
 */
export interface FaceDecal {
  cell: Vec3;
  /** The face's outward normal: one of ±X, ±Y, ±Z. */
  normal: Vec3;
  /** Index into the atlas: left to right, then top to bottom. */
  tile: number;
  /** Multiplies the tile, as 0xRRGGBB. White by default. */
  color?: number;
}

export interface DecalSet {
  /** A square image of `grid` × `grid` tiles. Draw into it, then pass a new set to show changes. */
  atlas: HTMLCanvasElement | OffscreenCanvas;
  grid: number;
  decals: readonly FaceDecal[];
  /** Darken each face by its direction, as the mesher shades voxels. Default true. */
  shade?: boolean;
  /** Shade corners using adjacent visible cells. Default false. */
  ao?: boolean;
}

/** The mesher's shading per face, in its order: -X, +X, -Y, +Y, -Z, +Z. */
const FACE_SHADE = [0.78, 0.86, 0.6, 1.0, 0.7, 0.92];

/** Right and up on each face, seen from outside, in the mesher's face order. */
const FACE_AXES: Record<number, { u: Vec3; v: Vec3 }> = {
  0: { u: [0, 0, 1], v: [0, 1, 0] },
  1: { u: [0, 0, -1], v: [0, 1, 0] },
  2: { u: [1, 0, 0], v: [0, 0, 1] },
  3: { u: [1, 0, 0], v: [0, 0, -1] },
  4: { u: [-1, 0, 0], v: [0, 1, 0] },
  5: { u: [1, 0, 0], v: [0, 1, 0] },
};

const faceIndex = (n: Vec3) => {
  const axis = n[0] ? 0 : n[1] ? 1 : 2;
  return axis * 2 + (n[axis] > 0 ? 1 : 0);
};

/**
 * Quads for the decals whose face is visible: the cell shows in `visible` (one byte per cell,
 * x-major) and its neighbour across the face does not. Positions are in grid units.
 */
export function buildDecalGeometry(set: DecalSet, visible: Uint8Array, size: Vec3): BufferGeometry {
  const [sx, sy, sz] = size;
  const at = (x: number, y: number, z: number) =>
    x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz && visible[x + sx * (y + sy * z)] !== 0;
  const shown = set.decals.filter(({ cell: [x, y, z], normal: n }) => at(x, y, z) && !at(x + n[0], y + n[1], z + n[2]));

  const positions = new Float32Array(shown.length * 12);
  const colors = new Float32Array(shown.length * 12);
  const uvs = new Float32Array(shown.length * 8);
  const index = new Uint32Array(shown.length * 6);
  const step = 1 / set.grid;
  // a texel in from each tile's edge, so filtering never pulls in the neighbouring tile
  const inset = 1 / set.atlas.width;
  const shade = set.shade ?? true;

  shown.forEach((d, q) => {
    const face = faceIndex(d.normal);
    const { u, v } = FACE_AXES[face];
    const center = d.cell.map((c, a) => c + 0.5 + d.normal[a] * 0.5);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const c = d.color ?? 0xffffff;
    const k = shade ? FACE_SHADE[face] : 1;
    const rgb = [((c >> 16) & 255) / 255 * k, ((c >> 8) & 255) / 255 * k, (c & 255) / 255 * k];
    const ao = set.ao ? faceOcclusion(d.cell, d.normal, u, v, at) : [1, 1, 1, 1];
    corners.forEach(([a, b], i) => {
      for (let axis = 0; axis < 3; axis++) {
        positions[q * 12 + i * 3 + axis] = center[axis] + 0.5 * (a * u[axis] + b * v[axis]);
        colors[q * 12 + i * 3 + axis] = rgb[axis] * ao[i];
      }
    });
    const tx = (d.tile % set.grid) * step;
    const ty = Math.floor(d.tile / set.grid) * step;
    const [u0, u1] = [tx + inset, tx + step - inset];
    // the atlas's top row is the texture's top (v = 1)
    const [v0, v1] = [1 - ty - step + inset, 1 - ty - inset];
    uvs.set([u0, v0, u1, v0, u1, v1, u0, v1], q * 8);
    index.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3], q * 6);
    if (ao[0] + ao[2] > ao[1] + ao[3]) {
      index.set([q * 4, q * 4 + 1, q * 4 + 3, q * 4 + 1, q * 4 + 2, q * 4 + 3], q * 6);
    }
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  return geometry;
}
