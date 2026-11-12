// Library and scene ops: every change to a library (its models, its scenes, its name and primary)
// and to the open scene (instances, stage, ground, host data), as plain data, checked when applied
// and invertible, like document ops (ops.ts). Changes to a model's voxels are that model's
// document ops; a library's history holds both. See docs/library.md and docs/scenes.md.

import { checkJson, isValidId, MAX_ANIMATION_BYTES, MAX_NAME, OpError } from "./ops";
import { isQuat, normalizeQuat, type Quat } from "./scene-math";
import type { KindSnapshot } from "./scene-kinds";
import type { DocumentData, Json, Vec3 } from "./types";

export const MAX_INSTANCES = 2000;
export const MAX_SCENE_MODELS = 256;
/** Voxels a scene embeds across all its models: cells × layers × frames. */
export const MAX_SCENE_CELLS = 64 * 1024 * 1024;
/** Host data a scene keeps (its own and its instances'), as JSON characters. */
export const MAX_SCENE_DATA = 1024 * 1024;
export const MAX_SCALE = 1000;

/** What an instance hangs from: another instance, at one of its model's markers (an id) or its origin. */
export interface Attach {
  instance: string;
  marker: string | null;
}

export type Playback =
  | { kind: "frame"; frame: string }
  | { kind: "loop"; speed: number; offset: number };

export interface Transform {
  position: Vec3;
  rotation: Quat;
  scale: number;
}

export interface InstanceRecord {
  readonly id: string;
  readonly name: string;
  /** A model of the scene; null when the instance's kind supplies its model, or it has none. */
  readonly model: string | null;
  /** A scene of the library placed whole (a rig, a prefab); its model is then null. See docs/pipeline.md. */
  readonly scene?: string;
  readonly kind?: string;
  /** The settings this instance changes from its kind's defaults: a JSON object. */
  readonly data?: { readonly [key: string]: Json };
  readonly parent: Attach | null;
  readonly position: Vec3;
  readonly rotation: Quat;
  /** Uniform; 1 when unset. */
  readonly scale?: number;
  readonly playback?: Playback;
  /** Saved, not undoable, like a layer's. */
  readonly visible: boolean;
  readonly locked: boolean;
  /** Keys a newer app or another host saved on the instance, kept as they are. */
  readonly extra?: { readonly [key: string]: Json };
}

export interface SceneModelRecord {
  readonly id: string;
  /** What the embedded copy was copied from. */
  readonly origin?: { docId: string; revision: number };
  /** A host's name for the model; the embedded document is then its cache. */
  readonly ref?: string;
  /** Made by a kind from settings; the embedded document is then its cache. */
  readonly built?: { kind: string; key: string };
  /** World units per voxel; 1 when unset. */
  readonly voxelSize?: number;
  /** Keys a newer app wrote on the model's entry in the file, kept as they are. */
  readonly extra?: { readonly [key: string]: Json };
}

export interface Ground {
  visible: boolean;
  size: [number, number];
}

export const DEFAULT_GROUND: Ground = { visible: true, size: [64, 64] };

export const MAX_SCENES = 256;

/** A scene as a library holds it: what isn't open, and what is saved. */
export interface SceneRecord {
  readonly id: string;
  readonly name: string;
  readonly ground: Ground;
  /** A model of the library that is always open in this scene, if any. */
  readonly stage: string | null;
  readonly hostData: { readonly [ns: string]: Json };
  readonly instances: readonly InstanceRecord[];
  /** Kinds as the file described them, for kinds no host registered. */
  readonly kinds?: { readonly [id: string]: KindSnapshot };
  /** Keys a newer app saved on the scene, kept as they are. */
  readonly extra?: { readonly [key: string]: Json };
}

