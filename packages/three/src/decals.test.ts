import { faceOcclusion } from "./ambient-occlusion";
import { describe, expect, test } from "bun:test";
import { buildDecalGeometry, type DecalSet } from "./decals";
import type { Vec3 } from "@voxeltoy/core/types";

const atlas = { width: 64, height: 64 } as OffscreenCanvas;

describe("decals", () => {
  test("only faces that show get a quad, on the face, facing out", () => {
    const size: Vec3 = [2, 1, 1];
    const visible = new Uint8Array([1, 1]);
    const set: DecalSet = {
      atlas,
      grid: 4,
      decals: [
        { cell: [0, 0, 0], normal: [1, 0, 0], tile: 0 }, // against the other voxel: hidden
        { cell: [0, 0, 0], normal: [-1, 0, 0], tile: 1 },
        { cell: [1, 0, 0], normal: [0, 1, 0], tile: 5, color: 0xff0000 },
      ],
      shade: false,
    };
    const g = buildDecalGeometry(set, visible, size);
    const pos = g.getAttribute("position");
    expect(pos.count).toBe(8);
    // the -X face of cell 0 lies on x = 0
    for (let i = 0; i < 4; i++) expect(pos.getX(i)).toBe(0);
    // the top of cell 1 lies on y = 1, within x 1..2
    for (let i = 4; i < 8; i++) {
      expect(pos.getY(i)).toBe(1);
      expect(pos.getX(i)).toBeGreaterThanOrEqual(1);
    }
    const color = g.getAttribute("color");
    expect([color.getX(4), color.getY(4), color.getZ(4)]).toEqual([1, 0, 0]);
    // tile 5 of a 4×4 atlas: second column, second row from the top
    const uv = g.getAttribute("uv");
    expect(uv.getX(4)).toBeCloseTo(0.25 + 1 / 64);
    expect(uv.getY(6)).toBeCloseTo(0.75 - 1 / 64);
  });

  test("a cell hidden by the slice shows no decals", () => {
    const set: DecalSet = { atlas, grid: 4, decals: [{ cell: [0, 0, 0], normal: [0, 1, 0], tile: 0 }] };
    expect(buildDecalGeometry(set, new Uint8Array([0]), [1, 1, 1]).getAttribute("position").count).toBe(0);
  });
});

test("decal AO matches the mesher at every occlusion level", () => {
  const cell = [1, 1, 1], normal = [0, 1, 0], u = [1, 0, 0], v = [0, 0, -1];
  for (const [neighbors, expected] of [
    [[], 1],
    [[[0, 2, 1]], 0.87],
    [[[0, 2, 1], [0, 2, 2]], 0.77],
    [[[0, 2, 1], [1, 2, 2]], 0.66],
  ] as const) {
    const solid = (x: number, y: number, z: number) => neighbors.some((p) => p[0] === x && p[1] === y && p[2] === z);
    expect(faceOcclusion(cell, normal, u, v, solid)[0]).toBe(expected);
  }
});
