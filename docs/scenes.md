# Scenes: product and technical design

Draft, November 6, 2026. A proposal, not an implemented feature or a release
commitment. It changes a product principle; see [Principles](#principles).

## Status

The web app's presentation is being redesigned as one workspace with a scene tree; see
[workspace.md](workspace.md). What follows describes what is built today.

All four phases are built (November 2026), on the `scenes` branch:

- **Documents.** `.voxeltoy` files carry `docId`, `revision` and host `data` (on the document and
  each layer) and keep keys they don't know. Host data changes are the `data` and `layer.data`
  ops, within a 64 KiB budget; live rooms refuse them for now, snapshots accept them.
- **One history.** `EditorOptions.history` sends an editor's undo steps to a `HistoryHost`,
  which takes them back with `editor.takeBack`. A scene gives every model an ordinary `Editor`
  (rather than the lightweight targets proposed below), all on its history.
- **Core.** `SceneEditor` (`packages/core/src/scene.ts`) with scene ops, transactions that put
  back what they did if they throw, strokes for drags, attachment that keeps world placement,
  deletes that re-hang children and clear refs, kinds with defaults and kind snapshots,
  re-import by `docId`. `.moxscene` read and write. Agent tools: `get_scene`, `add_model`,
  `place_instances`, `edit_instances`, `select_instances`, `undo_scene`, `redo_scene`,
  `set_scene_view`.
- **Viewport.** `Viewport.setPointerLayer` and `setContentShown`; `SceneLayer` draws instances
  (one geometry per model), the ground, outlines and a move/turn gizmo, and picks, drags,
  lifts and turns instances with snapping.
- **UI.** `SceneView` in the SDK: main bar, outliner, add bar with snap settings, instance bar
  (move, turn, size one axis at a time), shortcuts. The web app switches between the model and
  the scene ("Place in the scene", "Back to my model"), keeps the scene draft in IndexedDB, and
  opens dropped `.moxscene` files.

- **Edit in place and the stage.** `scene.openModel(instance)` / `closeModel()` (UI state, not
  undoable; closing applies what is in progress with `editor.finishPending()`); `newModel()`
  embeds an empty model and places it. `scene.activeModel` is the open model or the stage, and
  `scene.viewMatrix` puts its grid at the view's origin. `SceneView` shows the full model editor
  for it, with a `SceneLayer` around it: dimmed and never picked when editing in place, live
  on the stage, where instances are chosen from the scene tree and moved with the gizmo
  (`SceneLayerOptions.handlesOnly`). One selection at a time: selecting instances deselects the
  active model's voxels and the other way round, in the same undo step. `EditorComponents`
  gained a `ContextBar` slot, which the stage uses for the instance and add bars. Agent tools
  `open_model` and `close_model`; the web app registers the model tools for the open model.

- **Attach and play.** Instances attach to an instance or one of its model's markers from their
  menu (parts were layers until [pipeline.md](pipeline.md) replaced them with markers). Playback: `scene.frameOf(instance, ms)` gives the frame an instance shows on the scene's
  clock (held, looping at a speed from an offset, or by default the frame its model has open,
  so edits show); `SceneLayer` meshes each model per frame and swaps looping instances' meshes
  on one `requestAnimationFrame` clock. The instance menu sets loop, speed, direction, starting
  frame and held frames.
- **Export.** Scene `.glb` (`packages/three/src/scene-export.ts`): a node per instance
  following attachment, a model node scaled by its voxel size, a model's markers as empty nodes
  so what hangs from a marker is that node's child, meshes shared per model and frame, looping instances in the frame showing,
  hidden instances and what hangs from them left out, kinds and resolved
  settings in `extras`. Scene `.png`: the view on a transparent background, without the ground,
  outlines and gizmo.

- **Hosts.** `SceneHost` in the SDK takes `kinds`, `hooks` (linked models), `instanceMenu`,
  `addMenu`, `outlinerBadge` and `overlay` (draw into `layer.overlay`). In core:
  `scene.modelFor(instance)` is an instance's own model or the one its kind supplies: a ref
  linked through `SceneHostHooks.resolveModel` (async is fine), or a document built from its
  settings and cached as a `built` model (one per kind and settings, pruned when unused, kept
  in files so a scene shows them without its host). Linked models are saved through
  `saveModel` after every change to them, undo and redo included; `scene.modelChanged(ref, doc)`
  reloads one changed elsewhere and makes this scene's earlier edits to it un-undoable;
  `refreshLinked()` asks again after a scene opens. `scene.surfaceAt(ray)` finds stage voxels,
  then instances, then the ground; dragged instances land on the tops under the pointer.
  Kinds' `snap.step` and `rotate` apply to drags. Handles (`packages/three/src/field-handles.ts`)
  for point, points (drag, split, ghosts), size, radius and ref fields; the inspector
  (`packages/sdk/src/inspector.tsx`) has a control per field, inherited values dimmed, Reset,
  Add and Delete point, and read-only settings for kinds this app doesn't know. Agent tools
  check settings against a kind's fields. Host data on documents and layers travels through
  live rooms and their snapshots. The web app has no kinds of its own; example kinds for
  reference are in `apps/web/dev/example-kinds.ts`.

- **Levels on a stage** (November 7, 2026, for a host's level editor, which runs on a library
  whose scene has its course as the stage):
  - *Snapping lines up with the stage's cells.* The lattice runs from the stage's grid corner
    (`latticeOrigin`), not the scene's origin, so a stage an odd number of cells wide snaps to
    its cells too. `alignPosition` places an instance by its kind's `snap.align`: its model's grid
    on the cells (`edges`, the default) or its origin in the middle of a cell (`center`, for
    objects that stand one to a cell whatever their size). Drags and Add use it
    (`addInstance(…, { align: true })`); offsets snap with `snapOffset`.
  - *Faces.* A kind with `snap.faces` lands on walls and ceilings when dragged, turned a quarter
    at a time to stand out of the face: spikes hanging from a ceiling.
  - *Resizing keeps placement.* A resize that moves a model's voxels against its origin (growing
    one side) moves its instances back in the same undo step, in every scene, so the model stays
    put; on a stage, what stands in the scene moves with the voxels, so objects stay on their
    blocks.
  - *Picking on the stage.* The view tool picks and drags instances around a stage or a model
    being edited (`pickWhen`); voxel tools still go through them. A tap that misses every voxel
    picks by the box around one's voxels, so thin things far off (a pole, a coin) can be tapped.
    Kinds with no model (a zone, a trigger) are boxes that hold other things: they are picked
    only when nothing with voxels is, so what stands inside one comes first.
  - *Hosts with many kinds.* `InstanceKind.group` files kinds in submenus of the add menu;
    `LibraryEditorOptions.modelEditorOptions` gives one model's editor its own options (a level's
    tools, which mean nothing in the objects on it); `rotate: "none"` and `"quarter"` hold for
    the instance bar and the turn shortcuts too. The UI grid lets a host's wide main bar spill
    over its column rather than push the right-hand panels off screen.
  - `formats/library.ts` holds `LibraryDocument`, so reading a file loads no editor, and keeps
    unknown keys on model entries as it does elsewhere.

