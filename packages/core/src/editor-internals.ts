// What the parts of an editing session reach in the session itself, beyond its public API.
// `Editor` builds one of these for its parts (frames, shape layers, selected content, ...);
// nothing else sees it, so `window.editor` shows only the public API. See docs/editor-architecture.md.

import type { VoxelDocument } from "./document";
import type { Editor, PendingPolicy } from "./editor";
import type { LocalChange } from "./history";
import type { DocOp } from "./ops";
import type { ShapeDraft } from "./shapes";
import type { Layer, Preview, Vec3 } from "./types";

export interface EditorInternals {
  /** The session, for what its public API offers. */
  readonly editor: Editor;
  readonly doc: VoxelDocument;
  /** Apply one document op as part of the transaction (or as its own step). False if it was refused. */
  apply(label: string, op: DocOp): boolean;
  /** Write one cell of a layer's voxel array, recorded in the transaction. */
  write(data: Uint8Array, index: number, value: number): void;
  /** Record a change only this session sees (the selection) in the transaction. */
  local(label: string, change: LocalChange): void;
  /** Whether the document is read-only here, saying so if it is. */
  blocked(): boolean;
  /** Notify with the reason, if there is one. True when refused. */
  refuse(reason: string | null): boolean;
  /** Commit or drop pending work: floating content, an extrusion, a shape being placed, a stroke. */
  settlePending(policy: PendingPolicy, options?: { shape?: PendingPolicy; stroke?: boolean }): void;
  /** Rebuild what the view draws from the layers. */
  rebuildComposite(): void;
  /** Commit floating content and an extrusion. */
  settle(): void;
  /** The selection mask: one byte per cell, 1 = selected. Read-only; change it through `setSelectionState`. */
  readonly selection: Uint8Array;
  setSelectionState(mask: Uint8Array): void;
  /** The box being drawn with the shape brush, or a shape layer step's box being placed or changed. */
  readonly shapeDraft: Signal<ShapeDraft | null>;
  /** What the view previews: outlines and ghost cells. */
  readonly preview: Signal<Preview | null>;
  readonly activeLayerId: Signal<string>;
  /** Redraw the pending shape's preview. */
  refreshShape(): void;
  /**
   * Set a raster cell's state: -1 unset, 0 covered empty, otherwise its color. A legacy layer
   * can't hold a covered empty, so 0 unsets it. Returns whether it changed.
   */
  writeState(layer: Layer, index: number, state: number): boolean;
  /** About to edit the active layer: stop playback, then say why it can't be edited, or null. */
  prepareEdit(): string | null;
  /** How many cells are selected. */
  readonly selectedCount: number;
  /** Rewrite the selected cells of the active layer: `map` on a raster layer, `override` on an override layer. Returns how many changed. */
  editSelection(label: string, map: (value: number) => number, override: (state: number, shown: number) => number | null): number;
  /** Turn or mirror the values of voxels whose values encode a direction (`EditorOptions.transformValue`). */
  orientValues(voxels: Uint8Array, direction: (normal: Vec3) => Vec3): void;
  /** Replace the selection, recorded in the transaction. */
  setSelection(next: Uint8Array, label: string): void;
}

/** A signal as one object (see `signal.ts`). */
export interface Signal<T> {
  get(): T;
  set(value: T): void;
}
