import { describe, expect, test } from "bun:test";
import { Editor } from "./editor";
import { flipBlock, growMask, rotateBlock, shrinkMask, type Block } from "./selection";
import type { Ray, Vec3 } from "./types";

const down = (x: number, z: number): Ray => ({ origin: [x + 0.5, 100, z + 0.5], dir: [0, -1, 0] });

/** An 8³ editor with a 3-wide row of voxels on the floor at x = 1..3. */
function setup() {
  const e = new Editor();
  e.newDocument([8, 8, 8]);
  e.applyCells([[1, 0, 1], [2, 0, 1], [3, 0, 1]], "add", 1);
  return e;
}

/** Let queued reactive updates run. */
const tick = () => new Promise((r) => queueMicrotask(() => r(null)));

describe("selection masks", () => {
  test("grow and shrink are inverses on a solid box", () => {
    const size: Vec3 = [5, 5, 5];
    const mask = new Uint8Array(125);
    mask[2 + 5 * (2 + 5 * 2)] = 1;
    const grown = growMask(mask, size);
    expect(grown.reduce((n, v) => n + v, 0)).toBe(7);
    expect(shrinkMask(grown, size).reduce((n, v) => n + v, 0)).toBe(1);
  });

  test("four quarter turns and two flips are identities", () => {
    const block: Block = {
      size: [3, 2, 1],
      voxels: new Uint8Array([1, 2, 3, 4, 5, 6]),
      mask: new Uint8Array([1, 1, 1, 1, 1, 0]),
    };
    let turned = block;
    for (let i = 0; i < 4; i++) turned = rotateBlock(turned, 2);
    expect(turned).toEqual(block);
    expect(rotateBlock(block, 2).size).toEqual([2, 3, 1]);
    expect(flipBlock(flipBlock(block, 0), 0)).toEqual(block);
    expect([...flipBlock(block, 0).voxels]).toEqual([3, 2, 1, 6, 5, 4]);
  });
});

describe("selecting", () => {
  test("modes combine with the current selection, and undo restores it", () => {
    const e = setup();
    e.selectCells([[1, 0, 1], [2, 0, 1]], "replace");
    expect(e.selectionCount).toBe(2);
    e.selectCells([[3, 0, 1]], "add");
    expect(e.selectionCount).toBe(3);
    e.selectCells([[1, 0, 1]], "subtract");
    expect(e.isSelected([1, 0, 1])).toBe(false);
    e.selectCells([[2, 0, 1], [5, 5, 5]], "intersect");
    expect(e.selectionCount).toBe(1);
    expect(e.isSelected([2, 0, 1])).toBe(true);
    e.undo();
    expect(e.selectionCount).toBe(2);
    e.deselect();
    expect(e.hasSelection).toBe(false);
  });

  test("selection changes aren't saved in the document", () => {
    const e = setup();
    e.selectAll();
    expect(e.selectionCount).toBe(3);
    expect(Object.keys(e.getDocument())).not.toContain("selection");
  });

  test("the select tool takes every brush", () => {
    const e = setup();
    e.setTool("select");

    e.setSelectBrush("voxel");
    expect(e.pointerDown({ ray: down(1, 1) })).toBe(true);
    e.pointerMove({ ray: down(2, 1) });
    e.pointerUp();
    expect(e.selectionCount).toBe(2);

    e.setSelectBrush("box");
    e.pointerDown({ ray: down(1, 1) });
    e.pointerMove({ ray: down(3, 2) });
    e.pointerUp();
    // the box covers empty cells too: a selection is a region
    expect(e.selectionCount).toBe(6);

    e.setSelectBrush("face");
    e.pointerDown({ ray: down(2, 1) });
    e.pointerUp();
    expect(e.selectionCount).toBe(3);

    e.applyCells([[3, 0, 1]], "paint", 2);
    e.setSelectBrush("color");
    e.pointerDown({ ray: down(1, 1) });
    e.pointerUp();
    expect(e.selectionCount).toBe(2);
    expect(e.isSelected([3, 0, 1])).toBe(false);
  });

  test("shift adds, ctrl subtracts, and a tap on empty space deselects", () => {
    const e = setup();
    e.setTool("select");
    e.setSelectBrush("voxel");
    e.pointerDown({ ray: down(1, 1) });
    e.pointerUp();
    e.pointerDown({ ray: down(2, 1), shift: true });
    e.pointerUp();
    expect(e.selectionCount).toBe(2);
    e.pointerDown({ ray: down(1, 1), mod: true });
    e.pointerUp();
    expect(e.selectionCount).toBe(1);
    expect(e.pointerDown({ ray: down(6, 6) })).toBe(false);
    e.pointerTap();
    expect(e.hasSelection).toBe(false);
  });

  test("a selection shape stays pending until applied", () => {
    const e = setup();
    e.setTool("select");
    e.setSelectBrush("shape");
    e.setShapeKind("box");
    e.pointerDown({ ray: down(1, 1) });
    e.pointerMove({ ray: down(3, 1) });
    e.pointerUp();
    expect(e.pendingShape?.op).toBe("select");
    expect(e.hasSelection).toBe(false);
    e.commitShape();
    expect(e.isSelected([1, 0, 1])).toBe(true);
    expect(e.isSelected([3, 0, 1])).toBe(true);
  });

  test("mirror applies to selection brushes", () => {
    const e = setup();
    e.setMirror(0, true);
    e.selectCells([[1, 0, 1]]);
    expect(e.isSelected([6, 0, 1])).toBe(true);
  });

  test("connected, invert, grow and shrink", () => {
    const e = setup();
    e.applyCells([[6, 0, 6]], "add", 1);
    e.selectCells([[1, 0, 1]]);
    e.selectConnected();
    expect(e.selectionCount).toBe(3);
    e.invertSelection();
    expect(e.selectionCount).toBe(1);
    expect(e.isSelected([6, 0, 6])).toBe(true);
    e.growSelection();
    expect(e.selectionCount).toBe(6);
    e.shrinkSelection();
    expect(e.selectionCount).toBe(1);
  });
});

