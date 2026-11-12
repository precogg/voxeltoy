import { describe, expect, test } from "bun:test";
import { Editor } from "./editor";
import { parseMoxel, serializeMoxel } from "./formats/moxel";
import { checkMarker, markerAt, type MarkerShape } from "./markers";
import { applyOp, type DocTarget } from "./ops";
import { boxShape } from "./source";
import type { Vec3 } from "./types";

function editor(size: Vec3 = [8, 8, 8]) {
  const e = new Editor();
  e.newDocument(size);
  return e;
}

const point = (x: number, y: number, z: number): MarkerShape => ({ kind: "point", at: [x, y, z] });
const at = (e: Editor, id: string, frame?: string) => {
  const p = e.markerAt(id, frame);
  return p && !p.hidden && p.shape.kind === "point" ? p.shape.at : null;
};

/** The editor reopened from its own file. */
function reopen(e: Editor) {
  return new Editor(parseMoxel(serializeMoxel(e.getDocument())));
}

describe("markers", () => {
  test("add, rename, move and delete, each one undo step", () => {
    const e = editor();
    const id = e.addMarker({ shape: point(4, 2.3, 4), role: "mount" })!;
    expect(id).toStartWith("marker:");
    expect(e.marker(id)!.name).toBe("Mount 1");
    // points snap to half a voxel
    expect(at(e, id)).toEqual([4, 2.5, 4]);
    e.updateMarker(id, { name: "bell.1" });
    e.placeMarker(id, point(1, 1, 1));
    expect(at(e, id)).toEqual([1, 1, 1]);
    e.undo();
    expect(at(e, id)).toEqual([4, 2.5, 4]);
    e.undo();
    expect(e.marker(id)!.name).toBe("Mount 1");
    e.removeMarker(id);
    expect(e.markers).toHaveLength(0);
    e.undo();
    expect(e.markers).toHaveLength(1);
    e.undo();
    expect(e.markers).toHaveLength(0);
  });

  test("volumes are shape-step shapes", () => {
    const e = editor();
    const id = e.addMarker({ shape: { kind: "volume", shape: boxShape([0, 0, 0], [2, 4, 2]) }, role: "collision" })!;
    expect(e.marker(id)!.shape).toEqual({ kind: "volume", shape: boxShape([0, 0, 0], [2, 4, 2]) });
    expect(e.addMarker({ shape: { kind: "volume", shape: boxShape([0, 0, 0], [0, 4, 2]) } })).toBeNull();
  });

  test("checks turn down what doesn't fit, with a reason", () => {
    const frames = new Set(["frame:0"]);
    expect(() => checkMarker({ id: "marker:a", name: "", shape: point(0, 0, 0) }, frames)).toThrow("name");
    expect(() => checkMarker({ id: "marker:a", name: "a", shape: { kind: "point", at: [0.01, 0, 0] } }, frames)).toThrow("multiple");
    expect(() => checkMarker({ id: "marker:a", name: "a", shape: point(0, 0, 0), keys: [{ frame: "frame:x", shape: point(0, 0, 0) }] }, frames)).toThrow("frame");
    expect(() =>
      checkMarker({ id: "marker:a", name: "a", shape: { kind: "point", at: [0, 0, 0], up: { axis: 1, sign: 1 }, forward: { axis: 1, sign: -1 } } }, frames),
    ).toThrow("across");
    // default orientation is left out, so markers compare equal
    expect(checkMarker({ id: "marker:a", name: "a", shape: { kind: "point", at: [0, 0, 0], up: { axis: 1, sign: 1 } } }, frames).shape).toEqual(point(0, 0, 0));
  });

  test("move with the voxels when the model is resized", () => {
    const e = editor();
    const id = e.addMarker({ shape: point(4, 4, 4) })!;
    e.setOrigin([4, 0, 4]);
    e.resize([10, 8, 8], [2, 0, 0]);
    expect(at(e, id)).toEqual([6, 4, 4]);
    expect(e.origin).toEqual([6, 0, 4]);
    e.undo();
    expect(at(e, id)).toEqual([4, 4, 4]);
    expect(e.origin).toEqual([4, 0, 4]);
  });

  test("an older file's layer pivots open as mount markers named after their layers", () => {
    const e = editor([4, 8, 4]);
    e.renameLayer(e.activeLayerId, "Bell");
    const file = JSON.parse(serializeMoxel(e.getDocument()));
    file.layers[0].pivot = [2, 6, 2];
    file.layers[0].parent = 0;
    const opened = new Editor(parseMoxel(JSON.stringify(file)));
    expect(opened.markers).toEqual([{ id: "marker:pivot-0", name: "Bell", role: "mount", shape: point(2, 6, 2) }]);
    // saved again, it is a marker; the pivot is gone
    const again = JSON.parse(serializeMoxel(opened.getDocument()));
    expect(again.layers[0].pivot).toBeUndefined();
    expect(again.markers).toHaveLength(1);
  });

  test("a live room's document turns markers down", () => {
    const target = { layers: [], frames: undefined } as unknown as DocTarget;
    expect(() => applyOp(target, { t: "marker.add", index: 0, marker: { id: "marker:a", name: "a", shape: point(0, 0, 0) } })).toThrow("live rooms");
  });
});

