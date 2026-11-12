// A voxel document: its data and everything that depends only on it. Editing sessions
// (`Editor`) hold one and react to its events; scenes hold many and open sessions on few. See
// docs/editor-architecture.md.

import { batch, untrack } from "solid-js";
import { signal } from "./signal";
import { checkTags, DEFAULT_FPS, FIRST_FRAME_ID, isDuration, isFps, MAX_FRAMES, type AnimationTag } from "./animation";
import { MAX_COLORS } from "./color";
import { composeLayers, SourceCache } from "./evaluate";
import { invertEntry, type Entry, type Inversion } from "./history";
import {
  applyOps,
  checkJson,
  isValidId,
  MAX_ANIMATION_BYTES,
  MAX_SIZE,
  newFrameId,
  newGen,
  newLayerId,
  openFrame,
  randomId,
  revertOps,
  type DocOp,
  type DocTarget,
  type FrameRecord,
  type LayerRecord,
} from "./ops";
import { DEFAULT_PALETTE } from "./palette";
import { checkSource, isResolution, type ShapeSource } from "./source";
import { checkMarkers, checkOrigin, type Marker } from "./markers";
import { checkEffects } from "./effects";
import { checkBlend } from "./evaluate";
import type { AnimationFrame, Box, DocumentData, DocumentFrame, Json, Layer, LayerGroup, Vec3 } from "./types";

export const DEFAULT_SIZE: Vec3 = [32, 32, 32];

/** A new, empty document: one layer, the default palette. */
export function defaultDocument(size: Vec3 = DEFAULT_SIZE, palette: readonly number[] = DEFAULT_PALETTE.colors, name = "Untitled"): DocumentData {
  return {
    name,
    size: [...size],
    palette: [0, ...palette],
    layers: [{ name: "Layer 1", visible: true, locked: false, data: new Uint8Array(size[0] * size[1] * size[2]) }],
    activeLayer: 0,
  };
}

export type LayerKind = "raster" | "override" | "shape";

export function layerKind(layer: { coverage?: Uint8Array; shape?: ShapeSource }): LayerKind {
  return layer.shape ? "shape" : layer.coverage ? "override" : "raster";
}

/** Whether a document is plain raster layers at 1×: no shape layers, overrides or other resolution, so formats without them lose nothing. */
export function isFlatDocument(doc: DocumentData): boolean {
  return (doc.resolution ?? 1) === 1 && !doc.layers.some((l) => l.shape || l.coverage);
}

/** What a document can hold, set by the app it is in. */
export interface DocumentOptions {
  /** Keep the resolution at 1×. */
  lockResolution?: boolean;
}

/** What changed, after it changed. */
export type DocumentChange =
  /** The layer list (and with it the open frame's arrays): `before` is the list it replaced. */
  | { kind: "layers"; before: readonly Layer[] }
  /** The grid: size, generation and resolution. A `layers` change follows. */
  | { kind: "grid" }
  | { kind: "palette" }
  | { kind: "meta" }
  /** The whole document was replaced. */
  | { kind: "load"; data: DocumentData; origin: string };

/**
 * What changes are about to happen that replace arrays a session may point into: a new grid,
 * another frame opening, or a whole new document. Sessions drop what they have in progress.
 */
export type DocumentReplacing = "grid" | "frame" | "load";

export interface DocumentListener {
  willReplace?(what: DocumentReplacing): void;
  changed?(change: DocumentChange): void;
  /** One cell of an array the open frame shows was written. */
  cell?(data: Uint8Array, index: number): void;
}

/** Where an array belongs: a layer, the frame it is in, and which of the layer's arrays. */
export interface ArrayOwner {
  id: string;
  frame?: string;
  channel?: "coverage";
}

/**
 * A voxel document: name, grid, palette, layers, frames and host data, changed through document
 * ops (`ops.ts`) and cell writes. State is read through reactive getters. It knows nothing of
 * tools, selections or views: those are an editing session's (`Editor`).
 */
