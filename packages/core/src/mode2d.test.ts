import { describe, expect, test } from "bun:test";
import { Editor } from "./editor";
import type { Ray, Vec3 } from "./types";

/** Looking straight down Y, as 2D mode does from the top. */
const down = (x: number, z: number): Ray => ({ origin: [x + 0.5, 100, z + 0.5], dir: [0, -1, 0] });

function editor() {
  const e = new Editor();
  e.newDocument([8, 8, 8]);
  e.applyCells([[0, 0, 0]], "erase");
  return e;
}

function drag(e: Editor, from: Ray, to: Ray) {
  expect(e.pointerDown({ ray: from })).toBe(true);
  e.pointerMove({ ray: to });
  e.pointerUp();
}

const selected = (e: Editor) => {
  const cells: Vec3[] = [];
  const [sx, sy, sz] = e.size;
  for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) if (e.isSelected([x, y, z])) cells.push([x, y, z]);
  return cells;
};

describe("2D mode", () => {
  test("is UI state, outside history, and a new document leaves it", () => {
    const e = editor();
    expect(e.mode2D).toBeNull();
    e.enter2D(-1);
    expect(e.mode2D).toEqual({ side: -1 });
    expect(e.canUndo).toBe(false);
    e.newDocument([8, 8, 8]);
    expect(e.mode2D).toBeNull();
  });

  test("selectColumns selects through the volume, within what the clip shows", () => {
    const e = editor();
    e.selectColumns({ min: [1, 5, 1], max: [2, 5, 1] });
    expect(e.selectionCount).toBe(2 * 8);
    expect(e.isSelected([1, 0, 1]) && e.isSelected([2, 7, 1])).toBe(true);
    e.setWorkplane({ level: 3, clip: "-" });
    e.selectColumns({ min: [1, 0, 1], max: [1, 0, 1] });
    expect(selected(e)).toEqual([0, 1, 2, 3].map((y): Vec3 => [1, y, 1]));
  });

  test("a select box starts anywhere and takes whole columns", () => {
    const e = editor();
    e.applyCells([[1, 4, 1]], "add");
    e.setTool("select");
    e.setSelectBrush("box");
    e.enter2D(1);
    // starting on a voxel or on empty grid makes no difference
    drag(e, down(1, 1), down(2, 3));
    expect(e.selectionCount).toBe(2 * 3 * 8);
    expect(e.isSelected([2, 0, 3]) && e.isSelected([1, 7, 1])).toBe(true);
    expect(e.isSelected([3, 0, 3])).toBe(false);
  });

  test("the shape brush draws a rectangle of columns, and a tap deselects", () => {
    const e = editor();
    e.setTool("select");
    e.setSelectBrush("shape");
    e.enter2D(1);
    drag(e, down(0, 0), down(1, 0));
    expect(e.selectionCount).toBe(2 * 8);
    expect(e.pendingShape).toBeNull();
    drag(e, down(5, 5), down(5, 5));
    expect(e.hasSelection).toBe(false);
  });

  test("the voxel brush paints columns", () => {
    const e = editor();
    e.setTool("select");
    e.setSelectBrush("voxel");
    e.enter2D(1);
    drag(e, down(0, 0), down(0, 2));
    expect(e.selectionCount).toBe(2 * 8);
    expect(e.isSelected([0, 6, 2])).toBe(true);
  });

  test("face and color selection still act on the voxel you see", () => {
    const e = editor();
    e.applyCells([[2, 0, 2], [2, 1, 2]], "add");
    e.setTool("select");
    e.setSelectBrush("color");
    e.enter2D(1);
    drag(e, down(2, 2), down(2, 2));
    expect(selected(e)).toEqual([
      [2, 0, 2],
      [2, 1, 2],
    ]);
  });

  test("moving the top half of a model down: select columns, drag, apply", () => {
    const e = editor();
    // a 1x4 tower seen from the front (looking down -Z): the top half is y = 2..3
    e.applyCells([[3, 0, 3], [3, 1, 3], [3, 2, 3], [3, 3, 3]], "add");
    e.setWorkplane({ axis: 2, level: 0 });
    e.enter2D(1);
    const front = (x: number, y: number): Ray => ({ origin: [x + 0.5, y + 0.5, 100], dir: [0, 0, -1] });
    e.setTool("select");
    e.setSelectBrush("box");
    drag(e, front(2, 2), front(4, 5));
    e.setTool("move");
    drag(e, front(3, 3), front(5, 3));
    e.applyTransform();
    const filled = (c: Vec3) => e.getVoxel(c) !== 0;
    expect([0, 1].map((y) => filled([3, y, 3]))).toEqual([true, true]);
    expect([2, 3].map((y) => filled([5, y, 3]))).toEqual([true, true]);
    expect(filled([3, 2, 3])).toBe(false);
    // one undo step for the move
    e.undo();
    expect(filled([3, 3, 3])).toBe(true);
  });

  test("the pencil fills each pixel's column from the workplane toward you, once per stroke", () => {
    const e = editor();
    e.setWorkplane({ axis: 2, level: 2 });
    e.enter2D(1);
    e.setTool("add");
    e.setBrush("voxel");
    e.setThickness(3);
    const front = (x: number, y: number): Ray => ({ origin: [x + 0.5, y + 0.5, 100], dir: [0, 0, -1] });
    // drag across and back: the pixel already drawn isn't drawn again
    expect(e.pointerDown({ ray: front(1, 1) })).toBe(true);
    e.pointerMove({ ray: front(3, 1) });
    e.pointerMove({ ray: front(1, 1) });
    e.pointerUp();
    for (const x of [1, 2, 3]) for (const z of [2, 3, 4]) expect(e.getVoxel([x, 1, z])).toBe(e.color);
    expect(e.getVoxel([1, 1, 1])).toBe(0);
    expect(e.getVoxel([1, 1, 5])).toBe(0);
    // one undo step for the stroke
    e.undo();
    expect(e.getVoxel([2, 1, 3])).toBe(0);
  });

  test("the pencil can fill both sides of the workplane, and looks from either side", () => {
    const e = editor();
    e.setWorkplane({ axis: 2, level: 4 });
    e.setThickness(2);
    e.setBothSides(true);
    expect(e.pencilCells([0, 0, 0], 1).map((c) => c[2])).toEqual([3, 4, 5]);
    e.setBothSides(false);
    expect(e.pencilCells([0, 0, 0], 1).map((c) => c[2])).toEqual([4, 5]);
    expect(e.pencilCells([0, 0, 0], -1).map((c) => c[2])).toEqual([3, 4]);
  });

  test("a pencil box draws a rectangle of pixels as one edit", () => {
    const e = editor();
    e.setWorkplane({ axis: 1, level: 0 });
    e.enter2D(1);
    e.setTool("add");
    e.setBrush("box");
    e.setThickness(2);
    drag(e, down(0, 0), down(2, 1));
    expect(e.activeLayer!.data.filter(Boolean).length).toBe(3 * 2 * 2);
    // a tap draws one pixel
    drag(e, down(5, 5), down(5, 5));
    expect(e.getVoxel([5, 1, 5])).toBe(e.color);
  });

  test("erase and paint act on the front voxel of each pixel", () => {
    const e = editor();
    // two columns, each three deep, seen from the top
    e.applyCells([0, 1, 2].flatMap((y): Vec3[] => [[1, y, 1], [2, y, 1]]), "add");
    e.enter2D(1);
    e.setBrush("voxel");
    e.setTool("erase");
    drag(e, down(1, 1), down(2, 1));
    expect([e.getVoxel([1, 2, 1]), e.getVoxel([2, 2, 1])]).toEqual([0, 0]);
    expect(e.getVoxel([1, 1, 1])).not.toBe(0);
    e.setColor(5);
    e.setTool("brush");
    drag(e, down(1, 1), down(1, 1));
    expect(e.getVoxel([1, 1, 1])).toBe(5);
    expect(e.getVoxel([1, 0, 1])).not.toBe(5);
  });

  test("the depth brush pulls each front out by one, in its own color", () => {
    const e = editor();
    e.setColor(4);
    e.applyCells([[1, 0, 1], [2, 0, 1]], "add");
    e.setColor(9);
    e.enter2D(1);
    e.setTool("extrude");
    drag(e, down(1, 1), down(3, 1));
    expect(e.getVoxel([1, 1, 1])).toBe(4);
    expect(e.getVoxel([2, 1, 1])).toBe(4);
    // nothing to raise in an empty column
    expect(e.getVoxel([3, 0, 1]) || e.getVoxel([3, 1, 1])).toBe(0);
  });

  test("project shows the front voxel, its depth and the column's thickness", () => {
    const e = editor();
    e.setColor(3);
    e.applyCells([[1, 0, 2], [1, 4, 2]], "add");
    const top = e.project(1, 1);
    // looking along y, u is z and v is x
    const p = (x: number, z: number) => z + top.width * x;
    expect([top.u, top.v]).toEqual([2, 0]);
    const at = p(1, 2);
    expect(top.color[at]).toBe(3);
    expect(top.depth[at]).toBe(4);
    expect(top.thickness[at]).toBe(2);
    expect(top.depth[p(0, 0)]).toBe(-1);
    expect(e.project(1, -1).depth[at]).toBe(0);
    // the clip makes it a cross-section
    e.setWorkplane({ axis: 1, level: 2, clip: "-" });
    expect(e.project(1, 1).depth[at]).toBe(0);
  });
});