describe("editing the selected content", () => {
  test("content edits only touch selected cells", () => {
    const e = setup();
    e.selectCells([[1, 0, 1]]);
    expect(e.applyCells([[1, 0, 1], [2, 0, 1]], "erase")).toBe(1);
    expect(e.getVoxel([2, 0, 1])).toBe(1);
    e.deselect();
    expect(e.applyCells([[2, 0, 1]], "erase")).toBe(1);
  });

  test("fill, recolor and delete", () => {
    const e = setup();
    e.selectBox({ min: [2, 0, 1], max: [4, 0, 1] });
    e.recolorSelection(3);
    expect([2, 3, 4].map((x) => e.getVoxel([x, 0, 1]))).toEqual([3, 3, 0]);
    e.fillSelection(4);
    expect([2, 3, 4].map((x) => e.getVoxel([x, 0, 1]))).toEqual([4, 4, 4]);
    e.deleteSelection();
    expect([1, 2, 3, 4].map((x) => e.getVoxel([x, 0, 1]))).toEqual([1, 0, 0, 0]);
  });

  test("moving floats the content until it is applied as one step", async () => {
    const e = setup();
    e.selectCells([[1, 0, 1], [2, 0, 1]]);
    e.moveSelection([0, 0, 3]);
    expect(e.floating?.offset).toEqual([1, 0, 4]);
    // the source is hidden while floating, but the layer is untouched until applied
    expect(e.composite[e.index(1, 0, 1)]).toBe(0);
    expect(e.getVoxel([1, 0, 1])).toBe(1);
    expect(e.getDocument().layers[0].data[e.index(1, 0, 1)]).toBe(1);

    expect(e.applyTransform()).toBe(true);
    expect(e.floating).toBeNull();
    expect(e.getVoxel([1, 0, 1])).toBe(0);
    expect(e.getVoxel([1, 0, 4])).toBe(1);
    expect(e.getVoxel([2, 0, 4])).toBe(1);
    expect(e.getVoxel([3, 0, 1])).toBe(1);
    // the selection travels with its content
    expect(e.isSelected([1, 0, 4])).toBe(true);
    expect(e.isSelected([1, 0, 1])).toBe(false);

    e.undo();
    expect(e.getVoxel([1, 0, 1])).toBe(1);
    expect(e.getVoxel([1, 0, 4])).toBe(0);
    expect(e.isSelected([1, 0, 1])).toBe(true);
    await tick();
  });

  test("cancelling puts floating content back", () => {
    const e = setup();
    e.selectAll();
    e.rotateSelection(1);
    expect(e.floating?.size).toEqual([1, 1, 3]);
    e.cancelTransform();
    expect(e.composite[e.index(1, 0, 1)]).toBe(1);
    expect(e.canUndo).toBe(true); // only the earlier edits
    e.undo(); // undoes "Select all", not a transform
    expect(e.hasSelection).toBe(false);
  });

  test("rotating turns around the center of the bounds; four turns land where they started", () => {
    const e = setup();
    e.selectAll();
    e.rotateSelection(1);
    expect(e.floating?.offset).toEqual([2, 0, 0]);
    for (let i = 0; i < 3; i++) e.rotateSelection(1);
    expect(e.floating?.offset).toEqual([1, 0, 1]);
    expect(e.floating?.size).toEqual([3, 1, 1]);
  });

  test("floating content stays inside the volume", () => {
    const e = setup();
    e.selectAll();
    e.moveSelection([100, 0, -100]);
    expect(e.floating?.offset).toEqual([5, 0, 0]);
  });

  test("flip mirrors the content in place", () => {
    const e = setup();
    e.applyCells([[1, 0, 1]], "paint", 2);
    e.selectAll();
    e.flipSelection(0);
    e.applyTransform();
    expect([1, 2, 3].map((x) => e.getVoxel([x, 0, 1]))).toEqual([1, 1, 2]);
  });

  test("the move tool drags the selection, and with nothing selected, the layer", () => {
    const e = setup();
    e.setTool("move");
    // drag the top face of the row from z = 1 to z = 3
    expect(e.pointerDown({ ray: down(2, 1) })).toBe(true);
    e.pointerMove({ ray: down(2, 3) });
    e.pointerUp();
    expect(e.floating?.offset).toEqual([1, 0, 3]);
    expect(e.floating?.selects).toBe(false);
    // a tap on empty space applies
    expect(e.pointerDown({ ray: down(7, 7) })).toBe(false);
    e.pointerTap();
    expect(e.getVoxel([2, 0, 3])).toBe(1);
    expect(e.hasSelection).toBe(false);

    e.selectCells([[1, 0, 3]]);
    e.pointerDown({ ray: down(2, 3) }); // not selected: orbit
    expect(e.floating).toBeNull();
    e.pointerDown({ ray: down(1, 3) });
    e.pointerMove({ ray: down(1, 5) });
    e.cancelPointer(); // a second finger: back where it was, not floating
    expect(e.floating).toBeNull();
    expect(e.getVoxel([1, 0, 3])).toBe(1);
  });

  test("copy, paste and duplicate", () => {
    const e = setup();
    e.selectCells([[1, 0, 1]]);
    expect(e.copy()).toBe(true);
    e.deselect();
    expect(e.paste()).toBe(true);
    e.moveSelection([0, 1, 0]);
    e.applyTransform();
    expect(e.getVoxel([1, 1, 1])).toBe(1);
    expect(e.getVoxel([1, 0, 1])).toBe(1);
    expect(e.isSelected([1, 1, 1])).toBe(true);

    e.duplicateSelection();
    e.moveSelection([0, 1, 0]);
    e.applyTransform();
    expect(e.getVoxel([1, 2, 1])).toBe(1);
    expect(e.getVoxel([1, 1, 1])).toBe(1);

    e.cut();
    expect(e.getVoxel([1, 2, 1])).toBe(0);
  });

  test("pasting into another palette matches colors", () => {
    const e = setup();
    const red = e.addPaletteColor(0xff0000);
    e.applyCells([[1, 0, 1]], "paint", red);
    e.selectCells([[1, 0, 1]]);
    e.copy();
    e.newDocument([8, 8, 8], [0x00ff00, 0xff0000]);
    e.paste();
    e.applyTransform();
    expect(e.getVoxel([1, 0, 1])).toBe(2);
  });

  test("selection to a new layer", () => {
    const e = setup();
    const source = e.activeLayerId;
    e.selectCells([[1, 0, 1]]);
    const id = e.selectionToLayer({ move: true })!;
    expect(e.activeLayerId).toBe(id);
    expect(e.getVoxel([1, 0, 1], id)).toBe(1);
    expect(e.getVoxel([1, 0, 1], source)).toBe(0);
    e.undo();
    expect(e.layers.length).toBe(1);
    expect(e.getVoxel([1, 0, 1], source)).toBe(1);
  });

  test("undo while floating cancels the float first", () => {
    const e = setup();
    e.selectAll();
    e.moveSelection([0, 2, 0]);
    e.undo();
    expect(e.floating).toBeNull();
    expect(e.hasSelection).toBe(true);
  });

  test("resizing clears the selection, and undo brings it back", () => {
    const e = setup();
    e.selectAll();
    e.resize([10, 8, 8]);
    expect(e.hasSelection).toBe(false);
    e.undo();
    expect(e.selectionCount).toBe(3);
  });
});