/** The scene as ops see it. Models' documents live in their editors; the target adds and drops them. */
export interface SceneTarget {
  readonly name: string;
  readonly ground: Ground;
  readonly stage: string | null;
  readonly hostData: { readonly [ns: string]: Json };
  readonly models: readonly SceneModelRecord[];
  readonly instances: readonly InstanceRecord[];
  setName(name: string): void;
  setGround(ground: Ground): void;
  setStage(stage: string | null): void;
  setHostData(data: { readonly [ns: string]: Json }): void;
  setModels(models: readonly SceneModelRecord[]): void;
  setInstances(instances: readonly InstanceRecord[]): void;
  /** Embed a model's document (it gets an editor). */
  addModelDoc(id: string, doc: DocumentData): void;
  /** Drop a model's document, returning it as it was. */
  removeModelDoc(id: string): DocumentData;
  /** Replace a model's document, returning the one it had. */
  replaceModelDoc(id: string, doc: DocumentData): DocumentData;
  /** The marker ids of a model, or null if there is no such model. */
  modelMarkers(id: string): readonly string[] | null;
  /** Voxels embedded in all models now: cells × layers × frames. */
  readonly embeddedCells: number;
  /** Whether any scene, open or not, places the model or has it as its stage. */
  modelInUse(id: string): boolean;
  /** The library's scenes, in order: the open one as it is now. */
  readonly scenes: readonly { id: string; name: string }[];
  /** The scene these ops change, or null. */
  readonly openScene: string | null;
  /** The scenes a scene places directly (its instances' `scene`s). */
  scenePlaces(id: string): readonly string[];
  readonly libraryName: string;
  readonly primary: string | null;
  /** Add a scene to the library at `index`. */
  addScene(index: number, scene: SceneRecord): void;
  /** Take a scene out of the library, returning it as it was and where it stood. */
  removeScene(id: string): { index: number; scene: SceneRecord };
  setLibraryName(name: string): void;
  setPrimary(id: string | null): void;
}

export type InstanceKey = "name" | "transform" | "attach" | "playback";

export type SceneOp =
  | { t: "instance.add"; index: number; instance: InstanceRecord }
  | { t: "instance.remove"; id: string; index?: number; instance?: InstanceRecord }
  | { t: "instance.set"; id: string; key: InstanceKey; after: unknown; before?: unknown }
  | { t: "instance.order"; id: string; to: number; from?: number }
  | {
      /** Set (or with `unset`, remove) the value at `path` in an instance's settings (`target` its id) or the scene's host data (`target` null, `path[0]` the namespace). */
      t: "data.set";
      target: string | null;
      path: string[];
      after?: Json;
      unset?: boolean;
      before?: { value?: Json; unset: boolean };
    }
  | { t: "model.add"; index: number; model: SceneModelRecord; doc: DocumentData }
  | { t: "model.remove"; id: string; index?: number; model?: SceneModelRecord; doc?: DocumentData }
  | { t: "model.replace"; id: string; doc: DocumentData; before?: DocumentData }
  | { t: "model.set"; id: string; key: "voxelSize" | "origin" | "ref"; after: unknown; before?: unknown }
  | { t: "scene.set"; key: "name" | "stage" | "ground"; after: unknown; before?: unknown }
  | { t: "scenes.add"; index: number; scene: SceneRecord }
  | { t: "scenes.remove"; id: string; index?: number; scene?: SceneRecord }
  | { t: "library.set"; key: "name" | "primary"; after: unknown; before?: unknown };

/** Ops that change the open scene (the rest change the library). A history notes which scene they were in. */
export const isSceneLevel = (op: SceneOp) => op.t.startsWith("instance.") || op.t === "data.set" || op.t === "scene.set";

const fail = (message: string): never => {
  throw new OpError(message);
};

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));

function checkName(name: unknown, what: string): string {
  if (typeof name !== "string") return fail(`${what} must be text`);
  const trimmed = name.trim();
  if (!trimmed) fail(`${what} can't be empty`);
  return trimmed.slice(0, MAX_NAME);
}

export function checkTransform(t: unknown): Transform {
  const v = t as Partial<Transform> | null;
  if (!v || typeof v !== "object") return fail("A transform needs a position, rotation and scale");
  if (!isVec3(v.position)) fail("A position is [x, y, z]");
  if (!isQuat(v.rotation)) fail("A rotation is a quaternion [x, y, z, w]");
  const scale = v.scale ?? 1;
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0 || scale > MAX_SCALE) fail(`Scale must be above 0 and at most ${MAX_SCALE}`);
  return { position: [...v.position!] as Vec3, rotation: normalizeQuat(v.rotation as Quat), scale };
}

