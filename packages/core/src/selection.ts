import type { Axis, Box, Vec3 } from "./types";

export type SelectMode = "replace" | "add" | "subtract" | "intersect";

/**
 * Content lifted out of a layer while it is being moved, rotated or flipped. Buffers are
 * box-sized and x-major in local coordinates; `offset` places local [0, 0, 0] in the volume.
 */
export interface Floating {
  readonly layerId: string;
  readonly size: Vec3;
  /** Palette indices; 0 = empty. */
  readonly voxels: Uint8Array;
  /** Selected cells (including empty ones) that travel with the content. */
  readonly mask: Uint8Array;
  /** Lifted from an override layer: 1 where a cell was covered, so a covered empty travels too. */
  readonly coverage?: Uint8Array;
  readonly offset: Vec3;
  /** "move" hides its source until applied; the others leave the source in place. */
  readonly kind: "move" | "duplicate" | "paste";
  /** Whether applying makes the result the selection (false when a whole layer was lifted). */
  readonly selects: boolean;
  /** Rotated or flipped since it was lifted. */
  readonly turned: boolean;
}

// #region Masks

const NEIGHBORS: Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** Combine a selection with incoming cells. Returns a new mask. */
export function combineMask(current: Uint8Array, incoming: Uint8Array, mode: SelectMode): Uint8Array {
  const out = new Uint8Array(current.length);
  for (let i = 0; i < out.length; i++) {
    const a = current[i];
    const b = incoming[i];
    out[i] = mode === "replace" ? b : mode === "add" ? a | b : mode === "subtract" ? a & (b ^ 1) : a & b;
  }
  return out;
}

/** Every cell face-adjacent to the mask, plus the mask. */
export function growMask(mask: Uint8Array, size: Vec3): Uint8Array {
  const out = mask.slice();
  forEachSet(mask, size, (_, x, y, z) => {
    for (const [dx, dy, dz] of NEIGHBORS) {
      const j = neighbor(size, x + dx, y + dy, z + dz);
      if (j >= 0) out[j] = 1;
    }
  });
  return out;
}

/** The mask without cells on its surface. The edge of the volume doesn't count as a surface. */
export function shrinkMask(mask: Uint8Array, size: Vec3): Uint8Array {
  const out = mask.slice();
  forEachSet(mask, size, (i, x, y, z) => {
    for (const [dx, dy, dz] of NEIGHBORS) {
      const j = neighbor(size, x + dx, y + dy, z + dz);
      if (j >= 0 && !mask[j]) {
        out[i] = 0;
        return;
      }
    }
  });
  return out;
}

/** Face-connected flood over cells that pass `include`, starting from every seed index. */
export function floodMask(seeds: Iterable<number>, size: Vec3, include: (i: number) => boolean): Uint8Array {
  const [sx, sy, sz] = size;
  const out = new Uint8Array(sx * sy * sz);
  const stack: number[] = [];
  for (const s of seeds) {
    if (out[s] || !include(s)) continue;
    out[s] = 1;
    stack.push(s);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % sx;
    const y = Math.floor(i / sx) % sy;
    const z = Math.floor(i / (sx * sy));
    const next = [
      x > 0 ? i - 1 : -1,
      x < sx - 1 ? i + 1 : -1,
      y > 0 ? i - sx : -1,
      y < sy - 1 ? i + sx : -1,
      z > 0 ? i - sx * sy : -1,
      z < sz - 1 ? i + sx * sy : -1,
    ];
    for (const n of next) {
      if (n >= 0 && !out[n] && include(n)) {
        out[n] = 1;
        stack.push(n);
      }
    }
  }
  return out;
}

/** Inclusive bounds of the set cells, or null when none are set. */
export function maskBounds(mask: Uint8Array, size: Vec3): Box | null {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-1, -1, -1];
  forEachSet(mask, size, (_, x, y, z) => {
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  });
  return max[0] < 0 ? null : { min, max };
}