describe("marker keys", () => {
  /** An editor with three frames, a marker keyed on the first two. */
  function keyed() {
    const e = editor();
    const id = e.addMarker({ shape: point(1, 1, 1), name: "tip" })!;
    const f0 = e.activeFrameId;
    const f1 = e.insertFrame(f0, "duplicate")!;
    const f2 = e.insertFrame(f1, "duplicate")!;
    e.setFrame(f0);
    e.setMarkerKeyed(id, true);
    e.setFrame(f1);
    e.placeMarker(id, point(2, 2, 2));
    return { e, id, f0, f1, f2 };
  }

  test("a key holds until the next one; before the first, the marker's own place", () => {
    const { e, id, f0, f1, f2 } = keyed();
    expect(at(e, id, f0)).toEqual([1, 1, 1]);
    expect(at(e, id, f1)).toEqual([2, 2, 2]);
    expect(at(e, id, f2)).toEqual([2, 2, 2]);
    // a marker without keys moves everywhere
    const still = e.addMarker({ shape: point(0, 0, 0) })!;
    e.placeMarker(still, point(3, 3, 3));
    for (const f of [f0, f1, f2]) expect(at(e, still, f)).toEqual([3, 3, 3]);
  });

  test("hidden from a frame on, until the next key", () => {
    const { e, id, f0, f1, f2 } = keyed();
    e.setFrame(f2);
    e.setMarkerHidden(id, true);
    expect(e.markerAt(id, f2)!.hidden).toBe(true);
    expect(e.markerAt(id, f1)!.hidden).toBe(false);
    e.setMarkerHidden(id, false);
    expect(at(e, id, f2)).toEqual([2, 2, 2]);
    expect(at(e, id, f0)).toEqual([1, 1, 1]);
  });

  test("duplicating a frame copies where keyed markers are on it", () => {
    const { e, id, f1 } = keyed();
    const copy = e.insertFrame(f1, "duplicate")!;
    expect(e.marker(id)!.keys!.some((k) => k.frame === copy)).toBe(true);
    expect(at(e, id, copy)).toEqual([2, 2, 2]);
  });

  test("moving a frame moves its keys with it", () => {
    const { e, id, f0, f1, f2 } = keyed();
    e.moveFrame(f1, 2);
    expect(e.frames.map((f) => f.id)).toEqual([f0, f2, f1]);
    expect(at(e, id, f2)).toEqual([1, 1, 1]);
    expect(at(e, id, f1)).toEqual([2, 2, 2]);
  });

  test("deleting a frame drops its keys, and undo brings them back", () => {
    const { e, id, f0, f1, f2 } = keyed();
    e.removeFrames([f1]);
    expect(e.marker(id)!.keys!.map((k) => k.frame)).toEqual([f0]);
    expect(at(e, id, f2)).toEqual([1, 1, 1]);
    e.undo();
    expect(at(e, id, f1)).toEqual([2, 2, 2]);
    expect(at(e, id, f2)).toEqual([2, 2, 2]);
  });

  test("same in every frame keeps where it is on the open frame", () => {
    const { e, id, f0, f1 } = keyed();
    e.setFrame(f1);
    e.setMarkerKeyed(id, false);
    expect(e.marker(id)!.keys).toBeUndefined();
    expect(at(e, id, f0)).toEqual([2, 2, 2]);
  });

  test("survive a save and reload", () => {
    const { e, id, f0, f1, f2 } = keyed();
    e.updateMarker(id, { role: "hitbox", data: { damage: 3 } });
    e.setOrigin([4, 0.5, 4]);
    const copy = reopen(e);
    expect(copy.markers).toEqual(e.markers);
    expect(copy.origin).toEqual([4, 0.5, 4]);
    for (const f of [f0, f1, f2]) expect(at(copy, id, f)).toEqual(at(e, id, f));
  });

  test("a still model's markers survive a save and reload", () => {
    const e = editor();
    e.addMarker({ shape: point(1, 2, 3), role: "mount", name: "bell.1" });
    const copy = reopen(e);
    expect(copy.markers).toEqual(e.markers);
    expect(copy.hasOrigin).toBe(false);
  });

  test("markerAt resolves in frame order, not key order", () => {
    const frames = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const m = checkMarker(
      { id: "marker:m", name: "m", shape: point(0, 0, 0), keys: [{ frame: "c", shape: point(3, 3, 3) }, { frame: "a", shape: point(1, 1, 1) }] },
      new Set(["a", "b", "c"]),
    );
    expect(markerAt(m, frames, "b").shape).toEqual(point(1, 1, 1));
    expect(markerAt(m, frames, "c").shape).toEqual(point(3, 3, 3));
  });
});
