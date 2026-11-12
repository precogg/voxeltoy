import { describe, expect, test } from "bun:test";
import { Editor, type LocalEdit } from "./editor";
import { encodeRle } from "./formats/moxel";
import { applyOp, invertOp, OpError, type DocOp, type DocTarget, type LayerRecord } from "./ops";
import type { Vec3 } from "./types";

/** Everything shared about a document, comparable with toEqual. */
function shared(e: Editor) {
  const doc = e.getDocument();
  return {
    name: doc.name,
    size: doc.size,
    gen: doc.gen,
    palette: doc.palette,
    layers: doc.layers.map((l) => ({
      id: l.id,
      name: l.name,
      voxels: Array.from(encodeRle(l.data)),
    })),
  };
}

/** A copy of an editor's document that shares no arrays with it. */
const copyOf = (e: Editor) => {
  const doc = e.getDocument();
  return { ...doc, layers: doc.layers.map((l) => ({ ...l, data: l.data.slice() })) };
};

/** Two editors on the same document; every edit in `a` is replayed in `b`. */
function pair(size: Vec3 = [6, 6, 6]) {
  const a = new Editor();
  a.newDocument(size);
  const b = new Editor(copyOf(a));
  const edits: LocalEdit[] = [];
  a.onEdit((edit) => {
    edits.push(edit);
    b.applyOps(edit.ops);
  });
  return { a, b, edits };
}

describe("document ops", () => {
  test("loading a shared document keeps layer ids and the grid's generation", () => {
    const a = new Editor();
    a.createLayer("Top");
    const b = new Editor(copyOf(a));
    expect(shared(b)).toEqual(shared(a));
  });

  test("every kind of edit replays exactly in another editor", () => {
    const { a, b, edits } = pair();
    a.setName("Robot");
    a.applyCells([[0, 0, 0], [1, 0, 0], [2, 1, 0]], "add", 3);
    const top = a.createLayer("Arm")!;
    a.applyCells([[3, 3, 3]], "add", 5);
    a.duplicateLayer(top);
    a.renameLayer(a.activeLayerId, "Arm 2");
    a.moveLayer(a.activeLayerId, 0);
    a.setPaletteColor(2, 0x123456);
    a.addPaletteColor(0xabcdef);
    a.selectLayer(top);
    a.flipLayer(0);
    a.selectBox({ min: [0, 0, 0], max: [5, 5, 5] });
    a.selectionToLayer({ move: true });
    a.deselect();
    a.mergeDown(a.activeLayerId);
    a.resize([8, 5, 8]);
    a.loadPalette([0xff0000, 0x00ff00, 0x0000ff]);
    a.deleteLayer(a.layers[0].id);
    expect(edits.length).toBeGreaterThan(13);
    expect(shared(b)).toEqual(shared(a));
  });

  test("undo and redo replay too, back to the start", () => {
    const { a, b } = pair();
    const start = shared(a);
    a.applyCells([[1, 1, 1]], "add", 2);
    a.createLayer();
    a.applyCells([[2, 2, 2]], "add", 4);
    a.resize([4, 4, 4]);
    a.deleteLayer(a.layers[0].id);
    a.addPaletteColor(0x010203);
    const end = shared(a);
    while (a.canUndo) a.undo();
    expect(shared(a)).toEqual(start);
    expect(shared(b)).toEqual(start);
    while (a.canRedo) a.redo();
    expect(shared(a)).toEqual(end);
    expect(shared(b)).toEqual(end);
  });

  test("selection changes are undoable but stay local", () => {
    const { a, edits } = pair();
    a.selectBox({ min: [0, 0, 0], max: [1, 1, 1] });
    expect(a.selectionCount).toBe(8);
    expect(edits).toHaveLength(0);
    a.undo();
    expect(a.selectionCount).toBe(0);
  });

  test("ops that don't fit change nothing and say why", () => {
    const { a } = pair();
    const doc = shared(a);
    const bad: DocOp[] = [
      { t: "voxels", layer: "layer:missing", gen: "x", cells: Uint32Array.of(0), before: Uint8Array.of(0), after: Uint8Array.of(1) },
      { t: "voxels", layer: a.activeLayerId, gen: "stale", cells: Uint32Array.of(0), before: Uint8Array.of(0), after: Uint8Array.of(1) },
      { t: "palette.add", index: 2, color: 0 },
      { t: "layer.set", id: a.activeLayerId, key: "parent", after: a.activeLayerId },
      { t: "layer.remove", id: a.activeLayerId },
    ];
    for (const op of bad) expect(() => a.applyOps([op])).toThrow(OpError);
    expect(shared(a)).toEqual(doc);
  });

  test("a batch of ops is all or nothing", () => {
    const { a } = pair();
    const doc = shared(a);
    const gen = a.getDocument().gen!;
    expect(() =>
      a.applyOps([
        { t: "voxels", layer: a.activeLayerId, gen, cells: Uint32Array.of(0, 1), before: new Uint8Array(2), after: Uint8Array.of(1, 1) },
        { t: "palette.set", index: 999, after: 0 },
      ]),
    ).toThrow(OpError);
    expect(shared(a)).toEqual(doc);
  });

  test("strict checks catch cells outside the model and repeated cells", () => {
    const { a } = pair([2, 2, 2]);
    const gen = a.getDocument().gen!;
    const op = (cells: number[]): DocOp => ({
      t: "voxels",
      layer: a.activeLayerId,
      gen,
      cells: Uint32Array.from(cells),
      before: new Uint8Array(cells.length),
      after: new Uint8Array(cells.length).fill(1),
    });
    expect(() => a.applyOps([op([8])])).toThrow("outside");
    expect(() => a.applyOps([op([1, 1])])).toThrow("twice");
  });

  test("a resize keeps what it crops, so undoing it brings it back", () => {
    const target = plainTarget([4, 4, 4]);
    target.layers[0].data[3] = 7; // (3, 0, 0)
    target.layers[0].data[0] = 2;
    const op: DocOp = { t: "resize", from: [4, 4, 4], to: [2, 4, 4], offset: [-1, 0, 0], fromGen: "g0", toGen: "g1" };
    applyOp(target, op);
    expect(target.size).toEqual([2, 4, 4]);
    expect(target.layers[0].data.reduce((n, v) => n + (v ? 1 : 0), 0)).toBe(0);
    applyOp(target, invertOp(op));
    expect(target.gen).toBe("g0");
    expect(target.layers[0].data[3]).toBe(7);
    expect(target.layers[0].data[0]).toBe(2);
  });
});

