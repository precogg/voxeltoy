import { describe, expect, test } from "bun:test";
import { Editor } from "./editor";
import { boxExtent, rotateDraft, shapeCells, shapeHandles, turnDraft, type ShapeDraft, type ShapeSpec } from "./shapes";
import type { Box, Ray, Vec3 } from "./types";

const cube = (n: number, at: Vec3 = [0, 0, 0]): Box => ({ min: at, max: [at[0] + n - 1, at[1] + n - 1, at[2] + n - 1] });
const up = { axis: 1, sign: 1 } as const;
const spec = (kind: ShapeSpec["kind"], box: Box, extra: Partial<ShapeSpec> = {}): ShapeSpec => ({ kind, box, up, ...extra });
const key = (c: Vec3) => c.join(",");
/** Cells per layer along y, bottom to top. */
const layers = (cells: Vec3[], height: number) =>
  Array.from({ length: height }, (_, y) => cells.filter((c) => c[1] === y).length);

describe("shape rasterizing", () => {
  test("a box fills its box", () => {
    expect(shapeCells(spec("box", cube(3))).length).toBe(27);
  });

  test("spheres are round and symmetric, even sizes included", () => {
    const odd = shapeCells(spec("sphere", cube(3)));
    // 3³ without its 8 corners
    expect(odd.length).toBe(19);
    expect(odd.map(key)).not.toContain("0,0,0");
    expect(odd.map(key)).toContain("1,1,1");

    const even = shapeCells(spec("sphere", cube(8)));
    const set = new Set(even.map(key));
    for (const [x, y, z] of even) expect(set.has(key([7 - x, 7 - y, 7 - z]))).toBe(true);
    expect(set.has("0,0,0")).toBe(false);
  });

  test("pyramids step in by one cell a side per layer", () => {
    const box: Box = { min: [0, 0, 0], max: [6, 3, 6] };
    expect(layers(shapeCells(spec("pyramid", box)), 4)).toEqual([49, 25, 9, 1]);
    // pointing down puts the apex at the bottom
    expect(layers(shapeCells(spec("pyramid", box, { up: { axis: 1, sign: -1 } })), 4)).toEqual([1, 9, 25, 49]);
  });

  test("diamonds are octahedra", () => {
    // a 3D plus: center and its six neighbors
    expect(shapeCells(spec("diamond", cube(3))).length).toBe(7);
  });

  test("cylinders run along their axis", () => {
    const cells = shapeCells(spec("cylinder", { min: [0, 0, 0], max: [4, 9, 4] }));
    const per = layers(cells, 10);
    expect(new Set(per).size).toBe(1);
    // lying along x: every x slice is the same disc
    const lying = shapeCells(spec("cylinder", { min: [0, 0, 0], max: [9, 4, 4] }, { up: { axis: 0, sign: 1 } }));
    const slices = Array.from({ length: 10 }, (_, x) => lying.filter((c) => c[0] === x).length);
    expect(new Set(slices).size).toBe(1);
    expect(slices[0]).toBe(per[0]);
  });

  test("a torus has a hole as wide as its box allows", () => {
    // 12 across, 4 thick: the tube is 4 wide, leaving a 4-cell hole
    const cells = shapeCells(spec("torus", { min: [0, 0, 0], max: [11, 3, 11] }));
    const set = new Set(cells.map(key));
    expect(set.has("5,1,5")).toBe(false);
    expect(set.has("6,2,6")).toBe(false);
    expect(set.has("3,1,5")).toBe(true);
    expect(set.has("11,1,5")).toBe(true);
  });

  test("hollow keeps only the shell", () => {
    expect(shapeCells(spec("box", cube(4), { hollow: true })).length).toBe(64 - 8);
    expect(shapeCells(spec("box", cube(2), { hollow: true })).length).toBe(8);
  });
});

