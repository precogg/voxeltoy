# Libraries: one file, one thing open

Draft, November 7, 2026. It replaces the scene document (`.moxscene`, never released), the
web app's separate model and scene drafts, and the scratch scene per model. The scene tree and
the breadcrumb ([workspace.md](workspace.md)) stay; what they show now lives in one library.

## Status

Phases 1 and 2 are built (November 7, 2026, branch `workspace`): `LibraryEditor`
(`packages/core/src/library.ts`), `.voxeltoy` version 4 (`formats/library.ts`; versions 1 to 3 read
as a library of one; `parseMoxel` still gives tools one model), `.moxscene` gone, library agent
tools (`get_library`, `open`, `new_scene`), and in the SDK `LibraryView` with the library list,
models on their own, scenes and the breadcrumb from `Library`. The web app keeps one library in
IndexedDB (`library-store.ts`); sharing and live rooms are off (`session.ts` and its UI stay,
unused). A model's file is one model object per entry (`"model": { …a version 1–3 file… }`)
rather than its fields inline.

The CLI reads libraries (phase 3, November 7, 2026, branch `level-hosts`): `voxeltoy mcp` opens the
whole library, with one model open for the model tools (the primary model, else the primary
scene's stage, else the first model), the library and scene tools (`get_library`, `open`,
`add_model`, `get_scene`, ...) to move around it, and `save_file` writing all of it as version 4.
`voxeltoy info` lists models and scenes; `render` and `convert` take `--model` (an id or name).

Not yet (phase 3): the Godot loader reading libraries beyond the primary model; `.vox` scene
graphs as scenes; share links as library snapshots; thumbnails in the library list.

## Why

The app ended up holding several documents at once: a model draft, a scene draft, a scratch
scene per model, and copies of models embedded in scenes. Menus had to say which one you meant
("Open my model", "Open the scene on this device"), and editing a model in a scene changed a
copy. That is Flash's symbol confusion with more steps.

## The idea

- **A `.voxeltoy` file is a library**: models and scenes, and optionally one **primary** resource,
  the one that opens first.
- **A scene refers to the library's models by id.** There are no copies: a knight placed in
  three scenes is one model, and editing it anywhere edits it everywhere.
- **One library is open at a time**, and it is what the device keeps. Inside it you move with
  the breadcrumb: `Library › Level 1 › Knight`.
- **One history** for the whole library: model edits, scene edits and library changes undo in
  the order they were made.
- **Older files** (versions 1 to 3, one model each, whether `.voxeltoy` or legacy `.moxel`) open as a library holding that
  model as its primary. `.moxscene` is gone.

## The format

`.voxeltoy` version 4: JSON, as now, with voxels run-length encoded and base64.
New files use `.voxeltoy` and `"format": "voxeltoy"`. Files named `.moxel`, and
`"format": "moxel"`, still open. The version number is unchanged.

```jsonc
{
  "format": "voxeltoy", "version": 4,
  "docId": "lib:…", "revision": 12, "name": "Knights",
  "primary": "model:knight",              // optional: a model or scene id
  "models": [
    { "id": "model:knight", "voxelSize": 1, ...a model as version 1–3 hold it (name, size, palette, layers, frames, data) }
  ],
  "scenes": [
    { "id": "scene:level1", "name": "Level 1", "ground": { … }, "stage": "model:course",
      "instances": [ { "id": "inst:…", "model": "model:knight", … } ],
      "kinds": { … }, "data": { … } }
  ],
  "data": { … }                           // host data, by namespace
}
```

- **Models** keep everything a version 1–3 file has (layers, shapes, frames, tags, host data,
  `docId` and `revision`), so a model taken out of a library is an ordinary model.
- **Scenes** hold what `SceneDocument` holds today, minus models: instances name a model of the
  library (or a host kind). A host's `ref` and `built` models stay, as library models marked so.
- **Reading**: versions 1 to 3 become a library with one model, which is primary. Version 4
  reads as is. Anything newer is turned down with a reason.