describe("shared undo", () => {
  /** An editor whose edits are confirmed at once, with someone else's edits arriving through `remote`. */
  function confirmed() {
    const a = new Editor();
    a.newDocument([4, 4, 4]);
    a.onEdit((edit) => a.history.confirm(edit.id));
    const other = new Editor(copyOf(a));
    a.onEdit((edit) => other.applyOps(edit.ops));
    const remote = (fn: (e: Editor) => void) => {
      const off = other.onEdit((edit) => {
        a.applyOps(edit.ops);
        a.history.disown(edit.ops);
      });
      fn(other);
      off();
    };
    return { a, other, remote };
  }

  test("undo keeps cells someone else painted since", () => {
    const { a, remote } = confirmed();
    a.applyCells([[0, 0, 0], [1, 0, 0]], "add", 2);
    remote((b) => b.applyCells([[0, 0, 0]], "paint", 5));
    a.undo();
    expect(a.getVoxel([0, 0, 0])).toBe(5);
    expect(a.getVoxel([1, 0, 0])).toBe(0);
  });

  test("ownership follows writes, not colors", () => {
    const { a, remote } = confirmed();
    a.applyCells([[0, 0, 0]], "add", 2);
    // they paint it another color and back: the color matches, but the write is theirs
    remote((b) => b.setCells([[0, 0, 0]], 5));
    remote((b) => b.setCells([[0, 0, 0]], 2));
    a.undo();
    expect(a.getVoxel([0, 0, 0])).toBe(2);
  });

  test("redo only redoes what undo took back", () => {
    const { a, remote } = confirmed();
    a.applyCells([[0, 0, 0], [1, 0, 0]], "add", 2);
    remote((b) => b.applyCells([[0, 0, 0]], "paint", 5));
    a.undo();
    a.redo();
    expect(a.getVoxel([0, 0, 0])).toBe(5);
    expect(a.getVoxel([1, 0, 0])).toBe(2);
  });

  test("undoing a new layer that someone else drew on is skipped", () => {
    const { a, remote } = confirmed();
    const id = a.createLayer("Mine")!;
    remote((b) => {
      b.selectLayer(id);
      b.applyCells([[1, 1, 1]], "add", 3);
    });
    a.undo();
    expect(a.layers.some((l) => l.id === id)).toBe(true);
    expect(a.toast?.message).toContain("someone else");
  });

  test("undoing a deleted layer brings back its voxels", () => {
    const { a, other } = confirmed();
    const arm = a.createLayer("Arm")!;
    a.applyCells([[2, 2, 2]], "add", 4);
    a.deleteLayer(arm);
    a.undo();
    expect(a.getVoxel([2, 2, 2], arm)).toBe(4);
    expect(shared(other)).toEqual(shared(a));
  });

  test("undo after someone else resized skips voxel edits from the old grid", () => {
    const { a, remote } = confirmed();
    a.applyCells([[1, 1, 1]], "add", 2);
    remote((b) => b.resize([6, 6, 6]));
    a.undo();
    expect(a.getVoxel([2, 1, 2])).toBe(2);
    expect(a.toast?.message).toContain("someone else");
  });

  test("reconcile keeps a stroke on top of someone else's edit, and cancelling it reveals their work", () => {
    const { a, other } = confirmed();
    a.beginStroke("Paint");
    a.applyCells([[0, 0, 0]], "add", 2);
    const edits: LocalEdit[] = [];
    const off = other.onEdit((edit) => edits.push(edit));
    other.applyCells([[0, 0, 0], [1, 0, 0]], "add", 5);
    off();
    a.reconcile(edits[0].ops, () => a.applyOps(edits[0].ops));
    expect(a.getVoxel([0, 0, 0])).toBe(2);
    expect(a.getVoxel([1, 0, 0])).toBe(5);
    a.cancelStroke();
    expect(a.getVoxel([0, 0, 0])).toBe(5);
  });
});

