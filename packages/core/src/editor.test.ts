import { describe, expect, test } from "bun:test";
import { VoxelDocument } from "./document";
import { Editor } from "./editor";
import { decodeRle, encodeRle, parseMoxel, serializeMoxel } from "./formats/moxel";
import { parseVox, writeVox } from "./formats/vox";
import { parseText } from "./palette";
import { raycastVolume } from "./raycast";
import type { Axis, Ray, SliceMode, Vec3 } from "./types";

const down = (x: number, z: number): Ray => ({ origin: [x + 0.5, 100, z + 0.5], dir: [0, -1, 0] });
const count = (e: Editor) => e.activeLayer!.data.reduce((n, v) => n + (v ? 1 : 0), 0);

describe("raycast", () => {
  test("hits the first solid cell and reports the entry face", () => {
    const size: Vec3 = [4, 4, 4];
    const solid = new Uint8Array(64);
    solid[1 + 4 * (2 + 4 * 1)] = 1; // (1, 2, 1)
    const hit = raycastVolume({ origin: [1.5, 10, 1.5], dir: [0, -1, 0] }, size, (i) => solid[i] !== 0);
    expect(hit?.cell).toEqual([1, 2, 1]);
    expect(hit?.normal).toEqual([0, 1, 0]);
  });

  test("misses empty volumes", () => {
    expect(raycastVolume(down(0, 0), [4, 4, 4], () => false)).toBeNull();
  });
});

