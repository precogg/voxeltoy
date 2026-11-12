import { describe, expect, test } from "bun:test";
import { Editor } from "./editor";
import type { Ray, Vec3 } from "./types";

const UP: Vec3 = [0, 1, 0];

/** A ray straight down onto the column at (x, z). */
const down = (x: number, z: number): Ray => ({ origin: [x + 0.5, 100, z + 0.5], dir: [0, -1, 0] });

/** A ray from the side, slightly above the horizontal, so it can measure height. */
const side = (y: number): Ray => {
  const dir: Vec3 = [-1, -0.05, 0];
  const len = Math.hypot(...dir);
  return { origin: [40, y + 0.5 + 0.05 * 37.5, 2.5], dir: dir.map((n) => n / len) as Vec3 };
};

/** A 16³ editor with a 3×3 slab on the floor: colors 1 and 2 in stripes along x. */
function setup() {
  const e = new Editor();
  e.newDocument([16, 16, 16]);
  for (let x = 1; x <= 3; x++) for (let z = 1; z <= 3; z++) e.setVoxel([x, 0, z], x === 2 ? 2 : 1);
  e.history.clear();
  return e;
}

const count = (e: Editor) => e.activeLayer!.data.reduce((n, v) => n + (v ? 1 : 0), 0);

describe("extrusion", () => {
  test("pulling a face stacks copies of its voxels, keeping their colors, as one undo step", () => {
    const e = setup();
    expect(e.extrude([2, 0, 2], UP, 3)).toBe(true);
    expect(count(e)).toBe(9 * 4);
    expect(e.getVoxel([1, 3, 1])).toBe(1);
    expect(e.getVoxel([2, 3, 1])).toBe(2);
    expect(e.history.undoLabel).toBe("Extrude");
    e.undo();
    expect(count(e)).toBe(9);
  });

  test("pushing a face in carves its columns, starting with the face", () => {
    const e = setup();
    e.extrude([2, 0, 2], UP, 3);
    expect(e.extrude([2, 3, 2], UP, -2)).toBe(true);
    expect(count(e)).toBe(9 * 2);
    expect(e.getVoxel([2, 3, 2])).toBe(0);
    expect(e.getVoxel([2, 2, 2])).toBe(0);
    expect(e.getVoxel([2, 1, 2])).toBe(2);
    expect(e.history.undoLabel).toBe("Carve");
  });

  test("the face is the connected, coplanar, exposed region", () => {
    const e = setup();
    e.setVoxel([2, 1, 2], 3);
    // the middle voxel is covered, so the top face is a ring of eight
    expect(e.extrusionRegion([1, 0, 1], UP)).toHaveLength(8);
    // a side face of the slab is a row of three
    expect(e.extrusionRegion([3, 0, 2], [1, 0, 0])).toHaveLength(3);
  });

  test("a selection marks out part of a face, and follows the extrusion", () => {
    const e = setup();
    e.selectCells([[1, 0, 1], [2, 0, 1]], "replace");
    expect(e.extrusionRegion([1, 0, 1], UP)).toHaveLength(2);
    e.extrude([1, 0, 1], UP, 2);
    expect(count(e)).toBe(9 + 4);
    expect(e.isSelected([1, 2, 1])).toBe(true);
    // the new top is the selected face now, so extruding again carries on
    expect(e.extrusionRegion([1, 2, 1], UP)).toHaveLength(2);
    // outside the selection there is nothing to extrude
    expect(e.startExtrusion([3, 0, 3], UP)).toBe(false);
  });

  test("extrusion stays inside the volume and follows mirror", () => {
    const e = setup();
    e.extrude([2, 0, 2], UP, 100);
    expect(e.getVoxel([2, 15, 2])).toBe(2);
    e.undo();
    e.setMirror(0, true);
    e.extrude([2, 0, 2], UP, 1);
    expect(e.getVoxel([13, 1, 2])).toBe(2);
    expect(e.getVoxel([14, 1, 1])).toBe(1);
  });

  test("a pending extrusion previews, adjusts and cancels without touching the document", () => {
    const e = setup();
    e.startExtrusion([2, 0, 2], UP);
    e.setExtrusionDepth(2);
    expect(e.preview?.kind).toBe("add");
    expect(e.preview?.cells).toHaveLength(18);
    expect(e.preview?.values?.filter((v) => v === 2)).toHaveLength(6);
    e.setExtrusionDepth(-1);
    expect(e.preview?.kind).toBe("erase");
    expect(count(e)).toBe(9);
    e.undo();
    expect(e.pendingExtrusion).toBeNull();
    expect(e.preview).toBeNull();
    expect(e.canUndo).toBe(false);
  });

  test("another edit, a tool change or a tap on empty space applies it", () => {
    const e = setup();
    e.setTool("extrude");
    e.startExtrusion([2, 0, 2], UP, 1);
    e.setTool("add");
    expect(count(e)).toBe(18);
    e.setTool("extrude");
    e.startExtrusion([2, 1, 2], UP, 1);
    e.selectAll();
    expect(count(e)).toBe(27);
    e.startExtrusion([2, 2, 2], UP, 1);
    e.pointerTap();
    expect(count(e)).toBe(36);
  });

  test("the extrude tool: drag a face to set the depth, tap to repeat the last one", () => {
    const e = setup();
    e.setTool("extrude");
    // from the side, press the top of the slab's +x face and drag up
    e.pointerDown({ ray: side(0) });
    expect(e.pendingExtrusion?.normal).toEqual({ axis: 0, sign: 1 });
    e.cancelPointer();
    expect(e.pendingExtrusion).toBeNull();

    // from above, a tap uses the last depth (1 at first)
    e.pointerDown({ ray: down(2, 2) });
    e.pointerUp();
    expect(e.pendingExtrusion?.depth).toBe(1);
    // pressing the pending extrusion adjusts it rather than starting another
    e.pointerDown({ ray: down(2, 2) });
    e.pointerUp();
    expect(e.pendingExtrusion?.depth).toBe(1);
    e.setExtrusionDepth(2);
    // pressing another face applies it and starts the next one, at the depth just used
    e.setVoxel([8, 0, 8], 3);
    e.pointerDown({ ray: down(8, 8) });
    expect(count(e)).toBe(28);
    e.pointerUp();
    expect(e.pendingExtrusion?.depth).toBe(2);
    e.applyExtrusion();
    expect(count(e)).toBe(30);
    expect(e.getVoxel([8, 2, 8])).toBe(3);
    expect(e.history.undoLabel).toBe("Extrude");
  });

  test("locked layers can't be extruded", () => {
    const e = setup();
    e.setLayerLocked(e.activeLayerId, true);
    expect(e.extrude([2, 0, 2], UP, 1)).toBe(false);
    expect(e.toast?.message).toBe("Layer is locked");
  });
});

