// Sample models for the voxel runtime dev pages and the Godot spike's fixtures
// (integrations/godot/fixtures). Not part of the build.
import { toVoxelAnimation, type VoxelAnimation } from "@voxeltoy/core/formats/volumes";
import type { Vec3 } from "@voxeltoy/core/types";

/** A banded ball with a tunnel through it, on a plinth, bouncing over 8 frames. */
export function sampleAnimation(): VoxelAnimation {
  const size: Vec3 = [32, 32, 32];
  const palette = [0, 0xe4572e, 0xf3a712, 0x29335c, 0x669bbc, 0xa8c686, 0xf0ead6];
  const frames = Array.from({ length: 8 }, (_, frame) => {
    const lift = Math.round(5 * Math.abs(Math.sin((frame / 8) * Math.PI)));
    const voxels = new Uint8Array(size[0] * size[1] * size[2]);
    for (let z = 0; z < 32; z++) {
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
          const dx = x - 15.5, dy = y - 13.5 - lift, dz = z - 15.5;
          const ball = dx * dx + dy * dy + dz * dz < 11 * 11;
          const tunnel = dx * dx + dy * dy < 3.5 * 3.5;
          const plinth = y < 3 && Math.abs(dx) < 10 && Math.abs(dz) < 10;
          let v = 0;
          if (ball && !tunnel) v = 1 + (Math.floor((y - lift) / 4 + frame) % 5);
          if (plinth) v = 6;
          voxels[x + 32 * (y + 32 * z)] = v;
        }
      }
    }
    return { id: `frame:${frame}`, duration: frame === 0 ? 2 : 1, voxels };
  });
  return toVoxelAnimation({ name: "Sample", fps: 12, size, palette, frames });
}


export const BODY = 1, BELLY = 2, LEG = 3, EYE = 4, PUPIL = 5, ANTENNA = 6;
export const CRITTER_PALETTE = [0, 0x4f8a5b, 0xa6d17a, 0x2e4d3a, 0xfff6c8, 0x1b1b25, 0xffb347];

/** A round critter on four legs, walking in 4 frames. The body holds still; the legs move. */
export function critter(): VoxelAnimation {
  const size: Vec3 = [20, 22, 16];
  const [sx, sy] = size;
  const frames = [0, 1, 2, 3].map((frame) => {
    const voxels = new Uint8Array(size[0] * size[1] * size[2]);
    const set = (x: number, y: number, z: number, v: number) => {
      if (x >= 0 && y >= 0 && z >= 0 && x < size[0] && y < size[1] && z < size[2]) voxels[x + sx * (y + sy * z)] = v;
    };
    // body: a squashed ball
    for (let z = 0; z < 16; z++)
      for (let y = 4; y < 19; y++)
        for (let x = 0; x < 20; x++) {
          const dx = (x - 9.5) / 9.5, dy = (y - 11.5) / 7.5, dz = (z - 7.5) / 7.5;
          if (dx * dx + dy * dy + dz * dz < 1) set(x, y, z, dz > 0.55 && dy < 0.2 ? BELLY : BODY);
        }
    // eyes on the front (+z), glowing
    for (const ex of [5, 12])
      for (let y = 12; y < 16; y++)
        for (let x = ex; x < ex + 3; x++) set(x, y, 15, x === ex + 1 && y === 13 ? PUPIL : EYE);
    // antenna
    for (let y = 19; y < 21; y++) set(9, y, 7, BODY);
    set(9, 21, 7, ANTENNA);
    // legs: diagonal pairs lift in turn
    const lift = [
      [2, 0],
      [0, 0],
      [0, 2],
      [0, 0],
    ][frame];
    const legs: [number, number, number][] = [
      [4, 3, 0], [13, 3, 1], [4, 10, 1], [13, 10, 0],
    ];
    for (const [lx, lz, pair] of legs)
      for (let y = lift[pair]; y < 6; y++)
        for (let x = lx; x < lx + 3; x++) for (let z = lz; z < lz + 3; z++) set(x, y, z, LEG);
    return { id: `walk:${frame}`, duration: 1, voxels };
  });
  return toVoxelAnimation({ name: "Critter", fps: 8, size, palette: CRITTER_PALETTE, frames });
}