Not yet: a host's own handle drawing (`handle(field, instance)`) and picking hooks; cell
objects or a stamp tool; posing parts per instance; tweening. The web app doesn't offer a stage (a host sets one with `setStage`).
Done is a button and a menu item, not Enter or Esc, which the model editor already uses.

## Why

A model judged on its own, in an empty viewport, has no scale. Whether a door
fits the character, a sword suits the hand, or a tree reads as a tree next to a
house only shows when they stand together. Today the only way to check is to
export to Blender or Godot and come back.

A **scene** places **instances** of models in one space, so a model can be
designed against its neighbors, and a set of models can be composed, attached
and exported together.

Scenes are also what an app embedding Voxeltoy needs to build a level editor
around it: a grid model for the level itself, with objects placed freely over
it, carrying their own settings. A host's course can be a block-resolution
`.voxeltoy`, with objects that are palette values in cells today and camera
zones that would otherwise be a separate editor with its own undo. The
[Hosts](#hosts) section is what scenes give an app like that.

## The workflow

Qubicle's workflow: separate objects that move freely in one space, any of
which can be opened and edited in place without leaving that space.

1. **Place.** Add models to the scene from files, or start a new empty model
   right there. Each placement is an instance; one model can have many.
2. **Arrange.** Tap an instance to select it, drag it onto a surface, lift
   and rotate it with the gizmo, attach it to a part of another instance.
3. **Edit in place.** Double-tap an instance (or **Edit model** in its menu).
   The full model editor opens on that model, with the rest of the scene drawn
   around it, dimmed and untouchable. Every tool works as it does today.
4. **Back.** **Done** returns to the scene. Every instance of the model shows
   the edit, and each edit made inside is a step in the scene's one undo
   history, so undo can keep going back through them after Done.
5. **Out.** Save the `.moxscene`, export the scene as `.glb`, or export any
   model as a `.voxeltoy` to use on its own.

## Principles

[Product principles](principles.md) say Voxeltoy is not a tool for assembling
scenes and that nothing moves off the grid. This design keeps the second rule
for models and draws a line for the first:

- **Models stay on the grid.** Everything about editing a model is unchanged.
  An embedded model is an ordinary `.voxeltoy` document.
- **Scenes are where things move freely.** Instances have a position, rotation
  and scale that need not be whole voxels or quarter turns. Snapping to the
  voxel grid and to 90° is on by default, so free placement is a choice.
- **A scene is for composing and checking, not rendering.** No materials,
  lights to design, post-processing or render settings. The look is the
  editor's look.
- **Touch first still holds.** Every drag, handle and snap has a tappable path;
  modifier keys and Escape are shortcuts, and a second finger cancels a drag as
  it cancels a stroke.

## Scope

**First version** (phases 1 to 4 below): a `.moxscene` document of embedded
models and instances, one undo history across scene, models and host data, a
stage, edit in place, instance kinds with settings, attachment to parts,
per-instance flipbook playback, scene `.glb` and `.png` export, agent tools.
Scenes in the web app are local only: autosaved in the browser, saved and
opened as files.

**Not in the first version:**

- Share links and live rooms for scenes. (Host `data` on `.voxeltoy` documents
  does travel through them; see [Files](#files).)
- Linked models in the web app (a scene that refers to a model stored
  elsewhere). Embedding is designed to grow into it, and hosts with their own
  files can link now; see [Embedded now, linked later](#embedded-now-linked-later).
- Posing parts per instance, and keyframe tweening. See [Later](#later).
- Non-uniform scale, cameras, lights or materials as scene objects. Hosts can
  still have objects that change size (a pole's length, a zone's box), as
  host-built geometry from their settings; see [Hosts](#hosts).

## Model

```ts
interface SceneDocument {
  docId: string;               // stable identity, as for .voxeltoy (below)
  revision: number;
  name: string;
  models: SceneModel[];
  instances: Instance[];       // in outliner order; children follow their parents
  ground: { visible: boolean; size: [number, number] };
  stage?: string;              // a SceneModel id: the model always open in place (see The stage)
  kinds?: Record<string, KindSnapshot>; // what each host kind was when saved (Files without their host)
  data?: Record<string, Json>; // host data by namespace, kept as-is
}

interface SceneModel {
  id: string;                  // "model:…", unique in the scene
  doc: MoxelDocument;          // the embedded copy: the truth, or a cache when ref or built is set
  origin?: { docId: string; revision: number }; // what it was copied from
  ref?: string;                // a host's name for the model; doc is then its cache
  built?: { kind: string; key: string }; // made by a kind from settings; doc is then its cache
  voxelSize?: number;          // world units per voxel; default 1
}

interface Instance {
  id: string;                  // "inst:…"
  name: string;                // defaults to the model's or kind's name
  model: string | null;        // SceneModel id; null when the kind supplies the model, or there is none
  kind?: string;               // a host's instance kind (Hosts)
  data?: Json;                 // the settings this instance changes from its kind's defaults
  parent: { instance: string; marker: string | null } | null; // marker: a marker id of the parent's model
  position: Vec3;              // world units, relative to the parent's attach frame
  rotation: Quat;              // [x, y, z, w]
  scale?: number;              // uniform; default 1
  playback?: Playback;         // only for instances with a model; default: the frame its model has open
  visible: boolean;            // saved, not undoable (like layer visibility)
  locked: boolean;             // saved, not undoable
}

type Playback =
  | { kind: "frame"; frame: string }            // hold one frame (a still model: its one frame)
  | { kind: "loop"; speed: number; offset: number }; // play the flipbook; offset in ms
```

**Which model an instance shows.** `model` when it is set. Otherwise the
kind's `model(data)`, if the kind has one (a host ref, or a document built
from the settings and cached as a `built` model). Otherwise nothing: the kind
draws its `bounds`. An instance with both `model` and a kind that supplies one
is refused when the scene is checked, so there is never a question of which
wins.

**Units.** One world unit is one voxel. Models made at the same voxel size
line up with scale 1, which keeps voxel density consistent across a scene; scale
is there to try sizes, not as the normal way to fit things together. A model
made at another density says so with `voxelSize`: a level whose voxels are
blocks of 16 is `voxelSize: 16` among models at 1, and lines up with them at
scale 1. An instance's effective scale is its `scale` times its model's
`voxelSize`. glTF export bakes that product into each node's scale, and edit
in place includes it in the context transform. Snapping to the grid snaps to
the stage's voxels when there is one. A model's origin is its document's
`origin`, by default the center of its floor, which the exports use too.

**Rotation** is stored as a quaternion, so a later tween can interpolate it
correctly. The UI and agent tools take and show Euler degrees (XYZ) and snap
there.

**Attachment.** A model's markers are its attach points (see
[pipeline.md](pipeline.md)). An instance with `parent: { instance, marker }` is
placed in the frame of that marker: at the marker, turned as it is, where it is
on the frame the parent instance shows, so a held sword follows a hand keyed
per frame. With `marker: null` it is placed relative to the parent instance's
origin. A rig is a scene of part models attached this way; turning a part's
instance poses it.

**Repairs.** Some edits leave a reference with nothing to point to. Each is
repaired in the same undo step as the edit that caused it:

- Parents can't loop. Deleting an instance re-parents its children one level up
  and keeps their world placement, as layers do.
- If an edit removes the marker an instance hangs from, the instance falls back
  to `marker: null` and keeps its world placement.
- Deleting an instance clears every `ref` field that points to it (set to
  `null` in that instance's `data`, never left dangling).

**Selection** is a set of instance ids. As in the model editor it is undoable
but not saved. On the stage only one selection is active at a time; see
[Picking and selection](#picking-and-selection).

### Document identity and host data in `.voxeltoy`

`.voxeltoy` files have no identity today; only layers and frames have ids. Add
three optional top-level fields:

- `docId`: assigned when a document is created, kept by Save and Export model,
  replaced by **New** and **Save a copy**. Files without one get one when
  opened or embedded.
- `revision`: a counter the editor increases with each committed history entry
  (undo and redo included: it says the document changed, not how many edits it
  holds), saved with the file.
- `data`: host data by namespace, as on a scene, and `data` on each layer.
  Readers keep both as they are, and keep unknown top-level and layer keys
  rather than dropping them, so a file passed through an app that doesn't know
  them comes out intact. A host uses a layer's `data` for what it means by the
  layer (roles such as Terrain, Course and Trees are layer names today).

Layer `data` follows its layer through every structural op, so it is never
lost silently:

- **Add and remove** carry it, so undoing a delete brings it back.
- **Duplicate** copies it.
- **Merge** keeps the data of the layer merged into; the merged layer's data
  goes with it and comes back on undo.
- **Changes** go through `data.set` (see [History and undo](#history-and-undo)).

All three fields are ignored by older apps, so the `.voxeltoy` version doesn't
change. Duplicating a file outside Voxeltoy duplicates its `docId`; the re-import
prompt below covers that.

### Embedded now, linked later

An embedded model is **a copy that remembers its source**, not the model itself.

- **Now.** `doc` is the truth. `origin` records the `docId` and `revision` it
  was copied from.
- **Re-import.** Opening or dropping a `.voxeltoy` into a scene that already has a
  model with the same `docId` asks to **Replace** it (every instance updates)
  or **Add as new**. If the embedded copy was edited in the scene since it was
  copied (its revision is past `origin.revision`), the prompt says so. This is
  manual linking, and it works offline.
- **Later, with cloud storage.** `origin` gains a location. The embedded copy
  becomes an offline cache, so a scene always opens, and linking only adds
  "a newer version of Knight exists: Update".
- **Hosts link now.** A host that has its own files can link before cloud
  storage does: a model with a `ref` is loaded through the host's
  `resolveModel(ref)` when the scene opens, and `doc` is only its cache. A level
  shares one spike model with every other level, rather than each keeping a
  copy that goes stale.

**Saving linked models.** A linked model is saved through the host's
`saveModel(ref, doc)` after every committed history entry that changes it,
undo and redo included, debounced. So the host's file always matches what the
scene shows, including after an undo that happens long after Done.

**Changes from elsewhere.** If the host reports that a linked model changed
outside this scene (`modelChanged(ref)`: another level edited the shared spike),
the scene reloads it. That reload is not an edit and is not undoable. Like
another person's edit in a live room, it takes ownership away from this
scene's earlier entries for that model, so undo skips them rather than
overwriting the other change. This is the conditional undo `history.ts`
already does for shared work.

## History and undo

A scene has **one undo history**. Every change goes on it: scene ops, the ops
of whichever model is being edited, `data.set` on any scene, instance, document
or layer, and selection changes. A level editor goes between voxels and objects
all the time ("carve a gap, move the platform over it, undo both"), and a
second stack is the split a host has when camera zones live in another editor.

- **Entries mix items.** An entry is a list of items, each a scene op, a model
  op tagged with its model id (`{ model, op: DocOp }`), or a local change (the
  selection). `scene.transact(fn)` groups model edits, scene ops and host
  `data.set` calls into one entry, so a host's own edit lands as one undo step.
- **`Editor` takes its history from outside.** Today `Editor` creates its own
  (`readonly history = new History()` in `editor.ts`). It gains an
  `EditorOptions.history` (a history and the model id to tag its ops with), so
  an `Editor` opened on the stage or in place writes to the scene's history.
  Without the option, it behaves exactly as now.
- **Undo doesn't need the model to be open.** `applyOp` works on a
  `DocTarget`, not an `Editor`, so each embedded model is a lightweight
  `DocTarget` over its document. Undoing "carve a gap" after leaving edit in
  place applies the inverse to that target, bumps the model's revision, and
  every instance redraws from the new mesh. The affected instances flash
  briefly so the change is visible. Undo does not reopen the model; a model
  that is open applies the op through its `Editor` so its state stays live.
- **Edit in place is not collapsed.** Each stroke inside is its own entry.
  Entries made in a session carry the model's name in their labels ("Knight:
  Paint"), so the history reads clearly. There is no whole-document
  `model.replace` at Done.
- **Ops.** Scene changes are document ops, checked and invertible like
  `ops.ts`: `instance.add`, `instance.remove`, `instance.transform`,
  `instance.parent`, `instance.rename`, `instance.playback`, `instance.order`,
  `model.add`, `model.remove` (refused while instances use it), `model.replace`
  (re-import and **Replace** only), `scene.rename`, `scene.stage`.
- **Host data.** `data.set` applies a patch to a `data` value: set a path to a
  value, or **unset** it, which for an instance's settings means "back to the
  kind's default". Its inverse restores the previous value or absence exactly.
- **Not in history:** instance and layer visibility and lock, tool, color,
  snap settings, as in the model editor.
- **Ownership.** Scenes are local, so every item is owned. The `Owned`
  bookkeeping and cell logs stay as they are, which is what lets shared scenes
  come later on the same history, and what makes [changes from
  elsewhere](#embedded-now-linked-later) work now.
- **Budget.** Voxel entries hold cell data, and one history now covers many
  models. The entry cap (200 today) also gets a byte budget across the whole
  history, dropping the oldest entries first.

## Editing

### Scene editor

A headless `SceneEditor` in `@voxeltoy/core`, next to `Editor` rather than
inside it: `editor.ts` is built around one grid, and scenes have no grid of
their own. It follows the same rules: reactive getters for the UI, methods for
every change, `window.sceneEditor` for scripts, DOM-free and tested with
`bun test`. It owns the one history and the `DocTarget` of each model, and
creates the `Editor` of whichever model is open.

```js
const knight = scene.addModel(moxelDoc);              // returns the model id
const a = scene.addInstance(knight, { position: [0, 0, 0] });
scene.setTransform(a, { position: [4, 0, 2], rotation: [0, 90, 0] }); // Euler degrees in
scene.attach(sword, { instance: a, marker: handMarkerId });
scene.setPlayback(a, { kind: "loop", speed: 1, offset: 250 });
scene.setData(a, { length: 6 });                     // a data.set; scene.unsetData(a, "length")
scene.select([a]);
const model = scene.openModel(a);                    // an Editor on that model, on the scene's history
// ... edit with the ordinary Editor API ...
scene.closeModel();
scene.transact(() => { /* model edits, scene ops and data together: one undo step */ });
```

### The stage

A scene can name one model its **stage** (`stage`). The stage is always open:
its `Editor` runs for as long as the scene does, and every model tool works on
it. The instances around it stay live: they can be picked, dragged and
snapped to. One viewport draws both, and the toolbar has the model tools and
the scene's **Move** tool together. The stage is drawn at the scene's origin,
scaled by its `voxelSize`. A level is a scene whose stage is the course, and
its objects are instances over it.

A scene with no stage (the web app's default) shows only the **Move** tool
and the add menu until an instance is opened.

### Edit in place

Edit in place is the stage made temporary. `openModel(instance)` makes that
instance's model the stage until Done, with two differences:

- **Context isn't live.** The rest of the scene, including the real stage if
  there is one, is drawn around the model dimmed, never picked or snapped to,
  and can be hidden from the bar.
- **The model keeps its own space.** It is shown in its own grid space, as
  always, so every tool, the workplane, mirror and slice work unchanged. The
  rest of the scene is drawn transformed by the inverse of the opened
  instance's placement: the world tilts around the model, not the other way.

There is one editing path to build and test, and the web app gets the modal
Qubicle flow out of it.

- **Other instances of the same model** in view update live as you edit.
- **Undo** is the scene's history throughout (above).
- **Done**, Enter or Esc closes it and restores the real stage, or none.
- **Resizing** a model keeps its origin, the floor center, so instances don't
  jump.
- **Leaving** with a stroke or floating content open commits it first, as
  changing frames does.

### Making a new model in a scene

**New model** in the scene's add menu embeds an empty document (default size
and palette), places an instance in front of the camera on the surface under
the view's center, and opens it in place. This is the main path for "design
against what's already there". **Export model…** writes it out as a `.voxeltoy`
when it's ready to stand alone.

### Picking and selection

What a touch hits depends on the tool, so one finger always does one
predictable thing:

- **Voxel tools** (add, erase, paint, voxel select, fill, pick, extrude,
  shapes) hit only the stage's voxels. Instances are drawn but let the ray
  through, so you can build behind an object.
- **The Move tool** hits the nearest instance. A touch on an instance selects
  it and drags it. A touch on stage voxels or empty space orbits, as one finger
  off the model always does, and a tap there clears the selection.
- **Handles and the gizmo** are hit before anything else, whatever the tool.

**One active selection.** On the stage there are two kinds of selection: a
voxel mask and a set of instances. Only one is ever active. Selecting instances
clears the voxel selection and the other way round, as one undo step. Delete,
the inspector, Duplicate and the arrow keys act on the active one. A part of
an instance (`{ instance, field, index }`: one path vertex) is a selection of
instances too.

## UI

Touch first, as everywhere else. Every action below has a tappable path; drags
and shortcuts are faster ways to the same things.

**Viewport** (with the Move tool):

- Tap an instance: select it. Tap empty space: clear the selection. Selection
  outlines the instance and shows the gizmo.
- One finger on empty space orbits; two fingers pinch and pan, as in the model
  editor.
- One finger on a selected instance drags it onto the surface under the
  finger, snapped (see [Snapping](#snapping)). A second finger cancels the drag
  and puts the instance back.
- Gizmo: arrows move along an axis (Y lifts), rings rotate. It reuses the model
  editor's gizmo with free values and snapping.
- Double tap an instance: edit in place.

**Bar.** Add (New model, From file…, Duplicate, and a host's kinds), Snap
(step, 90°/15° rotation, surfaces, off), Ground, and the selection's menu.

**Instance bar**, like the marker bar, while an instance is selected: position,
rotation and scale steppers (a step is one snap step or one snap angle),
**Attach to…** (then tap an instance, then a marker, or **None**), Playback,
Edit model, and the kind's [inspector](#fields-inspector-and-handles).

**Outliner** in the layers panel's place: instances as a tree by attachment,
with visibility and lock toggles and a menu per row (Rename, Duplicate, Attach
to…, Select model's instances, Export model…, Delete). Each row's menu is the
tappable path; dragging rows to reorder or re-parent is a shortcut. With a
stage, the stage's layers are a section above the instances.

**Compact (≤ 640px).** The outliner is a sheet, as the layers panel is. The
instance bar uses one row of steppers with an axis switch.

**Mode.** The web app opens either a model or a scene. A small mode label shows
which, and **Place in a scene** on the model menu embeds the current model
into the open scene (or a new one) and switches to it. The model draft and the
scene draft are separate; editing a model in place changes the scene's copy,
not the draft.

## Rendering

The scene draws in the existing `Viewport` of `@voxeltoy/three`, which gains
an **instance layer**, rather than in a second viewport class. The stage and
edit in place both need one viewport that runs the model tools on one model
and draws instances around it, so the model editor and the scene share camera,
gestures, gizmo, mesher, picking and export.

- **The instance layer** is a list of `{ mesh, transform, tint, pickable }`
  that `SceneEditor` keeps up to date. Live instances on the stage are
  pickable; edit in place's context is the same layer, dimmed and not
  pickable.
- **One mesh per model and frame**, built with the wasm mesher and cached by
  model revision and frame id; every instance draws it with its own
  transform (`InstancedMesh` per model and frame, or shared geometry). The
  cache key is a record, not a pair, so a palette can join it later (see
  [Palettes](#palettes)); nothing else may assume one mesh per model and frame.
- **Kinds without a model** draw their `bounds` as an outline in the kind's
  color.
- **Playback** runs on one `requestAnimationFrame` clock; each looping instance
  picks its frame from the clock with `animation.ts`, plus its offset and speed.
- **Host overlays** (see [Hooks](#hooks)) draw into the same viewport and
  render on demand when they change.
- The ray-marched `VoxelVolume` is an alternative per model if mesh counts get
  large; see [voxel-runtime.md](voxel-runtime.md).

## Hosts

The SDK's `EditorHost` lets an app reshape the model editor; a `SceneHost`
does the same for scenes. The web app is a scene host that adds nothing. A
level editor is one that adds a lot, and nothing below is level-specific in
Voxeltoy: it is the plumbing, and the host brings the meaning. A level editor
sets a [stage](#the-stage); the web app doesn't.

### Instance kinds

A host registers **kinds**, each with what an instance of it is:

```ts
interface InstanceKind {
  id: string;                         // "spikes-timed", "camera-zone", "pole"
  label: string;
  model?: (data: Json) => string | MoxelDocument | null; // a model's ref, or one built from its settings
  bounds?: (data: Json) => Box;       // for kinds with no model: picking, outlines, framing
  fields?: Field[];                   // its settings, for the inspector and handles
  defaults?: Json;                    // settings it has unless the instance changes them
  snap?: SnapRule;                    // overrides the scene's, for this kind
  rotate?: "free" | "quarter" | "none";
}
```

- **Settings** are an instance's `data`. The host owns what they mean; Voxeltoy
  keeps them, edits them through `data.set` ops and shows them.
- **Size without scale.** A kind whose geometry depends on its settings
  (a pole's `length`) gives `model` a function. Voxeltoy rebuilds the mesh when
  the settings change, and saves the built document as a `built` model, keyed
  by kind and settings, so the file shows it without the host. A box-like kind
  with no model gives `bounds`, drawn as an outline in the kind's color, as a
  camera zone or trigger is.
- **Defaults and overrides.** An instance stores only the settings it changes.
  The inspector shows inherited values dimmed, so changing a kind's default
  changes every instance that kept it. **Reset** on a field unsets it.

### Fields, inspector and handles

A `Field` describes one setting, and also how it is drawn in the viewport, so
most kinds need no gizmo code (LDtk's field display modes and Hammer's FGD
helpers work this way):

```ts
type Field = { key: string; label?: string } & (
  | { type: "number"; min?: number; max?: number; step?: number }
  | { type: "bool" } | { type: "enum"; options: string[] } | { type: "color" }
  | { type: "point"; relative?: boolean; handle?: boolean }
  | { type: "points"; relative?: boolean; display?: "path" | "loop" | "points"; ghost?: boolean }
  | { type: "size"; axes: ("x" | "y" | "z")[]; anchor?: "center" | "min"; min?: number; max?: number; step?: number }
  | { type: "radius"; min?: number; max?: number }
  | { type: "ref"; kinds?: string[] }   // another instance, by id
);
```

- The **instance bar** grows an inspector of the selection's fields, with a
  stepper, toggle, menu or swatch each, as the bar's position steppers are.
- **Handles** come from fields: a `point` is a dot to drag, `points` a path
  whose vertices drag and split (with `ghost`, the model drawn faintly at each
  stop: where a moving platform will be), `size` face arrows, `radius` a ring,
  `ref` a line to its target. Every handle's value is also in the inspector,
  so nothing needs a precise drag; adding and removing path vertices has
  **Add point** and **Delete point** buttons as well as tap-to-split.
- A host can draw its own handle for a field with `handle(field, instance) →
  HandleSpec`, but the drag is always Voxeltoy's: live while dragging, one undo
  step when it ends, and a second finger or Escape puts the start value back.

### Snapping

One service for the gizmo, handles and drags: `scene.snap(point, context)`.

- **Steps:** the stage's voxel, or 1/2, 1/4, 1/8 and 1/16 of it, or off,
  chosen in the Snap menu. Holding a modifier key goes one step finer as a
  shortcut.
- **Surfaces:** a dragged instance lands on the face under the pointer, stage
  voxels first, then other instances, then the ground: an object goes on a
  block top, and a mug on a table. Surfaces can be turned off in the Snap menu
  to slide along the ground instead.
- A kind's or field's `snap` overrides the scene's (a waypoint snaps to block
  tops, a size steps by half a block), and a host can supply its own rule.

### Hooks

- **Pick and draw.** A host can add pickable things and draw into a
  viewport overlay that follows instance visibility and selection, in depth-
  tested, x-ray or faint modes (a preview of grown trees over their blocks).
  The scene renders on demand when overlays change.
- **Menus and outliner.** The host adds items to an instance's menu, the add
  menu (its kinds, grouped), and the outliner rows (a kind's icon, a count of
  problems).
- **Edits.** `onEdit` reports scene, model and data ops alike, so a host
  can follow changes (re-bake a course, re-check a path) with one listener.
- **Files.** `resolveModel`, `saveModel` and `modelChanged` link models by the
  host's names; `load` and `save` let a host keep the scene in its own files
  (a level file beside the course) instead of a `.moxscene`.
- **Agent tools.** Kinds and fields are schemas, so `place_instances` and
  `edit_instances` take a kind and settings, checked against the fields, and a
  host's kinds are placeable by an agent with no extra tools.

## Files without their host

A host's scene file opened in the web app, read by the CLI, or exported to
Godot has no kinds registered. It should still open, show, export and round
trip intact.

- **Everything is kept.** Unknown kinds, settings, `data` and `ref`s are
  preserved exactly, through editing and saving.
- **Kind snapshots.** When a host saves a scene, it writes `kinds`: each kind's
  label, defaults and color, and the bounds each model-less instance had. Without
  the host, defaults are resolved from the snapshot. With the host, its current
  definitions win and the snapshot is refreshed on save.
- **Showing them.** An instance whose kind is unknown shows its cached `built`
  or `ref` model if there is one, otherwise its saved bounds as an outline. It
  can be selected, moved, rotated, duplicated and deleted. The inspector shows
  its settings read-only, as values, with a note that the app that made it
  edits them.
- **Linked models offline.** A `ref` model the app can't resolve uses its
  cached `doc` and shows a "linked" badge. It can be viewed but not edited in
  place, since there is nowhere to save it.
- **Resolved values out.** `get_scene`, glTF export (as node `extras`) and
  `voxeltoy info` give each instance's settings with defaults filled in, so an
  agent or a Godot importer sees real values rather than only overrides.

## Files

**`.moxscene`** is a zip, stored without compression (`formats/zip.ts`):

```
scene.json              { "version": 1, "docId", "revision", "name", "ground", "stage", "kinds", "data",
                          "models": [{ "id", "file", "origin", "ref", "built", "voxelSize" }], "instances": [...] }
models/<model id>.voxeltoy  each embedded model, cached ones included, as an ordinary .voxeltoy
thumb.png               optional, for recent-files lists
```

Each embedded model can be pulled out of the zip and opened on its own.
Reading a scene validates every model as `.voxeltoy` loading does, then checks
that ids are unique, every reference resolves, no parent chain loops, and no
instance has both a `model` and a kind that supplies one. Unused `built`
models are pruned on save.

**Limits.** A total budget for embedded data (64 MiB to start, counted as
cells × layers × frames as animation does) and a cap on instances (2,000), both
with errors that say which limit was hit.

**Host data in sharing.** Scenes aren't shared yet, but `.voxeltoy` documents are,
and they now carry `data`. Share links keep it: the Worker's `check.ts`
accepts `data` on the document and on layers, within a size cap (64 KiB of
JSON per document to start), and refuses larger with a reason. Live rooms carry
it: `data.set` and the layer ops that carry `data` become wire ops in
`@voxeltoy/sync`, and a room's checks apply the same cap.

**Autosave** goes to IndexedDB rather than `localStorage`, which can't hold
a scene of embedded models. The model draft stays where it is. That's an app
change in `apps/web`; the SDK asks its host to load and save.

**Export.**

- **Scene (.glb):** a node per instance following attachment, a shared mesh per
  model, markers as empty child nodes that attached instances hang from. Effective
  scale is baked into each node. Looping instances export the frame showing.
  Hidden instances are left out. Each node's `extras` hold its kind and
  resolved settings; model-less kinds are empty nodes with their bounds.
- **Image (.png):** the current view, as the model PNG export does.
- **Model (.voxeltoy):** any embedded model, with its `docId`.

## Agents and CLI

**Agent tools** (`agent-tools.ts`), each one undo step, throwing errors an agent
can act on: `get_scene`, `add_model` (from a `.voxeltoy` or new), `place_instances`,
`edit_instances` (transform, attach, playback, settings, rename, delete), and
`open_model` / `close_model`, between which the existing model tools act on the
opened model. With a stage, the model tools act on the stage whenever no other
model is open.

**CLI:** `voxeltoy info` reads `.moxscene`; `voxeltoy convert` extracts models and
writes scene `.glb`; `voxeltoy render` renders a scene later, once the software
renderer handles transforms.

## Phases

The decisions that shape the document and the history land first, so later
phases add features rather than rework.

1. **Scene document and one history.** `docId`, `revision` and `data` in
   `.voxeltoy`, with unknown keys kept and layer ops carrying `data`;
   `SceneEditor` with scene ops and `data.set`; one history with mixed items
   and `EditorOptions.history`; the kinds and fields types and kind snapshots
   (the data shape, not the inspector yet); `.moxscene` read and write;
   `Viewport`'s instance layer with the Move tool, gizmo, grid snapping and
   ground drag; outliner and instance bar; add from file; IndexedDB autosave;
   agent tools. *Done when* a phone user can place, arrange, duplicate and
   delete instances of three models, undo all of it, save, and reopen the
   file intact, and a scene with unknown kinds and `data` round trips with
   nothing lost.
2. **Stage and edit in place.** The stage; tool-dependent picking and one
   active selection; edit in place as a temporary stage, with context
   rendering and live sibling updates; undo of model edits after Done; New
   model, Export model, re-import by `docId`. *Done when* a new model can be
   built from nothing inside a scene and exported, "carve a gap, move an
   instance over it" undoes as two steps in order with the model closed, and
   an edited `.voxeltoy` dropped back in replaces every instance of it.
3. **Hosts.** `SceneHost`; the inspector and handles from fields; the snapping
   service with surfaces; hooks; built-model caching; linked models through the
   host, with saving and changes from elsewhere; files without their host;
   `data` through share links and live rooms. *Done when* a host's level
   editor runs on a scene: its course is the stage, its objects are instances
   with settings, a moving platform's path is dragged in the viewport, its
   camera zones are a kind with no model and no history of their own, one undo
   goes back through voxel and object edits alike, and the level opened in the
   web app shows every object and saves without losing any.
4. **Attach and play.** Attachment to markers, per-instance playback, scene
   `.glb` and `.png`. *Done when* a sword attached to a hand marker exports to
   Godot as a child of that marker's node, and two instances of one flipbook
   loop out of phase.

Phases 3 and 4 don't depend on each other and can swap or overlap.

## Later

- **Posing per copy.** A rig placed in a level shows its rest pose; a different
  pose for one copy would be overrides on the placed scene (see
  [pipeline.md](pipeline.md)).
- **Tweening.** Every instance property is a plain value (position, rotation,
  scale, playback, settings, and later part rotations), so a timeline can add
  keyframe tracks of those values without changing the scene model. The scene
  timeline is separate from a model's flipbook timeline.
- **Palettes.** See [Palettes](#palettes).
- **Linked models** in the web app, once there is cloud storage; see above.
- **Shared scenes:** share links first (a snapshot, as for animations), then
  live rooms on the same history, whose ownership bookkeeping is already in
  place.

## Palettes

Deferred, deliberately: palettes in scenes, shared palettes and per-instance
palette swaps deserve their own research and design, and come first after
phase 3 (a host that swaps palettes in play wants them early).
Until then, each model keeps its own palette, as an ordinary `.voxeltoy` does.

The first phases must not close any of these doors:

- **Per-instance swaps** will be an optional field on `Instance` (or on its
  kind), absent in every file until then. Readers keep unknown instance keys,
  as they do for `.voxeltoy`.
- **A shared or scene palette** will be an optional scene field plus actions
  over its models; models never lose their own palette to it.
- **Rendering** keys meshes by a record that a palette can join, and nothing
  else assumes one mesh per model and frame. The mesher bakes colors into
  vertices today, so a swap can be its own cached mesh; moving the lookup to a
  shader later changes no file or API.
- **Palette ops** stay per model. Nothing in the scene history or `data`
  stores colors resolved from a palette instead of palette indices.


- Does the model editor's own toolbar move onto the same hooks a host uses?
  Godot and Tiled build their own tools on their plugin API, which keeps it
  honest, at the cost of reworking built-in tools. Deferred until the host
  API has settled through phase 3.
- With a stage, does a host still want cell objects (one per cell, painted
  like blocks) beside instances? A stamp tool that places instances at cell
  centers, snapped, may keep painting a row of coins as quick as it is today.