export function countMask(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

function forEachSet(mask: Uint8Array, size: Vec3, fn: (i: number, x: number, y: number, z: number) => void) {
  const [sx, sy] = size;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    fn(i, i % sx, Math.floor(i / sx) % sy, Math.floor(i / (sx * sy)));
  }
}

function neighbor(size: Vec3, x: number, y: number, z: number) {
  if (x < 0 || y < 0 || z < 0 || x >= size[0] || y >= size[1] || z >= size[2]) return -1;
  return x + size[0] * (y + size[1] * z);
}

// #endregion

// #region Box buffers

export interface Block {
  size: Vec3;
  voxels: Uint8Array;
  mask: Uint8Array;
  /** From an override layer: 1 where a cell was covered. */
  coverage?: Uint8Array;
}

/**
 * Copy the cells of `region` (and the voxels of `data` inside it) into a box-sized block. With
 * `coverage` (an override layer's), the block keeps which cells were covered too.
 */
export function extractBlock(data: Uint8Array, region: Uint8Array, volume: Vec3, box: Box, coverage?: Uint8Array): Block {
  const size: Vec3 = [box.max[0] - box.min[0] + 1, box.max[1] - box.min[1] + 1, box.max[2] - box.min[2] + 1];
  const voxels = new Uint8Array(size[0] * size[1] * size[2]);
  const mask = new Uint8Array(voxels.length);
  const covered = coverage ? new Uint8Array(voxels.length) : undefined;
  let k = 0;
  for (let z = 0; z < size[2]; z++)
    for (let y = 0; y < size[1]; y++)
      for (let x = 0; x < size[0]; x++, k++) {
        const i = box.min[0] + x + volume[0] * (box.min[1] + y + volume[1] * (box.min[2] + z));
        if (!region[i]) continue;
        mask[k] = 1;
        voxels[k] = data[i];
        if (covered) covered[k] = coverage![i];
      }
  return { size, voxels, mask, ...(covered ? { coverage: covered } : {}) };
}

/** Rebuild a block cell by cell, with each new cell reading from `from(new cell)`. */
function remap(block: Block, size: Vec3, from: (c: Vec3) => Vec3): Block {
  const voxels = new Uint8Array(block.voxels.length);
  const mask = new Uint8Array(block.mask.length);
  const coverage = block.coverage ? new Uint8Array(block.coverage.length) : undefined;
  const [ox, oy] = block.size;
  const c: Vec3 = [0, 0, 0];
  let k = 0;
  for (c[2] = 0; c[2] < size[2]; c[2]++)
    for (c[1] = 0; c[1] < size[1]; c[1]++)
      for (c[0] = 0; c[0] < size[0]; c[0]++, k++) {
        const [x, y, z] = from(c);
        const j = x + ox * (y + oy * z);
        voxels[k] = block.voxels[j];
        mask[k] = block.mask[j];
        if (coverage) coverage[k] = block.coverage![j];
      }
  return { size, voxels, mask, ...(coverage ? { coverage } : {}) };
}

/** Mirror a block along an axis. */
export function flipBlock(block: Block, axis: Axis): Block {
  const n = block.size[axis];
  return remap(block, block.size, (c) => {
    const out = [...c] as Vec3;
    out[axis] = n - 1 - c[axis];
    return out;
  });
}


/** Turn a block 90° around an axis, the same way as `Editor.rotateLayer`. */
export function rotateBlock(block: Block, axis: Axis): Block {
  const u = ((axis + 1) % 3) as Axis;
  const v = ((axis + 2) % 3) as Axis;
  const size = [...block.size] as Vec3;
  [size[u], size[v]] = [block.size[v], block.size[u]];
  // forward: new[u] = old.size[v] - 1 - old[v], new[v] = old[u]
  return remap(block, size, (c) => {
    const out = [...c] as Vec3;
    out[u] = c[v];
    out[v] = block.size[v] - 1 - c[u];
    return out;
  });
}

// #endregion
