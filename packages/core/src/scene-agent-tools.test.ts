import { describe, expect, test } from "bun:test";
import { LibraryEditor } from "./library";
import { createSceneAgentTools } from "./scene-agent-tools";

function tools() {
  const scene = new LibraryEditor();
  scene.openScene(scene.newScene("Test")!);
  const list = createSceneAgentTools(scene);
  const run = (name: string, input: Record<string, unknown> = {}) => JSON.parse(list.find((t) => t.name === name)!.execute(input));
  return { scene, run };
}

describe("scene agent tools", () => {
  test("add a model, place instances, edit them, undo as one step each", () => {
    const { scene, run } = tools();
    const { model } = run("add_model", { name: "Crate", size: [4, 4, 4] });
    const { instances } = run("place_instances", {
      instances: [
        { model: "Crate", position: [0, 0, 0] },
        { model, position: [6, 0, 0], rotation: [0, 90, 0] },
      ],
    });
    expect(instances.length).toBe(2);
    const info = run("get_scene");
    expect(info.models[0]).toMatchObject({ name: "Crate", size: [4, 4, 4], uses: 2 });
    expect(info.instances[1].rotation[1]).toBeCloseTo(90, 6);

    run("edit_instances", { edits: [{ instance: instances[0], move_by: [0, 2, 0] }, { instance: instances[1], attach: { instance: instances[0] } }] });
    expect(scene.instance(instances[0])!.position).toEqual([0, 2, 0]);
    expect(scene.instance(instances[1])!.parent?.instance).toBe(instances[0]);
    run("undo_scene");
    expect(scene.instance(instances[0])!.position).toEqual([0, 0, 0]);
    expect(scene.instance(instances[1])!.parent).toBeNull();
  });

  test("place a whole scene, and not one that places this one", () => {
    const { scene, run } = tools();
    const level = scene.scene!;
    const rig = scene.newScene("Knight")!;
    const { instances } = run("place_instances", { instances: [{ scene: "Knight", position: [4, 0, 0] }] });
    expect(scene.instance(instances[0])!.scene).toBe(rig);
    expect(run("get_scene").instances[0]).toMatchObject({ name: "Knight", scene: rig });
    scene.openScene(rig);
    expect(() => run("place_instances", { instances: [{ scene: level }] })).toThrow(/placed in itself/);
  });

  test("a failing edit changes nothing", () => {
    const { scene, run } = tools();
    run("add_model", { name: "A" });
    const { instances } = run("place_instances", { instances: [{ model: "A" }] });
    const undo = scene.undoLabel;
    expect(() => run("edit_instances", { edits: [{ instance: instances[0], move_by: [1, 0, 0] }, { instance: "nope", move_by: [1, 0, 0] }] })).toThrow(/No instance/);
    expect(scene.instance(instances[0])!.position).toEqual([0, 0, 0]);
    expect(scene.undoLabel).toBe(undo);
  });

  test("kinds take settings, checked as JSON", () => {
    const { scene, run } = tools();
    scene.registerKinds([{ id: "light", label: "Light", defaults: { power: 1 } }]);
    const { instances } = run("place_instances", { instances: [{ kind: "light", settings: { power: 3 } }] });
    expect(run("get_scene").instances[0].settings).toEqual({ power: 3 });
    run("edit_instances", { edits: [{ instance: instances[0], reset: ["power"] }] });
    expect(scene.settings(instances[0])).toEqual({ power: 1 });
    expect(() => run("place_instances", { instances: [{ kind: "light", settings: [1] }] })).toThrow(/settings/);
  });

  test("settings are checked against the kind's fields", () => {
    const { scene, run } = tools();
    scene.registerKinds([{ id: "light", label: "Light", fields: [{ key: "radius", type: "radius", min: 1, max: 10 }, { key: "mode", type: "enum", options: ["on", "off"] }] }]);
    expect(() => run("place_instances", { instances: [{ kind: "light", settings: { brightness: 3 } }] })).toThrow(/no setting/);
    expect(() => run("place_instances", { instances: [{ kind: "light", settings: { radius: 50 } }] })).toThrow(/from 1 to 10/);
    expect(() => run("place_instances", { instances: [{ kind: "light", settings: { mode: "dim" } }] })).toThrow(/one of on, off/);
    expect(run("place_instances", { instances: [{ kind: "light", settings: { radius: 4, mode: "off" } }] }).instances.length).toBe(1);
    expect(scene.instances.length).toBe(1);
  });

  test("get_library describes every model and scene, open or not; add_model can open the new model", () => {
    const { scene, run } = tools();
    const { model } = run("add_model", { name: "Course", size: [8, 2, 8] });
    scene.setStage(model);
    run("place_instances", { instances: [{ model }, { model }] });
    const { model: torch } = run("add_model", { name: "Torch", size: [2, 4, 2], open: true });
    expect(scene.activeModel).toBe(torch);
    const info = run("get_library");
    expect(info.openModel).toBe(torch);
    expect(info.models).toEqual([
      { id: model, name: "Course", size: [8, 2, 8], scenes: [scene.scenes[0].id] },
      { id: torch, name: "Torch", size: [2, 4, 2], scenes: [] },
    ]);
    // the scene isn't open any more, and still says what it holds
    expect(info.openScene).toBeNull();
    expect(info.scenes).toEqual([{ id: scene.scenes[0].id, name: "Test", stage: model, instances: 2 }]);
  });
});
