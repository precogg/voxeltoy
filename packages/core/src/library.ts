// The headless library editor: a library's models and scenes (instances of its models placed
// freely in space), one of them open at a time, one undo history across all of it, and host
// kinds with settings. DOM-free, like Editor. See docs/library.md and docs/scenes.md.

import { batch, createSignal, untrack } from "solid-js";
import { VoxelClipboard } from "./clipboard";
import { defaultDocument, VoxelDocument } from "./document";
import { Editor, type EditorOptions, type HistoryHost } from "./editor";

import { entryOf, type Entry, type LocalChange } from "./history";

import { isValidId, OpError, randomId } from "./ops";
import { DEFAULT_PALETTE } from "./palette";
import { frameAt, ticksToMs, totalTicks } from "./animation";
import { markerAt, markerCenter, markerRotation, originCells } from "./markers";
import {
  decomposeMat,
  eulerFromQuat,
  IDENTITY_QUAT,
  invertMat,
  matFromTransform,
  multiplyMat,
  normalizeQuat,
  quatFromEuler,
  transformDirection,
  transformPoint,
  translationMat,
  type Mat4,
  type Quat,
} from "./scene-math";
import { resolveSettings, type InstanceKind, type KindSnapshot } from "./scene-kinds";
import {
  applySceneOp,
  checkInstance,
  checkTransform,
  DEFAULT_GROUND,
  documentCells,
  invertSceneOp,
  transformOf,
  type Attach,
  type Ground,
  type InstanceRecord,
  type Playback,
  isSceneLevel,
  type SceneModelRecord,
  type SceneOp,
  type SceneRecord,
  type SceneTarget,
  type Transform,
} from "./scene-ops";
import { raycastVolume } from "./raycast";
import type { Box, DocumentData, Json, Ray, Vec3 } from "./types";


// what a library is as data lives with its file format, so reading a file needs no editor
import { libraryOf, type LibraryDocument } from "./formats/library";
export { libraryOf, type LibraryDocument };

/** An empty scene, ready for `scenes.add`. */
function emptyScene(id: string, name: string): SceneRecord {
  return { id, name, ground: { ...DEFAULT_GROUND, size: [...DEFAULT_GROUND.size] }, stage: null, hostData: {}, instances: [] };
}

/** Where a library is: the library itself, a model on its own, or a scene (and a model gone into from it). */
export type LibraryView = "library" | "model" | "scene";

/** A built model's cache key: its settings, with keys in order so equal settings give equal keys. */
function builtKey(settings: Json): string {
  const sort = (v: Json): Json =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as { [k: string]: Json })[k])]))
      : Array.isArray(v)
        ? v.map(sort)
        : v;
  return JSON.stringify(sort(settings));
}


/**
 * A step of a library's undo entry: a library or scene op (`in` the scene it changed, for scene
 * ops), an entry of one model's editor, or a local change.
 */
export type ScenePart = { scene: SceneOp; in?: string } | { model: string; entry: Entry } | { local: LocalChange };

export interface SceneEntry {
  id: string;
  label: string;
  parts: ScenePart[];
}

/** A change made here, for hosts that follow edits: scene ops and the model edits alongside them. */
export interface SceneEdit {
  label: string;
  scene: SceneOp[];
  models: { model: string; entry: Entry }[];
}

/** How dragging and steppers snap. UI state: not saved, not undoable. */
export interface SceneSnap {
  /** A step in world units (the stage's voxel, or a fraction of one), or null for none. */
  step: number | null;
  /** Rotation steps in degrees, or null for free rotation. */
  angle: number | null;
  /** Drop dragged instances on the surface under the pointer. */
  surfaces: boolean;
}

/** Where an instance goes, as callers give it: rotation in Euler degrees [x, y, z] or a quaternion. */
export interface Placement {
  position?: Vec3;
  rotation?: Vec3 | Quat;
  scale?: number;
}

/**
 * What a host does for a scene's linked models: models it keeps under its own names (`ref`),
 * such as a spike model every level shares. See docs/scenes.md ("Embedded now, linked later").
 */
export interface SceneHostHooks {
  /** The document for a model ref. May be async; the scene shows the instance once it arrives. */
  resolveModel?(ref: string): DocumentData | Promise<DocumentData>;
  /** A linked model changed here (an edit, undo or redo): keep the host's copy in step. */
  saveModel?(ref: string, doc: DocumentData): void;
}

/** A hit on something that can be stood on: stage voxels, another instance, or the ground. */
export interface SurfaceHit {
  point: Vec3;
  normal: Vec3;
  /** The instance hit, or null for the stage or the ground. */
  instance: string | null;
  distance: number;
}

export interface LibraryEditorOptions {
  /** Options for the editor of every model in the library (custom tools, a clipboard, ...). */
  editorOptions?: Omit<EditorOptions, "history">;
  /**
   * Options for one model's editor on top of those: a host's tools and placing rules for its
   * level, say, that mean nothing in the objects placed on it. Asked when the editor is made.
   */
  modelEditorOptions?: (model: string, library: LibraryEditor) => Omit<EditorOptions, "history" | "document"> | undefined;
}

const MAX_ENTRIES = 200;
/** Roughly what a history may hold, in bytes, before its oldest entries go. */
const MAX_HISTORY_BYTES = 256 * 1024 * 1024;

function signal<T>(value: T) {
  const [get, set] = createSignal<T>(value, { equals: false });
  return { get, set: (v: T) => set(() => v) };
}

/** A rough size of an entry, for the history's byte budget. */
function entryBytes(entry: SceneEntry): number {
  let n = 64;
  for (const part of entry.parts) {
    if ("scene" in part) {
      const op = part.scene;
      n += op.t === "model.add" || op.t === "model.remove" || op.t === "model.replace" ? documentCells((op as { doc?: DocumentData }).doc ?? { size: [0, 0, 0], layers: [], palette: [], name: "", activeLayer: 0 }) : 128;
    } else if ("model" in part) {
      for (const item of part.entry.items) {
        if (!("op" in item)) continue;
        const op = item.op;
        if (op.t === "voxels") n += op.cells.byteLength + op.before.length + op.after.length;
        else if (op.t === "layer.add") n += op.layer.data?.length ?? 64;
        else if (op.t === "layer.remove") n += op.layer?.data.length ?? 64;
        else n += 128;
      }
    }
  }
  return n;
}

const toQuat = (r: Vec3 | Quat): Quat => (r.length === 4 ? normalizeQuat(r as Quat) : quatFromEuler(r as Vec3));

/** One model a placed scene draws (see `LibraryEditor.placedContents`). */
export interface PlacedContent {
  /** Instance ids from the placing instance down; "stage" for a placed scene's stage. */
  readonly path: readonly string[];
  readonly model: string;
  readonly frame: string;
  /** Grid cells of the model to world units. */
  readonly matrix: Mat4;
  /** Whether it loops an animated model, so the scene's clock needs to run. */
  readonly loops: boolean;
}

/**
 * The headless library editor. Owns the library's models (an Editor for each one being edited)
 * and scenes, what is open, the open scene's instance selection, and one undo history for all of
 * it. Scene methods (`instances`, `addInstance`, ...) act on the open scene. State is read
 * through reactive getters; changes go through methods.
 *
 *   const library = new LibraryEditor()
 *   const knight = library.addModel(doc)
 *   library.openScene(library.newScene("Check"))
 *   const a = library.addInstance(knight, { position: [4, 0, 2], rotation: [0, 90, 0] })
 *   library.editor(knight).setVoxel([0, 0, 0], 3)   // on the library's history
 *   library.undo()
 */
export class LibraryEditor {
  private _libraryName = signal("Untitled");
  private _primary = signal<string | null>(null);
  /** The scenes in order; the open one's record is stale while it is open (its state is in the signals below). */
  private _sceneIds = signal<readonly string[]>([]);
  private sceneStore = new Map<string, SceneRecord>();
  /** The open scene, if any. Its state is the signals below. */
  private _scene = signal<string | null>(null);
  /** A model open on its own (not gone into from a scene), if any. */
  private _alone = signal<string | null>(null);
  private _name = signal("Scene");
  private _ground = signal<Ground>({ ...DEFAULT_GROUND, size: [...DEFAULT_GROUND.size] });
  private _stage = signal<string | null>(null);
  private _hostData = signal<{ readonly [ns: string]: Json }>({});
  private _models = signal<readonly SceneModelRecord[]>([]);
  private _instances = signal<readonly InstanceRecord[]>([]);
  private _selection = signal<readonly string[]>([]);
  private _snap = signal<SceneSnap>({ step: 1, angle: 90, surfaces: true });
  private _toast = signal<{ message: string; id: number } | null>(null);
  private _version = signal(0);
  private _historyVersion = signal(0);
  private _kinds = signal<ReadonlyMap<string, InstanceKind>>(new Map());
  private _open = signal<{ instance: string; model: string } | null>(null);
  /** The models host kinds supply for instances without their own: instance id to model id. */
  private _supplied = signal<ReadonlyMap<string, string>>(new Map());
  private hooks: SceneHostHooks = {};
  /** Refs being fetched from the host, so each is asked for once. */
  private resolving = new Set<string>();

  private docId = randomId("lib:");
  private _revision = 0;
  /** The open scene's kinds as the loaded file described them, for kinds no host registered here. */
  private savedKinds: { [id: string]: KindSnapshot } = {};
  private sceneExtra: { [key: string]: Json } | undefined;
  private savedExtra: { [key: string]: Json } | undefined;
  private _libraryData = signal<{ readonly [ns: string]: Json }>({});
  /** Each authored model's document: the models in `models`, which history and ops change. */
  private docs = new Map<string, VoxelDocument>();
  /**
   * Models host kinds supply from settings: built from them, or linked by the host's ref. A cache,
   * kept apart from `models`: never in history or ops, saved so a scene shows them without its host.
   */
  private _derived = signal<ReadonlyMap<string, { record: SceneModelRecord; doc: VoxelDocument }>>(new Map());
  /** Editing sessions, only for models being edited: opened in place, the stage, or asked for by a script. */
  private sessions = new Map<string, Editor>();
  private modelOf = new Map<Editor, string>();
  private undos: SceneEntry[] = [];
  private redos: SceneEntry[] = [];
  private tx: { label: string; parts: ScenePart[] } | null = null;
  private stroke: { label: string; parts: ScenePart[] } | null = null;
  private stepping = false;
  private editListeners = new Set<(edit: SceneEdit) => void>();
  private loadListeners = new Set<() => void>();
  private readonly target: SceneTarget;
  private readonly host: HistoryHost;
  private readonly editorOptions: Omit<EditorOptions, "history">;
  private readonly modelEditorOptions: LibraryEditorOptions["modelEditorOptions"];

  constructor(doc?: LibraryDocument, options: LibraryEditorOptions = {}) {
    // the library's models share a clipboard, so a copy in one pastes in another
    this.editorOptions = { ...options.editorOptions, clipboard: options.editorOptions?.clipboard ?? new VoxelClipboard() };
    this.modelEditorOptions = options.modelEditorOptions;
    const scene = this;
    this.host = {
      record: (editor, entry) => this.recordModel(editor, entry),
      undo: () => this.step("undo"),
      redo: () => this.step("redo"),
      get canUndo() {
        return scene.canUndo;
      },
      get canRedo() {
        return scene.canRedo;
      },
      get undoLabel() {
        return scene.undoLabel;
      },
      get redoLabel() {
        return scene.redoLabel;
      },
    };
    this.target = this.createTarget();
    if (doc) this.loadLibrary(doc);
  }

  // #region State

  /** The library's name. */
  get name() {
    return this._libraryName.get();
  }
  /** The model or scene that opens first, if any. */
  get primary(): string | null {
    return this._primary.get();
  }
  /** The library's host data, by namespace. */
  get libraryData(): { readonly [ns: string]: Json } {
    return this._libraryData.get();
  }
  /** The library's scenes, in order. */
  get scenes(): readonly { id: string; name: string }[] {
    const open = this._scene.get();
    const openName = this._name.get();
    return this._sceneIds.get().map((id) => ({ id, name: id === open ? openName : (this.sceneStore.get(id)?.name ?? "Scene") }));
  }
  /** The open scene's id, or null. */
  get scene(): string | null {
    return this._scene.get();
  }
  /** The open scene's name. */
  get sceneName() {
    return this._name.get();
  }
  /** What is open: the library itself, a model on its own, or a scene (with a model gone into it, perhaps). */
  get view(): LibraryView {
    if (this._alone.get()) return "model";
    return this._scene.get() ? "scene" : "library";
  }
  /** A model open on its own, if one is. */
  get modelAlone(): string | null {
    return this._alone.get();
  }
  get ground(): Ground {
    return this._ground.get();
  }
  /** The open scene's model always open in place, if it has one. */
  get stage(): string | null {
    return this._stage.get();
  }
  get hostData(): { readonly [ns: string]: Json } {
    return this._hostData.get();
  }
  get models(): readonly SceneModelRecord[] {
    return this._models.get();
  }
  /** The open scene's instances, in tree order (none when no scene is open). */
  get instances(): readonly InstanceRecord[] {
    return this._instances.get();
  }
  /** Selected instance ids, in the order they were selected. */
  get selection(): readonly string[] {
    return this._selection.get();
  }
  get snap(): SceneSnap {
    return this._snap.get();
  }
  get toast() {
    return this._toast.get();
  }
  /** Bumped whenever anything saved in the library changes, a model's voxels included. */
  get version() {
    this._version.get();
    for (const d of this.docs.values()) d.version;
    for (const { doc } of this._derived.get().values()) doc.version;
    return untrack(() => this._version.get());
  }
  get revision() {
    this._version.get();
    return this._revision;
  }
  get id() {
    return this.docId;
  }
  get canUndo() {
    this._historyVersion.get();
    return this.undos.length > 0;
  }
  get canRedo() {
    this._historyVersion.get();
    return this.redos.length > 0;
  }
  get undoLabel(): string | null {
    this._historyVersion.get();
    return this.undos[this.undos.length - 1]?.label ?? null;
  }
  get redoLabel(): string | null {
    this._historyVersion.get();
    return this.redos[this.redos.length - 1]?.label ?? null;
  }