describe("transforms", () => {
  test("rotating takes any number of quarter turns, either way", () => {
    const e = setup();
    e.selectBox({ min: [1, 0, 1], max: [3, 0, 1] });
    e.rotateSelection(1, -1);
    const once = e.floating!;
    e.cancelTransform();
    e.selectBox({ min: [1, 0, 1], max: [3, 0, 1] });
    e.rotateSelection(1, 3);
    expect(e.floating!.voxels).toEqual(once.voxels);
    expect(e.floating!.offset).toEqual(once.offset);
    e.rotateSelection(1, 1);
    expect(e.floating!.turned).toBe(true);
    expect(e.floating!.offset).toEqual([1, 0, 1]);
  });

  test("the floating content reports how far its center has moved", () => {
    const e = setup();
    e.selectBox({ min: [1, 0, 1], max: [3, 0, 3] });
    e.moveSelection([2, 1, 0]);
    expect(e.floatingDelta).toEqual([2, 1, 0]);
    e.rotateSelection(1);
    expect(e.floatingDelta).toEqual([2, 1, 0]);
  });

  test("the gizmo surrounds what the move tool would lift", () => {
    const e = setup();
    expect(e.transformBox).toBeNull();
    e.setTool("move");
    expect(e.transformBox).toEqual({ min: [1, 0, 1], max: [3, 0, 3] });
    e.selectBox({ min: [1, 0, 1], max: [1, 0, 3] });
    expect(e.transformBox).toEqual({ min: [1, 0, 1], max: [1, 0, 3] });
    e.moveSelection([0, 2, 0]);
    expect(e.transformBox).toEqual({ min: [1, 2, 1], max: [1, 2, 3] });
  });

  test("dragging the gizmo's arrow slides along its axis; its ring turns in quarter turns", () => {
    const e = setup();
    e.setTool("move");
    // the slab's center is (2.5, 0.5, 2.5); slide along Y with a ray from the side
    e.pointerDown({ ray: side(0), handle: "move-1" });
    e.pointerMove({ ray: side(3) });
    expect(e.floating?.offset).toEqual([1, 3, 1]);
    e.pointerUp();
    e.applyTransform();
    expect(e.getVoxel([2, 3, 2])).toBe(2);

    // the ring around Y: grab it at +X of the center, drag to -Z, a quarter turn
    const at = (x: number, z: number): Ray => ({ origin: [x, 100, z], dir: [0, -1, 0] });
    e.pointerDown({ ray: at(5, 2.5), handle: "rotate-1" });
    e.pointerMove({ ray: at(2.6, 0) });
    e.pointerUp();
    // the stripe along z now runs along x
    expect(e.floating?.voxels.filter((v) => v === 2)).toHaveLength(3);
    e.applyTransform();
    expect([1, 2, 3].map((x) => e.getVoxel([x, 3, 2]))).toEqual([2, 2, 2]);
  });
});
