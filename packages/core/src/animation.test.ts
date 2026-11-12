import { describe, expect, test } from "bun:test";
import { type AnimationTag, FIRST_FRAME_ID, frameAt, frameStart, tagLanes, totalTicks } from "./animation";
import { Editor } from "./editor";
import { parseMoxel, serializeMoxel } from "./formats/moxel";
import { applyOp, OpError, type DocTarget, type LayerRecord } from "./ops";
import type { Ray, Vec3 } from "./types";

const down = (x: number, z: number): Ray => ({ origin: [x + 0.5, 100, z + 0.5], dir: [0, -1, 0] });

function editor(size: Vec3 = [4, 4, 4]) {
  const e = new Editor();
  e.newDocument(size);
  return e;
}

/** How many voxels a layer has in a frame. */
const filled = (e: Editor, frame: string, layer = e.activeLayerId) => e.frameCel(frame, layer).reduce((n, v) => n + (v ? 1 : 0), 0);

describe("animation clock", () => {
  test("resolves exact boundaries and uneven holds", () => {
    const d = [1, 3, 2];
    expect(totalTicks(d)).toBe(6);
    expect(frameStart(d, 2)).toBe(4);
    // 12 fps: a tick is 83.33 ms
    expect(frameAt(d, 12, 0)).toBe(0);
    expect(frameAt(d, 12, 83.33)).toBe(0);
    expect(frameAt(d, 12, 1000 / 12)).toBe(1);
    expect(frameAt(d, 12, (4 * 1000) / 12 - 1)).toBe(1);
    expect(frameAt(d, 12, (4 * 1000) / 12)).toBe(2);
  });

  test("loops, or holds the last frame", () => {
    const d = [1, 1];
    expect(frameAt(d, 10, 200)).toBe(0);
    expect(frameAt(d, 10, 300)).toBe(1);
    expect(frameAt(d, 10, 10_000, false)).toBe(1);
    expect(frameAt([5], 10, 123_456)).toBe(0);
  });
});