  /** The instance whose model is being edited in place, if any. UI state: not saved, not undoable. */
  get open(): { instance: string; model: string } | null {
    return this._open.get();
  }

  /**
   * The model an instance shows: its own, or the one its kind supplies from its settings (a
   * model the host links by ref, or one built from the settings and cached in the scene).
   */
  modelFor(id: string): string | null {
    const inst = this.instance(id);
    if (!inst) return null;
    return inst.model ?? this._supplied.get().get(id) ?? null;
  }

  /** Give the scene its host's hooks for linked models. */
  setHost(hooks: SceneHostHooks) {
    this.hooks = hooks;
    this.syncSupplied();
  }

  /**
   * A linked model changed outside this scene (another level edited the shared spike): reload
   * it. Not an edit, and not undoable; this scene's earlier edits to it can no longer be undone,
   * so they don't overwrite the other change.
   */
  modelChanged(ref: string, doc: DocumentData) {
    for (const m of untrack(() => this.allModels)) {
      if (m.ref !== ref) continue;
      const model = this.docOf(m.id);
      if (!model) continue;
      // sessions on it start over when they hear
      model.load(doc, "linked");
      this.disownModel(m.id);
    }
    this._version.set(0);
  }

  /** Ask the host again for every linked model, reloading those that changed (after a scene opens). */
  async refreshLinked(): Promise<void> {
    const resolve = this.hooks.resolveModel;
    if (!resolve) return;
    await Promise.all(
      untrack(() => this.allModels)
        .filter((m) => m.ref !== undefined)
        .map(async (m) => {
          const doc = await resolve(m.ref!);
          const model = this.docOf(m.id);
          if (!model) return;
          const same = doc.docId === model.docId && (doc.revision ?? 0) === untrack(() => model.revision);
          if (!same) this.modelChanged(m.ref!, doc);
        }),
    );
  }

  /** Mark every history step touching a model as not undoable: it was replaced under them. */
  private disownModel(model: string) {
    for (const entry of [...this.undos, ...this.redos]) {
      for (const part of entry.parts) {
        if ("model" in part && part.model === model) part.entry.owned = part.entry.items.map(() => false);
      }
    }
  }

