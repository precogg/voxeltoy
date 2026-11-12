import { describe, expect, test } from "bun:test";
import { DEFAULT_WORKPLANE, Editor } from "./editor";
import type { Ray, Vec3 } from "./types";

const down = (x: number, z: number): Ray => ({ origin: [x + 0.5, 100, z + 0.5], dir: [0, -1, 0] });
const voxels = (e: Editor) => e.activeLayer!.data.reduce((n, v) => n + (v ? 1 : 0), 0);

function editor(size: Vec3 = [8, 8, 8]) {
  const e = new Editor();
  e.newDocument(size);
  e.applyCells([[0, 0, 0]], "erase");
  return e;
}

function drag(e: Editor, from: Ray, to: Ray) {
  expect(e.pointerDown({ ray: from })).toBe(true);
  e.pointerMove({ ray: to });
  e.pointerUp();
}

describe("workplane", () => {
  test("starts as the unclipped floor, which is not a slice", () => {
    const e = editor();
    expect(e.workplane).toEqual(DEFAULT_WORKPLANE);
    expect(e.slice).toBeNull();
    expect(e.workplaneFace).toBe(0);
  });

  test("is UI state: not undoable, and reset by a new document", () => {
    const e = editor();
    const version = e.documentVersion;
    e.setWorkplane({ axis: 2, level: 5, clip: "-" });
    expect(e.documentVersion).toBe(version);
    expect(e.canUndo).toBe(false);
    e.newDocument([8, 8, 8]);
    expect(e.workplane).toEqual(DEFAULT_WORKPLANE);
  });

  test("the slice is the workplane while it clips", () => {
    const e = editor();
    e.setSlice({ axis: 0, level: 3, mode: "+" });
    expect(e.workplane).toEqual({ axis: 0, level: 3, clip: "+" });
    expect(e.slice).toEqual({ axis: 0, level: 3, mode: "+" });
    // turning slicing off keeps the plane where it is
    e.setSlice(null);
    expect(e.workplane).toEqual({ axis: 0, level: 3, clip: "none" });
    expect(e.slice).toBeNull();
  });

  test("the level is clamped, and kept inside the volume on resize", () => {
    const e = editor();
    e.setWorkplane({ level: 99 });
    expect(e.workplane.level).toBe(7);
    e.setWorkplane({ level: -3 });
    expect(e.workplane.level).toBe(0);
    e.setWorkplane({ level: 7 });
    e.resize([8, 4, 8]);
    expect(e.workplane.level).toBe(3);
  });

  test("moving it without clipping leaves what is visible alone", () => {
    const e = editor();
    e.applyCells([[1, 0, 1], [1, 5, 1]], "add");
    e.setWorkplane({ level: 3 });
    expect(e.composite[e.index(1, 5, 1)]).toBe(e.color);
    e.setWorkplane({ clip: "-" });
    expect(e.composite[e.index(1, 5, 1)]).toBe(0);
  });

  test("add places in mid-air on a raised workplane", () => {
    const e = editor();
    e.setWorkplane({ level: 3 });
    drag(e, down(1, 1), down(1, 1));
    expect(e.getVoxel([1, 3, 1])).toBe(e.color);
    expect(voxels(e)).toBe(1);
  });

  test("add places on a vertical workplane", () => {
    const e = editor();
    e.setWorkplane({ axis: 2, level: 4 });
    const front: Ray = { origin: [2.5, 1.5, 100], dir: [0, 0, -1] };
    drag(e, front, front);
    expect(e.getVoxel([2, 1, 4])).toBe(e.color);
  });

  test("a voxel in front of the workplane still wins", () => {
    const e = editor();
    e.applyCells([[1, 6, 1]], "add");
    e.setWorkplane({ level: 3 });
    drag(e, down(1, 1), down(1, 1));
    expect(e.getVoxel([1, 7, 1])).toBe(e.color);
    expect(e.getVoxel([1, 3, 1])).toBe(0);
  });

  test("a select box can start on the workplane, with nothing under it", () => {
    const e = editor();
    e.setTool("select");
    e.setSelectBrush("box");
    e.setWorkplane({ level: 2 });
    drag(e, down(0, 0), down(2, 1));
    expect(e.selectionCount).toBe(6);
    expect(e.isSelected([2, 2, 1])).toBe(true);
    expect(e.isSelected([0, 0, 0])).toBe(false);
  });

  test("a tap on the workplane with the select tool deselects, like a tap on empty space", () => {
    const e = editor();
    e.setTool("select");
    e.setSelectBrush("box");
    drag(e, down(0, 0), down(2, 2));
    expect(e.hasSelection).toBe(true);
    drag(e, down(5, 5), down(5, 5));
    expect(e.hasSelection).toBe(false);
  });

  test("a select shape drawn on the workplane grows toward the camera", () => {
    const e = editor();
    e.setTool("select");
    e.setSelectBrush("shape");
    e.setWorkplane({ level: 2 });
    drag(e, down(0, 0), down(3, 3));
    const shape = e.pendingShape!;
    expect(shape.grow).toEqual({ axis: 1, sign: 1 });
    expect(shape.box.min[1]).toBe(2);
    expect(shape.box.max[1]).toBeGreaterThan(2);
  });

  test("face and color selection still need a voxel", () => {
    const e = editor();
    e.setTool("select");
    e.setSelectBrush("face");
    expect(e.pointerDown({ ray: down(1, 1) })).toBe(false);
  });

  test("pick puts the workplane against the face tapped, then the tool works again", () => {
    const e = editor();
    e.applyCells([[2, 0, 2], [2, 1, 2], [2, 2, 2]], "add");
    e.startWorkplanePick();
    e.pointerHover({ ray: down(2, 2) });
    expect(e.preview?.boxes).toEqual([{ min: [0, 3, 0], max: [7, 3, 7] }]);
    drag(e, down(2, 2), down(2, 2));
    expect(e.workplane).toEqual({ axis: 1, level: 3, clip: "none" });
    expect(e.pickingWorkplane).toBe(false);
    expect(e.getVoxel([2, 3, 2])).toBe(0);
    // a side face makes the plane vertical
    e.startWorkplanePick();
    const side: Ray = { origin: [100, 1.5, 2.5], dir: [-1, 0, 0] };
    drag(e, side, side);
    expect(e.workplane).toMatchObject({ axis: 0, level: 3 });
  });

  test("pick keeps the clip, and a tap off the model stops picking", () => {
    const e = editor();
    e.applyCells([[2, 0, 2]], "add");
    e.setWorkplane({ clip: "-", level: 5 });
    e.startWorkplanePick();
    // off the model the pointer orbits
    const miss: Ray = { origin: [100, 100, 100], dir: [1, 0, 0] };
    expect(e.pointerDown({ ray: miss })).toBe(false);
    e.pointerTap();
    expect(e.pickingWorkplane).toBe(false);
    e.startWorkplanePick();
    drag(e, down(2, 2), down(2, 2));
    expect(e.workplane).toEqual({ axis: 1, level: 1, clip: "-" });
  });

  test("a face on the edge of the volume puts the plane on the last layer", () => {
    const e = editor([4, 4, 4]);
    e.applyCells([[1, 3, 1]], "add");
    e.setWorkplaneFromFace([1, 3, 1], [0, 1, 0]);
    expect(e.workplane.level).toBe(3);
  });

  test("the handle sits on the edge of the grid nearest the eye", () => {
    const e = editor([8, 8, 8]);
    e.setWorkplane({ level: 2 });
    expect(e.workplaneHandle([4, 20, 100])).toEqual([4, 2, 8]);
    expect(e.workplaneHandle([-50, 20, 4])).toEqual([0, 2, 4]);
    e.setWorkplane({ axis: 2, level: 5, clip: "-" });
    // clipping below, the grid is on the far face of the layer
    expect(e.workplaneHandle([4, 100, 20])).toEqual([4, 8, 6]);
  });

  test("dragging the arrow slides the plane along its axis; cancelling puts it back", () => {
    const e = editor();
    e.setWorkplane({ level: 2 });
    // a horizontal ray beside the handle at [4, 2, 8], seen from the front
    const at = (y: number): Ray => ({ origin: [4.2, y, 100], dir: [0, 0, -1] });
    expect(e.pointerDown({ ray: at(2), handle: "workplane" })).toBe(true);
    e.pointerMove({ ray: at(5.2) });
    expect(e.workplane.level).toBe(5);
    e.pointerMove({ ray: at(-10) });
    expect(e.workplane.level).toBe(0);
    e.cancelPointer();
    expect(e.workplane.level).toBe(2);
    expect(e.pointerDown({ ray: at(2), handle: "workplane" })).toBe(true);
    e.pointerMove({ ray: at(4) });
    e.pointerUp();
    expect(e.workplane.level).toBe(4);
    expect(voxels(e)).toBe(0);
  });

  test("what the clip hides is kept, and the far side of it can be drawn faintly", () => {
    const e = editor();
    e.applyCells([0, 1, 2, 3, 4].map((y): Vec3 => [1, y, 1]), "add");
    expect(e.clippedBehind(1)).toBeNull();
    // only layer 2: below it is behind when seen from above, above it when seen from below
    e.setWorkplane({ level: 2, clip: "=" });
    expect(e.clipped[e.index(1, 4, 1)]).toBe(e.color);
    expect(e.clipped[e.index(1, 2, 1)]).toBe(0);
    const fromAbove = e.clippedBehind(1)!;
    expect([0, 1, 3, 4].map((y) => fromAbove[e.index(1, y, 1)])).toEqual([e.color, e.color, 0, 0]);
    const fromBelow = e.clippedBehind(-1)!;
    expect([0, 1, 3, 4].map((y) => fromBelow[e.index(1, y, 1)])).toEqual([0, 0, e.color, e.color]);
    // an edit under the clip keeps it up to date
    e.setWorkplane({ clip: "none" });
    e.applyCells([[1, 0, 1]], "erase");
    e.setWorkplane({ clip: "=" });
    expect(e.clipped[e.index(1, 0, 1)]).toBe(0);
    // with "-", nothing is clipped below the plane
    e.setWorkplane({ clip: "-" });
    expect(e.clippedBehind(1)).toBeNull();
    expect(e.showClipped).toBe(true);
  });
});