describe("editor", () => {
  test("projection is scriptable UI state outside document history", () => {
    const e = new Editor();
    const version = e.documentVersion;
    expect(e.projection).toBe("perspective");
    e.setProjection("orthographic");
    expect(e.projection).toBe("orthographic");
    expect(e.documentVersion).toBe(version);
    expect(e.canUndo).toBe(false);
  });

  test("add tool places on the floor, then stacks", () => {
    const e = new Editor();
    e.newDocument([8, 8, 8]);
    e.setTool("add");
    expect(e.pointerDown({ ray: down(2, 3) })).toBe(true);
    e.pointerUp();
    expect(e.getVoxel([2, 0, 3])).toBe(e.color);
    e.pointerDown({ ray: down(2, 3) });
    e.pointerUp();
    expect(e.getVoxel([2, 1, 3])).toBe(e.color);
  });

  test("tools pass through to orbit when nothing is hit", () => {
    const e = new Editor();
    e.setTool("erase");
    expect(e.pointerDown({ ray: down(2, 3) })).toBe(false);
  });

  test("undo and redo a stroke as one step", () => {
    const e = new Editor();
    e.newDocument([8, 8, 8]);
    e.applyCells([[0, 0, 0], [1, 0, 0]], "add");
    expect(count(e)).toBe(2);
    e.undo();
    expect(count(e)).toBe(0);
    e.redo();
    expect(count(e)).toBe(2);
  });

  test("cancelling a stroke reverts it without history", () => {
    const e = new Editor();
    e.newDocument([8, 8, 8]);
    e.pointerDown({ ray: down(1, 1) });
    expect(count(e)).toBe(1);
    e.cancelPointer();
    expect(count(e)).toBe(0);
    expect(e.canUndo).toBe(false);
  });

  test("mirror reflects across the volume center", () => {
    const e = new Editor();
    e.newDocument([8, 8, 8]);
    e.setMirror(0, true);
    e.applyCells([[1, 0, 2]], "add");
    expect(e.getVoxel([6, 0, 2])).toBe(e.color);
  });

  test("box brush fills a rectangle on drag", () => {
    const e = new Editor();
    e.newDocument([8, 8, 8]);
    e.setBrush("box");
    e.pointerDown({ ray: down(1, 1) });
    e.pointerMove({ ray: down(3, 2) });
    expect(count(e)).toBe(0); // only previewed so far
    e.pointerUp();
    expect(count(e)).toBe(6);
  });

  test("face brush extrudes a whole face", () => {
    const e = new Editor();
    e.newDocument([8, 8, 8]);
    e.applyCells([[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1]], "add");
    e.setBrush("face");
    e.pointerDown({ ray: down(0, 0) });
    e.pointerUp();
    expect(count(e)).toBe(8);
  });

  test("connected fill only recolors touching voxels", () => {
    const e = new Editor();
    e.newDocument([8, 8, 8]);
    e.applyCells([[0, 0, 0], [1, 0, 0], [5, 0, 0]], "add", 1);
    e.fill([0, 0, 0], 2, "connected");
    expect(e.getVoxel([1, 0, 0])).toBe(2);
    expect(e.getVoxel([5, 0, 0])).toBe(1);
    e.fill([0, 0, 0], 3, "all");
    expect(e.getVoxel([5, 0, 0])).toBe(1);
    e.fill([5, 0, 0], 3, "all");
    expect(e.getVoxel([5, 0, 0])).toBe(3);
  });

  test("locked and hidden layers refuse edits", () => {
    const e = new Editor();
    e.setLayerLocked(e.activeLayerId, true);
    expect(e.applyCells([[0, 0, 0]], "add")).toBe(0);
    expect(e.toast?.message).toBe("Layer is locked");
  });

  test("layers composite top-down and undo structurally", () => {
    const e = new Editor();
    e.newDocument([4, 4, 4]);
    e.applyCells([[0, 0, 0]], "add", 1);
    const top = e.createLayer();
    e.applyCells([[0, 0, 0]], "add", 2);
    expect(e.composite[0]).toBe(2);
    e.setLayerVisible(top, false);
    expect(e.composite[0]).toBe(1);
    e.setLayerVisible(top, true);
    e.mergeDown(top);
    expect(e.layers.length).toBe(1);
    expect(e.getVoxel([0, 0, 0])).toBe(2);
    e.undo();
    expect(e.layers.length).toBe(2);
    expect(e.getVoxel([0, 0, 0], e.layers[0].id)).toBe(1);
  });

  test("slice hides voxels above the level from picking", () => {
    const e = new Editor();
    e.newDocument([4, 4, 4]);
    e.applyCells([[1, 0, 1], [1, 1, 1], [1, 2, 1]], "add");
    e.setSlice({ axis: 1, level: 1, mode: "-" });
    expect(e.pickVisible(down(1, 1))?.cell).toEqual([1, 1, 1]);
  });

  for (const axis of [0, 1, 2] as Axis[]) {
    for (const mode of ["-", "+", "="] as SliceMode[]) {
      test(`slice ${mode} on axis ${axis} clips rendering, picking, and edits`, () => {
        const e = new Editor();
        e.newDocument([3, 3, 3]);
        const cells = [0, 1, 2].map((level): Vec3 => {
          const cell: Vec3 = [1, 1, 1];
          cell[axis] = level;
          return cell;
        });
        e.applyCells(cells, "add");
        const version = e.documentVersion;
        e.setSlice({ axis, level: 1, mode });
        expect(e.documentVersion).toBe(version);
        const visible = mode === "-" ? [true, true, false] : mode === "+" ? [false, true, true] : [false, true, false];
        cells.forEach((cell, i) => {
          expect(e.inSlice(cell)).toBe(visible[i]);
          expect(e.composite[e.index(...cell)]).toBe(visible[i] ? e.color : 0);
        });
        for (const sign of [-1, 1]) {
          const origin: Vec3 = [1.5, 1.5, 1.5];
          const dir: Vec3 = [0, 0, 0];
          origin[axis] = sign === -1 ? 10 : -10;
          dir[axis] = sign;
          const expected = sign === -1 ? visible.lastIndexOf(true) : visible.indexOf(true);
          expect(e.pickVisible({ origin, dir })?.cell).toEqual(cells[expected]);
          expect(e.pickActive({ origin, dir })?.cell).toEqual(cells[expected]);
        }
        e.setTool("erase");
        const origin: Vec3 = [1.5, 1.5, 1.5];
        const dir: Vec3 = [0, 0, 0];
        origin[axis] = 10;
        dir[axis] = -1;
        for (let i = 0; i < visible.filter(Boolean).length; i++) {
          expect(e.pointerDown({ ray: { origin, dir } })).toBe(true);
          e.pointerUp();
        }
        expect(e.pointerDown({ ray: { origin, dir } })).toBe(false);
        cells.forEach((cell, i) => expect(e.getVoxel(cell)).toBe(visible[i] ? 0 : e.color));
        expect(e.composite.some(Boolean)).toBe(false);
        // Scripted writes update the composite under the same clipping rule.
        cells.forEach((cell) => e.setVoxel(cell, e.color));
        cells.forEach((cell, i) => expect(e.composite[e.index(...cell)]).toBe(visible[i] ? e.color : 0));
        e.setSlice(null);
        expect(e.composite.filter(Boolean).length).toBe(3);
      });
    }
  }

  test("positive slice adds on its exposed face", () => {
    const e = new Editor();
    e.newDocument([4, 4, 4]);
    e.setSlice({ axis: 1, level: 2, mode: "+" });
    const up: Ray = { origin: [1.5, -10, 1.5], dir: [0, 1, 0] };
    expect(e.pointerDown({ ray: up })).toBe(true);
    e.pointerUp();
    expect(e.getVoxel([1, 2, 1])).toBe(e.color);
    expect(e.pickVisible(up)?.cell).toEqual([1, 2, 1]);
  });

  test("flip and rotate layers", () => {
    const e = new Editor();
    e.newDocument([4, 4, 4]);
    e.applyCells([[0, 0, 0]], "add");
    e.flipLayer(0);
    expect(e.getVoxel([3, 0, 0])).toBe(e.color);
    e.rotateLayer(1);
    expect(count(e)).toBe(1);
    e.undo();
    e.undo();
    expect(e.getVoxel([0, 0, 0])).toBe(e.color);
  });

  test("resize keeps the floor and centers x/z, undoably", () => {
    const e = new Editor();
    e.newDocument([4, 4, 4]);
    e.applyCells([[0, 0, 0]], "add");
    e.resize([8, 8, 8]);
    expect(e.size).toEqual([8, 8, 8]);
    expect(e.getVoxel([2, 0, 2])).toBe(e.color);
    e.undo();
    expect(e.size).toEqual([4, 4, 4]);
    expect(e.getVoxel([0, 0, 0])).toBe(e.color);
  });

  test("resize keeps an anchor point in place", () => {
    const e = new Editor();
    e.newDocument([4, 4, 4]);
    e.applyCells([[3, 3, 3]], "add");
    // grow from the low corner: the old voxels stay where they were
    e.resize([8, 6, 8], { anchor: [0, 0, 0] });
    expect(e.getVoxel([3, 3, 3])).toBe(e.color);
    e.undo();
    // keep the high corner: everything shifts up by the growth
    e.resize([8, 6, 8], { anchor: [1, 1, 1] });
    expect(e.getVoxel([7, 5, 7])).toBe(e.color);
    e.undo();
    // shrink toward the top, cropping the bottom; centered X/Z rounds down
    e.resize([3, 2, 4], { anchor: [0.5, 1, 0.5] });
    expect(e.size).toEqual([3, 2, 4]);
    expect(e.getVoxel([2, 1, 3])).toBe(e.color);
  });

  test("resize can place the old volume anywhere, including up off the floor", () => {
    const e = new Editor();
    e.newDocument([4, 4, 4]);
    e.applyCells([[0, 0, 0]], "add");
    const offsets: number[][] = [];
    e.onEdit((edit) => edit.ops.forEach((op) => op.t === "resize" && offsets.push(op.offset)));
    e.resize([10, 9, 8], [5, 3, 1]);
    expect(e.size).toEqual([10, 9, 8]);
    expect(e.getVoxel([5, 3, 1])).toBe(e.color);
    e.undo();
    expect(e.getVoxel([0, 0, 0])).toBe(e.color);
    // Edit listeners see each shift, and its reverse on undo.
    expect(offsets).toEqual([[5, 3, 1], [-5, -3, -1]]);
  });

  test("placeValue picks what Add places from the face it was placed against", () => {
    const e = new Editor(undefined, { placeValue: (value, normal) => (value === 2 && normal[0] === 1 ? 3 : value) });
    e.newDocument([4, 4, 4]);
    e.applyCells([[0, 0, 0]], "add", 2);
    expect(e.getVoxel([0, 0, 0])).toBe(2);
    e.applyCells([[1, 0, 0]], "add", 2, [1, 0, 0]);
    expect(e.getVoxel([1, 0, 0])).toBe(3);
    // Painting keeps the value as given.
    e.applyCells([[0, 0, 0]], "paint", 2);
    expect(e.getVoxel([0, 0, 0])).toBe(2);
  });

  test("placement orientation is local to each gesture and explicit API call", () => {
    const normals: number[][] = [];
    const e = new Editor(undefined, { placeValue: (_, normal) => { normals.push([...normal]); return 3; } });
    e.newDocument([8, 8, 8]);
    e.setColor(2);
    e.setTool("add");
    e.pointerDown({ ray: down(1, 1) });
    e.pointerUp();
    expect(e.getVoxel([1, 0, 1])).toBe(3);
    e.applyCells([[0, 0, 0]], "add", 2);
    expect(e.getVoxel([0, 0, 0])).toBe(2);
    e.newDocument([8, 8, 8]);
    e.applyCells([[0, 0, 0]], "add", 2);
    expect(e.getVoxel([0, 0, 0])).toBe(2);
    e.enter2D();
    for (const brush of ["voxel", "box"] as const) {
      e.setBrush(brush);
      e.pointerDown({ ray: down(2, 2) });
      e.pointerUp();
      expect(e.getVoxel([2, 0, 2])).toBe(3);
      e.undo();
    }
    expect(normals).toEqual([[0, 1, 0], [0, 1, 0], [0, 1, 0]]);
    // Raising copies the existing value rather than reorienting it.
    e.setTool("extrude");
    e.pointerDown({ ray: down(0, 0) });
    e.pointerUp();
    expect(e.getVoxel([0, 1, 0])).toBe(2);
    expect(normals).toHaveLength(3);
  });

  test("loading a shorter palette remaps out-of-range voxels", () => {
    const e = new Editor();
    e.newDocument([4, 4, 4]);
    e.applyCells([[0, 0, 0]], "add", 20);
    e.loadPalette([0xff0000, 0x00ff00]);
    expect(e.palette.length).toBe(3);
    expect(e.getVoxel([0, 0, 0])).toBeLessThan(3);
  });
});

