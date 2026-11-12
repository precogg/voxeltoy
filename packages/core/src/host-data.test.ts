import { describe, expect, test } from "bun:test";
import { Editor, type HistoryHost } from "./editor";
import { parseMoxel, serializeMoxel } from "./formats/moxel";
import type { Entry } from "./history";
import { applyOp, MAX_HOST_DATA, OpError } from "./ops";

describe("document identity", () => {
  test("a new document gets an id, kept through a file", () => {
    const e = new Editor();
    expect(e.docId).toMatch(/^doc:/);
    const back = parseMoxel(serializeMoxel(e.getDocument()));
    expect(back.docId).toBe(e.docId);
    expect(new Editor(back).docId).toBe(e.docId);
  });

  test("New makes a new id", () => {
    const e = new Editor();
    const first = e.docId;
    e.newDocument();
    expect(e.docId).not.toBe(first);
  });

  test("revision goes up with every change, undo and redo too, but not with the selection", () => {
    const e = new Editor();
    const r0 = e.revision;
    e.setVoxel([1, 1, 1], 2);
    expect(e.revision).toBe(r0 + 1);
    e.undo();
    expect(e.revision).toBe(r0 + 2);
    e.redo();
    expect(e.revision).toBe(r0 + 3);
    e.selectAll();
    expect(e.revision).toBe(r0 + 3);
    expect(parseMoxel(serializeMoxel(e.getDocument())).revision).toBe(r0 + 3);
  });
});

describe("host data", () => {
  test("document and layer data survive a file in every version", () => {
    const e = new Editor();
    e.setHostData("game", { level: 3, tags: ["a", "b"] });
    e.setLayerHostData(e.activeLayerId, { role: "terrain" });
    const still = parseMoxel(serializeMoxel(e.getDocument()));
    expect(still.hostData).toEqual({ game: { level: 3, tags: ["a", "b"] } });
    expect(still.layers[0].hostData).toEqual({ role: "terrain" });

    e.insertFrame();
    const animated = serializeMoxel(e.getDocument());
    expect(JSON.parse(animated).version).toBe(3);
    const back = parseMoxel(animated);
    expect(back.hostData).toEqual({ game: { level: 3, tags: ["a", "b"] } });
    expect(back.layers[0].hostData).toEqual({ role: "terrain" });
  });

  test("changes are undoable, and null removes", () => {
    const e = new Editor();
    e.setHostData("ns", 1);
    e.setHostData("ns", null);
    expect(e.hostData).toEqual({});
    e.undo();
    expect(e.hostData).toEqual({ ns: 1 });
    e.undo();
    expect(e.hostData).toEqual({});
  });

  test("layer data follows the layer through duplicate, delete and undo", () => {
    const e = new Editor();
    const id = e.activeLayerId;
    e.setLayerHostData(id, { role: "course" });
    e.duplicateLayer(id);
    const copy = e.activeLayerId;
    expect(copy).not.toBe(id);
    expect(e.layers.find((l) => l.id === copy)!.hostData).toEqual({ role: "course" });
    e.deleteLayer(copy);
    expect(e.layers.length).toBe(1);
    e.undo();
    expect(e.layers.find((l) => l.id === copy)!.hostData).toEqual({ role: "course" });
  });

  test("only plain JSON is kept, within a budget", () => {
    const e = new Editor();
    expect(e.setHostData("ns", { when: NaN } as never)).toBe(false);
    expect(e.setHostData("ns", "x".repeat(MAX_HOST_DATA + 1))).toBe(false);
    expect(e.hostData).toEqual({});
  });

  test("unknown keys at the top and on layers are kept", () => {
    const e = new Editor();
    const file = JSON.parse(serializeMoxel(e.getDocument()));
    file.futureThing = { a: 1 };
    file.layers[0].glow = 0.5;
    const doc = parseMoxel(JSON.stringify(file));
    expect(doc.extra).toEqual({ futureThing: { a: 1 } });
    const again = JSON.parse(serializeMoxel(new Editor(doc).getDocument()));
    expect(again.futureThing).toEqual({ a: 1 });
    expect(again.layers[0].glow).toBe(0.5);
  });

  test("a target without host data turns data ops down", () => {
    const target = {
      name: "x",
      size: [1, 1, 1] as [number, number, number],
      gen: "g",
      palette: [0, 1],
      layers: [],
      setName() {},
      setPalette() {},
      setLayers() {},
      setGrid() {},
      writeCell() {},
    };
    expect(() => applyOp(target, { t: "data", key: "ns", after: 1 })).toThrow(OpError);
  });
});

describe("history host", () => {
  /** A host that keeps one stack of (editor, entry), as a scene does. */
  function host() {
    const undos: { editor: Editor; entry: Entry }[] = [];
    const redos: { editor: Editor; entry: Entry }[] = [];
    const h: HistoryHost & { undos: typeof undos } = {
      undos,
      record(editor, entry) {
        undos.push({ editor, entry });
        redos.length = 0;
      },
      undo() {
        const top = undos.pop();
        if (!top) return false;
        const { inverse } = top.editor.takeBack(top.entry, "undo");
        if (inverse) redos.push({ editor: top.editor, entry: inverse });
        return true;
      },
      redo() {
        const top = redos.pop();
        if (!top) return false;
        const { inverse } = top.editor.takeBack(top.entry, "redo");
        if (inverse) undos.push({ editor: top.editor, entry: inverse });
        return true;
      },
      get canUndo() {
        return undos.length > 0;
      },
      get canRedo() {
        return redos.length > 0;
      },
    };
    return h;
  }

  test("two editors share one history, undone in the order edits were made", () => {
    const h = host();
    const a = new Editor(undefined, { history: h });
    const b = new Editor(undefined, { history: h });
    a.setVoxel([0, 0, 0], 1);
    b.setVoxel([1, 0, 0], 2);
    a.setVoxel([2, 0, 0], 3);
    expect(h.undos.length).toBe(3);
    expect(a.history.canUndo).toBe(false);
    expect(b.canUndo).toBe(true);

    b.undo(); // takes back a's last edit: one history
    expect(a.getVoxel([2, 0, 0])).toBe(0);
    expect(b.getVoxel([1, 0, 0])).toBe(2);
    a.undo();
    expect(b.getVoxel([1, 0, 0])).toBe(0);
    a.redo();
    expect(b.getVoxel([1, 0, 0])).toBe(2);
  });
});