export class VoxelDocument {
  private _name = signal("Untitled");
  private _size = signal<Vec3>([...DEFAULT_SIZE]);
  private _palette = signal<readonly number[]>([0, ...DEFAULT_PALETTE.colors]);
  private _layers = signal<readonly Layer[]>([]);
  private _resolution = signal(1);
  /** Frames in order. The open frame's voxels are the layers' data; the others keep theirs in `cels`. */
  private _frames = signal<readonly FrameRecord[]>([{ id: FIRST_FRAME_ID, duration: 1 }]);
  /** The frame whose voxels the layers hold. */
  private _frame = signal(FIRST_FRAME_ID);
  private _tags = signal<readonly AnimationTag[]>([]);
  private _fps = signal(DEFAULT_FPS);
  private _hostData = signal<Readonly<Record<string, Json>>>({});
  private _markers = signal<readonly Marker[]>([]);
  private _groups = signal<readonly LayerGroup[]>([]);
  private _origin = signal<Vec3 | null>(null);
  /** Bumped by every commit (local or remote) and layer visibility or lock change: what autosave follows. */
  private _version = signal(0);
  /** Bumped (at most once per microtask) by every change to voxels or structure, mid-stroke too. */
  private _contentVersion = signal(0);
  private contentQueued = false;
  /** Goes up at once with every write or structural change: what the volume cache checks. */
  private contentSerial = 0;
  /** Each frame's composed volume, and the serial it was composed at. */
  private volumes = new Map<string, { serial: number; data: Uint8Array }>();

  private _docId = randomId("doc:");
  private _revision = 0;
  private extraKeys: Record<string, Json> | undefined;
  /** The active layer the last load named (by id): what `toData` gives when no session says. */
  private loadedActive: string | undefined;
  /** The grid's generation. It changes with every resize, so voxel edits from another grid don't apply. */
  gen = newGen();
  private _resolutionLock: boolean;
  /** Evaluated shape sources per layer, shared with sessions' drafts. */
  readonly sourceCache = new SourceCache();
  /** Which layer (and frame, for voxels) each of the document's arrays belongs to. */
  private owners = new WeakMap<Uint8Array, ArrayOwner>();
  private listeners = new Set<DocumentListener>();
  /** The document as document ops see it. */
  readonly target: DocTarget;

  constructor(data?: DocumentData, options: DocumentOptions = {}) {
    this._resolutionLock = !!options.lockResolution;
    this.target = this.createTarget();
    this.load(data ?? defaultDocument());
  }

  // #region State

  get name() {
    return this._name.get();
  }
  get size(): Vec3 {
    return this._size.get();
  }
  get palette(): readonly number[] {
    return this._palette.get();
  }
  get layers(): readonly Layer[] {
    return this._layers.get();
  }
  /** Output cells per source unit along each axis: 1, 2, 4 or 8. See docs/vector-raster.md. */
  get resolution() {
    return this._resolution.get();
  }
  /** The frames in order: each pose, and how many ticks it lasts. See docs/animation.md. */
  get frames(): readonly AnimationFrame[] {
    return this._frames.get();
  }
  /** The frame whose voxels the layers hold: the one being edited. */
  get openFrameId(): string {
    return this._frame.get();
  }
  get tags(): readonly AnimationTag[] {
    return this._tags.get();
  }
  /** Ticks per second: a frame lasting `duration` ticks shows for `duration / fps` seconds. */
  get fps(): number {
    return this._fps.get();
  }
  get hostData(): Readonly<Record<string, Json>> {
    return this._hostData.get();
  }
  /** Named points and volumes that aren't voxels: mounts, colliders, hitboxes. See docs/pipeline.md. */
  get markers(): readonly Marker[] {
    return this._markers.get();
  }
  marker(id: string): Marker | undefined {
    return this.markers.find((m) => m.id === id);
  }
  /** The point the model is placed by and turns around, in source units; null is the center of its floor. */
  get origin(): Vec3 | null {
    return this._origin.get();
  }
  /** Layer groups: isolated stages that layers and groups name. See docs/pipeline.md. */
  get groups(): readonly LayerGroup[] {
    return this._groups.get();
  }
  group(id: string): LayerGroup | undefined {
    return this.groups.find((g) => g.id === id);
  }
  /** The document's stable identity. Kept by saving; a new document gets a new one. */
  get docId() {
    return this._docId;
  }
  /** Goes up with every committed change to the document, undo, redo and remote edits included. */
  get revision() {
    this._version.get();
    return this._revision;
  }
  /** Bumped by every commit and every visibility or lock change: anything saved changed. */
  get version() {
    return this._version.get();
  }
  /** Bumped by every change to voxels or structure, during a stroke too: what caches of its volumes follow. */
  get contentVersion() {
    return this._contentVersion.get();
  }
  get resolutionLocked() {
    return this._resolutionLock;
  }
  /** Keep the resolution where it is from now on. */
  lockResolution() {
    this._resolutionLock = true;
  }
  /** Whether the document is plain raster layers at 1×: no shape layers, override layers or other resolution. */
  get isFlat(): boolean {
    return this.resolution === 1 && !this.layers.some((l) => l.shape || l.coverage);
  }
  get isAnimated(): boolean {
    return this.frames.length > 1;
  }

