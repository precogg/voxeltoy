import { describe, expect, test } from "bun:test";
import { Editor } from "./editor";
import type { Vec3 } from "./types";

const count = (e: Editor) => e.activeLayer!.data.reduce((n, v) => n + (v ? 1 : 0), 0);

function editor(size: Vec3 = [16, 16, 16]) {
  const e = new Editor();
  e.newDocument(size);
  return e;
}

describe("spatial brush", () => {
  test("places a voxel in empty space, with nothing to build on", () => {
    const e = editor();
    e.spatial.stroke([[5.2, 7.9, 3.5]]);
    expect(e.getVoxel([5, 7, 3])).toBe(e.color);
    expect(count(e)).toBe(1);
  });

  test("a stroke leaves no gaps between samples far apart, and is one undo step", () => {
    const e = editor();
    e.spatial.begin([1.5, 1.5, 1.5]);
    e.spatial.to([11.5, 1.5, 1.5]);
    e.spatial.end();
    for (let x = 1; x <= 11; x++) expect(e.getVoxel([x, 1, 1])).toBe(e.color);
    expect(count(e)).toBe(11);
    e.undo();
    expect(count(e)).toBe(0);
    expect(e.canUndo).toBe(false);
  });

  test("a diagonal stroke stays connected", () => {
    const e = editor();
    e.spatial.stroke([[0.5, 0.5, 0.5], [9.5, 9.5, 9.5]]);
    for (let n = 0; n <= 9; n++) expect(e.getVoxel([n, n, n])).toBe(e.color);
  });

  test("size is a ball across that many cells", () => {
    const e = editor();
    expect(e.spatial.cells([8.5, 8.5, 8.5], 1)).toHaveLength(1);
    expect(e.spatial.cells([8.1, 8.1, 8.1], 2)).toHaveLength(8);
    expect(e.spatial.cells([8.5, 8.5, 8.5], 3)).toHaveLength(19);
    e.spatial.setSize(99);
    expect(e.spatial.size).toBe(16);
    e.spatial.setSize(0);
    expect(e.spatial.size).toBe(1);
  });

  test("cells outside the grid are left out", () => {
    const e = editor([4, 4, 4]);
    expect(e.spatial.cells([0.5, 0.5, 0.5], 3)).toHaveLength(7);
    e.spatial.stroke([[-3, -3, -3]]);
    expect(count(e)).toBe(0);
  });

  test("cancel takes the stroke back", () => {
    const e = editor();
    e.spatial.begin([2.5, 2.5, 2.5]);
    e.spatial.to([6.5, 2.5, 2.5]);
    expect(count(e)).toBe(5);
    e.spatial.cancel();
    expect(count(e)).toBe(0);
    expect(e.canUndo).toBe(false);
    expect(e.spatial.active).toBe(false);
  });

  test("follows the tool, the mirror and the selection", () => {
    const e = editor([8, 8, 8]);
    e.toggleMirror(0);
    e.spatial.stroke([[1.5, 1.5, 1.5]]);
    expect(e.getVoxel([1, 1, 1])).toBe(e.color);
    expect(e.getVoxel([6, 1, 1])).toBe(e.color);
    e.toggleMirror(0);
    e.setTool("erase");
    e.spatial.stroke([[1.5, 1.5, 1.5]]);
    expect(e.getVoxel([1, 1, 1])).toBe(0);
    expect(e.getVoxel([6, 1, 1])).toBe(e.color);
  });

  test("an erase stroke through solid carves a tunnel", () => {
    const e = editor([8, 8, 8]);
    const all: Vec3[] = [];
    for (let z = 0; z < 8; z++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) all.push([x, y, z]);
    e.applyCells(all, "add");
    e.spatial.stroke([[0.5, 4.5, 4.5], [7.5, 4.5, 4.5]], "erase");
    expect(count(e)).toBe(512 - 8);
  });

  test("an undo during a stroke ends it", () => {
    const e = editor();
    e.spatial.stroke([[1.5, 1.5, 1.5]]);
    e.spatial.begin([4.5, 4.5, 4.5]);
    e.undo();
    e.spatial.to([8.5, 4.5, 4.5]);
    expect(e.spatial.active).toBe(false);
  });
});
