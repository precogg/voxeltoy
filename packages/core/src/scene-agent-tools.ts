// Tools for browser agents (WebMCP) working on a scene: validated wrappers over LibraryEditor, one
// undo step each, throwing an Error with a reason the agent can act on. See docs/scenes.md.

import type { AgentTool, AgentView } from "./agent-tools";
import { defaultDocument } from "./document";
import { DEFAULT_PALETTE } from "./palette";
import { checkJson } from "./ops";
import type { Placement, LibraryEditor } from "./library";
import { eulerFromQuat } from "./scene-math";
import type { Attach, Playback } from "./scene-ops";
import type { CameraView, Json, Vec3 } from "./types";

type Input = Record<string, unknown>;

const fail = (message: string): never => {
  throw new Error(message);
};

const vec3 = (description: string) => ({ type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description });

function readVec(value: unknown, name: string): Vec3 | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) {
    fail(`${name} must be [x, y, z] numbers`);
  }
  return [...(value as number[])] as Vec3;
}

function readScale(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !(value > 0) || value > 1000) fail("scale must be a number above 0, at most 1000");
  return value as number;
}

function readSettings(value: unknown): { [key: string]: Json } | undefined {
  if (value === undefined) return undefined;
  let json: Json;
  try {
    json = checkJson(value);
  } catch (e) {
    return fail(`settings: ${(e as Error).message}`);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) fail("settings must be an object of setting names to values");
  return json as { [key: string]: Json };
}

const CAMERA_VIEWS: readonly CameraView[] = ["front", "back", "left", "right", "top", "bottom", "iso"];

/** Check settings against a kind's fields, when the kind is known and has them. */
function checkSettings(scene: LibraryEditor, kind: string | undefined, settings: { [key: string]: Json } | undefined) {
  const k = scene.kind(kind);
  if (!settings || !k?.fields?.length) return;
  const isVec = (v: Json) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number");
  for (const [key, value] of Object.entries(settings)) {
    const field = k.fields.find((f) => f.key === key);
    if (!field) {
      if (k.defaults && key in k.defaults) continue;
      fail(`${k.label} has no setting “${key}”; it has ${k.fields.map((f) => f.key).join(", ")}`);
    }
    if (value === null) continue;
    const bad = (what: string) => fail(`${k.label}'s ${key} must be ${what}`);
    switch (field!.type) {
      case "number":
      case "radius": {
        if (typeof value !== "number") bad("a number");
        const f = field as { min?: number; max?: number };
        if ((f.min !== undefined && (value as number) < f.min) || (f.max !== undefined && (value as number) > f.max)) bad(`from ${f.min ?? "-∞"} to ${f.max ?? "∞"}`);
        break;
      }
      case "bool":
        if (typeof value !== "boolean") bad("true or false");
        break;
      case "enum":
        if (!field!.options.includes(value as string)) bad(`one of ${field!.options.join(", ")}`);
        break;
      case "color":
        if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) bad('a color like "#ff8800"');
        break;
      case "point":
      case "size":
        if (!isVec(value)) bad("[x, y, z]");
        break;
      case "points":
        if (!Array.isArray(value) || !value.every(isVec)) bad("a list of [x, y, z]");
        break;
      case "ref":
        if (typeof value !== "string" || !scene.instance(value)) bad("an instance id from get_scene");
        break;
    }
  }
}