  layer(id: string): Layer | undefined {
    return this.layers.find((l) => l.id === id);
  }

  voxelCount() {
    const [x, y, z] = this.size;
    return x * y * z;
  }

  grid() {
    return { size: untrack(() => this.size), resolution: untrack(() => this.resolution) };
  }

  /** Which layer, frame and channel an array belongs to; undefined for arrays that aren't the document's. */
  ownerOf(data: Uint8Array): ArrayOwner | undefined {
    return this.owners.get(data);
  }

  // #endregion

  // #region Reads

  /** A layer's voxels in a frame. Read-only. Empty (length 0) for a shape layer. */
  frameCel(frameId: string, layerId: string): Uint8Array {
    this.contentVersion;
    const layer = this.layer(layerId);
    if (!layer) return new Uint8Array(this.voxelCount());
    if (layer.shape || frameId === this.openFrameId) return layer.data;
    return this._frames.get().find((f) => f.id === frameId)?.cels?.[layerId] ?? new Uint8Array(this.voxelCount());
  }

  /** Every voxel array of a raster layer, in every frame. */
  layerCels(layer: Layer): Uint8Array[] {
    if (layer.shape) return [];
    const open = untrack(() => this._frame.get());
    return untrack(() => this._frames.get()).map((f) => (f.id === open ? layer.data : (f.cels?.[layer.id] ?? layer.data)));
  }

  /**
   * The committed result: visible layers (or all of them) composed into one volume, in the open
   * frame. Nothing a session hides or previews is applied. What exports use.
   */
  evaluate(options: { allLayers?: boolean } = {}): Uint8Array {
    this.contentVersion;
    return composeLayers(untrack(() => this.layers), this.grid(), {
      cache: this.sourceCache,
      groups: untrack(() => this.groups),
      include: options.allLayers ? () => true : undefined,
      includeGroup: options.allLayers ? () => true : undefined,
    });
  }

  /** A frame's visible layers (or all, or some) composed into one volume. */
  evaluateFrame(frameId: string, options: { allLayers?: boolean; layers?: readonly string[] } = {}): Uint8Array {
    this.contentVersion;
    const only = options.layers && new Set(options.layers);
    const layers = untrack(() => this.layers).map((l) => (l.shape ? l : { ...l, data: untrack(() => this.frameCel(frameId, l.id)) }));
    return composeLayers(layers, this.grid(), {
      cache: this.sourceCache,
      groups: untrack(() => this.groups),
      include: only ? (l) => only.has((l as Layer).id) : options.allLayers ? () => true : undefined,
      includeGroup: only || options.allLayers ? () => true : undefined,
    });
  }

  /**
   * A frame's visible layers composed into one volume (the open frame's by default), cached until
   * anything in the document changes. Read-only: shared by every caller. What renderers, picking
   * and surfaces read, since it never depends on a session.
   */
  volume(frameId = untrack(() => this.openFrameId)): Uint8Array {
    this.contentVersion;
    const cached = this.volumes.get(frameId);
    if (cached && cached.serial === this.contentSerial) return cached.data;
    const data = untrack(() => this.evaluateFrame(frameId));
    this.volumes.set(frameId, { serial: this.contentSerial, data });
    return data;
  }

  /** A layer's own values: a raster layer's voxels, or a shape layer's committed evaluation. Read-only. */
  layerValues(layer: Layer | string): Uint8Array {
    const l = typeof layer === "string" ? this.layer(layer) : layer;
    if (!l) return new Uint8Array(this.voxelCount());
    return l.shape ? this.sourceCache.get(l.shape, this.grid(), l.id) : l.data;
  }