  /**
   * Bring the models host kinds supply in step with their instances' settings: link refs
   * (asking the host), build documents (cached in the scene), and drop built models nothing uses.
   * Caches, not edits: outside history.
   */
  private syncSupplied() {
    // a host that links synchronously comes back in here: run the pass again once this one is done
    if (this.syncing) {
      this.resync = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.resync = false;
        this.syncSuppliedOnce();
      } while (this.resync);
    } finally {
      this.syncing = false;
    }
  }

  private syncing = false;
  private resync = false;

  private syncSuppliedOnce() {
    const instances = untrack(() => this.instances);
    const start = untrack(() => this._derived.get());
    const derived = new Map(start);
    const records = () => [...untrack(() => this.models), ...[...derived.values()].map((d) => d.record)];
    const supplied = new Map<string, string>();
    const usedBuilt = new Set<string>();
    for (const inst of instances) {
      if (inst.model || !inst.kind) continue;
      const kind = this.kind(inst.kind);
      const settings = this.settings(inst.id);
      if (kind?.model) {
        let made: string | DocumentData | null;
        try {
          made = kind.model(settings);
        } catch (e) {
          this.notify(`${kind.label}: ${(e as Error).message}`);
          continue;
        }
        if (made === null) continue;
        if (typeof made === "string") {
          const ref = made;
          const linked = records().find((m) => m.ref === ref);
          if (linked) supplied.set(inst.id, linked.id);
          else this.linkRef(ref);
          continue;
        }
        const key = builtKey(settings);
        let built = records().find((m) => m.built?.kind === inst.kind && m.built?.key === key);
        if (!built) {
          built = { id: randomId("model:"), built: { kind: inst.kind, key } };
          let doc: VoxelDocument;
          try {
            doc = this.createDocument(made);
          } catch (e) {
            this.notify(`${kind.label}: ${(e as Error).message}`);
            continue;
          }
          derived.set(built.id, { record: built, doc });
        }
        usedBuilt.add(built.id);
        supplied.set(inst.id, built.id);
      } else if (!kind) {
        // without the host: the model it built last time, for these settings, if the file kept it
        const key = builtKey(settings);
        const built = records().find((m) => m.built?.kind === inst.kind && m.built?.key === key);
        if (built) supplied.set(inst.id, built.id);
      }
    }
    // a registered kind rebuilds what it needs; its old builds go (unregistered kinds keep theirs),
    // unless a scene that isn't open still shows them: the file keeps them for it
    const stored = this.storedBuiltKeys();
    for (const [id, { record }] of derived) {
      if (!record.built || !this.kind(record.built.kind) || usedBuilt.has(id)) continue;
      if (stored.has(`${record.built.kind} ${record.built.key}`)) continue;
      this.releaseSession(id);
      derived.delete(id);
    }
    batch(() => {
      const current = untrack(() => this._derived.get());
      // models linked while this pass ran (a host that answers at once) stay
      for (const [id, entry] of current) if (!start.has(id) && !derived.has(id)) derived.set(id, entry);
      if (derived.size !== current.size || [...derived.keys()].some((k) => !current.has(k))) this._derived.set(derived);
      const before = untrack(() => this._supplied.get());
      if (before.size !== supplied.size || [...supplied].some(([k, v]) => before.get(k) !== v)) this._supplied.set(supplied);
    });
  }

  /** The built models scenes that aren't open show, as `kind key`. */
  private storedBuiltKeys(): Set<string> {
    const keys = new Set<string>();
    const open = untrack(() => this._scene.get());
    for (const id of untrack(() => this._sceneIds.get())) {
      if (id === open) continue;
      const record = this.sceneStore.get(id);
      if (!record) continue;
      for (const inst of record.instances) {
        if (inst.model || !inst.kind) continue;
        const defaults = this.kind(inst.kind)?.defaults ?? record.kinds?.[inst.kind]?.defaults;
        keys.add(`${inst.kind} ${builtKey(resolveSettings(defaults, inst.data as Json | undefined))}`);
      }
    }
    return keys;
  }

  /** Embed a model the host keeps under `ref`, outside history, once it resolves. */
  private linkRef(ref: string) {
    const resolve = this.hooks.resolveModel;
    if (!resolve || this.resolving.has(ref)) return;
    this.resolving.add(ref);
    const add = (data: DocumentData) => {
      this.resolving.delete(ref);
      if (untrack(() => this.allModels).some((m) => m.ref === ref)) return;
      const id = randomId("model:");
      let doc: VoxelDocument;
      try {
        doc = this.createDocument(data);
      } catch (e) {
        this.notify(`Couldn't open the model “${ref}”: ${(e as Error).message}`);
        return;
      }
      const derived = new Map(untrack(() => this._derived.get()));
      derived.set(id, { record: { id, ref }, doc });
      this._derived.set(derived);
      this.syncSupplied();
    };
    let result: DocumentData | Promise<DocumentData>;
    try {
      result = resolve(ref);
    } catch (e) {
      this.resolving.delete(ref);
      this.notify(`Couldn't open the model “${ref}”: ${(e as Error).message}`);
      return;
    }
    if (result instanceof Promise) {
      result.then(add, (e: Error) => {
        this.resolving.delete(ref);
        this.notify(`Couldn't open the model “${ref}”: ${e.message}`);
      });
    } else {
      add(result);
    }
  }

  /** Where something could stand along a world ray: the nearest stage voxel or instance face, or else the ground. */
  surfaceAt(ray: Ray, exclude: ReadonlySet<string> = new Set()): SurfaceHit | null {
    let best: SurfaceHit | null = null;
    const consider = (matrix: Mat4, doc: VoxelDocument, instance: string | null) => {
      const inv = invertMat(matrix);
      const origin = transformPoint(inv, ray.origin);
      const d = transformDirection(inv, ray.dir);
      const len = Math.hypot(...d) || 1;
      const dir = d.map((n) => n / len) as Vec3;
      // the document's own volume: nothing a session hides or clips
      const volume = untrack(() => doc.volume());
      const hit = raycastVolume({ origin, dir }, untrack(() => doc.size), (i) => volume[i] !== 0);
      if (!hit) return;
      const distance = hit.distance / len;
      if (best && distance >= best.distance) return;
      const local = origin.map((o, a) => o + dir[a] * hit.distance) as Vec3;
      const n = transformDirection(matrix, hit.normal);
      const nl = Math.hypot(...n) || 1;
      best = { point: transformPoint(matrix, local), normal: n.map((v) => v / nl) as Vec3, instance, distance };
    };
    const stage = untrack(() => this.stage);
    const stageDoc = stage ? this.docOf(stage) : undefined;
    if (stage && stageDoc) consider(this.modelLocal(stage), stageDoc, null);
    for (const inst of untrack(() => this.instances)) {
      if (!this.isShown(inst.id) || exclude.has(inst.id)) continue;
      const model = untrack(() => this.modelFor(inst.id));
      const doc = model ? this.docOf(model) : undefined;
      if (doc) consider(this.meshMatrix(inst.id), doc, inst.id);
    }
    if (best) return best;
    if (untrack(() => this.ground).visible && ray.dir[1] < -1e-6) {
      const t = -ray.origin[1] / ray.dir[1];
      if (t > 0) return { point: [ray.origin[0] + ray.dir[0] * t, 0, ray.origin[2] + ray.dir[2] * t], normal: [0, 1, 0], instance: null, distance: t };
    }
    return null;
  }

  /** The step an instance moves in: its kind's, or the scene's. */
  snapStepFor(id: string): number | null {
    const kind = this.kind(untrack(() => this.instance(id))?.kind);
    if (kind?.snap?.step !== undefined) return kind.snap.step > 0 ? kind.snap.step * this.stageVoxel : null;
    return untrack(() => this.snapStep);
  }

  /** How an instance may turn: its kind's rule, or freely (within the scene's angle snap). */
  rotateRule(id: string): "free" | "quarter" | "none" {
    return this.kind(untrack(() => this.instance(id))?.kind)?.rotate ?? "free";
  }

  /** The model whose editor is in use: one open on its own, one gone into, or else the open scene's stage. */
  get activeModel(): string | null {
    return this._alone.get() ?? this.open?.model ?? this.stage;
  }

  get activeEditor(): Editor | null {
    const model = this.activeModel;
    return model && this.docOf(model) ? this.editor(model) : null;
  }

  /**
   * Edit an instance's model in place: its editor becomes the active one, with the rest of the
   * scene around it. Its edits go on the library's history as they happen. Returns the editor.
   */
  openModel(instance: string): Editor {
    const inst = untrack(() => this.instance(instance));
    const model = untrack(() => this.modelFor(instance));
    if (!inst || !model) throw new Error(inst ? `${inst.name} has no model to edit` : "That instance was deleted");
    if (this.model(model)?.built) throw new Error(`${inst.name} is built from its settings; change them instead`);
    const editor = this.editor(model);
    this.closeModel();
    // opening is a change of view, not an edit: the selection goes without an undo step
    batch(() => {
      this._selection.set([]);
      this._open.set({ instance, model });
    });
    return editor;
  }

  /**
   * Leave the model being edited, applying what is in progress in it: one gone into goes back
   * to its scene, one open on its own back to the library.
   */
  closeModel() {
    const open = untrack(() => this.open);
    const alone = untrack(() => this._alone.get());
    const model = open?.model ?? alone;
    if (!model) return;
    this.sessions.get(model)?.finishPending();
    batch(() => {
      this._open.set(null);
      this._alone.set(null);
    });
    // its edits stay in history; undoing them goes through the document from now on
    if (model !== untrack(() => this.stage)) this.releaseSession(model);
  }

  /** Open a model of the library on its own. Returns its editor. */
  openModelAlone(model: string): Editor {
    if (!this.docOf(model)) throw new Error(`There is no model ${model} in the library`);
    if (this.model(model)?.built) throw new Error(`${this.modelName(model)} is built from its settings by its kind`);
    this.closeModel();
    const editor = this.editor(model);
    batch(() => {
      this.switchScene(null);
      this._alone.set(model);
    });
    return editor;
  }

  /** Open a scene of the library (or with null, the library itself). Not an edit. */
  openScene(id: string | null) {
    if (id !== null && !untrack(() => this._sceneIds.get()).includes(id)) throw new Error(`There is no scene ${id} in the library`);
    this.closeModel();
    batch(() => {
      this._alone.set(null);
      this.switchScene(id);
    });
  }

  /** Back to the library itself: nothing open. */
  openLibrary() {
    this.openScene(null);
  }

  /** Open whatever `id` names: a model on its own or a scene. */
  openResource(id: string) {
    if (untrack(() => this._sceneIds.get()).includes(id)) this.openScene(id);
    else this.openModelAlone(id);
  }

  /** Make another scene the open one: the open one's state goes back to the store. */
  private switchScene(id: string | null) {
    const current = untrack(() => this._scene.get());
    if (current === id) return;
    this.endStroke();
    if (current) this.sceneStore.set(current, this.captureScene());
    batch(() => {
      this._open.set(null);
      this._selection.set([]);
      this.restoreScene(id ? this.sceneStore.get(id)! : null);
      this._scene.set(id);
    });
    this.syncSupplied();
  }

  /** Run `fn` with another scene open for a moment: for history steps and edits to scenes that aren't open. */
  private withScene<T>(id: string | undefined, fn: () => T): T {
    const current = untrack(() => this._scene.get());
    if (!id || id === current) return fn();
    if (!this.sceneStore.has(id)) throw new OpError("That scene was deleted");
    const open = untrack(() => this._open.get());
    const selection = untrack(() => this._selection.get());
    return batch(() => {
      if (current) this.sceneStore.set(current, this.captureScene());
      this.restoreScene(this.sceneStore.get(id)!);
      this._scene.set(id);
      try {
        return fn();
      } finally {
        // it may have been deleted while open
        if (this.sceneStore.has(id) && untrack(() => this._sceneIds.get()).includes(id)) this.sceneStore.set(id, this.captureScene());
        this.restoreScene(current ? this.sceneStore.get(current)! : null);
        this._scene.set(current);
        this._open.set(open);
        this._selection.set(selection);
      }
    });
  }

  /** The open scene's state, as a record. */
  private captureScene(): SceneRecord {
    const kinds = this.kindSnapshots();
    const hostData = untrack(() => this.hostData);
    return {
      id: untrack(() => this._scene.get())!,
      name: untrack(() => this._name.get()),
      ground: { ...untrack(() => this.ground) },
      stage: untrack(() => this.stage),
      hostData: { ...hostData },
      instances: untrack(() => this.instances).map((i) => ({ ...i })),
      ...(Object.keys(kinds).length ? { kinds } : {}),
      ...(this.sceneExtra ? { extra: { ...this.sceneExtra } } : {}),
    };
  }

  /** Put a scene's record into the signals (or with null, none). */
  private restoreScene(record: SceneRecord | null) {
    this.savedKinds = record?.kinds ? { ...record.kinds } : {};
    this.sceneExtra = record?.extra ? { ...record.extra } : undefined;
    batch(() => {
      this._name.set(record?.name ?? "Scene");
      this._ground.set(record ? { visible: record.ground.visible, size: [...record.ground.size] } : { ...DEFAULT_GROUND, size: [...DEFAULT_GROUND.size] });
      this._stage.set(record?.stage ?? null);
      this._hostData.set(record ? { ...record.hostData } : {});
      this._instances.set(record ? [...record.instances] : []);
    });
  }

  /** Grid units of the active model to world units: where the view's space sits in the scene. */
  get viewMatrix(): Mat4 {
    const alone = this._alone.get();
    if (alone) return this.modelLocal(alone);
    const open = this.open;
    if (open) return this.meshMatrix(open.instance);
    const stage = this.stage;
    return stage ? this.modelLocal(stage) : matFromTransform([0, 0, 0], IDENTITY_QUAT, 1);
  }

  instance(id: string): InstanceRecord | undefined {
    return this.instances.find((i) => i.id === id);
  }

  /** A model's record: one in `models`, or one a kind supplies. */
  model(id: string): SceneModelRecord | undefined {
    return this.models.find((m) => m.id === id) ?? this._derived.get().get(id)?.record;
  }

  /** Every model the scene holds: those in `models`, then those kinds supply (built or linked). */
  get allModels(): readonly SceneModelRecord[] {
    return [...this.models, ...[...this._derived.get().values()].map((d) => d.record)];
  }

  /** A model's document: what renderers, exports and picking read. */
  document(model: string): VoxelDocument {
    const doc = this.docOf(model);
    if (!doc) throw new Error(`There is no model ${model} in the scene`);
    return doc;
  }

  private docOf(model: string): VoxelDocument | undefined {
    return this.docs.get(model) ?? untrack(() => this._derived.get()).get(model)?.doc;
  }

  /**
   * An editing session on a model, made when first asked for and kept while it is in use (open in
   * place, the stage, or a script holding it). Its edits go on the scene's history.
   */
  editor(model: string): Editor {
    const existing = this.sessions.get(model);
    if (existing) return existing;
    const doc = this.document(model);
    const own = this.modelEditorOptions?.(model, this);
    const session = new Editor(undefined, { ...this.editorOptions, ...own, history: this.host, document: doc });
    this.sessions.set(model, session);
    this.modelOf.set(session, model);
    return session;
  }

  /** Put a model's session away. Its steps in history stay, and undo through the document. */
  private releaseSession(model: string) {
    const session = this.sessions.get(model);
    if (!session) return;
    session.dispose();
    this.sessions.delete(model);
    this.modelOf.delete(session);
  }

  /** A document for a model, with what this scene's models can hold. */
  private createDocument(data: DocumentData): VoxelDocument {
    const o = this.editorOptions;
    return new VoxelDocument(data, { lockResolution: !!(o.lockResolution || o.transformValue || o.replaceHiddenValue) });
  }

  /** The model an editor belongs to, if it is one of this scene's. */
  modelOfEditor(editor: Editor): string | undefined {
    return this.modelOf.get(editor);
  }

  /** A model's name: its document's. */
  modelName(id: string): string {
    return this.docOf(id)?.name ?? "Model";
  }

  /** How many instances use each model. */
  usage(model: string): number {
    return this.instances.filter((i) => i.model === model).length;
  }

  // #endregion

  // #region Kinds

  /** Kinds this scene's host offers. Registering replaces kinds with the same ids. */
  registerKinds(kinds: readonly InstanceKind[]) {
    const next = new Map(untrack(() => this._kinds.get()));
    for (const k of kinds) {
      if (!isValidId(k.id)) throw new Error(`Kind ids must be like “spikes” or “camera-zone”, not “${k.id}”`);
      next.set(k.id, k);
    }
    this._kinds.set(next);
    this.syncSupplied();
  }

  get kinds(): readonly InstanceKind[] {
    return [...this._kinds.get().values()];
  }

  /** A registered kind. */
  kind(id: string | undefined): InstanceKind | undefined {
    return id ? this._kinds.get().get(id) : undefined;
  }

  /** What is known of a kind: the registered one, or what the file said about it. */
  kindInfo(id: string): { label: string; defaults?: { [key: string]: Json }; color?: number; known: boolean } | undefined {
    const k = this.kind(id);
    if (k) return { label: k.label, defaults: k.defaults, color: k.color, known: true };
    const saved = this.savedKinds[id];
    return saved ? { label: saved.label, defaults: saved.defaults, color: saved.color, known: false } : undefined;
  }

  /** An instance's settings, with its kind's defaults filled in. */
  settings(id: string): { [key: string]: Json } {
    const inst = this.instance(id);
    if (!inst) return {};
    return resolveSettings(inst.kind ? this.kindInfo(inst.kind)?.defaults : undefined, inst.data as Json | undefined);
  }

  /** Whether an instance shows: it and everything it hangs from are visible. */
  isShown(id: string): boolean {
    for (let inst = this.instance(id); inst; inst = inst.parent ? this.instance(inst.parent.instance) : undefined) {
      if (!inst.visible) return false;
    }
    return true;
  }

  /** Whether an instance is locked, or hangs from one that is. */
  isLocked(id: string): boolean {
    for (let inst = this.instance(id); inst; inst = inst.parent ? this.instance(inst.parent.instance) : undefined) {
      if (inst.locked) return true;
    }
    return false;
  }

  /** Whether an instance is a group: no model and no kind, only a transform others hang from. */
  isGroup(id: string): boolean {
    const inst = this.instance(id);
    return !!inst && inst.model === null && inst.kind === undefined && inst.scene === undefined;
  }

  /**
   * The box an instance without a model shows, in its own space: from its kind, or as last saved.
   * A group's is the box around what hangs from it (a small one while it's empty).
   */
  instanceBounds(id: string): Box | null {
    const inst = this.instance(id);
    if (!inst || this.modelFor(id)) return null;
    if (this.isGroup(id)) return this.groupBounds(id);
    if (inst.scene !== undefined) return this.placedBounds(inst.scene);
    const kind = this.kind(inst.kind);
    if (kind?.bounds) return kind.bounds(this.settings(id));
    const saved = inst.kind ? this.savedKinds[inst.kind]?.bounds?.[id] : undefined;
    return saved ? { min: [...saved.min], max: [...saved.max] } : { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] };
  }

  /** What hangs from a group, boxed in the group's own space. */
  private groupBounds(id: string): Box {
    const inv = invertMat(this.worldMatrix(id));
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const child of this.instances) {
      if (child.parent?.instance !== id) continue;
      const box = this.worldBox(child.id);
      if (!box) continue;
      for (let c = 0; c < 8; c++) {
        const p = transformPoint(inv, [c & 1 ? box.max[0] : box.min[0], c & 2 ? box.max[1] : box.min[1], c & 4 ? box.max[2] : box.min[2]]);
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a], p[a]);
          max[a] = Math.max(max[a], p[a]);
        }
      }
    }
    return min[0] === Infinity ? { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] } : { min, max };
  }

  // #endregion

  // #region Transforms

  /** Grid units to world units in a model's own space: origin at the floor's center, scaled by its voxel size. */
  modelLocal(model: string): Mat4 {
    const doc = this.docOf(model);
    const vs = this.model(model)?.voxelSize ?? 1;
    const origin = doc ? untrack(() => originCells(doc)) : ([0, 0, 0] as Vec3);
    return multiplyMat(matFromTransform([0, 0, 0], IDENTITY_QUAT, vs), translationMat([-origin[0], -origin[1], -origin[2]]));
  }

  /**
   * Where an instance is in the world: its parent's frame, then its own transform. `ms` is the
   * scene's clock, for instances that hang from markers keyed per frame.
   */
  worldMatrix(id: string, ms = 0): Mat4 {
    const inst = this.instance(id);
    if (!inst) return matFromTransform([0, 0, 0], IDENTITY_QUAT, 1);
    const own = matFromTransform(inst.position, inst.rotation, inst.scale ?? 1);
    return inst.parent ? multiplyMat(this.attachFrame(inst.parent, ms), own) : own;
  }

  /**
   * The frame something attached at `attach` is placed in: one of the host model's markers, where it
   * is on the frame the host shows (at `ms` on the scene's clock), turned as it is; or the host's
   * origin, with its axes.
   */
  attachFrame(attach: Attach | null, ms = 0): Mat4 {
    if (!attach) return matFromTransform([0, 0, 0], IDENTITY_QUAT, 1);
    const host = this.instance(attach.instance);
    const world = this.worldMatrix(attach.instance, ms);
    const hostModel = host ? this.modelFor(host.id) : null;
    if (!host || !attach.marker || !hostModel) return world;
    const frame = this.markerFrame(hostModel, attach.marker, this.frameOf(host.id, ms));
    return frame ? multiplyMat(world, frame) : world;
  }

  /**
   * A model's marker as a frame in an instance's own space (world units, from the model's origin):
   * where it is on `frame` (the model's open frame when null), turned as it is. Null when it is gone.
   */
  markerFrame(model: string, markerId: string, frame: string | null): Mat4 | null {
    const doc = this.docOf(model);
    const marker = doc?.marker(markerId);
    if (!doc || !marker) return null;
    const { shape } = markerAt(marker, untrack(() => doc.frames), frame ?? untrack(() => doc.openFrameId));
    const r = untrack(() => doc.resolution);
    const at = markerCenter(shape).map((n) => n * r);
    const origin = untrack(() => originCells(doc));
    const vs = this.model(model)?.voxelSize ?? 1;
    const offset = at.map((n, a) => (n - origin[a]) * vs) as Vec3;
    return matFromTransform(offset, markerRotation(shape), 1);
  }

  /** Grid cells of an instance's model to world units: what a renderer draws its mesh with. */
  meshMatrix(id: string, ms = 0): Mat4 {
    const model = this.modelFor(id);
    if (!model) return this.worldMatrix(id, ms);
    return multiplyMat(this.worldMatrix(id, ms), this.modelLocal(model));
  }

  /** The box an instance's voxels (or its kind's bounds) take up in the world, axis-aligned. */
  worldBox(id: string): Box | null {
    const inst = this.instance(id);
    if (!inst) return null;
    let box: Box | null;
    let matrix: Mat4;
    const model = this.modelFor(id);
    if (model) {
      const doc = this.docOf(model);
      if (!doc) return null;
      const b = untrack(() => doc.contentBounds()) ?? { min: [0, 0, 0] as Vec3, max: untrack(() => doc.size).map((n) => n - 1) as Vec3 };
      box = { min: b.min, max: b.max.map((n) => n + 1) as Vec3 };
      matrix = this.meshMatrix(id);
    } else {
      box = this.instanceBounds(id);
      matrix = this.worldMatrix(id);
    }
    if (!box) return null;
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) {
      const p = transformPoint(matrix, [c & 1 ? box.max[0] : box.min[0], c & 2 ? box.max[1] : box.min[1], c & 4 ? box.max[2] : box.min[2]]);
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], p[a]);
        max[a] = Math.max(max[a], p[a]);
      }
    }
    return { min, max };
  }

  /** How wide a model stands on the ground in world units: its larger side across X and Z. */
  modelFootprint(model: string): number {
    const doc = this.docOf(model);
    if (!doc) return 1;
    const size = untrack(() => doc.size);
    return Math.max(size[0], size[2]) * (this.model(model)?.voxelSize ?? 1);
  }

  /**
   * The frame an instance shows `ms` milliseconds into the scene's clock: the frame it holds,
   * the one its loop has reached (at its speed, from its offset), or without playback, the frame
   * its model has open, so edits show as they are made. Null for an instance without a model.
   */
  frameOf(id: string, ms = 0): string | null {
    const inst = this.instance(id);
    const supplied = this.modelFor(id);
    return inst && supplied ? this.recordFrame(inst, supplied, ms) : null;
  }

  /** The frame an instance record shows of `model` at `ms`, as `frameOf` says; for scenes that aren't open too. */
  recordFrame(inst: InstanceRecord, model: string, ms = 0): string | null {
    const doc = this.docOf(model);
    if (!doc) return null;
    const frames = untrack(() => doc.frames);
    const open = untrack(() => doc.openFrameId);
    const playback = inst.playback;
    if (!playback || frames.length < 2) return open;
    if (playback.kind === "frame") return frames.some((f) => f.id === playback.frame) ? playback.frame : open;
    const durations = frames.map((f) => f.duration);
    const fps = untrack(() => doc.fps);
    const total = ticksToMs(totalTicks(durations), fps);
    const t = (((ms * playback.speed + playback.offset) % total) + total) % total;
    return frames[frameAt(durations, fps, t)].id;
  }

  /** Whether any visible instance loops an animated model, so the scene's clock needs to run. */
  get animating(): boolean {
    return this.instances.some((i) => {
      if (i.scene !== undefined && this.isShown(i.id)) return this.placedContents(i.id).some((c) => c.loops);
      const model = i.playback?.kind === "loop" && this.isShown(i.id) ? this.modelFor(i.id) : null;
      if (!model) return false;
      const doc = this.docOf(model);
      return !!doc && doc.frames.length > 1;
    });
  }

  /** An instance's transform in Euler degrees, as the UI and agents show it. */
  placement(id: string): { position: Vec3; rotation: Vec3; scale: number } | null {
    const inst = this.instance(id);
    if (!inst) return null;
    return { position: [...inst.position] as Vec3, rotation: eulerFromQuat(inst.rotation), scale: inst.scale ?? 1 };
  }

  /** The transform that keeps an instance where it is in the world when it hangs from `attach` instead. */
  private keepWorld(id: string, attach: Attach | null): Transform {
    const world = this.worldMatrix(id);
    const local = multiplyMat(invertMat(this.attachFrame(attach)), world);
    const d = decomposeMat(local);
    return { position: d.position, rotation: d.rotation, scale: d.scale };
  }

  // #endregion

  // #region Snapping

  setSnap(patch: Partial<SceneSnap>) {
    this._snap.set({ ...untrack(() => this.snap), ...patch });
  }

  /** The step positions snap to now, in world units, or null. */
  get snapStep(): number | null {
    const step = this.snap.step;
    return step && step > 0 ? step * this.stageVoxel : null;
  }

  /** The size of one stage voxel in world units: 1 without a stage. */
  get stageVoxel(): number {
    const stage = this.stage;
    return (stage && this.model(stage)?.voxelSize) || 1;
  }

  /**
   * Snap a point to the stage's cells (multiples of the snap step from the stage's corner; from
   * the origin without a stage).
   */
  snapPosition(p: Vec3): Vec3 {
    const step = untrack(() => this.snapStep);
    if (!step) return [...p] as Vec3;
    const at = untrack(() => this.latticeOrigin());
    return p.map((n, a) => at[a] + Math.round((n - at[a]) / step) * step) as Vec3;
  }

  /** Snap an offset (a move, not a place) to whole snap steps. */
  snapOffset(d: Vec3): Vec3 {
    const step = untrack(() => this.snapStep);
    return step ? (d.map((n) => Math.round(n / step) * step || 0) as Vec3) : ([...d] as Vec3);
  }

  /**
   * Where the stage's cells start in the world: the corner of its grid, which the snap lattice
   * runs from. The stage stands with its floor's center at the origin, so a stage an odd number
   * of cells wide has its cell edges half a cell off the origin. The origin without a stage.
   */
  latticeOrigin(): Vec3 {
    const stage = this.stage;
    return stage && this.docOf(stage) ? transformPoint(this.modelLocal(stage), [0, 0, 0]) : [0, 0, 0];
  }

  /**
   * Where an instance would stand if it were at `p` (in the world, for one hanging from nothing)
   * with its model lined up with the stage's cells, by its kind's `snap.align`: its model's grid
   * on the cells (`edges`, the default, so a model two cells wide covers two cells), or its
   * origin centered on a cell across and on the cell's floor (`center`). Axes left out of `axes`
   * keep their value. Attached instances and positions without a snap step come back as given.
   */
  alignPosition(id: string, p: Vec3, axes: readonly [boolean, boolean, boolean] = [true, true, true]): Vec3 {
    const inst = untrack(() => this.instance(id));
    const step = untrack(() => this.snapStepFor(id));
    if (!inst || inst.parent || !step) return [...p] as Vec3;
    const at = untrack(() => this.latticeOrigin());
    const snap = (n: number, a: number) => at[a] + Math.round((n - at[a]) / step) * step;
    if (this.kind(inst.kind)?.snap?.align === "center") {
      // across its up (Y, or the wall or ceiling it stands out of): the middle of a cell; along it, a cell's face
      const up = transformDirection(matFromTransform([0, 0, 0], inst.rotation, 1), [0, 1, 0]);
      const upAxis = up.reduce((best, n, a) => (Math.abs(n) > Math.abs(up[best]) ? a : best), 1);
      const across = (n: number, a: number) => at[a] + (Math.floor((n - at[a]) / step) + 0.5) * step;
      return p.map((n, a) => (!axes[a] ? n : a === upAxis ? snap(n, a) : across(n, a))) as Vec3;
    }
    // the corner of the instance's grid (or its kind's bounds), from its origin, as it is turned
    const model = untrack(() => this.modelFor(id));
    const box = model ? null : untrack(() => this.instanceBounds(id));
    const local = model ? this.modelLocal(model) : null;
    const own = matFromTransform([0, 0, 0], inst.rotation, inst.scale ?? 1);
    const corner = local ? transformPoint(multiplyMat(own, local), [0, 0, 0]) : box ? transformPoint(own, box.min) : ([0, 0, 0] as Vec3);
    return p.map((n, a) => (axes[a] ? snap(n + corner[a], a) - corner[a] : n)) as Vec3;
  }

  snapAngle(deg: number): number {
    const step = untrack(() => this.snap.angle);
    return step ? Math.round(deg / step) * step : deg;
  }

  // #endregion

  // #region History

  /** Run `fn` as a single undo step: scene changes and model edits alike. Nested calls join it. */
  transact<T>(label: string, fn: () => T): T {
    if (this.tx) return fn();
    const tx = { label, parts: [] as ScenePart[] };
    this.tx = tx;
    let result: T;
    try {
      result = batch(fn);
    } catch (e) {
      // all or nothing: what it did before it threw goes back
      this.tx = null;
      this.revertParts(tx.parts);
      throw e;
    }
    this.tx = null;
    if (tx.parts.length) this.push({ id: randomId("edit:"), label, parts: tx.parts });
    return result;
  }

  private revertParts(parts: readonly ScenePart[]) {
    batch(() => {
      // as in `step`: scene ops that need a model part back first go after it
      const later: { scene: SceneOp; in?: string }[] = [];
      const tryScene = (part: { scene: SceneOp; in?: string }): boolean => {
        try {
          this.withScene(part.in, () => applySceneOp(this.target, invertSceneOp(part.scene)));
          return true;
        } catch (e) {
          if (!(e instanceof OpError)) throw e;
          return false;
        }
      };
      for (let i = parts.length - 1; i >= 0; i--) {
        const part = parts[i];
        if ("local" in part) part.local.undo();
        else if ("scene" in part) {
          if (!tryScene(part)) later.push(part);
        } else this.takeBackModel(part.model, part.entry, "undo");
      }
      for (let progress = true; later.length && progress; ) {
        const before = later.length;
        later.splice(0, later.length, ...later.filter((part) => !tryScene(part)));
        progress = later.length < before;
      }
    });
    this.pruneSelection();
  }

  /**
   * Take back one model's entry: through its session when one is open (so what it shows follows),
   * or through its document alone. Returns the entry that takes it back in turn, and whether
   * anything was skipped.
   */
  private takeBackModel(model: string, entry: Entry, verb: "undo" | "redo"): { inverse: Entry | null; skipped: boolean } {
    const session = this.sessions.get(model);
    if (session) {
      const { done, inverse } = session.takeBack(entry, verb);
      return { inverse, skipped: !done || !inverse };
    }
    const doc = this.docOf(model);
    if (!doc) return { inverse: null, skipped: true };
    const { items, skipped } = doc.takeBack(entry);
    return {
      inverse: items.length ? entryOf(randomId("edit:"), entry.label, items) : null,
      skipped: skipped > 0 || !items.length,
    };
  }

  /** Start an undo step that spans several events (a drag). Changes until `endStroke` join it. */
  beginStroke(label: string) {
    this.endStroke();
    this.stroke = { label, parts: [] };
    this.tx = this.stroke;
  }

  /** Whether a stroke is open. */
  get stroking() {
    return !!this.stroke;
  }

  endStroke() {
    const stroke = this.stroke;
    if (!stroke) return;
    this.stroke = null;
    this.tx = null;
    if (stroke.parts.length) this.push({ id: randomId("edit:"), label: stroke.label, parts: stroke.parts });
  }

  /** Abandon the open stroke, putting back everything it changed. */
  cancelStroke() {
    const stroke = this.stroke;
    if (!stroke) return;
    this.stroke = null;
    this.tx = null;
    this.revertParts(stroke.parts);
  }

  undo(): boolean {
    return this.step("undo");
  }

  redo(): boolean {
    return this.step("redo");
  }

  /** Hear about each change made here, including undo and redo. Returns a function that stops. */
  onEdit(listener: (edit: SceneEdit) => void): () => void {
    this.editListeners.add(listener);
    return () => this.editListeners.delete(listener);
  }

  /** Hear about each time the whole scene is replaced (new, open). Returns a function that stops. */
  onLoad(listener: () => void): () => void {
    this.loadListeners.add(listener);
    return () => this.loadListeners.delete(listener);
  }

  private recordModel(editor: Editor, entry: Entry) {
    const model = this.modelOf.get(editor);
    if (!model) return;
    const parts: ScenePart[] = [{ model, entry }];
    // one selection at a time: selecting voxels lets go of the instances, in the same step
    const before = untrack(() => this.selection);
    if (before.length && untrack(() => editor.hasSelection)) {
      this._selection.set([]);
      parts.push({ local: { undo: () => this._selection.set(before), redo: () => this._selection.set([]) } });
    }
    if (this.tx) {
      this.tx.parts.push(...parts);
      this.repairMarkersEverywhere(model);
      this.keepPlaceOnResize(model, entry);
      return;
    }
    // a marker deleted: what hangs from it in any scene falls back to the model's origin, in the same
    // step; a resize leaves what is placed on or with the model where it was
    const tx = { label: `${editor.name}: ${entry.label}`, parts };
    this.tx = tx;
    try {
      this.repairMarkersEverywhere(model);
      this.keepPlaceOnResize(model, entry);
    } finally {
      this.tx = null;
    }
    this.push({ id: randomId("edit:"), label: tx.label, parts: tx.parts });
  }

  private push(entry: SceneEntry) {
    this.redos = [];
    this.pushTo(this.undos, entry);
    this.committed(entry);
  }

  private pushTo(list: SceneEntry[], entry: SceneEntry) {
    list.push(entry);
    while (list.length > MAX_ENTRIES) list.shift();
    let bytes = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      bytes += entryBytes(list[i]);
      if (bytes > MAX_HISTORY_BYTES && i < list.length - 1) {
        list.splice(0, i + 1);
        break;
      }
    }
    this._historyVersion.set(0);
  }

  private committed(entry: SceneEntry) {
    const scene = entry.parts.flatMap((p) => ("scene" in p ? [p.scene] : []));
    const models = entry.parts.flatMap((p) => ("model" in p ? [{ model: p.model, entry: p.entry }] : []));
    if (!scene.length && !models.length) return;
    this._revision++;
    this._version.set(0);
    if (scene.length) this.syncSupplied();
    // linked models go back to the host after every change, undo and redo included
    const save = this.hooks.saveModel;
    if (save) {
      for (const id of new Set(models.map((m) => m.model))) {
        const ref = this.model(id)?.ref;
        const doc = this.docOf(id);
        if (ref !== undefined && doc) save(ref, doc.toData());
      }
    }
    const edit: SceneEdit = { label: entry.label, scene, models };
    for (const listener of this.editListeners) listener(edit);
  }

  private step(from: "undo" | "redo"): boolean {
    if (this.stroke) this.cancelStroke();
    if (this.stepping || this.tx) return false;

    const stack = from === "undo" ? this.undos : this.redos;
    const entry = stack[stack.length - 1];
    if (!entry) return false;
    stack.pop();
    this.stepping = true;
    const parts: ScenePart[] = [];
    let skipped = 0;
    /** A scene the step changed: undo shows it, if nothing is being edited. */
    let reveal: string | undefined;
    try {
      batch(() => {
        // a scene op that doesn't fit yet (an attachment to a part whose model comes back later
        // in this step) is tried again once the rest is back
        const later: { scene: SceneOp; in?: string }[] = [];
        const tryScene = (part: { scene: SceneOp; in?: string }): boolean => {
          try {
            const inverse = invertSceneOp(part.scene);
            this.withScene(part.in, () => applySceneOp(this.target, inverse));
            parts.push({ scene: inverse, ...(part.in ? { in: part.in } : {}) });
            if (part.in) reveal = part.in;
            return true;
          } catch (e) {
            if (!(e instanceof OpError)) throw e;
            return false;
          }
        };
        for (let i = entry.parts.length - 1; i >= 0; i--) {
          const part = entry.parts[i];
          if ("local" in part) {
            part.local.undo();
            parts.push({ local: { undo: part.local.redo, redo: part.local.undo } });
          } else if ("scene" in part) {
            if (!tryScene(part)) later.push(part);
          } else {
            // nothing came back: read-only, or changed under it from elsewhere
            const { inverse, skipped: missed } = this.takeBackModel(part.model, part.entry, from);
            if (missed) skipped++;
            if (inverse) parts.push({ model: part.model, entry: inverse });
          }
        }
        for (let progress = true; later.length && progress; ) {
          const before = later.length;
          later.splice(0, later.length, ...later.filter((part) => !tryScene(part)));
          progress = later.length < before;
        }
        skipped += later.length;
      });
    } finally {
      this.stepping = false;
    }
    this.pruneSelection();
    // an undo that takes away the instance being edited in place leaves it; one that takes away
    // the open scene or model goes back to the library
    const open = untrack(() => this.open);
    if (open && !untrack(() => this.instance(open.instance))) this._open.set(null);
    const scene = untrack(() => this._scene.get());
    if (scene && !untrack(() => this._sceneIds.get()).includes(scene)) this.switchSceneGone();
    const alone = untrack(() => this._alone.get());
    if (alone && !this.docOf(alone)) this._alone.set(null);
    if (reveal && reveal !== scene && !untrack(() => this.activeModel) && untrack(() => this._sceneIds.get()).includes(reveal)) this.openScene(reveal);
    if (parts.length) {
      const next = { id: randomId("edit:"), label: entry.label, parts };
      this.pushTo(from === "undo" ? this.redos : this.undos, next);
      this.committed(next);
    } else {
      this._historyVersion.set(0);
    }
    if (skipped) this.notify(`Some of “${entry.label}” couldn't be ${from === "undo" ? "undone" : "redone"}`);
    return true;
  }

  /** Apply a library or scene op as (part of) an undo step. Returns false, with a notice, if it doesn't fit. */
  private apply(label: string, op: SceneOp): boolean {
    if (isSceneLevel(op) && !untrack(() => this._scene.get())) return this.fail("Open a scene first");
    return this.transact(label, () => {
      try {
        applySceneOp(this.target, op);
      } catch (e) {
        if (!(e instanceof OpError)) throw e;
        this.notify(e.message);
        return false;
      }
      this.tx!.parts.push(this.partOf(op));
      return true;
    });
  }

  /** Like `apply`, but throws the reason instead of a notice: for methods that must all succeed or stop. */
  private must(op: SceneOp) {
    if (isSceneLevel(op) && !untrack(() => this._scene.get())) throw new OpError("Open a scene first");
    applySceneOp(this.target, op);
    this.tx!.parts.push(this.partOf(op));
  }

  /** A history part for an op just applied: scene ops note the scene they changed. */
  private partOf(op: SceneOp): ScenePart {
    return isSceneLevel(op) ? { scene: op, in: untrack(() => this._scene.get())! } : { scene: op };
  }

  /** The open scene was deleted (by an undo, say): back to the library, without storing it. */
  private switchSceneGone() {
    batch(() => {
      this._open.set(null);
      this._selection.set([]);
      this.restoreScene(null);
      this._scene.set(null);
    });
  }

  notify(message: string) {
    this._toast.set({ message, id: (untrack(() => this.toast)?.id ?? 0) + 1 });
  }

  // #endregion

  // #region Models

  /**
   * Embed a model. Returns its id. With `origin`, it remembers which document it was copied
   * from (by default the document's own id and revision), so a newer copy can replace it later.
   */
  addModel(doc: DocumentData, options: { ref?: string; voxelSize?: number; id?: string } = {}): string {
    const id = options.id ?? randomId("model:");
    const docId = doc.docId && isValidId(doc.docId) ? doc.docId : undefined;
    const record: SceneModelRecord = {
      id,
      ...(docId ? { origin: { docId, revision: doc.revision ?? 0 } } : {}),
      ...(options.ref !== undefined ? { ref: options.ref } : {}),
      ...(options.voxelSize !== undefined && options.voxelSize !== 1 ? { voxelSize: options.voxelSize } : {}),
    };
    const op: SceneOp = { t: "model.add", index: untrack(() => this.models.length), model: record, doc };
    this.transact(`Add ${doc.name || "model"}`, () => this.must(op));
    return id;
  }

  /**
   * Start a new, empty model in the library. With a scene open, it is placed there too (selected)
   * and the instance's id is returned, ready for `openModel`; otherwise the model's id. One undo step.
   */
  newModel(options: Placement & { name?: string; size?: Vec3 } = {}): string | null {
    const size = (options.size ?? [16, 16, 16]).map((n) => Math.max(1, Math.min(256, Math.round(n)))) as Vec3;
    const name = options.name?.trim() || this.nextName("Model", untrack(() => this.models).map((m) => this.modelName(m.id)));
    const doc = defaultDocument(size, DEFAULT_PALETTE.colors, name);
    if (!untrack(() => this._scene.get())) return this.addModel(doc);
    try {
      return this.transact(`New ${name}`, () => {
        const model = this.addModel(doc);
        const id = this.addInstance(model, { position: options.position, rotation: options.rotation, scale: options.scale });
        if (!id) throw new OpError("The new model couldn't be placed");
        return id;
      });
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      this.notify(e.message);
      return null;
    }
  }

  /** The model already in the scene that was copied from this document, if any. */
  modelFromDocument(docId: string | undefined): string | undefined {
    if (!docId) return undefined;
    return untrack(() => this.models).find((m) => m.origin?.docId === docId || this.docs.get(m.id)?.docId === docId)?.id;
  }

  /** Whether a model was changed in the scene since it was copied. */
  modelEdited(id: string): boolean {
    const m = this.model(id);
    const doc = this.docOf(id);
    if (!m?.origin || !doc) return false;
    return untrack(() => doc.revision) > m.origin.revision;
  }

  /**
   * Replace a model's document with a newer copy (every instance updates), as one undo step.
   * Instances attached to parts the new copy doesn't have stay where they are, at its origin.
   */
  replaceModel(id: string, doc: DocumentData): boolean {
    try {
      this.transact(`Replace ${this.modelName(id)}`, () => {
        this.must({ t: "model.replace", id, doc });
        if (doc.docId && isValidId(doc.docId)) this.must({ t: "model.set", id, key: "origin", after: { docId: doc.docId, revision: doc.revision ?? 0 } });
        this.repairMarkersEverywhere(id);
      });
      return true;
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      this.notify(e.message);
      return false;
    }
  }

  /** Remove a model no scene uses (see `deleteModel` for one that is used). */
  removeModel(id: string): boolean {
    return this.apply(`Remove ${this.modelName(id)}`, { t: "model.remove", id });
  }

  /** The scenes that place a model, or have it as their stage. */
  scenesUsing(model: string): { id: string; name: string }[] {
    return this.scenes.filter((s) => {
      const record = s.id === untrack(() => this._scene.get()) ? null : this.sceneStore.get(s.id);
      const instances = record ? record.instances : untrack(() => this.instances);
      const stage = record ? record.stage : untrack(() => this.stage);
      return stage === model || instances.some((i) => i.model === model);
    });
  }

  // #region Placed scenes

  /** A scene's instances: the open one's as they are now, another's as last saved. */
  sceneInstances(id: string): readonly InstanceRecord[] {
    if (id === untrack(() => this._scene.get())) return untrack(() => this.instances);
    return this.sceneStore.get(id)?.instances ?? [];
  }

  private sceneStage(id: string): string | null {
    if (id === untrack(() => this._scene.get())) return untrack(() => this.stage);
    return this.sceneStore.get(id)?.stage ?? null;
  }

  /** The scenes a scene places directly. */
  scenePlaces(id: string): string[] {
    return [...new Set(this.sceneInstances(id).flatMap((i) => (i.scene !== undefined ? [i.scene] : [])))];
  }

  /** The scenes that place a scene directly. */
  scenesPlacing(id: string): { id: string; name: string }[] {
    return this.scenes.filter((s) => s.id !== id && this.scenePlaces(s.id).includes(id));
  }

  /** The scene an instance places, if it places one. */
  placedScene(id: string): string | null {
    return this.instance(id)?.scene ?? null;
  }

  /**
   * Every model a placed scene instance draws, at any depth: its path of instance ids (the placed
   * instance first; "stage" for a placed scene's stage), the model, the frame it shows at `ms`, and
   * its mesh matrix in the world. Hidden instances, and what hangs from them, are left out.
   */
  placedContents(id: string, ms = 0): PlacedContent[] {
    const scene = this.placedScene(id);
    return scene ? this.sceneContents(scene, this.worldMatrix(id, ms), ms, [id], new Set()) : [];
  }

  private sceneContents(sceneId: string, base: Mat4, ms: number, path: string[], seen: ReadonlySet<string>): PlacedContent[] {
    if (seen.has(sceneId)) return [];
    const inside = new Set(seen).add(sceneId);
    const out: PlacedContent[] = [];
    const stage = this.sceneStage(sceneId);
    const stageDoc = stage ? this.docOf(stage) : undefined;
    if (stage && stageDoc) {
      out.push({ path: [...path, "stage"], model: stage, frame: untrack(() => stageDoc.openFrameId), matrix: multiplyMat(base, this.modelLocal(stage)), loops: false });
    }
    const instances = this.sceneInstances(sceneId);
    const byId = new Map(instances.map((i) => [i.id, i]));
    const shown = (inst: InstanceRecord): boolean => {
      for (let at: InstanceRecord | undefined = inst, n = 0; at && n <= instances.length; at = at.parent ? byId.get(at.parent.instance) : undefined, n++) {
        if (!at.visible) return false;
      }
      return true;
    };
    for (const inst of instances) {
      if (!shown(inst)) continue;
      const world = multiplyMat(base, this.recordWorld(byId, inst.id, ms));
      if (inst.model) {
        const doc = this.docOf(inst.model);
        const frame = this.recordFrame(inst, inst.model, ms);
        if (!doc || !frame) continue;
        const loops = inst.playback?.kind === "loop" && untrack(() => doc.frames).length > 1;
        out.push({ path: [...path, inst.id], model: inst.model, frame, matrix: multiplyMat(world, this.modelLocal(inst.model)), loops });
      } else if (inst.scene !== undefined) {
        out.push(...this.sceneContents(inst.scene, world, ms, [...path, inst.id], inside));
      }
    }
    return out;
  }

  /** Where an instance of a scene that may not be open is, in that scene: as `worldMatrix`, over records. */
  private recordWorld(byId: ReadonlyMap<string, InstanceRecord>, id: string, ms: number, depth = 0): Mat4 {
    const inst = byId.get(id);
    if (!inst || depth > byId.size) return matFromTransform([0, 0, 0], IDENTITY_QUAT, 1);
    const own = matFromTransform(inst.position, inst.rotation, inst.scale ?? 1);
    if (!inst.parent) return own;
    const hostWorld = this.recordWorld(byId, inst.parent.instance, ms, depth + 1);
    const host = byId.get(inst.parent.instance);
    const frame = host?.model && inst.parent.marker ? this.markerFrame(host.model, inst.parent.marker, this.recordFrame(host, host.model, ms)) : null;
    return multiplyMat(frame ? multiplyMat(hostWorld, frame) : hostWorld, own);
  }

  /** A placed scene's box in the placing instance's own space: around everything it draws. */
  private placedBounds(sceneId: string): Box {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const c of this.sceneContents(sceneId, matFromTransform([0, 0, 0], IDENTITY_QUAT, 1), 0, [], new Set())) {
      const doc = this.docOf(c.model);
      if (!doc) continue;
      const b = untrack(() => doc.contentBounds());
      if (!b) continue;
      for (let k = 0; k < 8; k++) {
        const p = transformPoint(c.matrix, [k & 1 ? b.max[0] + 1 : b.min[0], k & 2 ? b.max[1] + 1 : b.min[1], k & 4 ? b.max[2] + 1 : b.min[2]]);
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a], p[a]);
          max[a] = Math.max(max[a], p[a]);
        }
      }
    }
    return min[0] === Infinity ? { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] } : { min, max };
  }

  // #endregion

  /**
   * Delete a model from the library, as one undo step, with every instance of it in every scene
   * (what hangs from them stays, a level up). It stops being the primary or a stage.
   */
  deleteModel(id: string): boolean {
    if (!untrack(() => this.models).some((m) => m.id === id)) return this.fail("That model was deleted");
    const name = this.modelName(id);
    if (untrack(() => this.activeModel) === id) this.closeModel();
    try {
      this.transact(`Delete ${name}`, () => {
        if (untrack(() => this._primary.get()) === id) this.must({ t: "library.set", key: "primary", after: null });
        for (const scene of this.scenesUsing(id)) {
          this.withScene(scene.id, () => {
            if (untrack(() => this.stage) === id) this.must({ t: "scene.set", key: "stage", after: null });
            const uses = untrack(() => this.instances).filter((i) => i.model === id).map((i) => i.id);
            if (uses.length && !this.deleteInstances(uses)) throw new OpError(`Its instances in ${scene.name} couldn't be deleted`);
          });
        }
        this.must({ t: "model.remove", id });
      });
      return true;
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      return this.fail(e.message);
    }
  }

  /** A copy of a model, as a new model of the library. Returns its id. */
  duplicateModel(id: string): string | null {
    const doc = this.docOf(id);
    const record = this.model(id);
    if (!doc || !record) return this.fail("That model was deleted"), null;
    const { docId: _, revision: __, ...data } = doc.toData();
    const name = this.nextName(`${doc.name} copy`, untrack(() => this.models).map((m) => this.modelName(m.id)));
    return this.addModel({ ...data, name }, { voxelSize: record.voxelSize });
  }

  /** Rename a model (its document's name), as one undo step. */
  renameModel(id: string, name: string): boolean {
    if (!this.docOf(id)) return this.fail("That model was deleted");
    this.editor(id).setName(name);
    if (untrack(() => this.activeModel) !== id) this.releaseSession(id);
    return true;
  }

  /** `base`, or `base 2`, `base 3`… so it doesn't repeat one of `taken`. */
  private nextName(base: string, taken: readonly string[]): string {
    const names = new Set(taken);
    if (!names.has(base)) return base;
    let n = 2;
    while (names.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }

  // #endregion

  // #region Scenes

  /**
   * Add a scene to the library, as one undo step, and return its id. With `models`, it places
   * one instance of each, side by side (New scene with this model). It isn't opened.
   */
  newScene(name?: string, models: readonly string[] = []): string | null {
    const id = randomId("scene:");
    const title = name?.trim() || this.nextName("Scene", this.scenes.map((s) => s.name));
    let x = 0;
    const instances: InstanceRecord[] = [];
    for (const model of models) {
      const doc = this.docOf(model);
      if (!doc) continue;
      const vs = this.model(model)?.voxelSize ?? 1;
      const width = untrack(() => doc.size[0]) * vs;
      instances.push({
        id: randomId("inst:"),
        name: this.modelName(model),
        model,
        parent: null,
        position: [x + width / 2 - (models.length > 1 ? 0 : width / 2), 0, 0],
        rotation: [...IDENTITY_QUAT],
        visible: true,
        locked: false,
      });
      x += width + 2;
    }
    const scene: SceneRecord = { ...emptyScene(id, title), instances };
    const ok = this.apply(`New scene ${title}`, { t: "scenes.add", index: untrack(() => this._sceneIds.get()).length, scene });
    return ok ? id : null;
  }

  /**
   * Start a scene the way a new document starts: a new scene holding one new, empty model, as one
   * undo step. Returns both ids (open the scene, then `openModel(instance)` to draw in it), or null.
   */
  startScene(name?: string): { scene: string; instance: string } | null {
    try {
      return this.transact("New scene", () => {
        const title = name?.trim() || this.nextName("Scene", this.scenes.map((s) => s.name));
        const modelName = this.nextName("Model", untrack(() => this.models).map((m) => this.modelName(m.id)));
        const model = this.addModel(defaultDocument([16, 16, 16], DEFAULT_PALETTE.colors, modelName));
        const scene = this.newScene(title, [model]);
        const instance = scene ? this.sceneStore.get(scene)?.instances[0]?.id : undefined;
        if (!scene || !instance) throw new OpError("The new scene couldn't be made");
        return { scene, instance };
      });
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      this.notify(e.message);
      return null;
    }
  }

  /** Delete a scene, as one undo step. Its instances go with it; the models stay in the library. */
  deleteScene(id: string): boolean {
    const scene = this.scenes.find((s) => s.id === id);
    if (!scene) return this.fail("That scene was deleted");
    if (untrack(() => this._scene.get()) === id) this.openLibrary();
    try {
      this.transact(`Delete ${scene.name}`, () => {
        if (untrack(() => this._primary.get()) === id) this.must({ t: "library.set", key: "primary", after: null });
        // where it is placed, its instances go with it
        for (const other of this.scenesPlacing(id)) {
          this.withScene(other.id, () => {
            const uses = untrack(() => this.instances).filter((i) => i.scene === id).map((i) => i.id);
            if (uses.length && !this.deleteInstances(uses)) throw new OpError(`Its placements in ${other.name} couldn't be deleted`);
          });
        }
        this.must({ t: "scenes.remove", id });
      });
      return true;
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      return this.fail(e.message);
    }
  }

  /** A copy of a scene, after it. Returns its id. */
  duplicateScene(id: string): string | null {
    const index = untrack(() => this._sceneIds.get()).indexOf(id);
    if (index < 0) return this.fail("That scene was deleted"), null;
    const record = id === untrack(() => this._scene.get()) ? this.captureScene() : this.sceneStore.get(id)!;
    const copy: SceneRecord = { ...record, id: randomId("scene:"), name: this.nextName(`${record.name} copy`, this.scenes.map((s) => s.name)) };
    return this.apply(`Duplicate ${record.name}`, { t: "scenes.add", index: index + 1, scene: copy }) ? copy.id : null;
  }

  /** Rename a scene, open or not, as one undo step. */
  renameScene(id: string, name: string): boolean {
    if (!untrack(() => this._sceneIds.get()).includes(id)) return this.fail("That scene was deleted");
    try {
      return this.transact("Rename scene", () => this.withScene(id, () => this.apply("Rename scene", { t: "scene.set", key: "name", after: name })));
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      return this.fail(e.message);
    }
  }

  /**
   * Bring another library's models and scenes into this one, as one undo step, with new ids so
   * nothing clashes (its scenes place its models, as they did). Returns the new ids, and the one
   * its primary became, if it had one.
   */
  importLibrary(doc: LibraryDocument): { models: string[]; scenes: string[]; primary: string | null } {
    const ids = new Map<string, string>();
    const models: string[] = [];
    const scenes: string[] = [];
    try {
      this.transact(`Import ${doc.name}`, () => {
        for (const { record, doc: model } of doc.models) {
          // caches kinds keep come back when their kinds need them
          if (record.built) continue;
          const id = randomId("model:");
          ids.set(record.id, id);
          models.push(id);
          const { id: _, ...rest } = record;
          this.must({ t: "model.add", index: untrack(() => this.models.length), model: { id, ...rest }, doc: model });
        }
        // scenes may place each other, so every scene has its new id first
        for (const scene of doc.scenes) ids.set(scene.id, randomId("scene:"));
        for (const scene of doc.scenes) {
          const id = ids.get(scene.id)!;
          scenes.push(id);
          const instances = scene.instances
            .filter((i) => (i.model === null || ids.has(i.model)) && (i.scene === undefined || ids.has(i.scene)))
            .map((i) => ({ ...i, model: i.model === null ? null : ids.get(i.model)!, ...(i.scene !== undefined ? { scene: ids.get(i.scene)! } : {}) }));
          const record: SceneRecord = {
            ...scene,
            id,
            name: this.nextName(scene.name, this.scenes.map((s) => s.name)),
            stage: scene.stage ? (ids.get(scene.stage) ?? null) : null,
            instances,
          };
          this.must({ t: "scenes.add", index: untrack(() => this._sceneIds.get()).length, scene: record });
        }
      });
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      this.notify(e.message);
      return { models: [], scenes: [], primary: null };
    }
    return { models, scenes, primary: doc.primary ? (ids.get(doc.primary) ?? null) : null };
  }

  /** Make a model or scene the one that opens first (or with null, none), as one undo step. */
  setPrimary(id: string | null): boolean {
    return this.apply(id ? "Make primary" : "No primary", { t: "library.set", key: "primary", after: id });
  }

  setVoxelSize(id: string, size: number): boolean {
    return this.apply("Voxel size", { t: "model.set", id, key: "voxelSize", after: size });
  }

  /**
   * In every scene, instances hanging from parts of `model` that are gone fall back to its origin
   * (see `repairParts`), so no scene is left naming a deleted part. Part of the open undo step.
   */
  private repairMarkersEverywhere(model: string) {
    const doc = this.docOf(model);
    if (!doc) return;
    const markers = new Set(untrack(() => doc.markers).map((m) => m.id));
    const open = untrack(() => this._scene.get());
    for (const id of untrack(() => this._sceneIds.get())) {
      const instances = id === open ? untrack(() => this.instances) : (this.sceneStore.get(id)?.instances ?? []);
      const byId = new Map(instances.map((i) => [i.id, i]));
      const broken = instances.some((i) => i.parent?.marker && !markers.has(i.parent.marker) && byId.get(i.parent.instance)?.model === model);
      if (!broken) continue;
      try {
        this.withScene(id, () => this.repairMarkers(model));
      } catch (e) {
        if (!(e instanceof OpError)) throw e;
        this.notify(e.message);
      }
    }
  }

  /**
   * After a resize of `model` that moved its voxels relative to its origin (the floor's center),
   * as growing it on one side does: keep everything where it was against those voxels, in every
   * scene, in the open undo step. Its instances move the other way, so the model stays put in the
   * world (and what hangs from its origin stays with it); on a scene's stage, which can't move,
   * what stands in the scene moves with the voxels instead, so objects stay on their blocks.
   */
  private keepPlaceOnResize(model: string, entry: Entry) {
    const shift: Vec3 = [0, 0, 0];
    for (const item of entry.items) {
      if (!("op" in item) || item.op.t !== "resize") continue;
      const { from, to, offset } = item.op;
      shift[0] += offset[0] - (to[0] - from[0]) / 2;
      shift[1] += offset[1];
      shift[2] += offset[2] - (to[2] - from[2]) / 2;
    }
    if (shift.every((n) => n === 0)) return;
    const vs = this.model(model)?.voxelSize ?? 1;
    const world = shift.map((n) => n * vs) as Vec3;
    const open = untrack(() => this._scene.get());
    for (const id of untrack(() => this._sceneIds.get())) {
      const record = id === open ? null : this.sceneStore.get(id);
      if (record && record.stage !== model && !record.instances.some((i) => i.model === model || i.kind)) continue;
      try {
        this.withScene(id, () => {
          const stage = untrack(() => this._stage.get());
          for (const inst of untrack(() => this.instances)) {
            const t = transformOf(inst);
            let position: Vec3 | null = null;
            if (stage === model && !inst.parent) position = t.position.map((n, a) => n + world[a]) as Vec3;
            else if (untrack(() => this.modelFor(inst.id)) === model) {
              // the voxels moved by `world` in the instance's own space: move it back by as much, turned and scaled
              const back = transformDirection(matFromTransform([0, 0, 0], t.rotation, t.scale), world);
              position = t.position.map((n, a) => n - back[a]) as Vec3;
            } else if (inst.parent && !inst.parent.marker && untrack(() => this.modelFor(inst.parent!.instance)) === model) {
              // hung from that instance's origin, which moved: stay with its voxels
              position = t.position.map((n, a) => n + world[a]) as Vec3;
            }
            if (position) this.must({ t: "instance.set", id: inst.id, key: "transform", after: { ...t, position } });
          }
        });
      } catch (e) {
        if (!(e instanceof OpError)) throw e;
        this.notify(e.message);
      }
    }
  }

  /** Instances hanging from markers of `model` that are gone fall back to its origin, staying in place. */
  private repairMarkers(model: string) {
    const doc = this.docOf(model);
    if (!doc) return;
    const markers = new Set(untrack(() => doc.markers).map((m) => m.id));
    for (const inst of untrack(() => this.instances)) {
      const p = inst.parent;
      if (!p?.marker || markers.has(p.marker) || this.instance(p.instance)?.model !== model) continue;
      // the marker is gone, so its frame can't be measured: keep the local transform, at the origin
      this.must({ t: "instance.set", id: inst.id, key: "attach", after: { parent: { instance: p.instance, marker: null }, ...transformOf(inst) } });
    }

  }

  // #endregion

  // #region Instances

  /**
   * Place an instance of a model (or with `kind` and no model, of a host kind). Returns its id,
   * or null with a notice if it can't go there.
   */
  addInstance(
    model: string | null,
    options: Placement & {
      name?: string;
      kind?: string;
      data?: { [key: string]: Json };
      parent?: Attach | null;
      playback?: Playback;
      /** Place a scene of the library whole, instead of a model (pass a null model). */
      scene?: string;
      select?: boolean;
      /** Line it up with the stage's cells across (see `alignPosition`), in the same step. */
      align?: boolean;
    } = {},
  ): string | null {
    if (!untrack(() => this._scene.get())) return this.fail("Open a scene first"), null;
    const id = randomId("inst:");
    const kind = this.kindInfo(options.kind ?? "");
    const placed = options.scene !== undefined ? this.scenes.find((s) => s.id === options.scene)?.name : undefined;
    const name = options.name ?? (model ? this.modelName(model) : (placed ?? kind?.label ?? options.kind ?? "Group"));
    const instance: InstanceRecord = {
      id,
      name,
      model,
      ...(options.scene !== undefined ? { scene: options.scene } : {}),
      ...(options.kind !== undefined ? { kind: options.kind } : {}),
      ...(options.data ? { data: options.data } : {}),
      parent: options.parent ?? null,
      position: options.position ? [...options.position] as Vec3 : [0, 0, 0],
      rotation: options.rotation ? toQuat(options.rotation) : [...IDENTITY_QUAT],
      ...(options.scale !== undefined ? { scale: options.scale } : {}),
      ...(options.playback ? { playback: options.playback } : {}),
      visible: true,
      locked: false,
    };
    const ok = this.transact(`Add ${name}`, () => {
      if (!this.apply("", { t: "instance.add", index: untrack(() => this.instances.length), instance })) return false;
      if (options.align && !instance.parent) {
        // a kind's model is linked or built when it's added: know its size before lining it up
        this.syncSupplied();
        const position = this.alignPosition(id, instance.position, [true, false, true]);
        if (position.some((n, a) => n !== instance.position[a]) && !this.setTransform(id, { position })) return false;
      }
      if (options.select !== false) this.select([id]);
      return true;
    });
    return ok ? id : null;
  }

  /**
   * Put instances in a new group, as one undo step: the group stands at the middle of their
   * floor, under their common parent (if they share one), and they keep where they are. What
   * hangs from them comes along. Returns the group's id.
   */
  groupInstances(ids: readonly string[], name = "Group"): string | null {
    const chosen = ids.filter((id) => this.instance(id));
    // the outermost: an instance whose ancestor is also chosen moves with it
    const top = chosen.filter((id) => !chosen.some((other) => other !== id && this.isAncestor(other, id)));
    if (!top.length) return this.fail("Select something to group"), null;
    const parents = new Set(top.map((id) => JSON.stringify(this.instance(id)!.parent)));
    const parent = parents.size === 1 ? this.instance(top[0])!.parent : null;
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const id of top) {
      const box = this.worldBox(id) ?? { min: transformPoint(this.worldMatrix(id), [0, 0, 0]), max: transformPoint(this.worldMatrix(id), [0, 0, 0]) };
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], box.min[a]);
        max[a] = Math.max(max[a], box.max[a]);
      }
    }
    const floor: Vec3 = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2];
    // the group's position, in its parent's frame
    const local = transformPoint(invertMat(this.attachFrame(parent)), floor);
    const index = Math.min(...top.map((id) => untrack(() => this.instances).findIndex((i) => i.id === id)));
    const group: InstanceRecord = {
      id: randomId("inst:"),
      name,
      model: null,
      parent,
      position: local.map((n) => (Math.abs(n) < 1e-9 ? 0 : n)) as Vec3,
      rotation: [...IDENTITY_QUAT],
      visible: true,
      locked: false,
    };
    try {
      this.transact(`Group ${top.length === 1 ? this.instance(top[0])!.name : `${top.length} objects`}`, () => {
        this.must({ t: "instance.add", index, instance: group });
        const attach = { instance: group.id, marker: null };
        for (const id of top) this.must({ t: "instance.set", id, key: "attach", after: { parent: attach, ...this.keepWorld(id, attach) } });
        this.select([group.id]);
      });
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      return this.fail(e.message), null;
    }
    return group.id;
  }

  /** Take a group apart, as one undo step: what it held hangs from its parent and stays where it is. */
  ungroup(id: string): boolean {
    const group = this.instance(id);
    if (!group || !this.isGroup(id)) return this.fail("Only a group can be ungrouped");
    const children = untrack(() => this.instances).filter((i) => i.parent?.instance === id);
    try {
      this.transact(`Ungroup ${group.name}`, () => {
        for (const child of children) {
          this.must({ t: "instance.set", id: child.id, key: "attach", after: { parent: group.parent, ...this.keepWorld(child.id, group.parent) } });
        }
        this.must({ t: "instance.remove", id });
        this.select(children.map((c) => c.id));
      });
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      return this.fail(e.message);
    }
    return true;
  }

  /** Copies of instances (and what hangs from them), next to the originals. Returns the copies' ids. */
  duplicateInstances(ids: readonly string[], offset: Vec3 = [0, 0, 0]): string[] {
    const all = untrack(() => this.instances);
    const chosen = new Set(ids);
    // what hangs from a chosen instance comes along
    for (const inst of all) if (inst.parent && [...chosen].some((c) => this.isAncestor(c, inst.id))) chosen.add(inst.id);
    const map = new Map<string, string>();
    for (const inst of all) if (chosen.has(inst.id)) map.set(inst.id, randomId("inst:"));
    // a copy's parent is added before it (the list's order needn't put parents first)
    const pending = all.filter((inst) => chosen.has(inst.id));
    const ordered: InstanceRecord[] = [];
    const placed = new Set<string>();
    while (pending.length) {
      const ready = pending.findIndex((i) => !i.parent || !chosen.has(i.parent.instance) || placed.has(i.parent.instance));
      if (ready < 0) break;
      const [inst] = pending.splice(ready, 1);
      ordered.push(inst);
      placed.add(inst.id);
    }
    const copies: string[] = [];
    try {
      this.transact(ids.length === 1 ? `Duplicate ${this.instance(ids[0])?.name ?? "instance"}` : "Duplicate", () => {
        for (const inst of ordered) {
          const id = map.get(inst.id)!;
          const parent = inst.parent ? { instance: map.get(inst.parent.instance) ?? inst.parent.instance, marker: inst.parent.marker } : null;
          const top = !inst.parent || !map.has(inst.parent.instance);
          const position = top ? (inst.position.map((n, a) => n + offset[a]) as Vec3) : inst.position;
          const copy: InstanceRecord = { ...inst, id, parent, position };
          this.must({ t: "instance.add", index: untrack(() => this.instances.length), instance: copy });
          copies.push(id);
        }
        this.select(copies.filter((id) => ids.some((orig) => map.get(orig) === id)));
      });
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      this.notify(e.message);
      return [];
    }
    return copies;
  }

  /**
   * Delete instances, as one undo step. What hangs from them hangs one level up and stays where
   * it is; settings of other instances that point at them are cleared.
   */
  deleteInstances(ids: readonly string[]): boolean {
    const gone = new Set(ids.filter((id) => this.instance(id)));
    if (!gone.size) return false;
    try {
      this.transact(gone.size === 1 ? `Delete ${this.instance([...gone][0])!.name}` : "Delete", () => {
        const all = untrack(() => this.instances);
        for (const inst of all) {
          if (gone.has(inst.id) || !inst.parent || !gone.has(inst.parent.instance)) continue;
          // the nearest attachment that survives
          let attach: Attach | null = inst.parent;
          while (attach && gone.has(attach.instance)) attach = this.instance(attach.instance)?.parent ?? null;
          this.must({ t: "instance.set", id: inst.id, key: "attach", after: { parent: attach, ...this.keepWorld(inst.id, attach) } });
        }
        this.clearRefs(gone);
        // deepest first, so nothing still hangs from what goes
        const depth = (id: string) => {
          let n = 0;
          for (let p = this.instance(id)?.parent; p; p = this.instance(p.instance)?.parent) n++;
          return n;
        };
        for (const id of [...gone].sort((a, b) => depth(b) - depth(a))) this.must({ t: "instance.remove", id });
        this.select(untrack(() => this.selection).filter((id) => !gone.has(id)));
      });
      return true;
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      this.notify(e.message);
      return false;
    }
  }

  /** Clear `ref` settings that point at instances going away. */
  private clearRefs(gone: ReadonlySet<string>) {
    for (const inst of untrack(() => this.instances)) {
      if (gone.has(inst.id) || !inst.kind || !inst.data) continue;
      const fields = this.kind(inst.kind)?.fields ?? [];
      for (const f of fields) {
        if (f.type !== "ref") continue;
        const value = inst.data[f.key];
        if (typeof value === "string" && gone.has(value)) this.must({ t: "data.set", target: inst.id, path: [f.key], after: null });
      }
    }
  }

  /** Move, turn or scale an instance; what isn't given stays. Rotation in Euler degrees or a quaternion. */
  setTransform(id: string, placement: Placement, label = "Move"): boolean {
    const inst = this.instance(id);
    if (!inst) return this.fail("That instance was deleted");
    const t = transformOf(inst);
    const next = {
      position: placement.position ? [...placement.position] as Vec3 : t.position,
      rotation: placement.rotation ? toQuat(placement.rotation) : t.rotation,
      scale: placement.scale ?? t.scale,
    };
    return this.apply(label, { t: "instance.set", id, key: "transform", after: next });
  }

  /** Move instances by an offset in world units, as one step. */
  moveInstances(ids: readonly string[], delta: Vec3): boolean {
    return this.transact("Move", () => {
      for (const id of ids) {
        const inst = this.instance(id);
        if (!inst || this.isLocked(id)) continue;
        // what hangs from another one moving comes along with it already
        if (inst.parent && ids.some((other) => other !== id && !this.isLocked(other) && this.isAncestor(other, inst.parent!.instance))) continue;
        // an attached instance moves in its parent's frame: convert the world offset into it
        const frame = this.attachFrame(inst.parent);
        const inv = invertMat(frame);
        const local = [inv[0] * delta[0] + inv[4] * delta[1] + inv[8] * delta[2], inv[1] * delta[0] + inv[5] * delta[1] + inv[9] * delta[2], inv[2] * delta[0] + inv[6] * delta[1] + inv[10] * delta[2]];
        if (!this.setTransform(id, { position: inst.position.map((n, a) => n + local[a]) as Vec3 })) return false;
      }
      return true;
    });
  }

  /**
   * Hang an instance from another (at one of its model's parts, or its origin), or from nothing,
   * keeping it where it is in the world.
   */
  attach(id: string, attach: Attach | null): boolean {
    if (!this.instance(id)) return this.fail("That instance was deleted");
    if (attach && !this.instance(attach.instance)) return this.fail("That instance was deleted");
    const label = attach ? `Attach to ${this.instance(attach.instance)!.name}` : "Detach";
    let transform: Transform;
    try {
      transform = this.keepWorld(id, attach);
      checkTransform(transform);
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      return this.fail(e.message);
    }
    return this.apply(label, { t: "instance.set", id, key: "attach", after: { parent: attach, ...transform } });
  }

  setPlayback(id: string, playback: Playback | null): boolean {
    return this.apply("Playback", { t: "instance.set", id, key: "playback", after: playback });
  }

  renameInstance(id: string, name: string): boolean {
    return this.apply("Rename", { t: "instance.set", id, key: "name", after: name });
  }

  /**
   * Put an instance somewhere in the scene tree, as one undo step: hanging from `parent` (or
   * nothing), just before its child `before` (or after the rest). It keeps where it is in the
   * world; hanging from the same instance keeps the part it hangs from. What dragging a row does.
   */
  placeInTree(id: string, parent: string | null, before: string | null = null): boolean {
    const inst = this.instance(id);
    if (!inst) return this.fail("That instance was deleted");
    if (parent === id || (parent && this.isAncestor(id, parent))) return this.fail(`${inst.name} can't hang from what hangs from it`);
    if (before === id) return true;
    const sameParent = (inst.parent?.instance ?? null) === parent;
    const label = sameParent ? "Reorder" : parent ? `Attach to ${this.instance(parent)?.name ?? "instance"}` : "Detach";
    try {
      return this.transact(label, () => {
        if (!sameParent) {
          const attach = parent ? { instance: parent, marker: null } : null;
          const transform = this.keepWorld(id, attach);
          checkTransform(transform);
          this.must({ t: "instance.set", id, key: "attach", after: { parent: attach, ...transform } });
        }
        const rest = untrack(() => this.instances).filter((i) => i.id !== id);
        const at = before ? rest.findIndex((i) => i.id === before) : -1;
        this.must({ t: "instance.order", id, to: at < 0 ? rest.length : at });
        return true;
      });
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      return this.fail(e.message);
    }
  }

  /** Move an instance to a position in the outliner's order. */
  moveInstanceTo(id: string, index: number): boolean {
    return this.apply("Reorder", { t: "instance.order", id, to: index });
  }

  /** Change settings of an instance: each key given is set (null included), as one undo step. */
  setData(id: string, patch: { [key: string]: Json }, label = "Change settings"): boolean {
    return this.transact(label, () => {
      for (const [key, value] of Object.entries(patch)) {
        if (!this.apply(label, { t: "data.set", target: id, path: [key], after: value })) return false;
      }
      return true;
    });
  }

  /** Put settings of an instance back to its kind's defaults. */
  unsetData(id: string, keys: readonly string[], label = "Reset settings"): boolean {
    return this.transact(label, () => keys.every((key) => this.apply(label, { t: "data.set", target: id, path: [key], unset: true })));
  }

  /** Set one namespace of the scene's host data (null removes it). */
  setSceneData(namespace: string, value: Json): boolean {
    const op: SceneOp = value === null
      ? { t: "data.set", target: null, path: [namespace], unset: true }
      : { t: "data.set", target: null, path: [namespace], after: value };
    return this.apply("Change data", op);
  }

  /** Rename the library, as one undo step. */
  setName(name: string): boolean {
    return this.apply("Rename library", { t: "library.set", key: "name", after: name });
  }

  /** Rename the open scene, as one undo step. */
  setSceneName(name: string): boolean {
    return this.apply("Rename scene", { t: "scene.set", key: "name", after: name });
  }

  setStage(model: string | null): boolean {
    return this.apply(model ? "Set stage" : "Clear stage", { t: "scene.set", key: "stage", after: model });
  }

  setGround(ground: Partial<Ground>): boolean {
    return this.apply("Ground", { t: "scene.set", key: "ground", after: { ...untrack(() => this.ground), ...ground } });
  }

  /** Show or hide instances. Saved, but not undoable, like layer visibility. */
  setVisible(id: string, visible: boolean) {
    this.patchLocal(id, { visible });
  }

  /** Lock instances against selecting and moving. Saved, but not undoable. */
  setLocked(id: string, locked: boolean) {
    this.patchLocal(id, { locked });
    if (locked) this.select(untrack(() => this.selection).filter((s) => s !== id));
  }

  private patchLocal(id: string, patch: Partial<Pick<InstanceRecord, "visible" | "locked">>) {
    const list = untrack(() => this.instances);
    if (!list.some((i) => i.id === id)) return;
    this._instances.set(list.map((i) => (i.id === id ? { ...i, ...patch } : i)));
    this._version.set(0);
  }

  private isAncestor(ancestor: string, id: string): boolean {
    for (let at: string | undefined = id, n = 0; at && n < 10000; n++) {
      if (at === ancestor) return true;
      at = this.instance(at)?.parent?.instance;
    }
    return false;
  }

  private fail(message: string): false {
    this.notify(message);
    return false;
  }

  // #endregion

  // #region Selection

  /** Select instances (replacing the selection). Undoable, not saved. Locked and hidden ones are skipped. */
  select(ids: readonly string[]) {
    const valid = ids.filter((id, i) => {
      const inst = this.instance(id);
      return inst && !this.isLocked(id) && this.isShown(id) && ids.indexOf(id) === i;
    });
    const before = untrack(() => this.selection);
    if (before.length === valid.length && before.every((id, i) => id === valid[i])) return;
    this._selection.set(valid);
    const change: LocalChange = {
      undo: () => this._selection.set(before),
      redo: () => this._selection.set(valid),
    };
    const apply = () => {
      this.tx!.parts.push({ local: change });
      // one selection at a time: picking instances lets go of the open model's voxels
      const editor = this.activeEditor;
      if (valid.length && editor && untrack(() => editor.hasSelection)) editor.deselect();
    };
    if (this.tx) apply();
    else this.transact("Select", apply);
  }

  /** Add an instance to the selection, or take it out if it is in. */
  toggleSelected(id: string) {
    const sel = untrack(() => this.selection);
    this.select(sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id]);
  }

  clearSelection() {
    this.select([]);
  }

  private pruneSelection() {
    const sel = untrack(() => this.selection);
    const kept = sel.filter((id) => this.instance(id));
    if (kept.length !== sel.length) this._selection.set(kept);
  }

  // #endregion

  // #region Documents

  /** Start an empty library, clearing history. */
  /** Replace the library with a new one, as a new document starts: one empty model, its primary, open. */
  newLibrary(name = "Untitled") {
    const id = randomId("model:");
    this.loadLibrary({ name, models: [{ record: { id }, doc: defaultDocument([16, 16, 16], DEFAULT_PALETTE.colors, "Model") }], scenes: [], primary: id });
  }

  /**
   * Replace the library, clearing history, and open its primary. Throws an Error with a reason if
   * it is malformed: a model that doesn't load, an instance that refers to something missing, a loop.
   */
  loadLibrary(doc: LibraryDocument) {
    const docs = new Map<string, VoxelDocument>();
    const derived = new Map<string, { record: SceneModelRecord; doc: VoxelDocument }>();
    const models: SceneModelRecord[] = [];
    // a model a scene names is the library's own; a built or linked one nothing names is a kind's cache
    const named = new Set((doc.scenes ?? []).flatMap((s) => [...(s.instances ?? []).map((i) => i.model), s.stage]));
    for (const { record, doc: modelDoc } of doc.models ?? []) {
      if (!isValidId(record?.id) || docs.has(record.id) || derived.has(record.id)) throw new Error("The library is damaged: two models share an id");
      let model: VoxelDocument;
      try {
        model = this.createDocument(modelDoc);
      } catch (e) {
        throw new Error(`The model “${modelDoc?.name ?? record.id}” doesn't open: ${(e as Error).message}`);
      }
      if ((record.built || record.ref !== undefined) && !named.has(record.id)) {
        derived.set(record.id, { record, doc: model });
      } else {
        docs.set(record.id, model);
        models.push(record);
      }
    }
    const scenes = new Map<string, SceneRecord>();
    for (const scene of doc.scenes ?? []) {
      if (!isValidId(scene?.id) || scenes.has(scene.id)) throw new Error("The library is damaged: two scenes share an id");
      scenes.set(scene.id, this.checkScene(scene, models, docs, derived, doc.scenes ?? []));
    }
    const primary = doc.primary && (docs.has(doc.primary) || scenes.has(doc.primary)) ? doc.primary : null;

    for (const model of [...this.sessions.keys()]) this.releaseSession(model);
    this.docs = docs;
    this.sceneStore = scenes;
    this.docId = doc.docId && isValidId(doc.docId) ? doc.docId : randomId("lib:");
    this._revision = Number.isInteger(doc.revision) && doc.revision! >= 0 ? doc.revision! : 0;
    this.savedExtra = doc.extra && Object.keys(doc.extra).length ? { ...doc.extra } : undefined;
    this.undos = [];
    this.redos = [];
    this.tx = null;
    this.stroke = null;
    batch(() => {
      this._open.set(null);
      this._alone.set(null);
      this._scene.set(null);
      this.restoreScene(null);
      this._libraryName.set(doc.name || "Untitled");
      this._libraryData.set(doc.hostData ? { ...doc.hostData } : {});
      this._primary.set(primary);
      this._sceneIds.set([...scenes.keys()]);
      this._models.set(models);
      this._derived.set(derived);
      this._selection.set([]);
      this._historyVersion.set(0);
      this._version.set(0);
    });
    // what opens first: the primary, or the library itself
    if (primary) this.openResource(primary);
    this.syncSupplied();
    for (const listener of this.loadListeners) listener();
  }

  /** A scene from a file, checked against the library's models: instances in an order where parents come first. */
  private checkScene(
    scene: SceneRecord,
    models: readonly SceneModelRecord[],
    docs: ReadonlyMap<string, VoxelDocument>,
    derived: ReadonlyMap<string, { record: SceneModelRecord; doc: VoxelDocument }>,
    /** Every scene in the file, for the scenes this one places. */
    fileScenes: readonly SceneRecord[] = [],
  ): SceneRecord {
    const pending = [...(scene.instances ?? [])];
    const placed: InstanceRecord[] = [];
    const all = [...models, ...[...derived.values()].map((d) => d.record)];
    const check: SceneTarget = {
      ...this.target,
      models: all,
      instances: placed,
      scenes: fileScenes.map((s) => ({ id: s.id, name: s.name })),
      openScene: scene.id,
      scenePlaces: (id) => [...new Set((fileScenes.find((s) => s.id === id)?.instances ?? []).flatMap((i) => (i.scene !== undefined ? [i.scene] : [])))],
      modelMarkers: (id) => {
        const model = docs.get(id) ?? derived.get(id)?.doc;
        return model ? untrack(() => model.markers).map((m) => m.id) : null;
      },
    };
    const name = scene.name || "Scene";
    while (pending.length) {
      const ready = pending.findIndex((i) => !i.parent || placed.some((p) => p.id === i.parent!.instance));
      if (ready < 0) throw new Error(`The scene ${name} is damaged: an instance hangs from one that isn't there`);
      const [src] = pending.splice(ready, 1);
      try {
        placed.push(checkInstance(check, src, placed));
      } catch (e) {
        throw new Error(`The scene ${name} is damaged: ${(e as Error).message}`);
      }
    }
    // keep the file's order
    const order = new Map((scene.instances ?? []).map((i, n) => [i.id, n]));
    placed.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    const stage = scene.stage && docs.has(scene.stage) ? scene.stage : null;
    if (scene.stage && !stage) throw new Error(`The scene ${name} is damaged: its stage isn't one of the library's models`);
    const ground = scene.ground && typeof scene.ground.visible === "boolean" && Array.isArray(scene.ground.size)
      ? { visible: scene.ground.visible, size: [scene.ground.size[0], scene.ground.size[1]] as [number, number] }
      : { ...DEFAULT_GROUND, size: [...DEFAULT_GROUND.size] as [number, number] };
    return {
      id: scene.id,
      name,
      ground,
      stage,
      hostData: scene.hostData ? { ...scene.hostData } : {},
      instances: placed,
      ...(scene.kinds ? { kinds: { ...scene.kinds } } : {}),
      ...(scene.extra ? { extra: { ...scene.extra } } : {}),
    };
  }

  /** The open scene's kinds as a file describes them: labels, defaults, and the bounds of objects with no model. */
  private kindSnapshots(): { [id: string]: KindSnapshot } {
    const instances = untrack(() => this.instances);
    const kinds: { [id: string]: KindSnapshot } = {};
    for (const inst of instances) {
      if (!inst.kind || kinds[inst.kind]) continue;
      const k = this.kind(inst.kind);
      const saved = this.savedKinds[inst.kind];
      kinds[inst.kind] = k
        ? { label: k.label, ...(k.defaults ? { defaults: k.defaults } : {}), ...(k.color !== undefined ? { color: k.color } : {}) }
        : { ...saved, bounds: undefined };
    }
    for (const inst of instances) {
      if (!inst.kind || untrack(() => this.modelFor(inst.id))) continue;
      const box = untrack(() => this.instanceBounds(inst.id));
      if (!box) continue;
      const snap = kinds[inst.kind];
      snap.bounds = { ...(snap.bounds ?? {}), [inst.id]: { min: [...box.min], max: [...box.max] } };
    }
    for (const snap of Object.values(kinds)) if (!snap.bounds) delete snap.bounds;
    return kinds;
  }

  /** The whole library, as files hold it. */
  getLibrary(): LibraryDocument {
    const open = untrack(() => this._scene.get());
    const hostData = untrack(() => this.libraryData);
    const primary = untrack(() => this.primary);
    return {
      docId: this.docId,
      revision: this._revision,
      name: untrack(() => this.name),
      ...(primary ? { primary } : {}),
      // the library's models, then the caches kinds keep, so the file shows them without its host
      models: untrack(() => this.allModels).map((record) => ({ record, doc: this.docOf(record.id)!.toData() })),
      scenes: untrack(() => this._sceneIds.get()).map((id) => (id === open ? this.captureScene() : this.sceneStore.get(id)!)),
      ...(Object.keys(hostData).length ? { hostData: { ...hostData } } : {}),
      ...(this.savedExtra ? { extra: { ...this.savedExtra } } : {}),
    };
  }

  /** The scene as scene ops see it. */
  private createTarget(): SceneTarget {
    const scene = this;
    return {
      get name() {
        return untrack(() => scene.sceneName);
      },
      get ground() {
        return untrack(() => scene.ground);
      },
      get stage() {
        return untrack(() => scene.stage);
      },
      get hostData() {
        return untrack(() => scene.hostData);
      },
      get models() {
        return untrack(() => scene.models);
      },
      get instances() {
        return untrack(() => scene.instances);
      },
      setName: (name) => this._name.set(name),
      setGround: (ground) => this._ground.set(ground),
      setStage: (stage) => this._stage.set(stage),
      setHostData: (data) => this._hostData.set(data),
      setModels: (models) => this._models.set(models),
      setInstances: (instances) => this._instances.set(instances),
      addModelDoc: (id, doc) => {
        let model: VoxelDocument;
        try {
          model = this.createDocument(doc);
        } catch (e) {
          throw new OpError((e as Error).message);
        }
        this.docs.set(id, model);
      },
      removeModelDoc: (id) => {
        const model = this.docs.get(id);
        if (!model) throw new OpError("That model was deleted");
        const doc = model.toData();
        this.releaseSession(id);
        this.docs.delete(id);
        return doc;
      },
      replaceModelDoc: (id, doc) => {
        const model = this.docs.get(id);
        if (!model) throw new OpError("That model was deleted");
        const before = model.toData();
        try {
          model.load(doc, "replace");
        } catch (e) {
          throw new OpError((e as Error).message);
        }
        return before;
      },
      modelMarkers: (id) => {
        const model = this.docOf(id);
        return model ? untrack(() => model.markers).map((m) => m.id) : null;
      },
      modelInUse: (id) => this.scenesUsing(id).length > 0,
      get scenes() {
        return untrack(() => scene.scenes);
      },
      get openScene() {
        return untrack(() => scene._scene.get());
      },
      scenePlaces: (id) => this.scenePlaces(id),
      get libraryName() {
        return untrack(() => scene.name);
      },
      get primary() {
        return untrack(() => scene.primary);
      },
      addScene: (index, record) => {
        this.sceneStore.set(record.id, { ...record, instances: [...record.instances] });
        const ids = [...untrack(() => this._sceneIds.get())];
        ids.splice(index, 0, record.id);
        this._sceneIds.set(ids);
      },
      removeScene: (id) => {
        const ids = untrack(() => this._sceneIds.get());
        const index = ids.indexOf(id);
        const record = id === untrack(() => this._scene.get()) ? this.captureScene() : this.sceneStore.get(id)!;
        if (id === untrack(() => this._scene.get())) this.switchSceneGone();
        this.sceneStore.delete(id);
        this._sceneIds.set(ids.filter((s) => s !== id));
        return { index, scene: record };
      },
      setLibraryName: (name) => this._libraryName.set(name),
      setPrimary: (id) => this._primary.set(id),
      get embeddedCells() {
        let n = 0;
        const all = [...scene.docs.values(), ...[...untrack(() => scene._derived.get()).values()].map((d) => d.doc)];
        for (const d of all) {
          const size = untrack(() => d.size);
          const rasters = untrack(() => d.layers).filter((l) => !l.shape).length;
          n += size[0] * size[1] * size[2] * rasters * Math.max(1, untrack(() => d.frames.length));
        }
        return n;
      },
    };
  }

  // #endregion
}