export function checkPlayback(p: unknown): Playback | undefined {
  if (p === null || p === undefined) return undefined;
  const v = p as Playback;
  if (v.kind === "frame") {
    if (!isValidId(v.frame)) fail("A held frame needs a frame id");
    return { kind: "frame", frame: v.frame };
  }
  if (v.kind === "loop") {
    const speed = v.speed ?? 1;
    const offset = v.offset ?? 0;
    if (typeof speed !== "number" || !Number.isFinite(speed) || Math.abs(speed) > 16) fail("Playback speed must be from -16 to 16");
    if (typeof offset !== "number" || !Number.isFinite(offset)) fail("A playback offset is in milliseconds");
    return { kind: "loop", speed, offset };
  }
  return fail("Playback is a held frame or a loop");
}

/** Whether `ancestor` is `id` or what it hangs from, at any depth. */
export function isInstanceAncestor(instances: readonly InstanceRecord[], ancestor: string, id: string): boolean {
  const byId = new Map(instances.map((i) => [i.id, i]));
  let at: string | undefined = id;
  for (let n = 0; at && n <= instances.length; n++) {
    if (at === ancestor) return true;
    at = byId.get(at)?.parent?.instance;
  }
  return false;
}

function checkAttach(target: SceneTarget, id: string, parent: unknown, instances = target.instances): Attach | null {
  if (parent === null || parent === undefined) return null;
  const p = parent as Attach & { part?: unknown };
  if (!p || typeof p !== "object" || !isValidId(p.instance)) fail("An attachment names an instance");
  const host = instances.find((i) => i.id === p.instance) ?? fail("That instance was deleted");
  if (isInstanceAncestor(instances, id, p.instance)) fail("An instance can't hang from itself or what hangs from it");
  const markers = host.model ? (target.modelMarkers(host.model) ?? []) : [];
  let marker = p.marker ?? null;
  // older files hung instances from a layer (a part); its pivot opened as a marker of the layer's id
  if (marker === null && typeof p.part === "string") {
    const legacy = `marker:${p.part}`;
    marker = markers.includes(legacy) ? legacy : null;
  }
  if (marker !== null) {
    if (!host.model) fail("That instance has no markers to attach to");
    if (!markers.includes(marker)) fail("That marker was deleted");
  }
  return { instance: p.instance, marker };
}

function checkSettings(data: unknown): { [key: string]: Json } | undefined {
  if (data === undefined || data === null) return undefined;
  const value = checkJson(data);
  if (typeof value !== "object" || Array.isArray(value) || value === null) fail("An instance's settings are a JSON object");
  return Object.keys(value as object).length ? (value as { [key: string]: Json }) : undefined;
}

/** An instance record, checked against the scene it joins. */
export function checkInstance(target: SceneTarget, src: InstanceRecord, instances = target.instances): InstanceRecord {
  if (!src || typeof src !== "object" || !isValidId(src.id)) fail("An instance needs a valid id");
  if (instances.some((i) => i.id === src.id)) fail("That instance already exists");
  if (src.model !== null && !target.models.some((m) => m.id === src.model)) fail("That model isn't in the scene");
  if (src.kind !== undefined && !isValidId(src.kind)) fail("A kind needs a valid id");
  if (src.scene !== undefined) {
    if (src.model !== null) fail("An instance places a model or a scene, not both");
    if (src.kind !== undefined) fail("A placed scene can't have a kind");
    if (!target.scenes.some((s) => s.id === src.scene)) fail("That scene was deleted");
    if (target.openScene && sceneReaches(target, src.scene, target.openScene)) {
      fail("A scene can't be placed in itself, or in a scene it places");
    }
  }
  const transform = checkTransform(src);
  const playback = src.model === null ? undefined : checkPlayback(src.playback);
  const data = checkSettings(src.data);
  return {
    id: src.id,
    name: checkName(src.name, "An instance's name"),
    model: src.model,
    ...(src.scene !== undefined ? { scene: src.scene } : {}),
    ...(src.kind !== undefined ? { kind: src.kind } : {}),
    ...(data ? { data } : {}),
    parent: checkAttach(target, src.id, src.parent, instances),
    position: transform.position,
    rotation: transform.rotation,
    ...(transform.scale !== 1 ? { scale: transform.scale } : {}),
    ...(playback ? { playback } : {}),
    visible: src.visible !== false,
    locked: !!src.locked,
    ...(src.extra && typeof src.extra === "object" ? { extra: checkJson(src.extra) as { [key: string]: Json } } : {}),
  };
}

