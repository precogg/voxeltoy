import { describe, expect, test } from "bun:test";
import { Matrix4, Quaternion, Vector3 } from "three";
import type { Vec3 } from "@voxeltoy/core/types";
import { boxCells, cellBox, clampCell, layerCell, lifeSize, rayCell, standOn, turnAbout, workspaceYaw } from "./reach";

const SIZE: Vec3 = [4, 4, 4];
/** A 4³ grid with its bottom layer filled. */
const floor = (i: number) => Math.floor(i / 4) % 4 === 0;
const none = () => false;

describe("ray cells", () => {
  test("Add takes the cell before the face it hits; Erase and Paint the cell hit", () => {
    const down: Vec3 = [0, -1, 0];
    const add = rayCell([1.5, 10, 2.5], down, SIZE, floor, "add")!;
    expect(add.cell).toEqual([1, 1, 2]);
    expect(add.axis).toBe(1);
    expect(add.level).toBe(1);
    const erase = rayCell([1.5, 10, 2.5], down, SIZE, floor, "erase")!;
    expect(erase.cell).toEqual([1, 0, 2]);
    expect(erase.level).toBe(0);
  });

  test("Add with nothing in the way lands on the grid's floor; Erase gets nothing", () => {
    expect(rayCell([0.5, 3, 0.5], [0.6, -0.8, 0], SIZE, none, "add")?.cell).toEqual([2, 0, 0]);
    expect(rayCell([0.5, 3, 0.5], [0, -1, 0], SIZE, none, "erase")).toBeNull();
    // looking up, past the grid
    expect(rayCell([0.5, 3, 0.5], [0, 1, 0], SIZE, none, "add")).toBeNull();
  });

  test("a drag across keeps to the layer it started on", () => {
    expect(layerCell([3.2, 5, 0.5], [0, -1, 0], 1, 1, SIZE)).toEqual([3, 1, 0]);
    // along the layer: no crossing
    expect(layerCell([0, 1.5, 0], [1, 0, 0], 1, 1, SIZE)).toBeNull();
    // crossing off the grid
    expect(layerCell([9, 5, 0.5], [0, -1, 0], 1, 1, SIZE)).toBeNull();
  });
});

describe("boxes", () => {
  test("every cell between two corners, either way round", () => {
    expect(cellBox([2, 0, 1], [0, 1, 1])).toEqual({ min: [0, 0, 1], max: [2, 1, 1] });
    expect(boxCells([2, 0, 1], [0, 1, 1])).toHaveLength(6);
    expect(boxCells([1, 1, 1], [1, 1, 1])).toEqual([[1, 1, 1]]);
  });

  test("a point off the grid takes the nearest cell in it", () => {
    expect(clampCell([-3, 1.5, 9], SIZE)).toEqual([0, 1, 3]);
  });
});

describe("life size", () => {
  test("stands on the top of the column a point is in", () => {
    // a 2-high pillar at (1, *, 1)
    const pillar = (i: number) => {
      const x = i % 4;
      const y = Math.floor(i / 4) % 4;
      const z = Math.floor(i / 16);
      return x === 1 && z === 1 && y < 2;
    };
    expect(standOn([1, 0, 1], SIZE, pillar)).toEqual([1.5, 2, 1.5]);
    // in the air above it: down onto it
    expect(standOn([1, 3, 1], SIZE, pillar)).toEqual([1.5, 2, 1.5]);
    // nothing there: the grid's floor
    expect(standOn([3, 2, 3], SIZE, pillar)).toEqual([3.5, 0, 3.5]);
  });

  test("the point stood on is under the feet, upright, at the scale and turn asked", () => {
    const feet = new Vector3(0.3, 0, -0.2);
    const offset: Vec3 = [-2, 0, -2];
    const m = lifeSize([1.5, 2, 1.5], offset, 1, Math.PI / 2, feet);
    const at = new Vector3(1.5 + offset[0], 2, 1.5 + offset[2]).applyMatrix4(m);
    expect(at.distanceTo(feet)).toBeLessThan(1e-9);
    expect(workspaceYaw(m)).toBeCloseTo(Math.PI / 2, 9);
    expect(new Vector3().setFromMatrixScale(m).x).toBeCloseTo(1, 9);
  });

  test("turning about the viewer leaves the viewer's spot where it is", () => {
    const m = new Matrix4().compose(new Vector3(1, 0.5, -2), new Quaternion(), new Vector3(0.1, 0.1, 0.1));
    const viewer = new Vector3(0.5, 1.6, 0);
    const local = viewer.clone().applyMatrix4(m.clone().invert());
    const turned = turnAbout(m, viewer, Math.PI / 4);
    expect(local.applyMatrix4(turned).distanceTo(viewer)).toBeLessThan(1e-9);
    expect(workspaceYaw(turned)).toBeCloseTo(Math.PI / 4, 9);
  });
});
