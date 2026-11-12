// Libraries: `.voxeltoy` version 4, a library's models and scenes in one JSON file (docs/library.md).
// Older `.moxel` files, and `"format": "moxel"`, still open.
//
//   { "format": "voxeltoy", "version": 4, "docId", "revision", "name", "primary", "data",
//     "models": [{ "id", "origin", "ref", "built", "voxelSize",
//                  "model": { ...a version 1 to 3 file: "format": "voxeltoy", "version", "name", ... } }],
//     "scenes": [{ "id", "name", "ground", "stage", "kinds", "data",
//                  "instances": [{ "id", "name", "model", "kind", "data", "parent",
//                                  "position", "rotation", "scale", "playback", "visible", "locked" }] }] }
//
// Each model is an ordinary single-model file, so one taken out of a library opens anywhere.
// Versions 1 to 3 (one model each) read as a library of that model, its primary. Unknown keys at
// the top, on scenes and on instances are kept, so a library passed through an app that doesn't
// know them comes out intact.

import { checkJson, isValidId } from "../ops";
import type { KindSnapshot } from "../scene-kinds";
import { documentCells, MAX_INSTANCES, MAX_SCENE_CELLS, MAX_SCENE_MODELS, MAX_SCENES, type InstanceRecord, type SceneModelRecord, type SceneRecord } from "../scene-ops";
import type { DocumentData, Json } from "../types";
import { FORMAT, isNativeFormat, moxelObject, parseMoxelObject } from "./moxel";

/** A whole library, independent of editor state: what `.voxeltoy` files hold (version 4). */
export interface LibraryDocument {
  docId?: string;
  revision?: number;
  name: string;
  /** The model or scene that opens first, if any. */
  primary?: string | null;
  models: { record: SceneModelRecord; doc: DocumentData }[];
  scenes: SceneRecord[];
  hostData?: { [ns: string]: Json };
  /** Unknown top-level keys from the file, kept as they are. */
  extra?: { [key: string]: Json };
}

/** A library holding one model, as its primary: what an older single-model file opens as. */
export function libraryOf(doc: DocumentData, id = "model:main"): LibraryDocument {
  return { name: doc.name || "Untitled", primary: id, models: [{ record: { id }, doc }], scenes: [] };
}

export const LIBRARY_VERSION = 4;

const TOP_KEYS = new Set(["format", "version", "docId", "revision", "name", "primary", "data", "models", "scenes"]);
const MODEL_KEYS = new Set(["id", "origin", "ref", "built", "voxelSize", "model"]);
const SCENE_KEYS = new Set(["id", "name", "ground", "stage", "kinds", "data", "instances"]);
const INSTANCE_KEYS = new Set(["id", "name", "model", "scene", "kind", "data", "parent", "position", "rotation", "scale", "playback", "visible", "locked", "extra"]);

/** A library as a `.voxeltoy` file (version 4). */
export function serializeLibrary(doc: LibraryDocument): string {
  const out: Record<string, unknown> = {};
  if (doc.extra) for (const [k, v] of Object.entries(doc.extra)) if (!TOP_KEYS.has(k)) out[k] = v;
  Object.assign(out, {
    format: FORMAT,
    version: LIBRARY_VERSION,
    ...(doc.docId ? { docId: doc.docId } : {}),
    ...(doc.revision !== undefined ? { revision: doc.revision } : {}),
    name: doc.name,
    ...(doc.primary ? { primary: doc.primary } : {}),
    ...(doc.hostData && Object.keys(doc.hostData).length ? { data: doc.hostData } : {}),
    models: doc.models.map(({ record, doc: model }) => {
      const { extra: kept, ...fields } = record;
      return { ...(kept ?? {}), ...fields, model: moxelObject(model) };
    }),
    scenes: doc.scenes.map((scene) => {
      const { extra, hostData, kinds, instances, ...rest } = scene;
      return {
        ...(extra ?? {}),
        ...rest,
        ...(kinds && Object.keys(kinds).length ? { kinds } : {}),
        ...(Object.keys(hostData).length ? { data: hostData } : {}),
        instances: instances.map((i) => {
          const { extra: kept, ...fields } = i;
          return { ...(kept ?? {}), ...fields };
        }),
      };
    }),
  });
  return JSON.stringify(out);
}

/**
 * A native library file, read as a library: version 4 as it is, versions 1 to 3 as a library holding
 * that model as its primary. Throws an Error with a reason if it isn't one or is damaged;
 * `LibraryEditor.loadLibrary` checks the rest (references, loops).
 */
