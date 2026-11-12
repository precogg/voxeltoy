import { describe, expect, test } from "bun:test";
import { createAgentTools } from "./agent-tools";
import { Editor } from "./editor";
import type { CameraView } from "./types";

function setup(size: [number, number, number] = [8, 8, 8]) {
  const editor = new Editor();
  editor.newDocument(size);
  const views: CameraView[] = [];
  const tools = createAgentTools(editor, { setView: (v) => views.push(v), fit: () => {} });
  const call = (name: string, input: Record<string, unknown> = {}): any => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return JSON.parse(tool.execute(input));
  };
  return { editor, tools, call, views };
}

const filled = (e: Editor) => e.activeLayer!.data.reduce((n, v) => n + (v ? 1 : 0), 0);

describe("agent tools", () => {
  test("edit_frames builds a flipbook, one undo step each", () => {
    const { call, editor } = setup();
    call("set_voxels", { voxels: [[0, 0, 0, 2]] });
    expect(call("get_document").animation.frames).toHaveLength(1);
    let anim = call("edit_frames", { action: "duplicate" }).animation;
    expect(anim.frames).toHaveLength(2);
    expect(anim.activeFrame).toBe(1);
    call("set_voxels", { voxels: [[1, 0, 0, 3]] });
    expect(call("get_voxels", { frame: 0 }).total).toBe(1);
    expect(call("get_voxels").total).toBe(2);
    anim = call("edit_frames", { action: "set_duration", frames: [0, 1], duration: 3 }).animation;
    expect(anim.frames.map((f: { duration: number }) => f.duration)).toEqual([3, 3]);
    expect(call("edit_frames", { action: "set_fps", fps: 6 }).animation.seconds).toBe(1);
    expect(() => call("edit_frames", { action: "delete", frames: [0, 1] })).toThrow(/at least one/);
    expect(() => call("edit_frames", { action: "select", frame: 5 })).toThrow(/numbered from 0/);
    call("edit_frames", { action: "select", frame: 0 });
    expect(editor.activeFrameIndex).toBe(0);
    editor.setReadOnly("View only");
    expect(() => call("edit_frames", { action: "blank" })).toThrow(/View only/);
    call("edit_frames", { action: "select", frame: 1 });
    expect(editor.activeFrameIndex).toBe(1);
  });

  test("names are unique and valid for WebMCP", () => {
    const { tools } = setup();
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
  });

  test("set_workplane moves and clips the workplane, outside history", () => {
    const { call, editor } = setup();
    expect(call("get_document").workplane).toEqual({ axis: "y", level: 0, clip: "off" });
    expect(call("set_workplane", { axis: "z", level: 3, clip: "below" }).workplane).toEqual({
      axis: "z",
      level: 3,
      clip: "below",
    });
    expect(editor.slice).toEqual({ axis: 2, level: 3, mode: "-" });
    expect(editor.canUndo).toBe(false);
    expect(call("set_workplane", { level: 99 }).workplane.level).toBe(7);
    expect(call("set_workplane", { reset: true }).workplane).toEqual({ axis: "y", level: 0, clip: "off" });
    expect(() => call("set_workplane", { clip: "sideways" })).toThrow(/clip must be one of/);
  });

  test("get_projection shows a view as screen rows, cropped to the model", () => {
    const { call, editor } = setup();
    // an L seen from the front: a column at x = 2 and a foot at x = 3, two deep at the bottom
    editor.setColor(2);
    editor.applyCells([[2, 0, 5], [2, 1, 5], [2, 2, 5], [3, 0, 5], [3, 0, 6]], "add");
    const front = call("get_projection", { view: "front" });
    expect(front.right).toEqual({ axis: "+x", from: 2, to: 3 });
    expect(front.up).toEqual({ axis: "+y", top: 2, bottom: 0 });
    expect(front.colors).toEqual([[2, 0], [2, 0], [2, 2]]);
    expect(front.depth).toEqual([[5, null], [5, null], [5, 6]]);
    expect(front.toward).toBe("+z");
    // from the back, left and right swap
    expect(call("get_projection", { view: "back" }).colors).toEqual([[0, 2], [0, 2], [2, 2]]);
    const top = call("get_projection", { view: "top" });
    expect(top.up).toEqual({ axis: "-z", top: 5, bottom: 6 });
    expect(top.colors).toEqual([[2, 2], [0, 2]]);
    expect(top.depth).toEqual([[2, 0], [null, 0]]);
    editor.newDocument([8, 8, 8]);
    editor.applyCells([[0, 0, 0]], "erase");
    expect(call("get_projection", { view: "left" }).empty).toBe(true);
  });

  test("get_document describes the model", () => {
    const { call } = setup();
    const doc = call("get_document");
    expect(doc.size).toEqual([8, 8, 8]);
    expect(doc.palette[0]).toBeNull();
    expect(doc.palette[1]).toMatch(/^#[0-9a-f]{6}$/);
    expect(doc.layers).toHaveLength(1);
    expect(doc.layers[0].active).toBe(true);
    expect(doc.bounds).toBeNull();
  });

  test("place_shapes builds in one undo step", () => {
    const { editor, call } = setup();
    const result = call("place_shapes", {
      shapes: [
        { kind: "box", min: [0, 0, 0], max: [3, 3, 3], color: 2 },
        { kind: "box", min: [1, 1, 1], max: [2, 2, 2], op: "erase" },
      ],
    });
    expect(result.changed).toBe(64 + 8);
    expect(filled(editor)).toBe(56);
    expect(result.undo).toBe("Place shapes");
    call("undo");
    expect(filled(editor)).toBe(0);
  });

  test("place_shapes leans a limb from the corner it names, tapered", () => {
    const { editor, call } = setup();
    const limb = (shape: Record<string, unknown>) => {
      editor.newDocument([8, 8, 8]);
      call("place_shapes", { shapes: [{ kind: "limb", min: [0, 0, 0], max: [7, 7, 7], radius: 1.5, color: 2, ...shape }] });
      return editor;
    };
    // from the min corner by default; from +x (corner 1) it leans the other way
    expect(limb({}).getVoxel([1, 1, 1])).toBe(2);
    expect(limb({}).getVoxel([6, 1, 1])).toBe(0);
    expect(limb({ corner: 1 }).getVoxel([6, 1, 1])).toBe(2);
    expect(limb({ corner: 1 }).getVoxel([1, 1, 1])).toBe(0);
    const full = filled(limb({}));
    expect(filled(limb({ tip: 0.5 }))).toBeLessThan(full);
    expect(() => call("place_shapes", { shapes: [{ kind: "limb", min: [0, 0, 0], max: [3, 3, 3], corner: 8 }] })).toThrow(/corner is 0 to 7/);
    expect(() => call("place_shapes", { shapes: [{ kind: "limb", min: [0, 0, 0], max: [3, 3, 3], tip: -1 }] })).toThrow(/tip/);
  });

  test("set_voxels replaces, erases, and maps hex colors to the palette", () => {
    const { editor, call } = setup();
    editor.setVoxel([0, 0, 0], 3);
    const hex = "#" + editor.palette[5].toString(16).padStart(6, "0");
    call("set_voxels", { voxels: [[0, 0, 0, 4], [1, 0, 0, hex], [2, 0, 0, 0]] });
    expect(editor.getVoxel([0, 0, 0])).toBe(4);
    expect(editor.getVoxel([1, 0, 0])).toBe(5);
    call("set_voxels", { voxels: [[0, 0, 0, 0]] });
    expect(editor.getVoxel([0, 0, 0])).toBe(0);
  });

  test("brush_stroke sweeps a brush through empty space as one undo step", () => {
    const { editor, call } = setup();
    const result = call("brush_stroke", { points: [[1, 4, 1], [6, 4, 1]], color: 3 });
    expect(result.changed).toBe(6);
    for (let x = 1; x <= 6; x++) expect(editor.getVoxel([x, 4, 1])).toBe(3);
    call("brush_stroke", { points: [[3, 4, 1]], op: "erase", size: 3 });
    expect(editor.getVoxel([3, 4, 1])).toBe(0);
    expect(editor.getVoxel([1, 4, 1])).toBe(3);
    expect(editor.spatial.size).toBe(1);
    editor.undo();
    expect(editor.getVoxel([3, 4, 1])).toBe(3);
    expect(() => call("brush_stroke", { points: [] })).toThrow();
  });

  test("get_voxels reads the topmost visible layer", () => {
    const { editor, call } = setup();
    editor.setVoxel([0, 0, 0], 2);
    editor.createLayer();
    editor.setVoxel([0, 0, 0], 3);
    editor.setVoxel([1, 0, 0], 4);
    const all = call("get_voxels");
    expect(all.total).toBe(2);
    expect(all.voxels).toContainEqual([0, 0, 0, 3]);
    const bottom = call("get_voxels", { layer: "Layer 1" });
    expect(bottom.voxels).toEqual([[0, 0, 0, 2]]);
    expect(call("get_voxels", { limit: 1 }).truncated).toBe(true);
  });

  test("edits fail with a reason on locked layers", () => {
    const { call } = setup();
    call("edit_layer", { action: "lock" });
    expect(() => call("place_shapes", { shapes: [{ min: [0, 0, 0], max: [1, 1, 1] }] })).toThrow(/locked/);
  });

  test("bad input fails with a helpful message", () => {
    const { call } = setup();
    expect(() => call("set_voxels", { voxels: [[0, 0, 4]] })).toThrow(/\[x, y, z, color\]/);
    expect(() => call("place_shapes", { shapes: [{ kind: "blob", min: [0, 0, 0], max: [1, 1, 1] }] })).toThrow(/kind/);
    expect(() => call("place_shapes", { shapes: [{ min: [0, 0, 0], max: [1, 1, 1], color: 999 }] })).toThrow(/color/);
  });

  test("edits report mirroring and selection clipping", () => {
    const { editor, call } = setup();
    call("set_mirror", { x: true });
    expect(call("set_voxels", { voxels: [[0, 0, 0, 1]] })).toMatchObject({ changed: 2, mirrored: ["x"] });
    call("set_mirror", { x: false });
    call("select", { action: "box", min: [0, 0, 0], max: [0, 0, 0] });
    const result = call("place_shapes", { shapes: [{ min: [0, 1, 0], max: [3, 1, 0] }] });
    expect(result.changed).toBe(0);
    expect(result.note).toMatch(/selected/);
    expect(editor.selectionCount).toBe(1);
  });

  test("transform_selection moves and rotates as one step", () => {
    const { editor, call } = setup();
    call("place_shapes", { shapes: [{ min: [0, 0, 0], max: [1, 0, 0], color: 2 }] });
    call("select", { action: "all" });
    const result = call("transform_selection", { steps: [{ move: [2, 0, 2] }, { rotate: "y" }] });
    expect(result.undo).toBe("Transform selection");
    expect(editor.getVoxel([0, 0, 0])).toBe(0);
    expect(filled(editor)).toBe(2);
    expect(result.bounds.max[0] - result.bounds.min[0]).toBe(0);
    call("undo");
    expect(editor.getVoxel([0, 0, 0])).toBe(2);
  });

  test("transform_selection can copy", () => {
    const { editor, call } = setup();
    editor.setVoxel([0, 0, 0], 2);
    call("select", { action: "all" });
    call("transform_selection", { steps: [{ move: [0, 1, 0] }], copy: true });
    expect(editor.getVoxel([0, 0, 0])).toBe(2);
    expect(editor.getVoxel([0, 1, 0])).toBe(2);
  });

  test("extrude pulls a face out and carves it in, explaining when it can't", () => {
    const { editor, call } = setup();
    call("place_shapes", { shapes: [{ min: [2, 0, 2], max: [4, 0, 4] }] });
    const out = call("extrude", { at: [3, 0, 3], direction: "+y", depth: 2 });
    expect(out).toMatchObject({ face: 9, changed: 18, undo: "Extrude" });
    expect(filled(editor)).toBe(27);
    expect(call("extrude", { at: [3, 2, 3], direction: "+y", depth: -1 }).changed).toBe(9);
    expect(() => call("extrude", { at: [3, 0, 3], direction: "+y", depth: 1 })).toThrow("covered");
    expect(() => call("extrude", { at: [3, 1, 3], direction: "up", depth: 1 })).toThrow("direction must be one of");
  });

  test("edit_layer and edit_palette", () => {
    const { editor, call } = setup();
    const { layers } = call("edit_layer", { action: "create", name: "Roof" });
    expect(layers.map((l: { name: string }) => l.name)).toEqual(["Layer 1", "Roof"]);
    expect(editor.activeLayer!.name).toBe("Roof");
    call("edit_layer", { action: "move", layer: "Roof", index: 0 });
    expect(editor.layers[0].name).toBe("Roof");

    const before = editor.palette.length;
    const { indices } = call("edit_palette", { action: "add", colors: ["#123456", "#abcdef"] });
    expect(indices).toEqual([before, before + 1]);
    expect(editor.palette[before]).toBe(0x123456);
    call("undo");
    expect(editor.palette.length).toBe(before);
    call("edit_palette", { action: "replace", palette: "PICO-8" });
    expect(editor.palette.length).toBe(17);
  });

  test("edit_markers places mounts, volumes and the origin, one undo step each", () => {
    const { editor, call } = setup();
    const { id, markers } = call("edit_markers", { action: "add", name: "bell.1", role: "mount", at: [4, 6, 4.5], up: "-y" });
    expect(id).toStartWith("marker:");
    expect(markers[0]).toMatchObject({ name: "bell.1", role: "mount", at: [4, 6, 4.5], up: "-y" });
    call("edit_markers", { action: "add", role: "collision", volume: { min: [0, 0, 0], max: [7, 1, 7] } });
    expect(call("get_document").markers[1]).toMatchObject({ role: "collision", volume: { kind: "box", min: [0, 0, 0], max: [7, 1, 7] } });
    call("edit_markers", { action: "place", marker: "bell.1", at: [2, 6, 2] });
    expect(call("undo").undone).toEqual(["Move marker"]);
    expect(call("edit_markers", { action: "set_origin", at: [4, 0, 2] }).origin).toEqual([4, 0, 2]);
    expect(editor.origin).toEqual([4, 0, 2]);
    expect(() => call("edit_markers", { action: "hide", marker: "bell.1" })).toThrow(/key_per_frame/);
    expect(() => call("edit_markers", { action: "place", marker: "nope", at: [0, 0, 0] })).toThrow(/No marker/);
    // points snap to half voxels
    expect(call("edit_markers", { action: "add", at: [0.3, 0, 0] }).markers[2].at).toEqual([0.5, 0, 0]);
    call("edit_markers", { action: "delete", marker: "bell.1" });
    expect(call("get_document").markers).toHaveLength(2);
  });

  test("edit_pipeline cuts with a blend, groups, masks and adds effects", () => {
    const { editor, call } = setup();
    call("set_voxels", { voxels: [[0, 0, 0, 2], [1, 0, 0, 2]] });
    call("edit_layer", { action: "create", name: "Hole" });
    call("set_voxels", { voxels: [[1, 0, 0, 3]] });
    const { layers } = call("edit_pipeline", { action: "set_blend", blend: "cut" });
    expect(layers[1].blend).toBe("cut");
    expect(call("get_voxels", {}).total).toBe(1);
    const { group } = call("edit_pipeline", { action: "group", layers: ["Hole"], name: "Holes" });
    expect(call("get_document").groups).toEqual([{ id: group, name: "Holes", visible: true }]);
    // alone in its group, the cut has nothing to cut
    expect(call("get_voxels", {}).total).toBe(2);
    // the group cuts with what it holds: the hole as a plain layer inside it
    call("edit_pipeline", { action: "set_blend", layer: "Hole", blend: "default" });
    call("edit_pipeline", { action: "set_blend", group: "Holes", blend: "cut" });
    expect(call("get_voxels", {}).total).toBe(1);
    call("edit_pipeline", { action: "add_effect", layer: "Layer 1", effect: { kind: "outline", color: 4 } });
    expect(editor.layers[0].effects).toEqual([{ kind: "outline", color: 4 }]);
    expect(() => call("edit_pipeline", { action: "mask_to_selection" })).toThrow(/select/i);
    expect(call("undo").undone).toEqual(["Change effects"]);
  });

  test("undo and redo report what they did", () => {
    const { call } = setup();
    call("place_shapes", { shapes: [{ kind: "sphere", min: [0, 0, 0], max: [3, 3, 3] }] });
    expect(call("undo")).toMatchObject({ undone: ["Add sphere"], redo: "Add sphere" });
    expect(call("redo")).toMatchObject({ redone: ["Add sphere"] });
    expect(call("undo", { steps: 5 }).undone).toHaveLength(1);
  });

  test("set_view drives the camera", () => {
    const { editor, call, views } = setup();
    call("set_view", { view: "top", projection: "orthographic" });
    expect(views).toEqual(["top"]);
    expect(editor.projection).toBe("orthographic");
  });

  test("a read-only document refuses edits with the reason, but still answers and selects", () => {
    const { editor, call } = setup();
    editor.setReadOnly("This link is view only");
    expect(() => call("set_voxels", { voxels: [[0, 0, 0, 1]] })).toThrow("view only");
    expect(() => call("edit_layer", { action: "create" })).toThrow("view only");
    expect(call("get_document").layers).toHaveLength(1);
    call("edit_layer", { action: "hide" });
    expect(editor.activeLayer!.visible).toBe(false);
    expect(() => call("select", { action: "box", min: [0, 0, 0], max: [1, 1, 1] })).not.toThrow();
  });
});

test("animation tag tools validate, undo once, and allow local selection when read-only", () => {
  const { editor, call } = setup();
  const result = call("edit_animation_tags", { action: "create", name: "Idle", direction: "reverse", repeat: 2 });
  expect(result.tags[0].direction).toBe("reverse");
  const id = result.tags[0].id;
  editor.undo(); expect(editor.tags).toHaveLength(0);
  editor.redo(); expect(editor.tags[0].repeat).toBe(2);
  expect(() => call("edit_animation_tags", { action: "create", name: "Broken", repeat: -1 })).toThrow();
  expect(editor.tags).toHaveLength(1);
  editor.setReadOnly("View only");
  call("edit_animation_tags", { action: "select", id });
  expect(editor.activeTagId).toBe(id);
  expect(() => call("edit_animation_tags", { action: "delete", id })).toThrow(/View only/);
});


test("agents report the same next undo action as the editor", () => {
  const { editor, call } = setup();
  const id = editor.addBoxLayer({ min: [0, 0, 0], max: [2, 2, 2] })!;
  expect(editor.editShape(editor.shapeStack(id)![0].id, id)).toBe(true);
  const label = editor.undoLabel;
  expect(label).not.toBe("Cancel shape");
  expect(call("get_document").undo).toBe(label);
  expect(call("undo").undone).toEqual([label]);
});