  /** The bounding box of every filled voxel in visible layers of the open frame, or null when empty. */
  contentBounds(): Box | null {
    const volume = this.evaluate();
    const [sx, sy] = untrack(() => this.size);
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-1, -1, -1];
    for (let i = 0; i < volume.length; i++) {
      if (!volume[i]) continue;
      const c = [i % sx, Math.floor(i / sx) % sy, Math.floor(i / (sx * sy))];
      for (let a = 0; a < 3; a++) {
        if (c[a] < min[a]) min[a] = c[a];
        if (c[a] > max[a]) max[a] = c[a];
      }
    }
    return max[0] < 0 ? null : { min, max };
  }

  /** The committed result as a document with one raster layer at 1× units, for flat exports. */
  flatDocument(): DocumentData {
    return {
      name: this.name,
      size: [...this.size],
      palette: [...this.palette],
      layers: [{ name: this.name, visible: true, locked: false, data: this.evaluate() }],
      activeLayer: 0,
    };
  }

  // #endregion

  // #region Changes

  /** Hear about changes: before arrays are replaced, after anything changes, and each cell written. Returns a function that stops. */
  listen(listener: DocumentListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Apply ops made elsewhere (a live room's), without history: all or nothing, throwing an
   * `OpError` that changes nothing if they don't fit. Counts as a committed change.
   */
  applyRemote(ops: readonly DocOp[]) {
    applyOps(this.target, ops, true);
    this.commit();
  }

  /** Take back ops applied earlier (newest first), without history. */
  revertRemote(ops: readonly DocOp[]) {
    revertOps(this.target, ops);
    this.commit();
  }

  /**
   * Take back an undo entry on the document alone: its ops still owned, newest first. Local
   * items (a session's selection) run as they are. For undoing a model with no session open.
   */
  takeBack(entry: Entry): Inversion {
    const inversion = invertEntry(this.target, entry);
    if (inversion.items.some((item) => "op" in item)) this.commit();
    return inversion;
  }

  /** A change was committed: the revision goes up and everything that saves hears of it. */
  commit() {
    this._revision++;
    this.bumpVersion();
  }

  /** Show or hide, lock or unlock a layer. Saved, but not an op: not shared or undoable. */
  setLayerMeta(id: string, patch: Partial<Pick<Layer, "visible" | "locked">>) {
    const before = untrack(() => this.layers);
    if (!before.some((l) => l.id === id)) return;
    this._layers.set(before.map((l) => (l.id === id ? { ...l, ...patch } : l)));
    this.queueContent();
    this.bumpVersion();
    this.emit({ kind: "layers", before });
  }

  /** Show or hide a group. Saved, but not an op: not shared or undoable, like a layer's visibility. */
  setGroupVisible(id: string, visible: boolean) {
    const before = untrack(() => this.groups);
    if (!before.some((g) => g.id === id)) return;
    this._groups.set(before.map((g) => (g.id === id ? { ...g, visible } : g)));
    this.queueContent();
    this.bumpVersion();
    this.emit({ kind: "layers", before: untrack(() => this.layers) });
  }

  /**
   * Open another frame for editing: the layers take its voxels, and the frame that was open keeps
   * its own. Not an edit: no history, no version. Sessions drop what they had in progress first.
   */
  openFrame(id: string) {
    if (id === untrack(() => this._frame.get())) return;
    this.notifyReplacing("frame");
    const { frames, layers } = openFrame(untrack(() => this._frames.get()), untrack(() => this.layers), untrack(() => this._frame.get()), id, this.voxelCount());
    batch(() => {
      this._frames.set(frames);
      this._frame.set(id);
    });
    this.setLayerRecords(layers);
  }

  /** Write one cell of one of the document's arrays, telling sessions when the open frame shows it. */
  writeCell = (data: Uint8Array, index: number, value: number) => {
    data[index] = value;
    this.queueContent();
    const frame = this.owners.get(data)?.frame;
    // another frame's voxels: nothing a session shows changes
    if (frame !== undefined && frame !== untrack(() => this._frame.get())) return;
    for (const l of this.listeners) l.cell?.(data, index);
  };

  private emit(change: DocumentChange) {
    for (const l of this.listeners) l.changed?.(change);
  }

  private notifyReplacing(what: DocumentReplacing) {
    for (const l of this.listeners) l.willReplace?.(what);
  }

  private bumpVersion() {
    this._version.set(untrack(() => this._version.get()) + 1);
  }

  private queueContent() {
    this.contentSerial++;
    if (this.contentQueued) return;
    this.contentQueued = true;
    queueMicrotask(() => {
      this.contentQueued = false;
      this._contentVersion.set(untrack(() => this._contentVersion.get()) + 1);
    });
  }

  /** Swap in a new layer list: index its arrays, default visibility and lock, and tell sessions. */
  private setLayerRecords(records: readonly LayerRecord[]) {
    const before = untrack(() => this.layers);
    this.indexFrames();
    const frame = untrack(() => this._frame.get());
    const layers = records.map((r): Layer => {
      this.owners.set(r.data, { id: r.id, frame });
      if (r.coverage) this.owners.set(r.coverage, { id: r.id, channel: "coverage" });
      return r.visible === undefined || r.locked === undefined ? { ...r, visible: r.visible ?? true, locked: r.locked ?? false } : (r as Layer);
    });
    this._layers.set(layers);
    this.sourceCache.keep(layers.map((l) => l.id));
    this.queueContent();
    this.emit({ kind: "layers", before });
  }

  /** Note which layer and frame every frame's voxels belong to, so writes to them are recorded. */
  private indexFrames() {
    for (const frame of untrack(() => this._frames.get())) {
      for (const [id, cel] of Object.entries(frame.cels ?? {})) this.owners.set(cel, { id, frame: frame.id });
    }
  }

  /** The document as document ops see it: reading and writing its state, without history. */
  private createTarget(): DocTarget {
    const doc = this;
    return {
      get name() {
        return untrack(() => doc.name);
      },
      get size() {
        return untrack(() => doc.size);
      },
      get gen() {
        return doc.gen;
      },
      get resolution() {
        return untrack(() => doc.resolution);
      },
      get palette() {
        return untrack(() => doc.palette);
      },
      get layers() {
        return untrack(() => doc.layers);
      },
      setName: (name) => {
        this._name.set(name);
        this.emit({ kind: "meta" });
      },
      setPalette: (palette) => {
        this._palette.set(palette);
        this.queueContent();
        this.emit({ kind: "palette" });
      },
      setLayers: (layers) => this.setLayerRecords(layers),
      setGrid: (size, gen, layers, resolution) => {
        this.notifyReplacing("grid");
        this.gen = gen;
        batch(() => {
          if (resolution !== undefined) this._resolution.set(resolution);
          this._size.set(size);
        });
        this.emit({ kind: "grid" });
        this.setLayerRecords(layers);
      },
      writeCell: this.writeCell,
      get frames() {
        return untrack(() => doc._frames.get());
      },
      get frame() {
        return untrack(() => doc._frame.get());
      },
      get fps() {
        return untrack(() => doc.fps);
      },
      setFrames: (frames, current, layers) => {
        if (current !== untrack(() => this._frame.get())) this.notifyReplacing("frame");
        batch(() => {
          this._frames.set(frames);
          this._frame.set(current);
        });
        this.setLayerRecords(layers);
      },
      get tags() {
        return untrack(() => doc.tags);
      },
      setTags: (tags) => {
        this._tags.set(tags);
        this.emit({ kind: "meta" });
      },
      setFps: (fps) => {
        this._fps.set(fps);
        this.emit({ kind: "meta" });
      },
      get hostData() {
        return untrack(() => doc.hostData);
      },
      setHostData: (data) => {
        this._hostData.set(data);
        this.emit({ kind: "meta" });
      },
      get markers() {
        return untrack(() => doc.markers);
      },
      setMarkers: (markers) => {
        this._markers.set(markers);
        this.emit({ kind: "meta" });
      },
      get origin() {
        return untrack(() => doc.origin);
      },
      get groups() {
        return untrack(() => doc.groups);
      },
      setGroups: (groups) => {
        const before = untrack(() => this.layers);
        this._groups.set(groups);
        this.queueContent();
        this.emit({ kind: "layers", before });
      },
      setOrigin: (origin) => {
        this._origin.set(origin);
        this.emit({ kind: "meta" });
      },
    };
  }

  // #endregion

  // #region Load and save

  /**
   * Replace the document. Layers keep their ids when the document has valid, distinct ones (a
   * shared document); otherwise (a file) they get new ones. Throws an Error with a reason, changing
   * nothing, if this document can't hold it (see `DocumentOptions`).
   */
  load(data: DocumentData, origin = "user") {
    const size = data.size.map((n) => Math.max(1, Math.min(MAX_SIZE, Math.floor(n)))) as Vec3;
    const count = size[0] * size[1] * size[2];
    const palette = data.palette.length > 1 ? data.palette.slice(0, MAX_COLORS + 1) : [0, ...DEFAULT_PALETTE.colors];
    const resolution = this.checkSources(data, size, palette.length);
    const given = data.layers.map((l) => l.id);
    const keepIds = given.every(isValidId) && new Set(given).size === given.length;
    const ids = keepIds ? (given as string[]) : data.layers.map(() => newLayerId());
    let layers: Layer[] = data.layers.map((l, i) => {
      const cells = l.shape ? new Uint8Array(0) : l.data.length === count ? l.data : new Uint8Array(count);
      return {
        id: ids[i],
        name: l.name,
        visible: l.visible,
        locked: l.locked,
        data: cells,
        ...(l.shape ? { shape: checkSource(l.shape, palette.length) } : {}),
        ...(l.coverage && !l.shape ? { coverage: l.coverage.length === count ? l.coverage : new Uint8Array(count) } : {}),
        ...readStage(l, count, palette.length, `Layer “${l.name}”`),
        ...(l.hostData !== undefined && l.hostData !== null ? { hostData: checkJson(l.hostData) } : {}),
        ...(l.extra && Object.keys(l.extra).length ? { extra: checkJson(l.extra) as Record<string, Json> } : {}),
      };
    });
    if (layers.length === 0) layers.push({ id: newLayerId(), name: "Layer 1", visible: true, locked: false, data: new Uint8Array(count) });
    const animation = readFrames(data, layers, count, palette.length);
    const tags = checkTags(data.tags ?? [], animation.frames);
    layers = animation.layers;
    const hostData = data.hostData ? (checkJson(data.hostData) as Record<string, Json>) : {};
    const extra = data.extra && Object.keys(data.extra).length ? (checkJson(data.extra) as Record<string, Json>) : undefined;
    const { markers, origin: modelOrigin } = readMarkers(data, animation.frameIds);
    const groups = readGroups(data, palette.length);
    const groupIds = new Set(groups.map((g) => g.id));
    // a layer in a group the file doesn't have is ungrouped
    layers = layers.map((l) => (l.group && !groupIds.has(l.group) ? (({ group: _, ...rest }) => rest)(l) : l));

    this.notifyReplacing("load");
    this.gen = data.gen && isValidId(data.gen) ? data.gen : newGen();
    this._docId = data.docId && isValidId(data.docId) ? data.docId : randomId("doc:");
    this._revision = Number.isInteger(data.revision) && data.revision! >= 0 ? data.revision! : 0;
    this.extraKeys = extra;
    this.loadedActive = layers[Math.max(0, Math.min(layers.length - 1, Math.floor(data.activeLayer ?? 0)))]?.id;
    batch(() => {
      this._name.set(data.name || "Untitled");
      this._hostData.set(hostData);
      this._markers.set(markers);
      this._groups.set(groups);
      this._origin.set(modelOrigin);
      this._size.set(size);
      this._resolution.set(resolution);
      this._palette.set(palette);
      this._frames.set(animation.frames);
      this._frame.set(animation.current);
      this._fps.set(animation.fps);
      this._tags.set(tags);
      this._layers.set(layers);
    });
    this.indexFrames();
    for (const layer of layers) {
      this.owners.set(layer.data, { id: layer.id, frame: animation.current });
      if (layer.coverage) this.owners.set(layer.coverage, { id: layer.id, channel: "coverage" });
    }
    this.sourceCache.keep(layers.map((l) => l.id));
    this.queueContent();
    this.bumpVersion();
    this.emit({ kind: "load", data, origin });
  }

  /**
   * Check what a document needs beyond raster layers before anything is replaced. Returns its
   * resolution; throws an Error with a reason if this document can't hold it.
   */
  private checkSources(data: DocumentData, size: Vec3, paletteLength: number): number {
    if (isFlatDocument(data)) return 1;
    const resolution = data.resolution ?? 1;
    if (!isResolution(resolution)) throw new Error("The model's resolution must be 1, 2, 4 or 8");
    if (resolution > 1 && this._resolutionLock) throw new Error("This editor only supports models at 1× resolution");
    if (size.some((n) => n % resolution)) throw new Error(`At ${resolution}× resolution, the model's size must be a multiple of ${resolution}`);
    const count = size[0] * size[1] * size[2];
    for (const layer of data.layers) {
      if (layer.shape) {
        try {
          checkSource(layer.shape, paletteLength);
        } catch (e) {
          throw new Error(`Layer “${layer.name}”: ${(e as Error).message}`);
        }
      }
      const { coverage, data: values } = layer;
      if (!coverage || layer.shape) continue;
      if (coverage.length !== count || values.length !== count) throw new Error(`Layer “${layer.name}” doesn't fit the model`);
      for (let i = 0; i < count; i++) {
        if (coverage[i] > 1 || (values[i] && !coverage[i])) throw new Error(`Layer “${layer.name}” has malformed coverage`);
      }
    }
    return resolution;
  }

  /**
   * The whole document as data. Layers carry their ids and the grid its generation, which files
   * leave out. `activeLayer` and `activeFrame` are a session's, so it passes them (by id).
   */
  toData(session: { activeLayer?: string; activeFrame?: string } = {}): DocumentData {
    const layers = this.layers;
    const resolution = this.resolution;
    const hostData = this.hostData;
    const frames = this.frames;
    const editing = session.activeFrame ?? this.openFrameId;
    const animated = frames.length > 1 || this.tags.length > 0;
    return {
      docId: this._docId,
      revision: this.revision,
      ...(Object.keys(hostData).length ? { hostData: { ...hostData } } : {}),
      ...(this.extraKeys ? { extra: { ...this.extraKeys } } : {}),
      ...(this.markers.length ? { markers: [...this.markers] } : {}),
      ...(this.origin ? { origin: [...this.origin] as Vec3 } : {}),
      ...(this.groups.length ? { groups: this.groups.map((g) => ({ ...g })) } : {}),
      name: this.name,
      size: [...this.size],
      gen: this.gen,
      palette: [...this.palette],
      ...(resolution !== 1 ? { resolution } : {}),
      layers: layers.map((l) => {
        return {
          id: l.id,
          name: l.name,
          visible: l.visible,
          locked: l.locked,
          data: l.shape ? l.data : untrack(() => this.frameCel(editing, l.id)),
          ...(l.coverage ? { coverage: l.coverage } : {}),
          ...(l.shape ? { shape: l.shape } : {}),
          ...(l.blend ? { blend: l.blend } : {}),
          ...(l.mask ? { mask: l.mask } : {}),
          ...(l.effects ? { effects: [...l.effects] } : {}),
          ...(l.group ? { group: l.group } : {}),
          ...(l.hostData !== undefined ? { hostData: l.hostData } : {}),
          ...(l.extra ? { extra: { ...l.extra } } : {}),
        };
      }),
      activeLayer: Math.max(0, layers.findIndex((l) => l.id === (session.activeLayer ?? this.loadedActive))),
      ...(animated
        ? {
            fps: this.fps,
            tags: this.tags.map((t) => ({ ...t })),
            frames: frames.map((f) => ({
              id: f.id,
              duration: f.duration,
              cels: layers.map((l) => (l.shape ? new Uint8Array(0) : untrack(() => this.frameCel(f.id, l.id)))),
            })),
            activeFrame: Math.max(0, frames.findIndex((f) => f.id === editing)),
          }
        : {}),
    };
  }

  // #endregion
}

/**
 * Frames from a document, checked before anything is replaced: the frame records (the open one
 * without cels), its id, and the layers holding its voxels. Throws an Error with a reason.
 */
function readFrames(doc: DocumentData, layers: Layer[], count: number, paletteLength: number) {
  const fps = doc.fps ?? DEFAULT_FPS;
  if (!isFps(fps)) throw new Error("The model's frames per second must be a whole number from 1 to 60");
  const given = doc.frames;
  if (!given?.length || !doc.layers.length) {
    return { frames: [{ id: FIRST_FRAME_ID, duration: 1 }] as FrameRecord[], current: FIRST_FRAME_ID, fps, layers, frameIds: new Map([[FIRST_FRAME_ID, FIRST_FRAME_ID]]) };
  }
  if (given.length > MAX_FRAMES) throw new Error(`An animation can have at most ${MAX_FRAMES} frames`);
  if (given.length > 1 && layers.some((l) => l.coverage)) throw new Error("Override layers can't be animated yet");
  if (given.length * layers.filter((l) => !l.shape).length * count > MAX_ANIMATION_BYTES) {
    throw new Error("This animation is too big to open");
  }
  const ids = given.map((f) => f.id);
  const keepIds = ids.every(isValidId) && new Set(ids).size === ids.length;
  // an array two cels share is copied, so each stays independent
  const seen = new Set<Uint8Array>();
  const records = given.map((f: DocumentFrame, n): FrameRecord & { cels: Record<string, Uint8Array> } => {
    if (!isDuration(f.duration)) throw new Error(`Frame ${n + 1} must last a whole number of ticks, from 1 to 999`);
    if (!Array.isArray(f.cels) || f.cels.length !== doc.layers.length) throw new Error(`Frame ${n + 1} doesn't match the layers`);
    const cels: Record<string, Uint8Array> = {};
    layers.forEach((l, i) => {
      if (l.shape) return;
      let cel = f.cels[i];
      if (!(cel instanceof Uint8Array) || cel.length !== count) throw new Error(`Frame ${n + 1} doesn't fit the model`);
      for (let k = 0; k < count; k++) if (cel[k] >= paletteLength) throw new Error(`Frame ${n + 1} uses a color that isn't in the palette`);
      if (seen.has(cel)) cel = cel.slice();
      seen.add(cel);
      cels[l.id] = cel;
    });
    const id = keepIds ? ids[n]! : n === 0 ? FIRST_FRAME_ID : newFrameId();
    return { id, duration: f.duration, cels };
  });
  const open = records[Math.max(0, Math.min(records.length - 1, Math.floor(doc.activeFrame ?? 0)))];
  return {
    frames: records.map((f): FrameRecord => (f === open ? { id: f.id, duration: f.duration } : f)),
    current: open.id,
    fps,
    layers: layers.map((l) => (l.shape ? l : { ...l, data: open.cels[l.id] })),
    // the ids marker keys may name (the file's, or by position when the file's weren't usable) and the ids they become
    frameIds: new Map(records.map((f, n) => [typeof ids[n] === "string" ? ids[n]! : `#${n}`, f.id])),
  };
}

/**
 * A document's markers and origin, checked before anything is replaced. Keys name frames by the
 * ids the document gave them, mapped to the ids its frames get. Throws an Error with a reason.
 */
function readMarkers(doc: DocumentData, frameIds: ReadonlyMap<string, string>): { markers: Marker[]; origin: Vec3 | null } {
  const origin = doc.origin ? checkOrigin(doc.origin) : null;
  if (!doc.markers?.length) return { markers: [], origin };
  const renamed = doc.markers.map((m) =>
    m.keys ? { ...m, keys: m.keys.filter((k) => frameIds.has(k.frame)).map((k) => ({ ...k, frame: frameIds.get(k.frame)! })) } : m,
  );
  try {
    return { markers: checkMarkers(renamed, new Set(frameIds.values()), checkJson), origin };
  } catch (e) {
    throw new Error(`The model's markers: ${(e as Error).message}`);
  }
}

/** A layer's blend, mask, effects and group from a document, checked. Throws an Error with a reason. */
function readStage(l: { blend?: unknown; mask?: unknown; effects?: unknown; group?: unknown }, count: number, paletteLength: number, what: string) {
  try {
    const effects = l.effects === undefined ? [] : checkEffects(l.effects, paletteLength);
    const mask = l.mask instanceof Uint8Array && l.mask.length === count ? l.mask : undefined;
    return {
      ...(l.blend ? { blend: checkBlend(l.blend) } : {}),
      ...(mask ? { mask: Uint8Array.from(mask, (v) => (v ? 1 : 0)) } : {}),
      ...(effects.length ? { effects } : {}),
      ...(typeof l.group === "string" && isValidId(l.group) ? { group: l.group } : {}),
    };
  } catch (e) {
    throw new Error(`${what}: ${(e as Error).message}`);
  }
}

/** A document's layer groups, checked: valid distinct ids, names, blends and effects; links to groups that aren't there, or that loop, dropped. */
function readGroups(doc: DocumentData, paletteLength: number): LayerGroup[] {
  const given = doc.groups ?? [];
  if (!Array.isArray(given)) throw new Error("The model's groups must be a list");
  const ids = new Set<string>();
  const groups = given.map((g, n): LayerGroup => {
    if (!g || typeof g !== "object" || !isValidId(g.id) || ids.has(g.id)) throw new Error(`Group ${n + 1} needs a distinct id`);
    ids.add(g.id);
    const name = typeof g.name === "string" && g.name.trim() ? g.name.trim().slice(0, 120) : `Group ${n + 1}`;
    try {
      const effects = g.effects === undefined ? [] : checkEffects(g.effects, paletteLength);
      return {
        id: g.id,
        name,
        visible: g.visible !== false,
        ...(g.blend ? { blend: checkBlend(g.blend) } : {}),
        ...(effects.length ? { effects } : {}),
        ...(typeof g.group === "string" ? { group: g.group } : {}),
      };
    } catch (e) {
      throw new Error(`Group “${name}”: ${(e as Error).message}`);
    }
  });
  const byId = new Map(groups.map((g) => [g.id, g]));
  return groups.map((g) => {
    if (!g.group) return g;
    // keep the link only if it leads somewhere without coming back
    const seen = new Set([g.id]);
    let ok = true;
    for (let at = byId.get(g.group); at; at = at.group ? byId.get(at.group) : undefined) {
      if (seen.has(at.id)) {
        ok = false;
        break;
      }
      seen.add(at.id);
    }
    if (ok && byId.has(g.group)) return g;
    const { group: _, ...rest } = g;
    return rest;
  });
}
