// Copied voxels, held outside any one editor so a copy in one model pastes into another.

import { createSignal } from "solid-js";
import type { Block } from "./selection";
import type { Vec3 } from "./types";

/** What was copied: the cells, where they came from, and the palette their values index into. */
export interface Clip {
  block: Block;
  offset: Vec3;
  palette: readonly number[];
}

/**
 * A clipboard editors can share: pass the same one in `EditorOptions.clipboard`. A scene's
 * models share one; an app can hand the same one to its other editors.
 */
export class VoxelClipboard {
  private _clip = createSignal<Clip | null>(null, { equals: false });

  /** What was copied last, or null. */
  get clip(): Clip | null {
    return this._clip[0]();
  }

  set(clip: Clip | null) {
    this._clip[1](clip);
  }
}
