import { describe, expect, test } from "bun:test";
import { defaultDocument, VoxelDocument } from "./document";
import { Editor } from "./editor";
import type { Entry } from "./history";

describe("documents and sessions", () => {
  test("two sessions on one document see each other's edits", () => {
    const doc = new VoxelDocument(defaultDocument([4, 4, 4]));
    const a = new Editor(undefined, { document: doc });
    const b = new Editor(undefined, { document: doc });
    a.setVoxel([1, 1, 1], 3);
    expect(b.getVoxel([1, 1, 1])).toBe(3);
    expect(b.composite[b.index(1, 1, 1)]).toBe(3);
    b.createLayer("Top");
    expect(a.layers.length).toBe(2);
    // each keeps its own active layer
    expect(b.activeLayer!.name).toBe("Top");
    expect(a.activeLayer!.name).toBe("Layer 1");
  });

  test("a document undoes an entry with no session open", () => {
    const entries: Entry[] = [];
    const doc = new VoxelDocument(defaultDocument([4, 4, 4]));
    const e = new Editor(undefined, {
      document: doc,
      history: { record: (_, entry) => entries.push(entry), undo: () => false, redo: () => false, canUndo: false, canRedo: false },
    });
    e.setVoxel([0, 0, 0], 2);
    e.dispose();
    const r = doc.revision;
    const { items } = doc.takeBack(entries[0]);
    expect(items.length).toBeGreaterThan(0);
    expect(doc.layers[0].data[0]).toBe(0);
    expect(doc.revision).toBe(r + 1);
  });

  test("remote ops count as committed changes", () => {
    const a = new Editor();
    const b = new Editor(a.getDocument());
    const ops: Parameters<Editor["applyOps"]>[0] = [];
    a.onEdit((edit) => ops.push(...edit.ops));
    a.setVoxel([1, 0, 1], 4);
    const r = b.revision;
    b.applyOps(ops);
    expect(b.revision).toBe(r + 1);
  });

  test("content bounds aren't clipped by a session's slice", () => {
    const e = new Editor(defaultDocument([8, 8, 8]));
    e.setVoxel([1, 6, 1], 2);
    e.setWorkplane({ axis: 1, level: 2, clip: "-" });
    expect(e.composite[e.index(1, 6, 1)]).toBe(0);
    expect(e.contentBounds()).toEqual({ min: [1, 6, 1], max: [1, 6, 1] });
  });

  test("loading a document starts each session over", () => {
    const doc = new VoxelDocument();
    const e = new Editor(undefined, { document: doc });
    e.setVoxel([0, 0, 0], 1);
    e.selectAll();
    doc.load(defaultDocument([2, 2, 2]));
    expect(e.size).toEqual([2, 2, 2]);
    expect(e.hasSelection).toBe(false);
    expect(e.composite.length).toBe(8);
  });

  test("playback shows frames without changing the document", () => {
    const e = new Editor(defaultDocument([4, 4, 4]));
    e.setFps(10);
    const first = e.activeFrameId;
    e.setVoxel([0, 0, 0], 1);
    const second = e.insertFrame()!;
    e.setVoxel([0, 0, 0], 2);
    e.setFrame(first);
    const version = e.doc.version;
    const contentBefore = e.doc.openFrameId;
    e.play(0);
    e.advance(150); // the second frame is showing
    expect(e.displayFrameId).toBe(second);
    expect(e.composite[0]).toBe(2);
    // the document still has the first frame open, and nothing about it changed
    expect(e.doc.openFrameId).toBe(contentBefore);
    expect(e.doc.version).toBe(version);
    expect(e.getDocument().activeFrame).toBe(0);
    e.pause();
    // pausing makes the frame showing the one being edited
    expect(e.activeFrameId).toBe(second);
    expect(e.getVoxel([0, 0, 0])).toBe(2);
  });
  test("previews are the session's: the document and other sessions don't see them", () => {
    const doc = new VoxelDocument(defaultDocument([4, 4, 4]));
    const a = new Editor(undefined, { document: doc });
    const b = new Editor(undefined, { document: doc });
    const before = doc.palette[1];
    a.previewPaletteColor(1, 0x123456);
    expect(a.palette[1]).toBe(0x123456);
    expect(b.palette[1]).toBe(before);
    expect(doc.toData().palette[1]).toBe(before);
    a.setPaletteColor(1, 0x123456, before);
    expect(doc.palette[1]).toBe(0x123456);
    expect(b.palette[1]).toBe(0x123456);
    a.undo();
    expect(a.palette[1]).toBe(before);
  });
});