/** Whether scene `from` is `to`, or places it at any depth. */
export function sceneReaches(target: Pick<SceneTarget, "scenePlaces">, from: string, to: string): boolean {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const at = queue.pop()!;
    if (at === to) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    queue.push(...target.scenePlaces(at));
  }
  return false;
}

function findInstance(target: SceneTarget, id: string) {
  const index = target.instances.findIndex((i) => i.id === id);
  if (index < 0) fail("That instance was deleted");
  return { instance: target.instances[index], index };
}

function replaceInstance(target: SceneTarget, id: string, next: InstanceRecord) {
  target.setInstances(target.instances.map((i) => (i.id === id ? next : i)));
}

/** Cells × layers × frames a document embeds. */
export function documentCells(doc: DocumentData): number {
  const cells = doc.size[0] * doc.size[1] * doc.size[2];
  const rasters = doc.layers.filter((l) => !l.shape).length;
  return cells * rasters * Math.max(1, doc.frames?.length ?? 1);
}

function checkModelRecord(target: SceneTarget, m: SceneModelRecord): SceneModelRecord {
  if (!m || !isValidId(m.id)) fail("A model needs a valid id");
  const voxelSize = m.voxelSize ?? 1;
  if (typeof voxelSize !== "number" || !Number.isFinite(voxelSize) || voxelSize <= 0 || voxelSize > MAX_SCALE) {
    fail(`A voxel size must be above 0 and at most ${MAX_SCALE}`);
  }
  if (m.ref !== undefined && (typeof m.ref !== "string" || !m.ref || m.ref.length > 1024)) fail("A model ref is a name");
  if (m.origin !== undefined && (!isValidId(m.origin.docId) || !Number.isInteger(m.origin.revision))) fail("A model's origin is malformed");
  if (m.built !== undefined && (!isValidId(m.built.kind) || typeof m.built.key !== "string")) fail("A built model's key is malformed");
  void target;
  return {
    id: m.id,
    ...(m.origin ? { origin: { docId: m.origin.docId, revision: m.origin.revision } } : {}),
    ...(m.ref !== undefined ? { ref: m.ref } : {}),
    ...(m.built ? { built: { kind: m.built.kind, key: m.built.key } } : {}),
    ...(voxelSize !== 1 ? { voxelSize } : {}),
  };
}

/** Read the value at `path` in a JSON object, or report it unset. */
function readPath(root: Json | undefined, path: readonly string[]): { value?: Json; unset: boolean } {
  let at: Json | undefined = root;
  for (const key of path) {
    if (!at || typeof at !== "object" || Array.isArray(at) || !(key in at)) return { unset: true };
    at = (at as { [k: string]: Json })[key];
  }
  return at === undefined ? { unset: true } : { value: at, unset: false };
}

/** A copy of `root` with the value at `path` set, or removed (and empty objects on the way pruned). */
function writePath(root: Json | undefined, path: readonly string[], value: Json | undefined): Json | undefined {
  if (!path.length) return value;
  const obj = root && typeof root === "object" && !Array.isArray(root) ? { ...(root as { [k: string]: Json }) } : {};
  const [key, ...rest] = path;
  const next = writePath(obj[key], rest, value);
  if (next === undefined) delete obj[key];
  else obj[key] = next;
  return Object.keys(obj).length ? obj : undefined;
}

