import { describe, expect, test } from "bun:test";
import { Editor, type CustomTool } from "./editor";
import type { Ray, Vec3 } from "./types";

const down = (x: number, z: number): Ray => ({ origin: [x + 0.5, 100, z + 0.5], dir: [0, -1, 0] });

// A value that records one direction: 1 + the index of its normal in this list.
const DIRS: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1]];
const dirOf = (v: number) => DIRS[v - 1];
const valueOf = (n: Vec3) => 1 + DIRS.findIndex((d) => d.every((x, a) => x === n[a]));
const transformValue = (v: number, direction: (n: Vec3) => Vec3) => valueOf(direction(dirOf(v)));

describe("custom tools", () => {
  test("receive the gesture, edit undoably, and preview on hover", () => {
    const calls: string[] = [];
    const stamp: CustomTool = {
      id: "stamp",
      down(input, editor) {
        const hit = editor.pickVisible(input.ray);
        if (!hit) return false;
        calls.push("down");
        editor.beginStroke("Stamp");
        editor.setCells([hit.cell], 7);
        return true;
      },
      move: () => void calls.push("move"),
      up(editor) {
        calls.push("up");
        editor.endStroke();
      },
      hover: (input, editor) => {
        const hit = editor.pickVisible(input.ray);
        return hit && { kind: "paint", boxes: [{ min: hit.cell, max: hit.cell }] };
      },
    };
    const e = new Editor(undefined, { tools: [stamp] });
    e.newDocument([4, 4, 4]);
    e.setCells([[1, 0, 1]], 1);
    e.setTool("stamp");

    expect(e.pointerDown({ ray: down(3, 3) })).toBe(false); // nothing there: orbit
    expect(e.pointerDown({ ray: down(1, 1) })).toBe(true);
    e.pointerMove({ ray: down(1, 1) });
    e.pointerUp();
    expect(calls).toEqual(["down", "move", "up"]);
    expect(e.getVoxel([1, 0, 1])).toBe(7);
    e.undo();
    expect(e.getVoxel([1, 0, 1])).toBe(1);

    e.pointerHover({ ray: down(1, 1) });
    expect(e.preview?.kind).toBe("paint");
    expect(e.hover).toEqual({ cell: [1, 0, 1], normal: [0, 1, 0] });
    e.pointerHover(null);
    expect(e.hover).toBeNull();
  });

  test("a cancelled custom gesture reverts its stroke", () => {
    const tool: CustomTool = {
      id: "t",
      down(_input, editor) {
        editor.beginStroke("T");
        editor.setCells([[0, 0, 0]], 3);
        return true;
      },
    };
    const e = new Editor(undefined, { tools: [tool] });
    e.newDocument([4, 4, 4]);
    e.setTool("t");
    e.pointerDown({ ray: down(0, 0) });
    expect(e.getVoxel([0, 0, 0])).toBe(3);
    e.cancelPointer();
    expect(e.getVoxel([0, 0, 0])).toBe(0);
    expect(e.canUndo).toBe(false);
  });
});

describe("transformValue", () => {
  test("turns direction-encoding values with the selection and the layer", () => {
    const e = new Editor(undefined, { transformValue });
    e.newDocument([4, 4, 4]);
    e.setCells([[0, 0, 0]], valueOf([1, 0, 0]));
    e.selectAll();
    // around Y, +X turns toward -Z
    e.rotateSelection(1);
    e.applyTransform();
    const turned = e.activeLayer!.data.find((v) => v)!;
    expect(dirOf(turned)).toEqual([0, 0, -1]);

    e.deselect();
    e.flipLayer(2);
    expect(dirOf(e.activeLayer!.data.find((v) => v)!)).toEqual([0, 0, 1]);

    e.rotateLayer(1);
    expect(dirOf(e.activeLayer!.data.find((v) => v)!)).toEqual([1, 0, 0]);
  });

  test("leaves values alone without the option", () => {
    const e = new Editor();
    e.newDocument([4, 4, 4]);
    e.setCells([[0, 0, 0]], 2);
    e.flipLayer(0);
    expect(e.activeLayer!.data.find((v) => v)).toBe(2);
  });
});

describe("value visibility", () => {
  test("filtering reveals lower layers and stays consistent after edits and undo", () => {
    const e = new Editor();
    e.newDocument([4, 4, 4]);
    e.setVoxel([1, 0, 1], 2);
    e.createLayer();
    e.setVoxel([1, 0, 1], 1);
    const version = e.documentVersion;
    e.setHiddenValues([1]);
    expect(e.documentVersion).toBe(version);
    expect(e.composite[e.index(1, 0, 1)]).toBe(2);
    expect(e.pickActive(down(1, 1))).toBeNull();
    e.applyCells([[1, 0, 1]], "add", 3);
    expect(e.composite[e.index(1, 0, 1)]).toBe(3);
    e.undo();
    expect(e.getVoxel([1, 0, 1])).toBe(1);
    expect(e.composite[e.index(1, 0, 1)]).toBe(2);
    e.setHiddenValues([]);
    expect(e.composite[e.index(1, 0, 1)]).toBe(1);
  });
});