describe("shape placing", () => {
  test("rotating a standing cylinder lays it down on its base", () => {
    const draft: ShapeDraft = { box: { min: [10, 0, 10], max: [13, 9, 13] }, up, grow: up };
    const lying = rotateDraft("prism", draft, [32, 32, 32]);
    expect(lying.up).toEqual({ axis: 0, sign: 1 });
    // 10 long along x, 4 tall, still on the floor, centered where it stood
    expect(lying.box).toEqual({ min: [7, 0, 10], max: [16, 3, 13] });
    // a capsule points along an axis either way: back up after three turns
    let back = lying;
    for (let i = 0; i < 2; i++) back = rotateDraft("capsule", back, [32, 32, 32]);
    expect(back.up.axis).toBe(1);
  });

  test("symmetric shapes don't rotate", () => {
    const draft: ShapeDraft = { box: cube(4), up, grow: up };
    expect(rotateDraft("diamond", draft, [32, 32, 32])).toBe(draft);
  });

  test("a handle sits in the middle of each face, whichever way the shape grew", () => {
    const draft: ShapeDraft = { box: { min: [2, 0, 2], max: [5, 3, 5] }, up, grow: up };
    const handles = Object.fromEntries(shapeHandles(draft).map((h) => [h.id, h.point]));
    expect(Object.keys(handles).sort()).toEqual(["max-0", "max-1", "max-2", "min-0", "min-1", "min-2"]);
    expect(handles["max-1"]).toEqual([4, 4, 4]);
    expect(handles["min-1"]).toEqual([4, 0, 4]);
    expect(handles["min-0"]).toEqual([2, 2, 4]);
    expect(handles["max-2"]).toEqual([4, 2, 6]);
  });

  test("turning a draft swaps its extents across the axis and turns where it points", () => {
    const draft: ShapeDraft = { box: { min: [2, 0, 2], max: [3, 5, 3] }, up, grow: up };
    const lying = turnDraft("cone", draft, 2, 1, [32, 32, 32]);
    expect(boxExtent(lying.box)).toEqual([6, 2, 2]);
    expect(lying.up).toEqual({ axis: 0, sign: -1 });
    // four quarter turns come back
    let back = lying;
    for (let i = 0; i < 3; i++) back = turnDraft("cone", back, 2, 1, [32, 32, 32]);
    expect(back.up).toEqual(up);
    expect(boxExtent(back.box)).toEqual([2, 6, 2]);
    // a capsule points its axis's + way; a cylinder (a prism) either way; a wedge's slope turns too
    expect(turnDraft("capsule", draft, 2, 1, [32, 32, 32]).up).toEqual({ axis: 0, sign: 1 });
    expect(turnDraft("prism", draft, 2, 1, [32, 32, 32]).up).toEqual({ axis: 0, sign: -1 });
    expect(turnDraft("wedge", draft, 1, 1, [32, 32, 32]).forward).toEqual({ axis: 0, sign: 1 });
  });
});

const down = (x: number, z: number): Ray => ({ origin: [x + 0.5, 100, z + 0.5], dir: [0, -1, 0] });
const count = (e: Editor) => e.activeLayer!.data.reduce((n, v) => n + (v ? 1 : 0), 0);

function shapeEditor() {
  const e = new Editor();
  e.newDocument([16, 16, 16]);
  e.setTool("add");
  e.setBrush("shape");
  return e;
}