describe("frames", () => {
  test("a new document has one frame and no animation in its document", () => {
    const e = editor();
    expect(e.frames).toHaveLength(1);
    expect(e.activeFrameId).toBe(FIRST_FRAME_ID);
    expect(e.fps).toBe(12);
    expect(e.getDocument().frames).toBeUndefined();
  });

  test("duplicate copies every layer, and edits to the copy stay in it", () => {
    const e = editor();
    e.setVoxel([0, 0, 0], 2);
    const second = e.createLayer()!;
    e.setVoxel([1, 0, 0], 3);
    const first = e.activeFrameId;
    const copy = e.insertFrame()!;
    expect(e.activeFrameId).toBe(copy);
    expect(e.frames.map((f) => f.id)).toEqual([first, copy]);
    expect(e.getVoxel([1, 0, 0])).toBe(3);
    e.setVoxel([2, 0, 0], 4);
    e.setVoxel([1, 0, 0], 0);
    expect(filled(e, first, second)).toBe(1);
    expect(e.frameCel(first, second)[1]).toBe(3);
    expect(filled(e, copy, second)).toBe(1);

    // undo the edit, then the duplicate
    e.undo();
    e.undo();
    expect(filled(e, copy, second)).toBe(1);
    e.undo();
    expect(e.frames).toHaveLength(1);
    expect(e.activeFrameId).toBe(first);
    e.redo();
    expect(e.frames).toHaveLength(2);
  });

  test("a blank frame starts empty with the same layers", () => {
    const e = editor();
    e.setVoxel([0, 0, 0], 2);
    const blank = e.insertFrame({ content: "blank" })!;
    expect(e.activeFrameId).toBe(blank);
    expect(e.layers).toHaveLength(1);
    expect(filled(e, blank)).toBe(0);
    expect(e.composite.some((v) => v)).toBe(false);
  });

  test("undo shows the frame the change was in", () => {
    const e = editor();
    const first = e.activeFrameId;
    const second = e.insertFrame({ content: "blank" })!;
    e.setVoxel([0, 0, 0], 2);
    e.setFrame(first);
    e.undo();
    expect(e.activeFrameId).toBe(second);
    expect(e.getVoxel([0, 0, 0])).toBe(0);
    e.setFrame(first);
    e.redo();
    expect(e.activeFrameId).toBe(second);
    expect(e.getVoxel([0, 0, 0])).toBe(2);
  });

  test("deleting frames keeps at least one, and undo puts them back in place", () => {
    const e = editor();
    const a = e.activeFrameId;
    e.setVoxel([0, 0, 0], 2);
    const b = e.insertFrame()!;
    e.setVoxel([1, 0, 0], 3);
    const c = e.insertFrame({ content: "blank" })!;
    expect(e.removeFrames([a, b, c])).toBe(0);
    expect(e.removeFrames([b])).toBe(1);
    expect(e.frames.map((f) => f.id)).toEqual([a, c]);
    e.undo();
    expect(e.frames.map((f) => f.id)).toEqual([a, b, c]);
    expect(filled(e, b)).toBe(2);
    // deleting the frame being edited opens the one before it
    e.setFrame(b);
    e.removeFrames([b]);
    expect(e.activeFrameId).toBe(a);
    expect(e.getVoxel([0, 0, 0])).toBe(2);
    expect(e.getVoxel([1, 0, 0])).toBe(0);
  });

  test("reordering moves a frame's identity, voxels and timing", () => {
    const e = editor();
    const a = e.activeFrameId;
    e.setVoxel([0, 0, 0], 2);
    const b = e.insertFrame({ content: "blank" })!;
    e.setFrameDuration(b, 3);
    e.moveFrame(b, 0);
    expect(e.frames.map((f) => [f.id, f.duration])).toEqual([
      [b, 3],
      [a, 1],
    ]);
    expect(e.activeFrameId).toBe(b);
    expect(filled(e, a)).toBe(1);
    e.undo();
    expect(e.frames.map((f) => f.id)).toEqual([a, b]);
  });

  test("timing is part of the document and undoable", () => {
    const e = editor();
    const a = e.activeFrameId;
    e.insertFrame();
    e.setFrameDuration(a, 2);
    e.setFps(24);
    expect(e.frames[0].duration).toBe(2);
    expect(e.animationLength).toBe((3 * 1000) / 24);
    e.setFps(0);
    expect(e.fps).toBe(24);
    e.undo();
    expect(e.fps).toBe(12);
    e.undo();
    expect(e.frames[0].duration).toBe(1);
  });

  test("a stroke in progress is taken back when the frame changes", () => {
    const e = editor();
    const a = e.activeFrameId;
    const b = e.insertFrame({ content: "blank" })!;
    e.beginStroke("Draw");
    e.setVoxel([0, 0, 0], 2);
    e.setFrame(a);
    expect(filled(e, b)).toBe(0);
    expect(filled(e, a)).toBe(0);
    expect(e.canUndo).toBe(true); // the frame insert, not the stroke
    e.undo();
    expect(e.frames).toHaveLength(1);
  });

  test("floating content is committed to its own frame before switching", () => {
    const e = editor();
    e.setVoxel([0, 0, 0], 2);
    const a = e.activeFrameId;
    const b = e.insertFrame()!;
    e.selectBox({ min: [0, 0, 0], max: [0, 0, 0] });
    e.moveSelection([1, 0, 0]);
    expect(e.floating).not.toBeNull();
    e.setFrame(a);
    expect(e.floating).toBeNull();
    expect(e.frameCel(b)[1]).toBe(2);
    expect(e.frameCel(b)[0]).toBe(0);
    expect(e.frameCel(a)[0]).toBe(2);
    // the selection stays with the place, not the frame
    expect(e.hasSelection).toBe(true);
  });

  test("layers exist in every frame: add, duplicate, delete and merge", () => {
    const e = editor();
    const base = e.activeLayerId;
    e.setVoxel([0, 0, 0], 2);
    const a = e.activeFrameId;
    const b = e.insertFrame()!;
    e.setVoxel([1, 0, 0], 3);
    const top = e.createLayer()!;
    expect(filled(e, a, top)).toBe(0);
    expect(filled(e, b, top)).toBe(0);
    e.setVoxel([3, 0, 0], 4);
    e.duplicateLayer(base);
    const copy = e.activeLayerId;
    expect(filled(e, a, copy)).toBe(1);
    expect(filled(e, b, copy)).toBe(2);

    e.deleteLayer(copy);
    expect(e.layers.some((l) => l.id === copy)).toBe(false);
    e.undo();
    expect(filled(e, a, copy)).toBe(1);
    expect(filled(e, b, copy)).toBe(2);
    e.deleteLayer(copy);

    e.mergeDown(top);
    expect(e.layers.map((l) => l.id)).toEqual([base]);
    expect(filled(e, b, base)).toBe(3);
    expect(filled(e, a, base)).toBe(1);
    e.undo();
    expect(filled(e, b, top)).toBe(1);
    expect(filled(e, b, base)).toBe(2);
  });

  test("resizing crops every frame, and undo restores frames that aren't open", () => {
    const e = editor([4, 4, 4]);
    const a = e.activeFrameId;
    e.setVoxel([0, 3, 0], 2);
    const b = e.insertFrame({ content: "blank" })!;
    e.setVoxel([1, 3, 1], 3);
    e.resize([4, 2, 4]);
    expect(filled(e, a)).toBe(0);
    expect(filled(e, b)).toBe(0);
    e.setFrame(a);
    e.undo();
    expect(e.size).toEqual([4, 4, 4]);
    expect(e.frameCel(a)[e.index(0, 3, 0)]).toBe(2);
    expect(e.frameCel(b)[e.index(1, 3, 1)]).toBe(3);
  });

  test("a palette that drops colors remaps them in every frame", () => {
    const e = editor();
    const a = e.activeFrameId;
    e.setVoxel([0, 0, 0], 9);
    e.insertFrame();
    e.loadPalette([0xff0000, 0x00ff00]);
    expect(e.frameCel(a)[0]).toBeLessThan(3);
    e.undo();
    expect(e.frameCel(a)[0]).toBe(9);
  });

  test("copying a cel replaces one layer in another frame", () => {
    const e = editor();
    const a = e.activeFrameId;
    e.setVoxel([0, 0, 0], 2);
    const b = e.insertFrame({ content: "blank" })!;
    e.setFrame(a);
    expect(e.copyCel(b)).toBe(true);
    expect(filled(e, b)).toBe(1);
    expect(e.activeFrameId).toBe(a);
    e.undo();
    expect(filled(e, b)).toBe(0);
  });

  test("read-only documents turn frame edits down", () => {
    const e = editor();
    e.setReadOnly("View only");
    expect(e.insertFrame()).toBeNull();
    expect(e.frames).toHaveLength(1);
  });

  test("evaluateFrame composes another frame without opening it", () => {
    const e = editor();
    const a = e.activeFrameId;
    e.setVoxel([0, 0, 0], 2);
    e.insertFrame({ content: "blank" });
    expect(e.evaluateFrame(a)[0]).toBe(2);
    expect(e.evaluate()[0]).toBe(0);
  });

  test("onion skins name the neighboring poses", () => {
    const e = editor();
    const a = e.activeFrameId;
    const b = e.insertFrame()!;
    const c = e.insertFrame()!;
    expect(e.onionFrames).toEqual({ before: null, after: null });
    e.setOnionSkin({ enabled: true });
    e.setFrame(b);
    expect(e.onionFrames).toEqual({ before: a, after: c });
    e.setFrame(c);
    expect(e.onionFrames).toEqual({ before: b, after: null });
    e.setOnionSkin({ loop: true });
    expect(e.onionFrames).toEqual({ before: b, after: a });
  });
});

