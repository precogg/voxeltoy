import { describe, expect, test } from "bun:test";
import { Editor } from "./editor";
import { parseLibrary, serializeLibrary } from "./formats/library";
import { parseMoxel, serializeMoxel } from "./formats/moxel";
import { LibraryEditor, libraryOf, type LibraryDocument } from "./library";
import { decomposeMat, eulerFromQuat, matFromTransform, quatFromEuler, transformPoint } from "./scene-math";
import type { DocumentData, Vec3 } from "./types";

function model(name: string, size: Vec3 = [4, 4, 4]): DocumentData {
  const e = new Editor();
  e.newDocument(size);
  e.setName(name);
  const doc = e.getDocument();
  return { ...doc, name };
}

const close = (a: readonly number[], b: readonly number[]) => a.forEach((n, i) => expect(n).toBeCloseTo(b[i], 6));
const worldOrigin = (s: LibraryEditor, id: string) => transformPoint(s.worldMatrix(id), [0, 0, 0]);

/** A library with one empty scene, open, as its primary: where the scene tests start. */
function sceneEditor(): LibraryEditor {
  return new LibraryEditor(oneScene());
}

function oneScene(): LibraryDocument {
  const scene = { id: "scene:test", name: "Test", ground: { visible: true, size: [64, 64] as [number, number] }, stage: null, hostData: {}, instances: [] };
  return { name: "Test", primary: scene.id, models: [], scenes: [scene] };
}

/** A library saved and opened again, as a file would be. */
const reopen = (s: LibraryEditor) => new LibraryEditor(parseLibrary(serializeLibrary(s.getLibrary())));

describe("scene math", () => {
  test("Euler degrees round trip", () => {
    for (const e of [[0, 90, 0], [30, -45, 120], [90, 0, 0], [0, 0, -90]] as Vec3[]) close(eulerFromQuat(quatFromEuler(e)), e);
  });

  test("a matrix decomposes into what made it", () => {
    const q = quatFromEuler([10, 20, 30]);
    const d = decomposeMat(matFromTransform([1, 2, 3], q, 2.5));
    close(d.position, [1, 2, 3]);
    close(d.rotation, q);
    expect(d.scale).toBeCloseTo(2.5, 6);
  });
});