export function createSceneAgentTools(scene: LibraryEditor, view?: AgentView): AgentTool[] {
  const findInstance = (ref: unknown): string => {
    const inst = scene.instances.find((i) => i.id === ref) ?? scene.instances.find((i) => i.name === ref);
    return inst?.id ?? fail(`No instance with id or name ${JSON.stringify(ref)}; get_scene lists them`);
  };
  const findModel = (ref: unknown): string => {
    const model = scene.models.find((m) => m.id === ref) ?? scene.models.find((m) => scene.modelName(m.id) === ref);
    return model?.id ?? fail(`No model with id or name ${JSON.stringify(ref)}; get_scene lists them, and add_model adds one`);
  };
  const readAttach = (value: unknown): Attach | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const v = value as { instance?: unknown; marker?: unknown };
    if (!v || typeof v !== "object") fail("attach is { instance, marker? } or null");
    const instance = findInstance(v.instance);
    let marker: string | null = null;
    if (v.marker !== undefined && v.marker !== null) {
      const model = scene.modelFor(instance);
      const markers = model ? scene.document(model).markers : [];
      marker =
        (markers.find((m) => m.id === v.marker) ?? markers.find((m) => m.name === v.marker))?.id ??
        fail(`${scene.instance(instance)!.name} has no marker ${JSON.stringify(v.marker)}; edit_markers adds one to its model`);
    }
    return { instance, marker };
  };
  const readPlayback = (value: unknown): Playback | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const v = value as { frame?: unknown; loop?: unknown; speed?: unknown; offset?: unknown };
    if (v.loop) return { kind: "loop", speed: typeof v.speed === "number" ? v.speed : 1, offset: typeof v.offset === "number" ? v.offset : 0 };
    if (typeof v.frame === "string") return { kind: "frame", frame: v.frame };
    return fail('playback is { "loop": true, "speed"?, "offset"? }, { "frame": "<frame id>" } or null');
  };
  /** Why the last change did nothing, from the scene's notice. */
  const why = (fallback: string) => scene.toast?.message ?? fallback;
  const libraryInfo = () => {
    // scenes that aren't open keep their stage and instances in the library's records
    const records = new Map(scene.getLibrary().scenes.map((s) => [s.id, s]));
    return {
      name: scene.name,
      primary: scene.primary,
      view: scene.view,
      openScene: scene.scene,
      openModel: scene.activeModel,
      models: scene.allModels.map((m) => ({
        id: m.id,
        name: scene.modelName(m.id),
        size: scene.document(m.id).size,
        ...(m.voxelSize ? { voxelSize: m.voxelSize } : {}),
        ...(m.ref !== undefined ? { ref: m.ref } : {}),
        ...(m.built ? { built: true } : {}),
        scenes: scene.scenesUsing(m.id).map((s) => s.id),
      })),
      scenes: scene.scenes.map((s) => {
        const record = records.get(s.id);
        return { id: s.id, name: s.name, stage: record?.stage ?? null, instances: record?.instances.length ?? 0 };
      }),
      undo: scene.undoLabel,
      redo: scene.redoLabel,
    };
  };
  const sceneInfo = () => ({
    library: scene.name,
    scene: scene.scene,
    name: scene.sceneName,
    stage: scene.stage,
    models: scene.models.map((m) => {
      const e = scene.document(m.id);
      return {
        id: m.id,
        name: e.name,
        size: e.size,
        markers: e.markers.map((m) => ({ id: m.id, name: m.name, ...(m.role ? { role: m.role } : {}) })),
        frames: e.frames.map((f) => f.id),
        uses: scene.usage(m.id),
        ...(m.voxelSize ? { voxelSize: m.voxelSize } : {}),
      };
    }),
    kinds: scene.kinds.map((k) => ({ id: k.id, label: k.label, ...(k.defaults ? { defaults: k.defaults } : {}), ...(k.fields ? { fields: k.fields } : {}) })),
    instances: scene.instances.map((i) => ({
      id: i.id,
      name: i.name,
      model: i.model,
      ...(i.scene !== undefined ? { scene: i.scene } : {}),
      ...(i.kind ? { kind: i.kind, settings: scene.settings(i.id) } : {}),
      ...(scene.isGroup(i.id) ? { group: true } : {}),
      parent: i.parent,
      position: i.position,
      rotation: eulerFromQuat(i.rotation),
      scale: i.scale ?? 1,
      ...(i.playback ? { playback: i.playback } : {}),
      ...(i.visible ? {} : { visible: false }),
      ...(i.locked ? { locked: true } : {}),
    })),
    selection: scene.selection,
    open: scene.open,
    undo: scene.undoLabel,
    redo: scene.redoLabel,
  });

  const placementProps = {
    position: vec3("Where its origin goes (the center of its model's floor), in world units: one unit is one voxel."),
    rotation: vec3("Euler degrees [x, y, z], applied x then y then z."),
    scale: { type: "number", description: "Uniform scale; 1 keeps the model's voxel size." },
  };

  const tools: AgentTool[] = [
    {
      name: "get_library",
      title: "Get library",
      description:
        "The library: its models (size, and the scenes that place each; ref and built mark models a host links or builds), " +
        "its scenes (stage and how many instances), which one is primary (opens first), and what is open now: the library itself, " +
        "a model on its own, or a scene (get_scene describes it). openModel is the model the model tools act on.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      execute: () => JSON.stringify(libraryInfo()),
    },
    {
      name: "open",
      title: "Open",
      description:
        "Open a scene of the library (then the scene tools act on it, and the model tools on its stage, if it has one), " +
        "a model on its own (then the model tools act on it), or with no id, the library itself. Not an edit.",
      inputSchema: { type: "object", properties: { id: { type: "string", description: "A scene or model id (or name) from get_library; omit for the library." } } },
      execute: (input: Input) => {
        if (input.id === undefined || input.id === null) {
          scene.openLibrary();
        } else {
          const ref = String(input.id);
          const id =
            scene.scenes.find((s) => s.id === ref || s.name === ref)?.id ??
            scene.models.find((m) => m.id === ref || scene.modelName(m.id) === ref)?.id ??
            fail(`No scene or model ${JSON.stringify(ref)}; get_library lists them`);
          try {
            scene.openResource(id);
          } catch (e) {
            fail((e as Error).message);
          }
        }
        return JSON.stringify(libraryInfo());
      },
    },
    {
      name: "new_scene",
      title: "New scene",
      description: "Add a scene to the library, as one undo step, with one instance of each model given side by side, and open it. Returns its id.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, models: { type: "array", items: { type: "string" }, description: "Model ids or names to place." } },
      },
      execute: (input: Input) => {
        const models = (Array.isArray(input.models) ? input.models : []).map(findModel);
        const id = scene.newScene(typeof input.name === "string" ? input.name : undefined, models) ?? fail(why("Couldn't add the scene"));
        scene.openScene(id);
        return JSON.stringify({ scene: id, undo: scene.undoLabel });
      },
    },
    {
      name: "get_scene",
      title: "Get scene",
      description:
        "The open scene: the library's models (with their markers, for attaching), the instances placed from them with position, rotation (Euler degrees) and scale in world units (one unit is one voxel), what each hangs from, host kinds and their settings, and what is selected.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      execute: () => JSON.stringify(sceneInfo()),
    },
    {
      name: "add_model",
      title: "Add model",
      description:
        "Add a new, empty model to the library, as one undo step (place it in a scene with place_instances). " +
        "With open, it also opens on its own, so the model tools act on it. Returns its id.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          size: { type: "array", items: { type: "integer" }, minItems: 3, maxItems: 3, description: "Its grid size [x, y, z]; defaults to 16 × 16 × 16." },
          open: { type: "boolean", description: "Open it on its own for the model tools. Defaults to false." },
        },
      },
      execute: (input: Input) => {
        const size = (readVec(input.size, "size") ?? [16, 16, 16]).map((n) => Math.max(1, Math.min(256, Math.round(n)))) as Vec3;
        const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : "Untitled";
        const id = scene.addModel(defaultDocument(size, DEFAULT_PALETTE.colors, name));
        if (input.open === true) scene.openModelAlone(id);
        return JSON.stringify({ model: id, ...(input.open === true ? { open: id } : {}), undo: scene.undoLabel });
      },
    },
    {
      name: "place_instances",
      title: "Place instances",
      description:
        "Place instances of models (or of host kinds, or of whole scenes of the library, such as a rig) in the scene, as one undo step. Each needs a model (id or name), a kind, or a scene. A placed scene shows its instances where they are in it, moved by the placing instance; edits to that scene show in every copy. Returns their ids.",
      inputSchema: {
        type: "object",
        properties: {
          instances: {
            type: "array",
            items: {
              type: "object",
              properties: {
                model: { type: "string", description: "A model id or name from get_scene." },
                kind: { type: "string", description: "A host kind from get_scene, for objects without a model." },
                scene: { type: "string", description: "A scene of the library (id or name, from get_library) to place whole; not this scene, nor one that places it." },
                name: { type: "string" },
                ...placementProps,
                settings: { type: "object", description: "A kind's settings this instance changes from its defaults." },
                attach: { type: "object", description: "{ instance, marker? }: what it hangs from (marker: a marker id or name of that instance's model, such as a mount; without one, its origin)." },
              },
            },
          },
        },
        required: ["instances"],
      },
      execute: (input: Input) => {
        const list = Array.isArray(input.instances) ? (input.instances as Input[]) : fail("instances must be a list");
        if (!list.length) fail("instances is empty");
        const ids = scene.transact(list.length === 1 ? "Place" : `Place ${list.length}`, () =>
          list.map((item, n) => {
            const model = item.model !== undefined ? findModel(item.model) : null;
            const kind = typeof item.kind === "string" ? item.kind : undefined;
            const placed =
              item.scene === undefined
                ? undefined
                : ((scene.scenes.find((s) => s.id === item.scene) ?? scene.scenes.find((s) => s.name === item.scene))?.id ??
                  fail(`No scene with id or name ${JSON.stringify(item.scene)}; get_library lists them`));
            if (!model && !kind && !placed) fail(`instance ${n + 1} needs a model, a kind or a scene (group_instances makes groups)`);
            checkSettings(scene, kind, readSettings(item.settings));
            const placement: Placement = {
              position: readVec(item.position, "position"),
              rotation: readVec(item.rotation, "rotation"),
              scale: readScale(item.scale),
            };
            const id = scene.addInstance(model, {
              ...placement,
              ...(typeof item.name === "string" ? { name: item.name } : {}),
              ...(kind ? { kind } : {}),
              ...(placed ? { scene: placed } : {}),
              data: readSettings(item.settings),
              select: false,
            });
            if (!id) fail(`instance ${n + 1}: ${why("it couldn't be placed")}`);
            const attach = readAttach(item.attach);
            if (attach && !scene.attach(id!, attach)) fail(`instance ${n + 1}: ${why("it couldn't be attached")}`);
            return id!;
          }),
        );
        return JSON.stringify({ instances: ids, undo: scene.undoLabel });
      },
    },
    {
      name: "edit_instances",
      title: "Edit instances",
      description:
        "Change instances, as one undo step: set or offset their transform, rename, change or reset settings, attach (keeping their place in the world), set playback, show, hide, lock, or delete.",
      inputSchema: {
        type: "object",
        properties: {
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                instance: { type: "string", description: "An instance id or name." },
                ...placementProps,
                move_by: vec3("An offset in world units."),
                name: { type: "string" },
                settings: { type: "object", description: "Settings to set (null is a value)." },
                reset: { type: "array", items: { type: "string" }, description: "Settings to put back to the kind's default." },
                attach: { type: ["object", "null"], description: "{ instance, marker? }, or null to hang from nothing." },
                playback: { type: ["object", "null"], description: '{ "loop": true, "speed"?, "offset"? } or { "frame": "<id>" }, or null.' },
                visible: { type: "boolean" },
                locked: { type: "boolean" },
                delete: { type: "boolean" },
              },
              required: ["instance"],
            },
          },
        },
        required: ["edits"],
      },
      execute: (input: Input) => {
        const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : fail("edits must be a list");
        scene.transact(edits.length === 1 ? "Edit" : `Edit ${edits.length}`, () => {
          for (const [n, e] of edits.entries()) {
            const id = findInstance(e.instance);
            const where = `edit ${n + 1}`;
            const check = (ok: boolean, what: string) => ok || fail(`${where}: ${why(`couldn't ${what}`)}`);
            if (e.delete) {
              check(scene.deleteInstances([id]), "delete");
              continue;
            }
            if (typeof e.name === "string") check(scene.renameInstance(id, e.name), "rename");
            const placement: Placement = { position: readVec(e.position, "position"), rotation: readVec(e.rotation, "rotation"), scale: readScale(e.scale) };
            if (placement.position || placement.rotation || placement.scale) check(scene.setTransform(id, placement), "move");
            const by = readVec(e.move_by, "move_by");
            if (by) check(scene.moveInstances([id], by), "move");
            const settings = readSettings(e.settings);
            if (settings) {
              checkSettings(scene, scene.instance(id)?.kind, settings);
              check(scene.setData(id, settings), "change settings");
            }
            if (Array.isArray(e.reset)) check(scene.unsetData(id, (e.reset as unknown[]).map(String)), "reset settings");
            const attach = readAttach(e.attach);
            if (attach !== undefined) check(scene.attach(id, attach), "attach");
            const playback = readPlayback(e.playback);
            if (playback !== undefined) check(scene.setPlayback(id, playback), "set playback");
            if (typeof e.visible === "boolean") scene.setVisible(id, e.visible);
            if (typeof e.locked === "boolean") scene.setLocked(id, e.locked);
          }
        });
        return JSON.stringify({ ...sceneInfo(), models: undefined, kinds: undefined });
      },
    },
    {
      name: "select_instances",
      title: "Select instances",
      description: "Select instances by id or name (an empty list clears the selection).",
      inputSchema: { type: "object", properties: { instances: { type: "array", items: { type: "string" } } }, required: ["instances"] },
      execute: (input: Input) => {
        const ids = (Array.isArray(input.instances) ? input.instances : fail("instances must be a list")).map(findInstance);
        scene.select(ids);
        return JSON.stringify({ selection: scene.selection });
      },
    },
    {
      name: "group_instances",
      title: "Group instances",
      description:
        "Put instances (by id or name) in a new group, as one undo step: an empty instance they hang from, at the middle of their floor, so they move, turn and hide together. They keep where they are. Returns the group's id.",
      inputSchema: {
        type: "object",
        properties: { instances: { type: "array", items: { type: "string" } }, name: { type: "string" } },
        required: ["instances"],
      },
      execute: (input: Input) => {
        const ids = (Array.isArray(input.instances) ? input.instances : fail("instances must be a list")).map(findInstance);
        const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : undefined;
        const group = scene.groupInstances(ids, name) ?? fail(why("Couldn't group them"));
        return JSON.stringify({ group, undo: scene.undoLabel });
      },
    },
    {
      name: "ungroup",
      title: "Ungroup",
      description: "Take a group apart, as one undo step: what it held hangs from its parent and stays where it is.",
      inputSchema: { type: "object", properties: { group: { type: "string", description: "A group's id or name." } }, required: ["group"] },
      execute: (input: Input) => {
        const id = findInstance(input.group);
        if (!scene.ungroup(id)) fail(why("Couldn't ungroup it"));
        return JSON.stringify({ selection: scene.selection, undo: scene.undoLabel });
      },
    },
    {
      name: "open_model",
      title: "Open model",
      description:
        "Edit an instance's model in place, with the rest of the scene around it. While it is open, the model tools (get_document, set_voxels, place_shapes, ...) act on it, and every edit is a step in the scene's history. close_model returns to the scene.",
      inputSchema: { type: "object", properties: { instance: { type: "string", description: "An instance id or name." } }, required: ["instance"] },
      execute: (input: Input) => {
        const id = findInstance(input.instance);
        try {
          scene.openModel(id);
        } catch (e) {
          fail((e as Error).message);
        }
        return JSON.stringify({ open: scene.open, model: scene.modelName(scene.open!.model) });
      },
    },
    {
      name: "close_model",
      title: "Close model",
      description: "Stop editing the model opened with open_model, applying anything in progress, and return to the scene.",
      inputSchema: { type: "object", properties: {} },
      execute: () => {
        if (!scene.open) fail("No model is open");
        scene.closeModel();
        return JSON.stringify({ open: null, undo: scene.undoLabel });
      },
    },
    {
      name: "undo_scene",
      title: "Undo",
      description: "Take back the last change to the scene or any model in it.",
      inputSchema: { type: "object", properties: {} },
      execute: () => {
        const label = scene.undoLabel;
        if (!scene.undo()) fail("There is nothing to undo");
        return JSON.stringify({ undid: label, undo: scene.undoLabel, redo: scene.redoLabel });
      },
    },
    {
      name: "redo_scene",
      title: "Redo",
      description: "Put back the last change undone.",
      inputSchema: { type: "object", properties: {} },
      execute: () => {
        const label = scene.redoLabel;
        if (!scene.redo()) fail("There is nothing to redo");
        return JSON.stringify({ redid: label, undo: scene.undoLabel, redo: scene.redoLabel });
      },
    },
  ];
  if (view) {
    tools.push({
      name: "set_scene_view",
      title: "Set view",
      description: "Point the camera: frame the whole scene, or look from a side.",
      inputSchema: { type: "object", properties: { view: { type: "string", enum: ["fit", ...CAMERA_VIEWS] } }, required: ["view"] },
      execute: (input: Input) => {
        if (input.view === "fit") view.fit();
        else if (CAMERA_VIEWS.includes(input.view as CameraView)) view.setView(input.view as CameraView);
        else fail(`view is fit or one of ${CAMERA_VIEWS.join(", ")}`);
        return JSON.stringify({ view: input.view });
      },
    });
  }
  return tools;
}