export function parseLibrary(text: string): LibraryDocument {
  let file: Record<string, unknown>;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error("Not a Voxeltoy file");
  }
  if (!file || typeof file !== "object" || !isNativeFormat(file.format)) throw new Error("Not a Voxeltoy file");
  if (file.version !== LIBRARY_VERSION) {
    if (typeof file.version === "number" && file.version > LIBRARY_VERSION) throw new Error(`This file was made by a newer Voxeltoy (version ${file.version})`);
    return libraryOf(parseMoxelObject(file));
  }
  const bad = (why: string): never => {
    throw new Error(`This Voxeltoy file is damaged: ${why}`);
  };
  const models = Array.isArray(file.models) ? (file.models as Record<string, unknown>[]) : bad("its models are malformed");
  const scenes = Array.isArray(file.scenes) ? (file.scenes as Record<string, unknown>[]) : bad("its scenes are malformed");
  if (models.length > MAX_SCENE_MODELS) bad(`it has more than ${MAX_SCENE_MODELS} models`);
  if (scenes.length > MAX_SCENES) bad(`it has more than ${MAX_SCENES} scenes`);

  const json = <T>(value: unknown): T => {
    try {
      return checkJson(value) as T;
    } catch (e) {
      return bad((e as Error).message);
    }
  };
  const keep = (from: Record<string, unknown>, known: Set<string>) => {
    let kept: { [key: string]: Json } | undefined;
    for (const [k, v] of Object.entries(from)) if (!known.has(k) && v !== undefined) (kept ??= {})[k] = json<Json>(v);
    return kept;
  };
  let cells = 0;
  const parsedModels = models.map((m, n) => {
    if (!m || typeof m !== "object" || !isValidId(m.id)) bad(`model ${n + 1} has no valid id`);
    if (!m.model || typeof m.model !== "object") bad(`model ${n + 1} has no voxels`);
    let doc;
    try {
      doc = parseMoxelObject(m.model as Record<string, unknown>);
    } catch (e) {
      return bad(`model ${n + 1}: ${(e as Error).message}`);
    }
    cells += documentCells(doc);
    if (cells > MAX_SCENE_CELLS) bad("its models are too big to open");
    const record: Record<string, unknown> = {};
    for (const k of MODEL_KEYS) if (k !== "model" && m[k] !== undefined) record[k] = m[k];
    const kept = keep(m, MODEL_KEYS);
    if (kept) record.extra = kept;
    return { record: record as unknown as SceneModelRecord, doc };
  });

  const parsedScenes: SceneRecord[] = scenes.map((sc, n) => {
    if (!sc || typeof sc !== "object" || !isValidId(sc.id)) bad(`scene ${n + 1} has no valid id`);
    const instances = Array.isArray(sc.instances) ? (sc.instances as Record<string, unknown>[]) : bad(`scene ${n + 1}'s instances are malformed`);
    if (instances.length > MAX_INSTANCES) bad(`scene ${n + 1} has more than ${MAX_INSTANCES} instances`);
    const hostData = sc.data !== undefined && sc.data !== null ? json<{ [ns: string]: Json }>(sc.data) : {};
    if (typeof hostData !== "object" || Array.isArray(hostData)) bad(`scene ${n + 1}'s data must be an object`);
    const kinds = sc.kinds !== undefined && sc.kinds !== null ? json<{ [id: string]: KindSnapshot }>(sc.kinds) : undefined;
    const extra = keep(sc, SCENE_KEYS);
    return {
      id: sc.id as string,
      name: typeof sc.name === "string" && sc.name.trim() ? sc.name : "Scene",
      ground: sc.ground as SceneRecord["ground"],
      stage: typeof sc.stage === "string" ? sc.stage : null,
      hostData,
      ...(kinds ? { kinds } : {}),
      ...(extra ? { extra } : {}),
      instances: instances.map((i) => {
        if (!i || typeof i !== "object") return bad("an instance is malformed");
        const kept = keep(i, INSTANCE_KEYS);
        return { ...(i as unknown as InstanceRecord), ...(kept ? { extra: kept } : {}) };
      }),
    };
  });

  const hostData = file.data !== undefined && file.data !== null ? json<{ [ns: string]: Json }>(file.data) : undefined;
  if (hostData && (typeof hostData !== "object" || Array.isArray(hostData))) bad("its data must be an object");
  const extra = keep(file, TOP_KEYS);
  return {
    ...(typeof file.docId === "string" && isValidId(file.docId) ? { docId: file.docId } : {}),
    ...(Number.isInteger(file.revision) ? { revision: file.revision as number } : {}),
    name: typeof file.name === "string" && file.name.trim() ? file.name : "Untitled",
    ...(typeof file.primary === "string" ? { primary: file.primary } : {}),
    ...(hostData ? { hostData } : {}),
    ...(extra ? { extra } : {}),
    models: parsedModels,
    scenes: parsedScenes,
  };
}