describe("playback", () => {
  test("plays from the frame being edited by elapsed time, and pause adopts the frame showing", () => {
    const e = editor();
    const a = e.activeFrameId;
    const b = e.insertFrame()!;
    e.setFrameDuration(b, 2);
    const c = e.insertFrame({ content: "blank" })!;
    e.setFrame(b);
    const undoLabel = e.history.undoLabel;
    e.play(1000);
    expect(e.playing).toBe(true);
    e.advance(1000 + 1000 / 12);
    expect(e.displayFrameId).toBe(b);
    expect(e.activeFrameId).toBe(b);
    e.advance(1000 + 2000 / 12);
    expect(e.displayFrameId).toBe(c);
    // a late callback skips ahead rather than slowing down
    e.advance(1000 + 4000 / 12);
    expect(e.displayFrameId).toBe(b);
    e.advance(1000 + 7000 / 12);
    expect(e.displayFrameId).toBe(a);
    expect(e.activeFrameId).toBe(b);
    // the document still holds the frame being edited
    expect(e.getDocument().activeFrame).toBe(1);
    e.pause();
    expect(e.activeFrameId).toBe(a);
    expect(e.history.undoLabel).toBe(undoLabel);
  });

  test("editing pauses on the frame showing", () => {
    const e = editor();
    const a = e.activeFrameId;
    e.insertFrame({ content: "blank" });
    e.play(0);
    e.advance(1000 / 12);
    expect(e.displayFrameId).toBe(a);
    e.setVoxel([0, 0, 0], 2);
    expect(e.playing).toBe(false);
    expect(filled(e, a)).toBe(1);
  });

  test("a touch on the model only stops playback", () => {
    const e = editor();
    e.setVoxel([1, 0, 1], 2);
    e.insertFrame();
    e.play(0);
    e.setTool("add");
    expect(e.pointerDown({ ray: down(1, 1) })).toBe(true);
    expect(e.playing).toBe(false);
    e.pointerUp();
    expect(filled(e, e.activeFrameId)).toBe(1);
  });

  test("one frame doesn't play", () => {
    const e = editor();
    e.play(0);
    expect(e.playing).toBe(false);
  });
});