describe("read-only documents", () => {
  test("block edits with the reason, but not selection", () => {
    const e = new Editor();
    e.newDocument([4, 4, 4]);
    e.setReadOnly("View only");
    expect(e.applyCells([[0, 0, 0]], "add")).toBe(0);
    expect(e.toast?.message).toBe("View only");
    expect(e.createLayer()).toBeNull();
    e.setPaletteColor(1, 0);
    e.resize([8, 8, 8]);
    e.setName("Nope");
    expect(e.canUndo).toBe(false);
    expect(e.size).toEqual([4, 4, 4]);
    e.selectBox({ min: [0, 0, 0], max: [1, 1, 1] });
    expect(e.selectionCount).toBe(8);
  });
});

function plainTarget(size: Vec3): DocTarget & { layers: LayerRecord[] } {
  const count = size[0] * size[1] * size[2];
  const target = {
    name: "Plain",
    size,
    gen: "g0",
    palette: [0, 1, 2, 3, 4, 5, 6, 7, 8] as readonly number[],
    layers: [{ id: "layer:a", name: "A", data: new Uint8Array(count) }] as LayerRecord[],
    setName(name: string) {
      target.name = name;
    },
    setPalette(palette: readonly number[]) {
      target.palette = palette;
    },
    setLayers(layers: readonly LayerRecord[]) {
      target.layers = [...layers];
    },
    setGrid(s: Vec3, gen: string, layers: readonly LayerRecord[]) {
      target.size = s;
      target.gen = gen;
      target.layers = [...layers];
    },
    writeCell(data: Uint8Array, index: number, value: number) {
      data[index] = value;
    },
  };
  return target;
}