function checkPath(path: unknown, scene: boolean): string[] {
  if (!Array.isArray(path) || path.length > 32 || !path.every((k) => typeof k === "string" && k.length > 0 && k.length <= MAX_NAME)) {
    fail("A data path is a list of keys");
  }
  if (scene && !(path as string[]).length) fail("Scene data needs a namespace");
  return path as string[];
}

function dataSize(target: SceneTarget, instances = target.instances, hostData = target.hostData): number {
  let size = JSON.stringify(hostData).length;
  for (const i of instances) if (i.data) size += JSON.stringify(i.data).length;
  return size;
}

function checkDataBudget(target: SceneTarget, instances?: readonly InstanceRecord[], hostData?: { readonly [ns: string]: Json }) {
  if (dataSize(target, instances, hostData) > MAX_SCENE_DATA) fail(`A scene's settings can be at most ${MAX_SCENE_DATA / 1024 / 1024} MiB in all`);
}

/** Apply a scene op: check it, fill in what it replaced, change the scene. Throws an `OpError`, changing nothing, if it doesn't fit. */
export function applySceneOp(target: SceneTarget, op: SceneOp): void {
  switch (op.t) {
    case "instance.add": {
      if (target.instances.length >= MAX_INSTANCES) fail(`A scene can have at most ${MAX_INSTANCES} instances`);
      const instance = checkInstance(target, op.instance);
      if (!Number.isInteger(op.index)) fail("An instance position must be a whole number");
      const index = Math.max(0, Math.min(target.instances.length, op.index));
      const next = [...target.instances];
      next.splice(index, 0, instance);
      if (instance.data) checkDataBudget(target, next);
      op.instance = instance;
      target.setInstances(next);
      return;
    }
    case "instance.remove": {
      const { instance, index } = findInstance(target, op.id);
      if (target.instances.some((i) => i.parent?.instance === op.id)) fail("Instances still hang from that one");
      op.index = index;
      op.instance = instance;
      target.setInstances(target.instances.filter((i) => i.id !== op.id));
      return;
    }
    case "instance.set": {
      const { instance } = findInstance(target, op.id);
      let next: InstanceRecord;
      switch (op.key) {
        case "name":
          op.before = instance.name;
          op.after = checkName(op.after, "An instance's name");
          next = { ...instance, name: op.after as string };
          break;
        case "transform": {
          const t = checkTransform(op.after);
          op.before = transformOf(instance);
          op.after = t;
          next = withTransform(instance, t);
          break;
        }
        case "attach": {
          const v = op.after as { parent: Attach | null } & Transform;
          if (!v || typeof v !== "object") fail("An attachment needs a parent and a transform");
          const parent = checkAttach(target, op.id, v.parent);
          const t = checkTransform(v);
          op.before = { parent: instance.parent, ...transformOf(instance) };
          op.after = { parent, ...t };
          next = { ...withTransform(instance, t), parent };
          break;
        }
        case "playback": {
          if (instance.model === null) fail("Only an instance of a model plays");
          const playback = checkPlayback(op.after);
          op.before = instance.playback ?? null;
          op.after = playback ?? null;
          const { playback: _, ...rest } = instance;
          next = playback ? { ...rest, playback } : rest;
          break;
        }
        default:
          return fail(`Instances have no ${String((op as { key: unknown }).key)}`);
      }
      replaceInstance(target, op.id, next);
      return;
    }
    case "instance.order": {
      const { instance, index } = findInstance(target, op.id);
      if (!Number.isInteger(op.to)) fail("An instance position must be a whole number");
      const to = Math.max(0, Math.min(target.instances.length - 1, op.to));
      op.from = index;
      if (to === index) return;
      const next = target.instances.filter((i) => i.id !== op.id);
      next.splice(to, 0, instance);
      target.setInstances(next);
      return;
    }
    case "data.set": {
      const scene = op.target === null;
      const path = checkPath(op.path, scene);
      const value = op.unset ? undefined : checkJson(op.after === undefined ? null : op.after);
      if (scene) {
        const before = readPath(target.hostData as Json, path);
        const next = (writePath(target.hostData as Json, path, value) ?? {}) as { [ns: string]: Json };
        checkDataBudget(target, undefined, next);
        op.before = before;
        target.setHostData(next);
        return;
      }
      const { instance } = findInstance(target, op.target as string);
      const before = readPath(instance.data as Json | undefined, path);
      const data = writePath(instance.data as Json | undefined, path, value);
      if (data !== undefined && (typeof data !== "object" || Array.isArray(data) || data === null)) fail("An instance's settings are a JSON object");
      const { data: _, ...rest } = instance;
      const next: InstanceRecord = data ? { ...rest, data: data as { [key: string]: Json } } : rest;
      const instances = target.instances.map((i) => (i.id === instance.id ? next : i));
      checkDataBudget(target, instances);
      op.before = before;
      target.setInstances(instances);
      return;
    }
    case "model.add": {
      if (target.models.length >= MAX_SCENE_MODELS) fail(`A scene can have at most ${MAX_SCENE_MODELS} models`);
      if (target.models.some((m) => m.id === op.model?.id)) fail("That model is already in the scene");
      const model = checkModelRecord(target, op.model);
      if (!op.doc || !Array.isArray(op.doc.layers)) fail("A model needs a document");
      if (target.embeddedCells + documentCells(op.doc) > Math.min(MAX_SCENE_CELLS, MAX_ANIMATION_BYTES)) {
        fail("The scene is too big to hold another model");
      }
      if (!Number.isInteger(op.index)) fail("A model position must be a whole number");
      const index = Math.max(0, Math.min(target.models.length, op.index));
      target.addModelDoc(model.id, op.doc);
      const next = [...target.models];
      next.splice(index, 0, model);
      op.model = model;
      target.setModels(next);
      return;
    }
    case "model.remove": {
      const index = target.models.findIndex((m) => m.id === op.id);
      if (index < 0) fail("That model was deleted");
      if (target.modelInUse(op.id)) fail("A scene still uses that model");
      if (target.primary === op.id) fail("That model is the library's primary");
      op.index = index;
      op.model = target.models[index];
      op.doc = target.removeModelDoc(op.id);
      target.setModels(target.models.filter((m) => m.id !== op.id));
      return;
    }
    case "model.replace": {
      if (!target.models.some((m) => m.id === op.id)) fail("That model was deleted");
      if (!op.doc || !Array.isArray(op.doc.layers)) fail("A model needs a document");
      const cells = target.embeddedCells;
      op.before = target.replaceModelDoc(op.id, op.doc);
      if (target.embeddedCells > MAX_SCENE_CELLS && target.embeddedCells > cells) {
        target.replaceModelDoc(op.id, op.before);
        fail("The scene is too big for that model");
      }
      // markers that went away leave what hung from them at the model's origin
      return;
    }
    case "model.set": {
      const model = target.models.find((m) => m.id === op.id) ?? fail("That model was deleted");
      const before = model[op.key] ?? null;
      const checked = checkModelRecord(target, { ...model, [op.key]: op.after === null ? undefined : op.after });
      op.before = before;
      op.after = checked[op.key] ?? null;
      target.setModels(target.models.map((m) => (m.id === op.id ? checked : m)));
      return;
    }
    case "scene.set": {
      switch (op.key) {
        case "name":
          op.before = target.name;
          op.after = checkName(op.after, "A scene's name");
          target.setName(op.after as string);
          return;
        case "stage": {
          const stage = op.after === null ? null : (op.after as string);
          if (stage !== null && !target.models.some((m) => m.id === stage)) fail("That model isn't in the scene");
          op.before = target.stage;
          target.setStage(stage);
          return;
        }
        case "ground": {
          const g = op.after as Ground;
          if (!g || typeof g.visible !== "boolean" || !Array.isArray(g.size) || g.size.length !== 2 || !g.size.every((n) => Number.isInteger(n) && n >= 1 && n <= 4096)) {
            fail("A ground has a visibility and a size from 1 to 4096");
          }
          op.before = { ...target.ground };
          target.setGround({ visible: g.visible, size: [g.size[0], g.size[1]] });
          return;
        }
      }
      return fail(`Scenes have no ${String((op as { key: unknown }).key)}`);
    }
    case "scenes.add": {
      const scene = op.scene;
      if (!scene || !isValidId(scene.id)) fail("A scene needs a valid id");
      if (target.scenes.some((s) => s.id === scene.id)) fail("That scene already exists");
      if (target.scenes.length >= MAX_SCENES) fail(`A library holds at most ${MAX_SCENES} scenes`);
      checkName(scene.name, "A scene's name");
      for (const inst of scene.instances) if (inst.model !== null && !target.models.some((m) => m.id === inst.model)) fail("That scene places a model the library doesn't have");
      if (scene.stage !== null && !target.models.some((m) => m.id === scene.stage)) fail("That scene's stage isn't in the library");
      target.addScene(Math.max(0, Math.min(target.scenes.length, op.index)), scene);
      return;
    }
    case "scenes.remove": {
      if (!target.scenes.some((s) => s.id === op.id)) fail("That scene was deleted");
      if (target.primary === op.id) fail("That scene is the library's primary");
      const { index, scene } = target.removeScene(op.id);
      op.index = index;
      op.scene = scene;
      return;
    }
    case "library.set": {
      if (op.key === "name") {
        op.before = target.libraryName;
        op.after = checkName(op.after, "A library's name");
        target.setLibraryName(op.after as string);
        return;
      }
      if (op.key === "primary") {
        const id = op.after === null ? null : (op.after as string);
        if (id !== null && !target.models.some((m) => m.id === id) && !target.scenes.some((s) => s.id === id)) fail("That isn't in the library");
        op.before = target.primary;
        target.setPrimary(id);
        return;
      }
      return fail(`Libraries have no ${String((op as { key: unknown }).key)}`);
    }
    default:
      fail(`Unknown scene edit ${(op as { t: unknown }).t}`);
  }
}