describe("animated documents", () => {
  function animated() {
    const e = editor();
    e.setVoxel([0, 0, 0], 2);
    e.insertFrame();
    e.setVoxel([1, 0, 0], 3);
    e.setFrameDuration(e.activeFrameId, 4);
    e.setFps(8);
    e.createLayer("Top");
    e.setVoxel([2, 0, 0], 4);
    return e;
  }

  test("round-trip through getDocument and loadDocument", () => {
    const e = animated();
    const doc = e.getDocument();
    expect(doc.frames).toHaveLength(2);
    expect(doc.activeFrame).toBe(1);
    expect(doc.fps).toBe(8);
    const f = new Editor(doc);
    expect(f.frames.map((x) => [x.id, x.duration])).toEqual(e.frames.map((x) => [x.id, x.duration]));
    expect(f.activeFrameId).toBe(e.activeFrameId);
    for (const frame of e.frames) for (const l of e.layers) expect(f.frameCel(frame.id, l.id)).toEqual(e.frameCel(frame.id, l.id));
    expect(f.canUndo).toBe(false);
  });

  test("round-trip through .moxel version 3", () => {
    const e = animated();
    const text = serializeMoxel(e.getDocument());
    expect(JSON.parse(text).version).toBe(3);
    const f = new Editor(parseMoxel(text));
    expect(f.fps).toBe(8);
    expect(f.frames.map((x) => x.duration)).toEqual([1, 4]);
    expect(f.activeFrameIndex).toBe(1);
    for (const [i, frame] of e.frames.entries()) {
      for (const [j, l] of e.layers.entries()) expect(f.frameCel(f.frames[i].id, f.layers[j].id)).toEqual(e.frameCel(frame.id, l.id));
    }
  });

  test("still models stay version 1, and load as one frame", () => {
    const e = editor();
    e.setVoxel([0, 0, 0], 2);
    const text = serializeMoxel(e.getDocument());
    expect(JSON.parse(text).version).toBe(1);
    const f = new Editor(parseMoxel(text));
    expect(f.frames).toHaveLength(1);
    expect(f.getVoxel([0, 0, 0])).toBe(2);
  });

  test("damaged animations are turned down before anything changes", () => {
    const e = animated();
    const file = JSON.parse(serializeMoxel(e.getDocument()));
    expect(() => parseMoxel(JSON.stringify({ ...file, frames: [{ ...file.frames[0], duration: 0 }] }))).toThrow(/ticks/);
    expect(() => parseMoxel(JSON.stringify({ ...file, frames: [{ ...file.frames[0], cels: [] }] }))).toThrow(/layers/);
    expect(() => parseMoxel(JSON.stringify({ ...file, fps: 1000 }))).toThrow(/per second/);
    expect(() => parseMoxel(JSON.stringify({ ...file, version: 5 }))).toThrow(/Unsupported/);
    const doc = e.getDocument();
    const f = editor();
    expect(() => f.loadDocument({ ...doc, frames: [{ duration: 1, cels: [new Uint8Array(3), new Uint8Array(3)] }] })).toThrow();
    expect(f.frames).toHaveLength(1);
  });

  test("cels that share an array are kept independent", () => {
    const shared = new Uint8Array(64);
    const e = new Editor({
      name: "Shared",
      size: [4, 4, 4],
      palette: [0, 0xff0000, 0x00ff00],
      layers: [{ name: "L", visible: true, locked: false, data: shared }],
      activeLayer: 0,
      frames: [
        { duration: 1, cels: [shared] },
        { duration: 1, cels: [shared] },
      ],
    });
    e.setVoxel([0, 0, 0], 1);
    expect(filled(e, e.frames[1].id)).toBe(0);
  });
});

