// Cells of a grid: x-major, so cell `i` is `x + sx * (y + sy * z)`.

import type { Axis, Vec3 } from "./types";

/** A cell's index in a grid `sx` wide and `sy` tall. */
export const cellIndex = (x: number, y: number, z: number, sx: number, sy: number) => x + sx * (y + sy * z);

/** A cell's coordinates from its index, in a grid `sx` wide and `sy` tall. */
export const cellCoord = (i: number, sx: number, sy: number): Vec3 => [i % sx, Math.floor(i / sx) % sy, Math.floor(i / (sx * sy))];

/** How directions move when content turns a quarter around `axis`: +u goes to +v. */
export function quarterTurn(axis: Axis) {
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  return (n: Vec3): Vec3 => {
    const out = [...n] as Vec3;
    out[u] = -n[v] || 0;
    out[v] = n[u];
    return out;
  };
}

/** How directions move when content is mirrored along `axis`. */
export function mirror(axis: Axis) {
  return (n: Vec3): Vec3 => {
    const out = [...n] as Vec3;
    out[axis] = -n[axis] || 0;
    return out;
  };
}