/** The op that takes `op` back. `op` must have been applied. */
export function invertSceneOp(op: SceneOp): SceneOp {
  const never = (): never => fail("That edit was never applied");
  switch (op.t) {
    case "instance.add":
      return { t: "instance.remove", id: op.instance.id };
    case "instance.remove":
      return { t: "instance.add", index: op.index ?? never(), instance: op.instance ?? never() };
    case "instance.set":
      return { t: "instance.set", id: op.id, key: op.key, after: op.before === undefined ? never() : op.before, before: op.after };
    case "instance.order":
      return { t: "instance.order", id: op.id, to: op.from ?? never() };
    case "data.set": {
      const before = op.before ?? never();
      return { t: "data.set", target: op.target, path: op.path, ...(before.unset ? { unset: true } : { after: before.value }) };
    }
    case "model.add":
      return { t: "model.remove", id: op.model.id };
    case "model.remove":
      return { t: "model.add", index: op.index ?? never(), model: op.model ?? never(), doc: op.doc ?? never() };
    case "model.replace":
      return { t: "model.replace", id: op.id, doc: op.before ?? never(), before: op.doc };
    case "model.set":
      return { t: "model.set", id: op.id, key: op.key, after: op.before === undefined ? never() : op.before, before: op.after };
    case "scene.set":
      return { t: "scene.set", key: op.key, after: op.before === undefined ? never() : op.before, before: op.after };
    case "scenes.add":
      return { t: "scenes.remove", id: op.scene.id };
    case "scenes.remove":
      return { t: "scenes.add", index: op.index ?? never(), scene: op.scene ?? never() };
    case "library.set":
      return { t: "library.set", key: op.key, after: op.before === undefined ? never() : op.before, before: op.after };
  }
}

export function transformOf(i: InstanceRecord): Transform {
  return { position: [...i.position] as Vec3, rotation: [...i.rotation] as Quat, scale: i.scale ?? 1 };
}

function withTransform(i: InstanceRecord, t: Transform): InstanceRecord {
  const { scale: _, ...rest } = i;
  return { ...rest, position: t.position, rotation: t.rotation, ...(t.scale !== 1 ? { scale: t.scale } : {}) };
}