describe("formats", () => {
  test("RLE round trip", () => {
    const data = new Uint8Array(1000);
    data.fill(3, 100, 700);
    data[999] = 9;
    expect(decodeRle(encodeRle(data), data.length)).toEqual(data);
  });

  test(".moxel round trip", () => {
    const e = new Editor();
    e.newDocument([5, 6, 7]);
    e.applyCells([[1, 2, 3]], "add", 4);
    e.createLayer("Top");
    const doc = parseMoxel(serializeMoxel(e.getDocument()));
    expect(doc.size).toEqual([5, 6, 7]);
    expect(doc.layers.map((l) => l.name)).toEqual(["Layer 1", "Top"]);
    expect(doc.layers[0].data[1 + 5 * (2 + 6 * 3)]).toBe(4);
    expect(doc.palette).toEqual([...e.palette]);
  });

  test(".vox round trip preserves size, layers, voxels and palette", async () => {
    const e = new Editor();
    e.newDocument([5, 6, 7]);
    e.applyCells([[1, 2, 3], [4, 0, 6]], "add", 4);
    e.createLayer("Top");
    e.applyCells([[0, 5, 0]], "add", 7);
    const buffer = await writeVox(e.getDocument()).arrayBuffer();
    const doc = parseVox(buffer);
    expect(doc.size).toEqual([5, 6, 7]);
    expect(doc.layers.map((l) => l.name)).toEqual(["Layer 1", "Top"]);
    const at = (l: number, [x, y, z]: Vec3) => doc.layers[l].data[x + 5 * (y + 6 * z)];
    expect(at(0, [1, 2, 3])).toBe(4);
    expect(at(0, [4, 0, 6])).toBe(4);
    expect(at(1, [0, 5, 0])).toBe(7);
    expect(doc.palette[4]).toBe(e.palette[4]);
  });

  test("text palette formats", () => {
    expect(parseText("GIMP Palette\nName: x\n#\n255   0   0\tRed\n  0 255   0\n")).toEqual([0xff0000, 0x00ff00]);
    expect(parseText("JASC-PAL\n0100\n2\n255 0 0\n0 0 255\n")).toEqual([0xff0000, 0x0000ff]);
    expect(parseText("ff0000\n00ff00\n")).toEqual([0xff0000, 0x00ff00]);
    expect(parseText("; paint.net\nFFFF0000\nFF0000FF\n")).toEqual([0xff0000, 0x0000ff]);
  });
});

