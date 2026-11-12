# Editor architecture: documents and sessions

Plan, November 7, 2026. Being carried out on the `editor-split` branch.

## Why

`Editor` (`packages/core/src/editor.ts`, ~4,500 lines) holds two different things:

- **A document:** name, grid, palette, layers, frames, host data, and the ops that change
  them.
- **An editing session on it:** tools, selection, floating content, extrusion, shape drafts,
  workplane, slice, mirror, 2D mode, playback, onion skins, hidden cells, history and the
  composite volume the view draws.

That was fine with one model per page. Scenes need many documents and only one or two
sessions, and the coupling shows:

- **Every scene model gets a full editing session,** with its tool controller, selection
  mask and composite, even if it is never opened.
- **What the document holds depends on the session.** Each layer's `data` is the open
  frame's, and playback rewrites the document's frames and layers on every frame change.
- **Document changes reach straight into session state.** A resize cancels shapes and
  floating content and resets the selection from inside the document's op target. The same
  "drop what's pending" sequence is copied into seven places.
- **Some document reads come back filtered by the session.** `contentBounds`, scene picking
  and surfaces use the composite, which is clipped by the slice and hidden cells.
- **The document is changed outside ops** in places: palette previews, pivot drag previews,
  frame switching.

## Shape

### `VoxelDocument` (`packages/core/src/document.ts`)

The data and everything that depends only on it. It is DOM-free and reactive.

- **State:** `docId`, `revision`, `hostData`, unknown file keys, name, size and grid gen,
  palette, resolution, layers (including visible and locked, which are saved with the file),
  frames, fps, tags, and the open frame (whose cels are the layers' `data`, as ops expect).
- **Changes:** `apply(op)` and `revert(ops)` (checked, through `ops.ts`), and `writeCell`.
  The document keeps `layerOf` so writes can be recorded by layer and frame.
- **Reads:** `layer(id)`, `frameCel`, `evaluate`, `evaluateFrame`, `layerValues`,
  `contentBounds` (unfiltered), and a `volume` (the open frame's visible layers, kept up to
  date cell by cell).
- **Versions:** `contentVersion` goes up on every write, including during a stroke.
  `revision` goes up on every committed change, local or remote.
- **Events** that sessions subscribe to: `onCells`, `onStructure` (layers, grid, frames,
  palette) and `onLoad`.
- **Construction:** `VoxelDocument.from(data, capabilities)` validates (shape sources, resolution
  lock) and builds. `toData()` writes it back out.
- **Undo without a session:** `takeBack(entry)` inverts an entry's ops on the document alone,
  so a scene can undo edits to models that aren't open.

### `Editor` (the session, `packages/core/src/editor.ts`)

Keeps its name and public API, so the SDK, viewport, agent tools and `window.editor` go on
working.

- **Owns** `readonly doc: VoxelDocument`. Document getters (`layers`, `size`, `palette`, ...)
  delegate to it.
- **Holds** everything in the session list above: transactions and strokes, history (its own
  or a host's), the composite and `clipped`, and the tool controller.
- **Reacts to document events** in one place:
  - `onStructure` drops pending work, repairs the active layer, clamps the color and workplane,
    and rebuilds the composite.
  - `onCells` updates the composite and hidden cells.
  - This replaces the session code inside the document's op target.
- **Playback** draws the frame showing without opening it in the document. The document's
  open frame changes only when the user changes frames to edit.

### The session's parts

`Editor` keeps its whole public API, but the larger features live in parts of their own, each
holding its state and logic, with `Editor` forwarding to them:

| Part | File | What it holds |
| --- | --- | --- |
| `EditorFrames` | `editor-frames.ts` | the frame being edited, playback, tags, onion skins |
| `EditorShapes` | `editor-shapes.ts` | shape layers' steps, the step being placed or changed, baking, resolution |
| `EditorExtrusion` | `editor-extrusion.ts` | the extrude tool's face and pending extrusion |
| `EditorFloating` | `editor-floating.ts` | floating content (move, turn, flip, duplicate, paste) and copy |

A part gets an `EditorInternals` (`editor-internals.ts`): the few session internals it needs
beyond the public API, such as `apply`, `write`, `settlePending`, the selection mask and the
shape draft signal. Nothing else sees it, so `window.editor` shows only the public API. A new
feature that stands apart from the rest of the session goes in a part the same way; one that
works through the session's shared state (tools, the selection, layers) stays in `Editor`.

### Scenes

- **Documents only.** `SceneEditor` holds a `VoxelDocument` per model and creates an `Editor`
  only for a model opened in place or the stage, dropping it on close. Undo of a closed model's
  steps goes through `doc.takeBack`; a closed session's selection steps become no-ops.
- **Models from kinds are a cache.** Models that kinds build or link from settings live in a
  separate cache, not in the authored `models` list. That removes the class of bug where the
  list and the editors drift apart.
- **Unfiltered reads.** Rendering, picking, surfaces, bounds and export read documents: the
  `volume` and `evaluateFrame`, never a session's composite.

## Also fixed along the way

- **Undo:** one path for `step` and `takeBack`, with the same cleanup for undo and redo.
- **Repeated code:** a single `dropPending()`, and guard helpers in place of the nine copies
  of `editBlocker` and five of `shapeBlocker`. `layer(id)` replaces 33 `layers.find` calls,
  and coordinate decoding is shared.
- **Labels:** `undoLabel` and `redoLabel` on `Editor` follow the host's history; agent tools
  use them.
- **Clipboard:** an app-level object editors can share, so copy in one model and paste in
  another works.
- **Notices:** a toast id counter (two notices in the same millisecond no longer collapse).
- **Edit guards:** `setVoxel` honors locks and hidden layers like every other edit;
  `clearOverride` and `selectionToLayer` refuse with reasons.
- **Revision:** remote ops bump `revision`.
- **Previews:** palette and pivot previews become session overlays instead of unrecorded
  document writes.
- **Defaults:** one default-document builder shared by `newDocument`, scenes and agent tools.
- **Naming:** for example `extrudeDepth`/`repeatDepth` and the hybrid flags, with every
  consumer updated.

## Stages

Each stage keeps every test passing and ends in a commit.

1. **Extract `VoxelDocument`.** Move the state, op target, `layerOf`, load and validate,
   `getDocument`, evaluation, versions and events. `Editor` delegates. No behavior change
   except unfiltered `contentBounds` and the revision fixes.
2. **Session reacts through events.** Remove the session code from the op target; add
   `dropPending`; unify undo.
3. **Playback without rewriting the document.**
4. **Scenes on documents.** Sessions only on open, the separate kind-model cache, and
   rendering and export from documents.
5. **Cleanups** from the list above.
6. **One persistent viewport for scenes** (no placeholder model, no remount on edit in
   place), and instanced rendering. This one is in `@voxeltoy/three` and the SDK.

## Status

Stages 1–5 are done. Stage 5 brought `layer(id)` for the layer lookups, `refuse()` for the
edit guards, `cellCoord` in `grid.ts`, a shared `VoxelClipboard`, palette and pivot previews as
session overlays, `setVoxel` honoring locks and hidden layers, toast ids from a counter, one
default-document builder, and the names `isFlat` and `lastExtrusionDepth` (the `hybrid` option has since been removed).
Stage 6 is still to do.