describe("frame ops", () => {
  function room(): DocTarget {
    const target = {
      name: "Room",
      size: [2, 2, 2] as Vec3,
      gen: "g0",
      palette: [0, 1, 2] as readonly number[],
      layers: [{ id: "layer:a", name: "A", data: new Uint8Array(8) }] as LayerRecord[],
      setName() {},
      setPalette() {},
      setLayers(layers: readonly LayerRecord[]) {
        target.layers = [...layers];
      },
      setGrid() {},
      writeCell(data: Uint8Array, index: number, value: number) {
        data[index] = value;
      },
    };
    return target;
  }

  test("a target without animation turns frame edits down", () => {
    const target = room();
    expect(() => applyOp(target, { t: "frame.add", index: 1, frame: { id: "frame:b", duration: 1 } })).toThrow(OpError);
    expect(() => applyOp(target, { t: "fps", after: 24 })).toThrow(OpError);
  });

  test("a target without animation accepts voxels for its one frame only", () => {
    const target = room();
    const cells = Uint32Array.of(0);
    applyOp(target, { t: "voxels", layer: "layer:a", frame: FIRST_FRAME_ID, gen: "g0", cells, before: new Uint8Array(1), after: Uint8Array.of(1) });
    expect(target.layers[0].data[0]).toBe(1);
    expect(() =>
      applyOp(target, { t: "voxels", layer: "layer:a", frame: "frame:x", gen: "g0", cells, before: new Uint8Array(1), after: Uint8Array.of(2) }),
    ).toThrow(OpError);
  });
});