describe("hidden cells", () => {
  const down: Ray = { origin: [1.5, 100, 1.5], dir: [0, -1, 0] };
  const stack = () => {
    const e = new Editor();
    e.newDocument([4, 4, 4]);
    e.setCells([[1, 0, 1], [1, 1, 1]], 1);
    return e;
  };

  test("hide by position: not drawn, picked or erased; shown while peeking; not saved", () => {
    const e = stack();
    const version = e.documentVersion;
    expect(e.hideCells([[1, 1, 1], [3, 3, 3]])).toBe(1);
    expect(e.hiddenCellCount).toBe(1);
    expect(e.documentVersion).toBe(version);
    expect(e.composite[e.index(1, 1, 1)]).toBe(0);
    expect(e.pickVisible(down)?.cell).toEqual([1, 0, 1]);
    expect(e.applyCells([[1, 1, 1]], "erase")).toBe(0);
    e.setHiddenCellsShown(true);
    expect(e.pickVisible(down)?.cell).toEqual([1, 1, 1]);
    expect(e.isCellHidden([1, 1, 1])).toBe(false);
    expect(e.isPositionHidden([1, 1, 1])).toBe(true);
    e.setHiddenCellsShown(false);
    expect(e.isCellHidden([1, 1, 1])).toBe(true);
    e.clearHiddenCells();
    expect(e.hiddenCellCount).toBe(0);
    expect(e.pickVisible(down)?.cell).toEqual([1, 1, 1]);
  });

  test("Add brings a hidden cell back; emptied cells and new documents drop hiding", () => {
    const e = stack();
    e.hideCells([[1, 1, 1], [1, 0, 1]]);
    e.applyCells([[1, 1, 1]], "add", 2);
    expect(e.getVoxel([1, 1, 1])).toBe(1);
    expect(e.isCellHidden([1, 1, 1])).toBe(false);
    e.setCells([[1, 0, 1]], 0);
    expect(e.hiddenCellCount).toBe(0);
    e.hideCells([[1, 1, 1]]);
    e.newDocument([4, 4, 4]);
    expect(e.hiddenCellCount).toBe(0);
  });
});