describe("placing instances", () => {
  test("place, move, duplicate and delete, all undoable", () => {
    const s = sceneEditor();
    const knight = s.addModel(model("Knight"));
    const a = s.addInstance(knight, { position: [4, 0, 2], rotation: [0, 90, 0] })!;
    expect(s.instance(a)!.name).toBe("Knight");
    expect(s.selection).toEqual([a]);
    close(s.placement(a)!.rotation, [0, 90, 0]);

    s.setTransform(a, { position: [5, 0, 2] });
    const [b] = s.duplicateInstances([a], [2, 0, 0]);
    expect(s.instances.length).toBe(2);
    expect(s.instance(b)!.position).toEqual([7, 0, 2]);
    expect(s.selection).toEqual([b]);
    s.deleteInstances([a]);
    expect(s.instances.map((i) => i.id)).toEqual([b]);

    s.undo(); // delete
    expect(s.instances.length).toBe(2);
    s.undo(); // duplicate
    expect(s.instances.length).toBe(1);
    expect(s.selection).toEqual([a]);
    s.undo(); // move
    expect(s.instance(a)!.position).toEqual([4, 0, 2]);
    s.redo();
    expect(s.instance(a)!.position).toEqual([5, 0, 2]);
  });

  test("an instance needs a model in the scene", () => {
    const s = sceneEditor();
    expect(s.addInstance("model:nope")).toBeNull();
    expect(s.toast?.message).toMatch(/isn't in the scene/);
  });
});

describe("one history", () => {
  test("a copy in one model pastes into another", () => {
    const s = sceneEditor();
    const a = s.editor(s.addModel(model("A")));
    const b = s.editor(s.addModel(model("B")));
    a.setVoxel([1, 1, 1], 5);
    a.selectAll();
    expect(a.copy()).toBe(true);
    expect(b.canPaste).toBe(true);
    expect(b.paste()).toBe(true);
    b.applyTransform();
    expect(b.getVoxel([1, 1, 1])).toBe(5);
  });
  test("models are documents; a session exists only while one is edited", () => {
    const s = sceneEditor();
    const m = s.addModel(model("Crate"));
    const a = s.addInstance(m)!;
    const sessions = (s as unknown as { sessions: Map<string, Editor> }).sessions;
    expect(sessions.size).toBe(0);
    expect(s.document(m).name).toBe("Crate");
    const crate = s.openModel(a);
    expect(sessions.size).toBe(1);
    crate.setVoxel([2, 0, 2], 3);
    s.closeModel();
    expect(sessions.size).toBe(0);
    // undo and redo of a closed model's edit go through its document
    expect(s.undoLabel).toMatch(/Crate: /);
    s.undo();
    expect(s.document(m).layers[0].data[2 + 4 * 4 * 2]).toBe(0);
    s.redo();
    expect(s.document(m).volume()[2 + 4 * 4 * 2]).toBe(3);
    expect(sessions.size).toBe(0);
  });
  test("model edits and scene edits undo in the order they were made", () => {
    const s = sceneEditor();
    const m = s.addModel(model("Course"));
    const a = s.addInstance(m)!;
    const course = s.editor(m);
    course.setVoxel([1, 0, 1], 2); // carve... or rather build
    s.setTransform(a, { position: [3, 0, 0] });
    expect(s.undoLabel).toBe("Move");
    s.undo();
    expect(s.instance(a)!.position).toEqual([0, 0, 0]);
    expect(course.getVoxel([1, 0, 1])).toBe(2);
    expect(s.undoLabel).toMatch(/Course: /);
    // a model's editor reports the scene's history, which is the one it writes to
    expect(course.undoLabel).toBe(s.undoLabel);
    course.undo(); // the model's undo is the scene's
    expect(course.getVoxel([1, 0, 1])).toBe(0);
    s.redo();
    expect(course.getVoxel([1, 0, 1])).toBe(2);
  });

  test("a transaction groups a model edit with scene edits", () => {
    const s = sceneEditor();
    const m = s.addModel(model("Course"));
    const a = s.addInstance(m)!;
    s.transact("Gap and platform", () => {
      s.editor(m).setVoxel([0, 0, 0], 3);
      s.setTransform(a, { position: [0, 2, 0] });
    });
    expect(s.undoLabel).toBe("Gap and platform");
    s.undo();
    expect(s.editor(m).getVoxel([0, 0, 0])).toBe(0);
    expect(s.instance(a)!.position).toEqual([0, 0, 0]);
  });

  test("revision goes up with model edits too", () => {
    const s = sceneEditor();
    const m = s.addModel(model("A"));
    const r = s.revision;
    s.editor(m).setVoxel([0, 0, 0], 1);
    expect(s.revision).toBe(r + 1);
  });
});

describe("attachment", () => {
  test("attaching and detaching keep the world placement", () => {
    const s = sceneEditor();
    const m = s.addModel(model("Thing"));
    const parent = s.addInstance(m, { position: [10, 0, 0], rotation: [0, 90, 0], scale: 2 })!;
    const child = s.addInstance(m, { position: [10, 4, 3] })!;
    const before = worldOrigin(s, child);
    expect(s.attach(child, { instance: parent, marker: null })).toBe(true);
    close(worldOrigin(s, child), before);
    s.setTransform(parent, { position: [0, 0, 0] });
    close(worldOrigin(s, child), [before[0] - 10, before[1], before[2]]);
    s.attach(child, null);
    expect(s.instance(child)!.parent).toBeNull();
  });

  test("attaching to a marker places the child in the marker's frame, turned as it is", () => {
    const s = sceneEditor();
    const doc = model("Arm", [4, 8, 4]);
    const m = s.addModel(doc);
    const editor = s.editor(m);
    // the origin is the floor's center, [2, 0, 2]; the hand's mount points down
    const hand = editor.addMarker({ shape: { kind: "point", at: [2, 6, 2], up: { axis: 1, sign: -1 } }, role: "mount" })!;
    const arm = s.addInstance(m, { position: [0, 0, 0] })!;
    const sword = s.addInstance(m, { position: [0, 6, 0] })!;
    s.attach(sword, { instance: arm, marker: hand });
    close(s.instance(sword)!.position, [0, 0, 0]);
    // attaching keeps it where it was; unturned, its up runs along the marker's, down
    s.setTransform(sword, { rotation: [0, 0, 0, 1] });
    const world = s.worldMatrix(sword);
    close([world[4], world[5], world[6]], [0, -1, 0]);
  });

  test("an attached instance follows a marker keyed per frame, on the frame its host shows", () => {
    const s = sceneEditor();
    const m = s.addModel(model("Swing", [4, 8, 4]));
    const editor = s.editor(m);
    const tip = editor.addMarker({ shape: { kind: "point", at: [2, 6, 2] } })!;
    const f0 = editor.activeFrameId;
    const f1 = editor.insertFrame(f0, "duplicate")!;
    editor.setMarkerKeyed(tip, true);
    editor.placeMarker(tip, { kind: "point", at: [3, 4, 2] });
    const swing = s.addInstance(m, { position: [0, 0, 0] })!;
    const sword = s.addInstance(m)!;
    s.attach(sword, { instance: swing, marker: tip });
    s.setTransform(sword, { position: [0, 0, 0] });
    s.setPlayback(swing, { kind: "frame", frame: f0 });
    close(s.worldMatrix(sword).slice(12, 15), [0, 6, 0]);
    s.setPlayback(swing, { kind: "frame", frame: f1 });
    close(s.worldMatrix(sword).slice(12, 15), [1, 4, 0]);
  });

  test("a model's own origin is what places it", () => {
    const s = sceneEditor();
    const m = s.addModel(model("Post", [4, 8, 4]));
    s.editor(m).setOrigin([0, 0, 0]);
    const post = s.addInstance(m, { position: [10, 0, 0] })!;
    // the model's corner is at the instance's position
    close(s.meshMatrix(post).slice(12, 15), [10, 0, 0]);
  });

  test("loops are refused", () => {
    const s = sceneEditor();
    const m = s.addModel(model("A"));
    const a = s.addInstance(m)!;
    const b = s.addInstance(m)!;
    s.attach(b, { instance: a, marker: null });
    expect(s.attach(a, { instance: b, marker: null })).toBe(false);
  });

  test("deleting a parent hangs its children one level up, where they were", () => {
    const s = sceneEditor();
    const m = s.addModel(model("A"));
    const root = s.addInstance(m, { position: [1, 0, 0] })!;
    const mid = s.addInstance(m, { position: [2, 0, 0] })!;
    const leaf = s.addInstance(m, { position: [3, 0, 0] })!;
    s.attach(mid, { instance: root, marker: null });
    s.attach(leaf, { instance: mid, marker: null });
    const before = worldOrigin(s, leaf);
    s.deleteInstances([mid]);
    expect(s.instance(leaf)!.parent?.instance).toBe(root);
    close(worldOrigin(s, leaf), before);
    s.undo();
    expect(s.instance(leaf)!.parent?.instance).toBe(mid);
  });
});

describe("kinds and settings", () => {
  test("settings resolve against defaults; unset puts the default back", () => {
    const s = sceneEditor();
    s.registerKinds([{ id: "pole", label: "Pole", defaults: { length: 4, color: "red" } }]);
    const p = s.addInstance(null, { kind: "pole" })!;
    expect(s.instance(p)!.name).toBe("Pole");
    expect(s.settings(p)).toEqual({ length: 4, color: "red" });
    s.setData(p, { length: 6 });
    expect(s.instance(p)!.data).toEqual({ length: 6 });
    expect(s.settings(p).length).toBe(6);
    s.unsetData(p, ["length"]);
    expect(s.instance(p)!.data).toBeUndefined();
    s.undo();
    expect(s.settings(p).length).toBe(6);
  });

  test("deleting an instance clears ref settings that point at it", () => {
    const s = sceneEditor();
    s.registerKinds([
      { id: "switch", label: "Switch", fields: [{ key: "door", type: "ref" }] },
      { id: "door", label: "Door" },
    ]);
    const door = s.addInstance(null, { kind: "door" })!;
    const sw = s.addInstance(null, { kind: "switch", data: { door } })!;
    s.deleteInstances([door]);
    expect(s.instance(sw)!.data).toEqual({ door: null });
    s.undo();
    expect(s.instance(sw)!.data).toEqual({ door });
  });

  test("an instance with no model and no kind is a group", () => {
    const s = sceneEditor();
    const g = s.addInstance(null)!;
    expect(s.isGroup(g)).toBe(true);
    expect(s.instance(g)!.name).toBe("Group");
  });
});

describe("groups", () => {
  test("grouping keeps things where they are, moves them together, and undoes as one step", () => {
    const s = sceneEditor();
    const m = s.addModel(model("Crate", [2, 2, 2]));
    const a = s.addInstance(m, { position: [4, 0, 0] })!;
    const b = s.addInstance(m, { position: [8, 0, 2] })!;
    const g = s.groupInstances([a, b], "Props")!;
    expect(s.instance(a)!.parent).toEqual({ instance: g, marker: null });
    // the group stands at the middle of their floor
    close(worldOrigin(s, g), [6, 0, 1]);
    close(worldOrigin(s, a), [4, 0, 0]);
    close(worldOrigin(s, b), [8, 0, 2]);
    expect(s.selection).toEqual([g]);
    // its box is what it holds
    const box = s.worldBox(g)!;
    close(box.min, [3, 0, -1]);
    close(box.max, [9, 2, 3]);
    s.setTransform(g, { position: [6, 3, 1] });
    close(worldOrigin(s, a), [4, 3, 0]);
    s.undo();
    s.undo();
    expect(s.instance(g)).toBeUndefined();
    expect(s.instance(a)!.parent).toBeNull();
    close(worldOrigin(s, a), [4, 0, 0]);
  });

  test("hiding or locking a group hides or locks what it holds", () => {
    const s = sceneEditor();
    const m = s.addModel(model("Crate", [2, 2, 2]));
    const a = s.addInstance(m)!;
    const g = s.groupInstances([a])!;
    s.setVisible(g, false);
    expect(s.isShown(a)).toBe(false);
    expect(s.instance(a)!.visible).toBe(true);
    s.setVisible(g, true);
    s.setLocked(g, true);
    expect(s.isLocked(a)).toBe(true);
    s.select([a]);
    expect(s.selection).toEqual([]);
  });

  test("ungrouping hangs what it held from the group's parent, where it was", () => {
    const s = sceneEditor();
    const m = s.addModel(model("Crate", [2, 2, 2]));
    const a = s.addInstance(m, { position: [2, 0, 0] })!;
    const outer = s.groupInstances([a], "Outer")!;
    const inner = s.groupInstances([a], "Inner")!;
    expect(s.instance(inner)!.parent).toEqual({ instance: outer, marker: null });
    s.setTransform(outer, { rotation: [0, 90, 0] });
    const before = worldOrigin(s, a);
    expect(s.ungroup(inner)).toBe(true);
    expect(s.instance(a)!.parent).toEqual({ instance: outer, marker: null });
    close(worldOrigin(s, a), before);
    expect(s.ungroup(a)).toBe(false);
  });
});

describe("files", () => {
  test("a scene round trips, unknown kinds, settings and keys included", async () => {
    const s = sceneEditor();
    s.registerKinds([{ id: "zone", label: "Camera zone", defaults: { fov: 60 }, bounds: (d) => ({ min: [0, 0, 0], max: [(d as { w: number }).w, 2, 2] }) }]);
    const m = s.addModel(model("Spikes"));
    const a = s.addInstance(m, { position: [1, 2, 3], rotation: [0, 45, 0] })!;
    const z = s.addInstance(null, { kind: "zone", data: { w: 5 } })!;
    s.setSceneData("game", { level: 7 });
    s.editor(m).setVoxel([0, 0, 0], 2);
    const t = reopen(s); // a host that doesn't know "zone"
    expect(t.instances.length).toBe(2);
    expect(t.hostData).toEqual({ game: { level: 7 } });
    expect(t.settings(z)).toEqual({ fov: 60, w: 5 });
    expect(t.instanceBounds(z)).toEqual({ min: [0, 0, 0], max: [5, 2, 2] });
    expect(t.kindInfo("zone")).toMatchObject({ label: "Camera zone", known: false });
    expect(t.editor(m).getVoxel([0, 0, 0])).toBe(2);
    close(t.placement(a)!.rotation, [0, 45, 0]);

    // saved again without the host, nothing is lost
    const again = parseLibrary(serializeLibrary(t.getLibrary()));
    expect(again.scenes[0].kinds?.zone?.bounds?.[z]).toEqual({ min: [0, 0, 0], max: [5, 2, 2] });
    expect(again.scenes[0].instances.find((i) => i.id === z)!.data).toEqual({ w: 5 });
  });

  test("unknown keys on the library, its scenes and instances are kept", () => {
    const s = sceneEditor();
    const m = s.addModel(model("A"));
    s.addInstance(m);
    const doc = s.getLibrary();
    doc.extra = { future: true };
    const scene = doc.scenes[0] as { extra?: object; instances: { extra?: object }[] };
    scene.extra = { weather: "rain" };
    scene.instances[0].extra = { glow: 1 };
    const back = parseLibrary(serializeLibrary(new LibraryEditor(doc).getLibrary()));
    expect(back.extra).toEqual({ future: true });
    expect(back.scenes[0].extra).toEqual({ weather: "rain" });
    expect((back.scenes[0].instances[0] as { extra?: object }).extra).toEqual({ glow: 1 });
  });

  test("a damaged library is turned down with a reason", () => {
    const s = sceneEditor();
    const doc = oneScene();
    doc.scenes[0] = { ...doc.scenes[0], instances: [{ id: "inst:a", name: "A", model: "model:gone", parent: null, position: [0, 0, 0], rotation: [0, 0, 0, 1], visible: true, locked: false }] };
    expect(() => s.loadLibrary(doc)).toThrow(/damaged/);
  });

  test("re-importing a document finds the model it was copied from", () => {
    const s = sceneEditor();
    const doc = model("Knight");
    const m = s.addModel(doc);
    expect(s.modelFromDocument(doc.docId)).toBe(m);
    expect(s.modelEdited(m)).toBe(false);
    s.editor(m).setVoxel([0, 0, 0], 1);
    expect(s.modelEdited(m)).toBe(true);
    const newer = { ...doc, revision: (doc.revision ?? 0) + 5, layers: doc.layers.map((l) => ({ ...l, data: new Uint8Array(l.data.length).fill(3) })) };
    expect(s.replaceModel(m, newer)).toBe(true);
    expect(s.editor(m).getVoxel([1, 1, 1])).toBe(3);
    s.undo();
    expect(s.editor(m).getVoxel([1, 1, 1])).toBe(0);
  });
});

describe("edit in place and the stage", () => {
  test("a new model opens in place; its edits undo after it closes, in order with the scene's", () => {
    const s = sceneEditor();
    const id = s.newModel({ name: "Door", size: [4, 8, 2], position: [5, 0, 0] })!;
    expect(s.instance(id)!.name).toBe("Door");
    const editor = s.openModel(id);
    expect(s.open).toEqual({ instance: id, model: s.instance(id)!.model! });
    expect(s.activeEditor).toBe(editor);
    editor.setVoxel([0, 0, 0], 3);
    editor.setVoxel([1, 0, 0], 3);
    s.closeModel();
    expect(s.open).toBeNull();
    s.setTransform(id, { position: [6, 0, 0] });
    s.undo(); // move
    expect(s.instance(id)!.position).toEqual([5, 0, 0]);
    s.undo(); // second voxel, with the model closed
    expect(editor.getVoxel([1, 0, 0])).toBe(0);
    expect(editor.getVoxel([0, 0, 0])).toBe(3);
    s.undo();
    s.undo(); // the new model itself
    expect(s.instances.length).toBe(0);
  });

  test("closing applies floating content", () => {
    const s = sceneEditor();
    const id = s.newModel()!;
    const e = s.openModel(id);
    e.setVoxel([1, 1, 1], 2);
    e.selectAll();
    e.setTool("move");
    e.duplicateSelection?.();
    s.closeModel();
    expect(e.floating).toBeNull();
  });

  test("undoing the instance being edited leaves it", () => {
    const s = sceneEditor();
    const id = s.newModel()!;
    s.openModel(id);
    s.undo();
    expect(s.open).toBeNull();
  });

  test("one selection at a time: instances or the active model's voxels", () => {
    const s = sceneEditor();
    const m = s.addModel(model("Course", [8, 8, 8]));
    s.setStage(m);
    const stage = s.editor(m);
    stage.setVoxel([1, 0, 1], 2);
    const other = s.addModel(model("Spikes"));
    const a = s.addInstance(other)!;
    expect(s.selection).toEqual([a]);
    stage.selectAll();
    expect(stage.hasSelection).toBe(true);
    expect(s.selection).toEqual([]);
    s.select([a]);
    expect(stage.hasSelection).toBe(false);
    s.undo();
    expect(stage.hasSelection).toBe(true);
    expect(s.selection).toEqual([]);
  });

  test("the view matrix puts the active model's grid at the origin of the view", () => {
    const s = sceneEditor();
    const id = s.newModel({ size: [4, 4, 4], position: [10, 0, 0] })!;
    s.openModel(id);
    close(transformPoint(s.viewMatrix, [2, 0, 2]), [10, 0, 0]);
  });
});

describe("playback", () => {
  /** A flipbook of four frames, one tick each at 10 fps: 100 ms a frame. */
  function flipbook(s: SceneEditor) {
    const m = s.addModel(model("Flame"));
    const e = s.editor(m);
    e.setFps(10);
    for (let i = 0; i < 3; i++) e.insertFrame();
    return { m, frames: e.frames.map((f) => f.id), e };
  }

  test("two instances of one flipbook loop out of phase", () => {
    const s = sceneEditor();
    const { m, frames } = flipbook(s);
    const a = s.addInstance(m, { playback: { kind: "loop", speed: 1, offset: 0 } })!;
    const b = s.addInstance(m, { playback: { kind: "loop", speed: 1, offset: 200 } })!;
    expect(s.animating).toBe(true);
    expect(s.frameOf(a, 0)).toBe(frames[0]);
    expect(s.frameOf(b, 0)).toBe(frames[2]);
    expect(s.frameOf(a, 350)).toBe(frames[3]);
    expect(s.frameOf(b, 350)).toBe(frames[1]);
    expect(s.frameOf(a, 450)).toBe(frames[0]); // wraps
  });

  test("speed, reverse, held frames, and the open frame by default", () => {
    const s = sceneEditor();
    const { m, frames, e } = flipbook(s);
    const fast = s.addInstance(m, { playback: { kind: "loop", speed: 2, offset: 0 } })!;
    const back = s.addInstance(m, { playback: { kind: "loop", speed: -1, offset: 0 } })!;
    const held = s.addInstance(m, { playback: { kind: "frame", frame: frames[1] } })!;
    const plain = s.addInstance(m)!;
    expect(s.frameOf(fast, 100)).toBe(frames[2]);
    expect(s.frameOf(back, 100)).toBe(frames[3]);
    expect(s.frameOf(held, 999)).toBe(frames[1]);
    expect(s.frameOf(plain, 999)).toBe(e.activeFrameId);
  });
});

describe("hosts", () => {
  /** A pole model as tall as its `length` setting. */
  const pole = (length: number): DocumentData => {
    const e = new Editor();
    e.newDocument([1, Math.max(1, length), 1]);
    e.setName("Pole");
    e.transact("Pole", () => {
      for (let y = 0; y < length; y++) e.setVoxel([0, y, 0], 2);
    });
    return e.getDocument();
  };

  test("a kind builds its model from settings, cached, and rebuilt when they change", () => {
    const s = sceneEditor();
    let builds = 0;
    s.registerKinds([{ id: "pole", label: "Pole", defaults: { length: 3 }, model: (d) => (builds++, pole((d as { length: number }).length)) }]);
    const a = s.addInstance(null, { kind: "pole" })!;
    const b = s.addInstance(null, { kind: "pole" })!;
    const m = s.modelFor(a)!;
    expect(m).not.toBeNull();
    expect(s.modelFor(b)).toBe(m); // same settings, one model
    expect(s.editor(m).size).toEqual([1, 3, 1]);
    expect(s.instanceBounds(a)).toBeNull();
    const solo = sceneEditor();
    solo.registerKinds([{ id: "pole", label: "Pole", defaults: { length: 3 }, model: (d) => pole((d as { length: number }).length) }]);
    const only = solo.addInstance(null, { kind: "pole" })!;
    solo.setData(only, { length: 7 });
    expect(solo.allModels.map((x) => x.id)).toEqual([solo.modelFor(only)]);
    // built models are a cache of the kind's, not the scene's own
    expect(solo.models).toEqual([]);
    expect(solo.editor(solo.modelFor(only)!).size).toEqual([1, 7, 1]);
    s.setData(a, { length: 5 });
    const m2 = s.modelFor(a)!;
    expect(m2).not.toBe(m);
    expect(s.editor(m2).size).toEqual([1, 5, 1]);
    s.setData(b, { length: 5 });
    expect(s.modelFor(b)).toBe(m2);
    expect(s.models.some((x) => x.id === m)).toBe(false); // nothing uses the old build
    // every listed model still has its editor: a rebuild that swaps one for another updates the list
    for (const x of s.models) expect(() => s.editor(x.id)).not.toThrow();
    expect(s.models.every((x) => x.built)).toBe(true);
    s.undo();
    expect(s.editor(s.modelFor(b)!).size).toEqual([1, 3, 1]);
    expect(builds).toBeGreaterThan(0);
  });

  test("built models travel in the file, so the scene shows them without its host", async () => {
    const s = sceneEditor();
    s.registerKinds([{ id: "pole", label: "Pole", defaults: { length: 4 }, model: (d) => pole((d as { length: number }).length) }]);
    const a = s.addInstance(null, { kind: "pole" })!;
    const t = reopen(s);
    expect(t.modelFor(a)).not.toBeNull();
    expect(t.editor(t.modelFor(a)!).size).toEqual([1, 4, 1]);
  });

  test("linked models: resolved through the host, saved back after each change, reloaded from elsewhere", async () => {
    const files = new Map<string, DocumentData>([["spikes", model("Spikes")]]);
    const saved: string[] = [];
    const s = sceneEditor();
    s.setHost({
      resolveModel: async (ref) => files.get(ref)!,
      saveModel: (ref, doc) => {
        saved.push(ref);
        files.set(ref, doc);
      },
    });
    s.registerKinds([{ id: "spikes", label: "Spikes", model: () => "spikes" }]);
    const a = s.addInstance(null, { kind: "spikes" })!;
    expect(s.modelFor(a)).toBeNull(); // still arriving
    await Promise.resolve();
    await Promise.resolve();
    const m = s.modelFor(a)!;
    expect(s.model(m)!.ref).toBe("spikes");

    s.editor(m).setVoxel([0, 0, 0], 3);
    expect(saved).toEqual(["spikes"]);
    expect(files.get("spikes")!.layers[0].data[0]).toBe(3);
    s.undo();
    expect(saved).toEqual(["spikes", "spikes"]);
    expect(files.get("spikes")!.layers[0].data[0]).toBe(0);
    s.redo();

    // another level changes the shared model: this scene's edit can't be undone over it
    const other = model("Spikes v2");
    other.layers[0].data.fill(5);
    s.modelChanged("spikes", other);
    expect(s.editor(m).getVoxel([1, 1, 1])).toBe(5);
    s.undo();
    expect(s.editor(m).getVoxel([1, 1, 1])).toBe(5);
    expect(s.toast?.message).toMatch(/couldn't be undone/);
  });

  test("surfaces: stage voxels and instance tops are found before the ground", () => {
    const s = sceneEditor();
    const course = model("Course", [8, 4, 8]);
    const ce = new Editor(course);
    ce.transact("Floor", () => {
      for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) ce.setVoxel([x, 0, z], 2);
    });
    const stage = s.addModel(ce.getDocument());
    s.setStage(stage);
    const down = { origin: [0.2, 10, 0.2] as Vec3, dir: [0, -1, 0] as Vec3 };
    const hit = s.surfaceAt(down)!;
    expect(hit.instance).toBeNull();
    close(hit.point, [0.2, 1, 0.2]);
    close(hit.normal, [0, 1, 0]);

    const box = s.addInstance(s.addModel(model("Box", [2, 2, 2])), { position: [0, 1, 0] })!;
    s.editor(s.modelFor(box)!).setVoxel([1, 1, 1], 2);
    const onBox = s.surfaceAt(down)!;
    expect(onBox.instance).toBe(box);
    close(onBox.point, [0.2, 3, 0.2]);
    expect(s.surfaceAt(down, new Set([box]))!.instance).toBeNull();

    s.setStage(null);
    s.deleteInstances([box]);
    const ground = s.surfaceAt({ origin: [3, 5, 3], dir: [0, -1, 0] })!;
    close(ground.point, [3, 0, 3]);
  });

  test("keys a newer app wrote on a model's entry survive a round trip", () => {
    const text = serializeLibrary(libraryOf(model("Knight")));
    const file = JSON.parse(text);
    file.models[0].lod = { far: "knight-far" };
    const again = JSON.parse(serializeLibrary(parseLibrary(JSON.stringify(file))));
    expect(again.models[0].lod).toEqual({ far: "knight-far" });
    expect(again.models[0].extra).toBeUndefined();
  });

  test("snapping lines models up with the stage's cells, odd-sized stages too", () => {
    const s = sceneEditor();
    // a stage of 16-unit blocks, 3 blocks across: its cell edges are at -24, -8, 8 and 24
    const stage = s.addModel(model("Course", [3, 2, 4]), { voxelSize: 16 });
    s.setStage(stage);
    close(s.latticeOrigin(), [-24, 0, -32]);
    close(s.snapPosition([1, 0, 1]), [8, 0, 0]);
    // a 16-voxel crate fills one block: its center stands in the middle of a cell
    const crate = s.addInstance(s.addModel(model("Crate", [16, 16, 16])), { position: [3, 0, 3], align: true })!;
    close(s.instance(crate)!.position, [0, 0, 8]);
    expect(s.canUndo).toBe(true);
    s.undo();
    expect(s.instance(crate)).toBeUndefined();
    // two blocks wide: it covers two cells, so its center is on an edge between them
    const bench = s.addInstance(s.addModel(model("Bench", [32, 8, 16])), { position: [3, 0, 3], align: true })!;
    close(s.instance(bench)!.position, [8, 0, 8]);
    // a kind that centers stands in the middle of a cell whatever its size
    s.registerKinds([{ id: "berry", label: "Berry", model: () => model("Berry", [8, 8, 8]), snap: { align: "center" } }]);
    const berry = s.addInstance(null, { kind: "berry", position: [9, 5, -1], align: true })!;
    close(s.instance(berry)!.position, [16, 5, -8]);
    close(s.alignPosition(berry, [9, 5, -1]), [16, 0, -8]);
  });

  test("resizing a model keeps what is placed with it where it was", () => {
    const s = sceneEditor();
    const stage = s.addModel(model("Course", [4, 2, 4]), { voxelSize: 16 });
    s.setStage(stage);
    const crate = s.addInstance(s.addModel(model("Crate", [16, 16, 16])), { position: [8, 0, 8] })!;
    // grow the course two blocks on its low X side: the blocks move +2 cells in its grid, and its
    // center moves one, so the crate goes one block (16) over with the blocks it stood on
    s.editor(stage).resize([6, 2, 4], [2, 0, 0]);
    close(s.instance(crate)!.position, [24, 0, 8]);
    s.undo();
    close(s.instance(crate)!.position, [8, 0, 8]);
    expect(s.document(stage).size).toEqual([4, 2, 4]);
    s.redo();
    close(s.instance(crate)!.position, [24, 0, 8]);

    // an instance of a resized model moves the other way, so its voxels stay put in the world
    const box = s.addModel(model("Box", [4, 4, 4]));
    const a = s.addInstance(box, { position: [0, 0, 0], rotation: [0, 90, 0] })!;
    const before = transformPoint(s.meshMatrix(a), [0, 0, 0]);
    s.editor(box).resize([6, 4, 4], [2, 0, 0]);
    // the cell that was at the grid's corner is two cells in now, and in the same place
    close(transformPoint(s.meshMatrix(a), [2, 0, 0]), before);
    // a centered resize leaves them alone
    const at = [...s.instance(a)!.position];
    s.editor(box).resize([8, 4, 4]);
    close(s.instance(a)!.position, at);
  });

  test("kinds set their own snap step and turning rule", () => {
    const s = sceneEditor();
    s.registerKinds([{ id: "waypoint", label: "Waypoint", snap: { step: 0.5 }, rotate: "none" }]);
    const w = s.addInstance(null, { kind: "waypoint" })!;
    expect(s.snapStepFor(w)).toBe(0.5);
    expect(s.rotateRule(w)).toBe("none");
  });
});

describe("the scene tree", () => {
  test("placing an instance in the tree re-parents and reorders it as one step, keeping it where it is", () => {
    const s = sceneEditor();
    const m = s.addModel(model("Crate", [2, 2, 2]));
    const a = s.addInstance(m, { position: [4, 0, 0] })!;
    const b = s.addInstance(m, { position: [8, 0, 0] })!;
    const c = s.addInstance(m, { position: [0, 0, 6] })!;
    const g = s.groupInstances([b])!;
    s.setTransform(g, { position: [10, 0, 0] });
    // drop a into the group, before b
    expect(s.placeInTree(a, g, b)).toBe(true);
    expect(s.instance(a)!.parent).toEqual({ instance: g, marker: null });
    close(worldOrigin(s, a), [4, 0, 0]);
    const order = s.instances.map((i) => i.id);
    expect(order.indexOf(a)).toBeLessThan(order.indexOf(b));
    // reorder at the top level: c before the group
    expect(s.placeInTree(c, null, g)).toBe(true);
    expect(s.instances.map((i) => i.id).indexOf(c)).toBeLessThan(s.instances.map((i) => i.id).indexOf(g));
    // a group can't go into what it holds
    expect(s.placeInTree(g, a)).toBe(false);
    s.undo();
    s.undo();
    expect(s.instance(a)!.parent).toBeNull();
    close(worldOrigin(s, a), [4, 0, 0]);
  });
});

describe("libraries", () => {
  test("an older .moxel opens as a library holding that model, its primary", () => {
    const text = serializeMoxel(model("Knight"));
    const lib = new LibraryEditor(parseLibrary(text));
    expect(lib.view).toBe("model");
    expect(lib.modelName(lib.modelAlone!)).toBe("Knight");
    // and comes back out as one
    expect(parseMoxel(serializeLibrary(lib.getLibrary())).name).toBe("Knight");
  });

  test("scenes place the library's models, not copies: an edit shows in every scene", () => {
    const lib = new LibraryEditor(libraryOf(model("Knight")));
    const knight = lib.modelAlone!;
    const a = lib.newScene("One", [knight])!;
    const b = lib.newScene("Two", [knight])!;
    lib.openScene(b);
    lib.openModel(lib.instances[0].id).setVoxel([1, 1, 1], 4);
    lib.openScene(a);
    expect(lib.document(lib.modelFor(lib.instances[0].id)!).layers[0].data[1 + 4 * (1 + 4 * 1)]).toBe(4);
    expect(lib.scenes.map((s) => s.name)).toEqual(["One", "Two"]);
  });

  test("one history: undo crosses a scene edit, a model edit and a rename, in order, opening where they were", () => {
    const lib = new LibraryEditor(libraryOf(model("Knight")));
    const knight = lib.modelAlone!;
    const scene = lib.newScene("Check", [knight])!;
    lib.openScene(scene);
    const inst = lib.instances[0].id;
    lib.setTransform(inst, { position: [5, 0, 0] });
    lib.openModelAlone(knight);
    lib.editor(knight).setVoxel([0, 0, 0], 3);
    lib.renameScene(scene, "Scale check");
    lib.undo(); // the rename
    expect(lib.scenes[0].name).toBe("Check");
    lib.undo(); // the voxel
    expect(lib.document(knight).layers[0].data[0]).toBe(0);
    lib.openLibrary();
    lib.undo(); // the move, in a scene that isn't open: it opens
    expect(lib.scene).toBe(scene);
    expect(lib.instance(inst)!.position).toEqual([0, 0, 0]);
  });

  test("deleting a model takes its instances in every scene with it, as one step", () => {
    const lib = new LibraryEditor(libraryOf(model("Knight")));
    const knight = lib.modelAlone!;
    const one = lib.newScene("One", [knight])!;
    lib.newScene("Two", [knight]);
    lib.openLibrary();
    expect(lib.scenesUsing(knight).length).toBe(2);
    expect(lib.deleteModel(knight)).toBe(true);
    expect(lib.models.length).toBe(0);
    expect(lib.primary).toBeNull();
    lib.undo();
    expect(lib.models.length).toBe(1);
    expect(lib.primary).toBe(knight);
    lib.openScene(one);
    expect(lib.instances.length).toBe(1);
  });

  test("scenes: new, rename, duplicate, delete and primary, each undoable; nothing to place without one open", () => {
    const lib = new LibraryEditor();
    expect(lib.view).toBe("library");
    const m = lib.addModel(model("Crate"));
    expect(lib.addInstance(m)).toBeNull();
    const a = lib.newScene()!;
    expect(lib.scenes.map((s) => s.name)).toEqual(["Scene"]);
    const b = lib.duplicateScene(a)!;
    expect(lib.scenes.map((s) => s.name)).toEqual(["Scene", "Scene copy"]);
    lib.setPrimary(b);
    lib.deleteScene(b);
    expect(lib.primary).toBeNull();
    lib.undo();
    expect(lib.primary).toBe(b);
    // a saved library opens its primary
    const t = reopen(lib);
    expect(t.scene).toBe(b);
  });
});

describe("review regressions", () => {
  test("deleting a marker repairs what hangs from it in every scene, in the same undo step", () => {
    const lib = new LibraryEditor(libraryOf(model("Arm", [4, 8, 4])));
    const arm = lib.modelAlone!;
    const hand = lib.editor(arm).addMarker({ shape: { kind: "point", at: [2, 6, 2] }, name: "Hand" })!;
    const scene = lib.newScene("One", [arm])!;
    lib.openScene(scene);
    const parent = lib.instances[0].id;
    const child = lib.addInstance(arm)!;
    expect(lib.attach(child, { instance: parent, marker: hand })).toBe(true);
    lib.openModelAlone(arm);
    lib.editor(arm).removeMarker(hand);
    // the file opens again
    expect(() => reopen(lib)).not.toThrow();
    lib.undo();
    lib.openScene(scene);
    expect(lib.instance(child)!.parent).toEqual({ instance: parent, marker: hand });
  });

  test("undoing a replaced model puts back attachments to its markers", () => {
    const s = sceneEditor();
    const doc = model("Arm", [4, 8, 4]);
    const m = s.addModel(doc);
    const hand = s.editor(m).addMarker({ shape: { kind: "point", at: [2, 6, 2] }, name: "Hand" })!;
    const parent = s.addInstance(m)!;
    const child = s.addInstance(m)!;
    s.attach(child, { instance: parent, marker: hand });
    expect(s.replaceModel(m, model("Arm v2", [4, 8, 4]))).toBe(true);
    expect(s.instance(child)!.parent).toEqual({ instance: parent, marker: null });
    s.undo();
    expect(s.instance(child)!.parent).toEqual({ instance: parent, marker: hand });
  });

  test("duplicating a parent listed after its child copies both", () => {
    const s = sceneEditor();
    const m = s.addModel(model("A"));
    const child = s.addInstance(m)!;
    const parent = s.addInstance(m)!;
    s.attach(child, { instance: parent, marker: null });
    const copies = s.duplicateInstances([parent]);
    expect(copies.length).toBe(2);
    const copyChild = copies.find((id) => s.instance(id)!.parent)!;
    expect(s.instance(copyChild)!.parent!.instance).toBe(copies.find((id) => id !== copyChild));
  });

  test("moving a parent and its child together moves the child once", () => {
    const s = sceneEditor();
    const m = s.addModel(model("A"));
    const parent = s.addInstance(m)!;
    const child = s.addInstance(m, { position: [1, 0, 0] })!;
    s.attach(child, { instance: parent, marker: null });
    s.moveInstances([parent, child], [3, 0, 0]);
    close(worldOrigin(s, child), [4, 0, 0]);
  });

  test("a host that resolves links at once: the instance gets its model", () => {
    const s = sceneEditor();
    s.setHost({ resolveModel: () => model("Spikes") });
    s.registerKinds([{ id: "spikes", label: "Spikes", model: () => "spikes" }]);
    const a = s.addInstance(null, { kind: "spikes" })!;
    const m = s.modelFor(a);
    expect(m).not.toBeNull();
    expect(s.model(m!)!.ref).toBe("spikes");
  });

  test("built models a closed scene shows stay, and travel in the file", () => {
    const lib = new LibraryEditor(oneScene());
    const kinds = [{ id: "pole", label: "Pole", defaults: { length: 4 }, model: () => model("Pole", [1, 4, 1]) }];
    lib.registerKinds(kinds);
    const a = lib.addInstance(null, { kind: "pole" })!;
    lib.openLibrary();
    const t = reopen(lib);
    t.openScene("scene:test");
    expect(t.modelFor(a)).not.toBeNull();
  });
});

describe("placed scenes", () => {
  /** A library with a rig scene (a torso and an arm hung from its shoulder mount) and an open level. */
  function rigged() {
    const s = sceneEditor();
    const level = s.scene!;
    const torso = s.addModel(model("Torso", [4, 6, 4]));
    const shoulder = s.editor(torso).addMarker({ shape: { kind: "point", at: [4, 5, 2] }, name: "shoulder", role: "mount" })!;
    s.editor(torso).setCells([[0, 0, 0], [3, 5, 3]], 2);
    const arm = s.addModel(model("Arm", [2, 4, 2]));
    s.editor(arm).setCells([[0, 0, 0], [1, 3, 1]], 3);
    const rig = s.newScene("Knight")!;
    s.openScene(rig);
    const t = s.addInstance(torso, { position: [0, 0, 0] })!;
    const a = s.addInstance(arm)!;
    s.attach(a, { instance: t, marker: shoulder });
    s.setTransform(a, { position: [0, 0, 0], rotation: [0, 0, 0] });
    s.openScene(level);
    return { s, level, rig, torso, arm, t, a };
  }

  test("a placed scene draws its models where its instances put them, moved by the placing instance", () => {
    const { s, rig, torso, arm } = rigged();
    const one = s.addInstance(null, { scene: rig, position: [10, 0, 0] })!;
    expect(s.instance(one)!.name).toBe("Knight");
    expect(s.isGroup(one)).toBe(false);
    const contents = s.placedContents(one);
    expect(contents.map((c) => c.model)).toEqual([torso, arm]);
    // the arm's origin (the center of its floor) is on the torso's shoulder, 2 right and 5 up of the torso's origin
    const armOrigin = transformPoint(contents[1].matrix, [1, 0, 1]);
    close(armOrigin, [12, 5, 0]);
    // its box goes around both
    const box = s.worldBox(one)!;
    close(box.min, [8, 0, -2]);
    close(box.max, [13, 9, 2]);
  });

  test("two copies show the same rig; editing the rig shows in both", () => {
    const { s, level, rig, a } = rigged();
    const one = s.addInstance(null, { scene: rig, position: [0, 0, 0] })!;
    const two = s.addInstance(null, { scene: rig, position: [20, 0, 0] })!;
    s.openScene(rig);
    s.setTransform(a, { rotation: [0, 0, 90] });
    s.openScene(level);
    const turned = (id: string) => decomposeMat(s.placedContents(id)[1].matrix).rotation;
    close(turned(one), turned(two));
    close(turned(one), quatFromEuler([0, 0, 90]));
  });

  test("a scene can't be placed in itself or in a scene it places", () => {
    const { s, level, rig } = rigged();
    expect(s.addInstance(null, { scene: level })).toBeNull();
    s.addInstance(null, { scene: rig });
    s.openScene(rig);
    expect(s.addInstance(null, { scene: level })).toBeNull();
  });

  test("deleting a scene takes its placements with it, in one undo step", () => {
    const { s, level, rig } = rigged();
    const one = s.addInstance(null, { scene: rig })!;
    expect(s.deleteScene(rig)).toBe(true);
    s.openScene(level);
    expect(s.instance(one)).toBeUndefined();
    s.undo();
    s.openScene(level);
    expect(s.instance(one)!.scene).toBe(rig);
  });

  test("placements survive a save and reload", () => {
    const { s, rig } = rigged();
    const one = s.addInstance(null, { scene: rig, position: [3, 0, 0] })!;
    const copy = reopen(s);
    copy.openScene(s.scene!);
    expect(copy.instance(one)!.scene).toBe(rig);
    expect(copy.placedContents(one)).toHaveLength(2);
  });
});

describe("starting", () => {
  test("a new library starts in an empty model, its primary", () => {
    const s = new LibraryEditor(oneScene());
    s.newLibrary();
    expect(s.models.length).toBe(1);
    expect(s.scenes.length).toBe(0);
    expect(s.primary).toBe(s.models[0].id);
    expect(s.canUndo).toBe(false);
  });

  test("a new scene starts with a new, empty model in it, in one undo step", () => {
    const s = new LibraryEditor(oneScene());
    const models = s.models.length;
    const scenes = s.scenes.length;
    const started = s.startScene()!;
    expect(started).not.toBeNull();
    expect(s.models.length).toBe(models + 1);
    s.openScene(started.scene);
    expect(s.instance(started.instance)?.model).toBe(s.models[s.models.length - 1].id);
    s.openModel(started.instance);
    s.openLibrary();
    s.undo();
    expect(s.scenes.length).toBe(scenes);
    expect(s.models.length).toBe(models);
  });
});