- **Writing** is always version 4. **Export model…** writes one model as a library of one, so
  any file opens anywhere; the CLI and Godot loader read the primary model (or a named one).

## The UI

What opens is the primary resource; with none, the library itself.

- **Library view** (`Library` in the breadcrumb, or the first crumb): the left panel lists
  **Models** and **Scenes**. **+** adds a new model, a new scene (it starts, like a new document,
  in a new empty model placed in it, open to draw in; one undo step), or imports a file (a `.voxeltoy`'s
  resources, a `.vox`, an image palette). Each row's menu: Rename, Duplicate, Delete, Make
  primary, Export…, and for a model **New scene with this model**.
- **A model** opens alone: `Library › Knight`, the layers panel as today. To check its scale
  against something, **New scene with this model** makes a scene with it, goes in, and you add
  the player there; delete the scene when you're done.
- **A scene** opens with its tree: `Library › Level 1`. Going into an instance's model reads
  `Library › Level 1 › Knight`, with the scene around it, as now.
- **On a phone** the top bar stays small. Where you are is a line of small text under it
  (`Level 1 › Knight`; the library, where every path starts, is left out); a tap on it lists every
  crumb, Library first, to go back to. The menu's first entry also leads back up (Back to library,
  or Back to the scene from a model in it). While a shape is edited in place, the bar keeps its
  back button instead, the way out.
- **The main menu**: New library (it starts with one empty model, its primary, open), Open…, Save (the library), Import…, Export (the open model or
  scene: `.glb`, `.png`, `.vox`, a model as `.voxeltoy`), and the rest as today.
- **Deleting a model** used in scenes says where, and deletes those instances with it, in one
  undo step.

## On the device

One library draft in IndexedDB, saved as it changes, and opened on start. Opening or creating a
library replaces it (after asking, when it has anything in it). The localStorage model draft,
the scene draft, the scratch scenes and the mode preference go; on first start, an existing
model draft becomes the library's primary model.

## Sharing

Share links and live rooms are about one model today and stay off while libraries land (the
code stays; the UI hides them). They come back as a library snapshot first, and live rooms later.

## Core

`LibraryEditor` (`packages/core/src/library.ts`) grows out of `SceneEditor`, which already has
most of it: model documents with sessions only for what is open, one history, scene ops,
groups, attachment and host kinds.

- **Holds** the library's models (`VoxelDocument`s), its scenes (each a list of instances,
  ground, stage, host data), the primary, and one history.
- **Opens** one thing: `library.open` is `null` (the library), `{ model }`, `{ scene }`, or
  `{ scene, instance }` (a model gone into from a scene). Not undoable, not saved.
- **Scene methods** (`addInstance`, `groupInstances`, `placeInTree`, ...) act on the open scene;
  instance ops carry their scene's id.
- **Library ops**: add, remove, rename and duplicate models and scenes, set the primary. Like
  every op they are checked, inverted and shareable.
- `SceneEditor` goes; hosts that want one scene make a library with one.

## What went

These names are already gone: `formats/moxscene.ts`, `scene-files.ts`'s scene open and save, `scene-store.ts` (drafts, scratch
scenes, the mode), `scratchScene` and `SceneDocument.document`, the app's separate model draft, and the menu items that moved between a model and a scene.

## Phases

1. **Core.** `LibraryEditor`; `.voxeltoy` version 4 read and write, versions 1–3 read as a library
   of one; `.moxscene` removed; agent tools on the open scene and the library. *Done when* the
   tests that build scenes run against libraries, an old `.voxeltoy` round trips into version 4
   with nothing lost, and undo crosses a model edit, a scene edit and a rename in order.
2. **App.** One library on the device; the library view; opening models and scenes from it; the
   breadcrumb from `Library`; New scene with this model; Import; Export; sharing hidden. *Done
   when* a phone user can start a library, make a knight, check it against an imported player
   in a new scene, reload, and save one `.voxeltoy` holding all of it.
3. **Edges.** The CLI and Godot loader read libraries; `.vox` import brings its scene graph as
   a scene; share links as library snapshots.