describe("animation tags", () => {
  test("ranges follow IDs across insertion and reorder; deletion and tags undo together", () => {
    const e = editor();
    const a = e.activeFrameId;
    e.insertFrame(); const b = e.activeFrameId;
    e.insertFrame(); const c = e.activeFrameId;
    const id = e.createTag("Walk", a, c)!;
    e.removeFrames([a]);
    expect(e.tags[0].from).toBe(b);
    e.undo();
    expect(e.tags[0].from).toBe(a);
    expect(e.frames[0].id).toBe(a);
    e.redo();
    expect(e.tags[0].from).toBe(b);
    e.removeFrames([b, c]); // cannot delete every frame
    expect(e.tags).toHaveLength(1);
    e.insertFrame({ after: c });
    e.removeFrames([b, c]);
    expect(e.tags).toHaveLength(0);
    e.undo();
    expect(e.tags[0].id).toBe(id);
  });

  test("tagged still documents round trip; invalid and duplicate tags are rejected", () => {
    const e = editor();
    const id = e.createTag("Idle")!;
    expect(id).toBeTruthy();
    expect(e.createTag("Idle")).toBeNull();
    expect(e.updateTag(id, { from: "missing" })).toBe(false);
    const doc = parseMoxel(serializeMoxel(e.getDocument()));
    const other = editor(); other.loadDocument(doc);
    expect(other.tags).toEqual(e.tags);
    e.undo();
    expect(e.tags).toHaveLength(0);
    e.redo();
    expect(e.tags[0].name).toBe("Idle");
  });

  test("selected ranges play in direction and stop after finite repeats", () => {
    const e = editor();
    const a = e.activeFrameId;
    e.insertFrame(); const b = e.activeFrameId;
    e.insertFrame(); const c = e.activeFrameId;
    const id = e.createTag("Walk", a, b)!;
    e.setActiveTag(id); e.setFps(10); e.setFrame(c);
    e.play(0); expect(e.displayFrameId).toBe(a);
    e.advance(100); expect(e.displayFrameId).toBe(b);
    e.advance(200); expect(e.displayFrameId).toBe(a);
    e.pause(); e.updateTag(id, { direction: "reverse", repeat: 1 }); e.setFrame(c);
    e.play(0); expect(e.displayFrameId).toBe(b);
    e.advance(200); expect(e.displayFrameId).toBe(a); expect(e.playing).toBe(false);
  });
});

test("tag endpoints follow reorders and ping-pong omits duplicate endpoints", () => {
  const e = editor();
  const a = e.activeFrameId;
  e.insertFrame(); const b = e.activeFrameId;
  e.insertFrame(); const c = e.activeFrameId;
  const id = e.createTag("Walk", a, c)!;
  e.moveFrame(a, 2);
  e.setActiveTag(id); e.setFps(10); e.setFrame(b);
  e.play(0); expect(e.displayFrameId).toBe(c);
  e.advance(100); expect(e.displayFrameId).toBe(a);
  e.pause(); e.undo(); // undo frame rate
  e.undo(); // undo reorder
  e.updateTag(id, { direction: "pingpong" }); e.setFps(10); e.setFrame(a);
  e.play(0);
  const seen: string[] = [];
  for (const time of [0, 100, 200, 300, 400]) { e.advance(time); seen.push(e.displayFrameId); }
  expect(seen).toEqual([a, b, c, b, a]);
});

describe("tag lanes", () => {
  const frames = ["a", "b", "c", "d", "e", "f"].map(id => ({ id }));
  const tag = (id: string, from: string, to: string): AnimationTag => ({ id, name: id, from, to, direction: "forward", repeat: 0 });
  const lanes = (tags: AnimationTag[]) => Object.fromEntries(tagLanes(frames, tags).map(l => [l.tag.id, [l.start, l.end, l.lane]]));

  test("tags that share no frames share a row", () => {
    expect(lanes([tag("idle", "a", "b"), tag("walk", "c", "e"), tag("jump", "f", "f")]))
      .toEqual({ idle: [0, 1, 0], walk: [2, 4, 0], jump: [5, 5, 0] });
  });

  test("a nested tag sits below the one around it, whatever the order", () => {
    expect(lanes([tag("strike", "c", "d"), tag("attack", "b", "e"), tag("hit", "d", "d")]))
      .toEqual({ strike: [2, 3, 1], attack: [1, 4, 0], hit: [3, 3, 2] });
  });

  test("partial overlaps take their own row; crossed endpoints and missing frames", () => {
    expect(lanes([tag("one", "a", "c"), tag("two", "e", "c"), tag("gone", "a", "zz")]))
      .toEqual({ one: [0, 2, 0], two: [2, 4, 1] });
  });
});