describe("review regressions", () => {
  test("a document opens on the layer it was saved with active", () => {
    const e = new Editor();
    e.newDocument([2, 2, 2]);
    e.createLayer("Top");
    const doc = e.getDocument();
    expect(doc.activeLayer).toBe(1);
    const f = new Editor(doc);
    expect(f.activeLayerId).toBe(f.layers[1].id);
    // and a document with no session saves it as loaded
    expect(new VoxelDocument(doc).toData().activeLayer).toBe(1);
  });

  test("loading a snapshot during a stroke takes the stroke back before the new voxels arrive", () => {
    const e = new Editor();
    e.newDocument([2, 2, 2]);
    const incoming = e.getDocument();
    incoming.layers[0].data.fill(3);
    e.beginStroke("Paint");
    e.setVoxel([0, 0, 0], 5);
    e.loadDocument(incoming);
    expect([...e.layers[0].data]).toEqual(new Array(8).fill(3));
  });
});


describe("undo action state", () => {
  test("a pending move is undoable even with empty recorded history", () => {
    const e = new Editor();
    e.applyCells([[1, 0, 1]], "add");
    e.liftSelection();
    e.history.clear();
    expect(e.floating).not.toBeNull();
    expect(e.canUndo).toBe(true);
    expect(e.undoLabel).toBe("Cancel move");
    expect(e.undo()).toBe(true);
    expect(e.floating).toBeNull();
    expect(e.canUndo).toBe(false);
    expect(e.undoLabel).toBeNull();
    expect(e.getVoxel([1, 0, 1])).not.toBe(0);
  });

  test("an extrusion cancellation precedes recorded history", () => {
    const e = new Editor();
    e.applyCells([[1, 0, 1]], "add");
    const recorded = e.undoLabel;
    expect(e.startExtrusion([1, 0, 1], [0, 1, 0])).toBe(true);
    expect(e.undoLabel).toBe("Cancel extrusion");
    expect(e.undo()).toBe(true);
    expect(e.undoLabel).toBe(recorded);
  });
});