describe("shape brush", () => {
  test("drag a base, adjust, then apply as one undo step", () => {
    const e = shapeEditor();
    e.setShapeKind("sphere");
    expect(e.pointerDown({ ray: down(2, 2) })).toBe(true);
    e.pointerMove({ ray: down(7, 7) });
    e.pointerUp();

    const shape = e.pendingShape!;
    expect(shape.box).toEqual({ min: [2, 0, 2], max: [7, 5, 7] });
    expect(count(e)).toBe(0);
    expect(e.preview?.cells?.length).toBeGreaterThan(0);

    // tapping off the shape doesn't commit; it falls through to orbit
    expect(e.pointerDown({ ray: down(14, 14) })).toBe(false);
    expect(e.pendingShape).not.toBeNull();

    expect(e.commitShape()).toBe(true);
    expect(e.pendingShape).toBeNull();
    expect(count(e)).toBe(shapeCells(shape).length);
    e.undo();
    expect(count(e)).toBe(0);
  });

  test("a tap places a default-size shape", () => {
    const e = shapeEditor();
    e.pointerDown({ ray: down(8, 8) });
    e.pointerUp();
    expect(e.pendingShape!.box).toEqual({ min: [5, 0, 5], max: [11, 6, 11] });
  });

  test("dragging a face handle moves that face along its axis", () => {
    const e = shapeEditor();
    e.pointerDown({ ray: down(2, 2) });
    e.pointerMove({ ray: down(5, 5) });
    e.pointerUp();
    expect(e.pendingShape!.box.max[1]).toBe(3);

    // a horizontal ray moving up the top face's axis
    const side = (y: number): Ray => ({ origin: [4, y, -50], dir: [0, 0, 1] });
    expect(e.pointerDown({ ray: side(4), handle: "max-1" })).toBe(true);
    e.pointerMove({ ray: side(9) });
    e.pointerUp();
    expect(e.pendingShape!.box).toEqual({ min: [2, 0, 2], max: [5, 8, 5] });

    // a second finger reverts just the adjustment in progress
    e.pointerDown({ ray: side(9), handle: "max-1" });
    e.pointerMove({ ray: side(12) });
    e.cancelPointer();
    expect(e.pendingShape!.box.max[1]).toBe(8);

    // the side faces work the same way, and a face never passes the one opposite
    const front = (x: number): Ray => ({ origin: [x, 2, -50], dir: [0, 0, 1] });
    e.pointerDown({ ray: front(2), handle: "min-0" });
    e.pointerMove({ ray: front(0) });
    e.pointerUp();
    expect(e.pendingShape!.box.min[0]).toBe(0);
    e.pointerDown({ ray: front(0), handle: "min-0" });
    e.pointerMove({ ray: front(20) });
    e.pointerUp();
    expect(e.pendingShape!.box.min[0]).toBe(5);
  });

  test("dragging the shape slides it across the axis you look along", () => {
    const e = shapeEditor();
    e.pointerDown({ ray: down(2, 2) });
    e.pointerMove({ ray: down(5, 5) });
    e.pointerUp();
    expect(e.pointerDown({ ray: down(4, 4) })).toBe(true);
    e.pointerMove({ ray: down(6, 5) });
    e.pointerUp();
    expect(e.pendingShape!.box).toEqual({ min: [4, 0, 3], max: [7, 3, 6] });
  });

  test("the gizmo's ring turns the pending shape; a second finger turns it back", () => {
    const e = shapeEditor();
    e.setShapeKind("cone");
    e.pointerDown({ ray: down(2, 2) });
    e.pointerMove({ ray: down(3, 3) });
    e.pointerUp();
    const before = e.pendingShape!;
    expect(boxExtent(before.box)).toEqual([2, 2, 2]);
    e.turnPendingShape(2, 1);
    expect(e.pendingShape!.up).toEqual({ axis: 0, sign: -1 });
    expect(e.transformBox).toEqual(e.pendingShape!.box);
  });

  test("erase shapes cut into the surface", () => {
    const e = new Editor();
    e.newDocument([8, 8, 8]);
    e.placeShape({ kind: "box", box: { min: [0, 0, 0], max: [7, 3, 7] }, up });
    expect(count(e)).toBe(256);
    e.setTool("erase");
    e.setBrush("shape");
    e.pointerDown({ ray: down(2, 2) });
    e.pointerMove({ ray: down(3, 3) });
    e.pointerUp();
    expect(e.pendingShape!.box).toEqual({ min: [2, 2, 2], max: [3, 3, 3] });
    e.commitShape();
    expect(count(e)).toBe(256 - 8);
  });

  test("style changes retarget the pending shape; undo cancels it", () => {
    const e = shapeEditor();
    e.pointerDown({ ray: down(0, 0) });
    e.pointerMove({ ray: down(11, 11) });
    e.pointerUp();
    expect(e.pendingShape!.box.max[1]).toBe(11);
    // an untouched height follows the shape's default: a torus gets a thin tube
    e.setShapeKind("torus");
    expect(e.pendingShape!.box.max[1]).toBe(3);
    e.setTool("erase");
    expect(e.pendingShape!.op).toBe("erase");
    e.setTool("add");
    e.undo();
    expect(e.pendingShape).toBeNull();
    expect(e.canUndo).toBe(false);
  });

  test("leaving the shape brush drops the pending shape", () => {
    const e = shapeEditor();
    e.pointerDown({ ray: down(2, 2) });
    e.pointerUp();
    e.setBrush("voxel");
    expect(e.pendingShape).toBeNull();
    expect(e.preview).toBeNull();
  });
});
