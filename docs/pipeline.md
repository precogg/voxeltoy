# The model pipeline, markers, and rigs as scenes

Draft, November 7, 2026. It changes two product principles (parts, and what a model holds
besides voxels); see [Principles](#principles). It replaces [parts.md](parts.md). All six phases
are built; see [Status](#status).

## Status

Built (November 7, 2026, branch `pipeline-markers`):

- **Pipeline names** (phase 1). `evaluate.ts` has `Blend` (`occupancy` and `keep`), `stepBlend`,
  `layerBlend`, `blendCell` and `blendStage`; layers and steps both blend through them, with the
  fast paths kept. `pipeline.test.ts` checks the table below. No change in behavior or files.
- **Markers and origin in core** (phase 2). `markers.ts`: the types, checks, `markerAt`, frame
  keys, axes and rotation. Document ops `marker.add`, `marker.remove`, `marker.set` and `origin`;
  `frame.add` and `frame.remove` carry keys, and resizes move markers and the origin. `.voxeltoy`
  files keep `markers` and `origin` at the top of a model, in every version. The `Editor` has
  `addMarker`, `updateMarker`, `placeMarker`, `setMarkerKeyed`, `setMarkerHidden`,
  `removeMarker`, `setOrigin`, `origin`, `markerAt`. Agents have `edit_markers`, and
  `get_document` reports markers and the origin. Live rooms turn marker ops down.
- **UI and exports** (phase 3). The marker bar (`marker-bar.tsx`, from **Model > Markers and
  origin...** or `Shift+M`) chooses a marker or the origin, adds markers by kind, places the
  chosen one by tapping or dragging on the model, nudges it along an axis, sizes volumes, and
  has Rename, Role, Key per frame, Hide from this frame and Delete. **Model > Show markers**
  keeps them drawn. The viewport draws points as small axes and volumes as wireframes, by role.
  `.glb` exports write markers as named empty nodes with `extras.voxeltoy`; the Godot addon's
  `MoxelGLTFMarkers` makes collision markers `StaticBody3D`s and hitboxes and hurtboxes
  `Area3D`s, checked headless with `fixtures/check_markers.gd`.
- **Rigs as scenes** (phase 4). Layer parents and pivots, `parts.ts`, the pivot bar and the
  rigged-parts export are gone. Instances attach to `{ instance, marker }` and follow keyed
  markers on the frame their host shows, in the scene view while it plays too. A model's
  `origin` places it in scenes and exports. Older files open with each layer pivot as a mount
  marker named after the layer, and older attachments to a part find that marker when the
  layer had an id.

- **Scenes in scenes** (phase 5). An instance can place a library scene whole
  (`addInstance(null, { scene })`, the add menu's **Scenes**, agents' `place_instances` with
  `scene`). It draws, picks by its voxels, plays and exports as that scene's instances, moved by
  the placing instance, at any depth; edits to the placed scene show in every copy. A scene can't
  place itself or a scene that places it. Deleting a scene deletes its placements in the same
  step. Two taps on a placed scene (or **Open scene** in its menu) open it. In the library list, a
  model only one scene uses (and not the primary) is listed under that scene.

- **Blends, masks, effects and groups** (phase 6). A layer has an optional `blend` (the menus
  call them Normal, Behind, Cut, Paint, Intersect, Intersect keep colors, Replace), a `mask` (the
  same in every frame; outside it the layer does nothing, not even an intersect's emptying), and
  `effects` (`effects.ts`: mirror, outline, hollow, noise), applied to its content before it
  blends. A model has `groups`: isolated stages with a name, visibility, blend, effects and a
  parent group; a layer names its group, and a group sits in the stack where its lowest member
  is (`stageTree`). `composeLayers` folds the tree; `composeCell` gives one cell of it, which keeps
  the editor's display incremental for stacks without effects (effects reach across cells, so the
  display composes again as a whole after a burst of writes). Ops `layer.set` (blend, effects,
  group), `layer.mask`, `group.add`, `group.remove` (what it held moves up), `group.set`; group
  visibility is saved but not undoable, as a layer's. Resizes move masks and resolution changes
  resample them. `.voxeltoy` files keep it all in every version. Agents use `edit_pipeline`. In the
  layers panel, groups are header rows above their indented members; a layer's menu has Blend,
  Effects, Mask (to selection, select, clear) and Group; Ctrl+G groups the active layer. Live
  rooms turn all of it down.

Not yet: masks per frame and painted masks (a mask comes from the selection); more effects
(grow and shrink, smooth, recolor by height); collapsing groups in the layers panel;
attaching to an instance inside a placed scene (the `path` below; attach to the placed scene's
origin for now); kinds' supplied models inside a placed scene (they draw only in the open scene);
going into a placed scene in place, with the level around it (it opens on its own);
markers in sequence and sheet manifests, which needs them projected into the exported view;
turning a marker in the marker bar (agents and the API set `up` and `forward`); choosing a
marker by tapping it in the viewport (the bar's menu chooses it).

## Summary

- **A model is a pipeline.** Layers are stages folded bottom to top into one volume, as in
  Photoshop: each stage has *content* (where it is solid, and with what) and a *blend* (how that
  content combines with what is below). A raster layer, an override layer, a shape layer and a
  shape step are all the same kind of stage. The evaluator already works this way; this doc
  names its parts so that groups, masks and effects can be added later without new concepts.
- **A model has one output, its voxels.** Nothing about a layer survives composition. So a layer
  is not a rigid part, and parents and pivots leave layers.
- **Markers** are named points and simple volumes inside a model that are not voxels: mount
  points, colliders, hitboxes. They sit beside the pipeline, never in it, and can be keyed per
  frame.
- **A rig is a scene.** Each part is a model whose origin is its pivot. Parts attach to markers
  on their parent part. Scenes can be placed in other scenes, so one rig can appear many times in
  a level.

## Why

Three things pull in different directions today.

1. **Layers are compositing stages.** `composeLayers` (`packages/core/src/evaluate.ts`) folds
   them into one volume, and with shape and override layers the result is no longer the union of
   each layer's voxels. An override can erase cells that a lower layer made.
2. **Layers are also rigid parts.** A layer's `parent` and `pivot` turn it into a body with a
   transform. The rigged glTF export builds each part's mesh straight from `layer.data`, skipping
   evaluation. It only works for raster layers: `exportsParts` in
   `packages/three/src/scene-export.ts` required a flat document. It has to skip evaluation,
   because once the layers are composed you can no longer tell which layer a cell came from.
   For example, if an override layer erases cells of the arm, the export has no way to answer
   whether the arm part loses them.
3. **Pivots are used as mount points.** A bellpost uses part pivots to say where the bells
   hang. That works because a pivot is the only named point a model has, not because the bell
   mounts are joints.

Compositing, rigid bodies and named points are three separate ideas. Each gets its own home:
the pipeline, scenes, and markers.

## The pipeline

### Contract

```ts
evaluate(model, { frame, grid }) → Uint8Array   // one palette index per cell, 0 = empty
```

Evaluation is pure and DOM-free: it never changes its inputs, allocates palette entries or
records history, as now. The result is the model's **output**. Display, meshing, picking, the
software renderer, and every flat export (`.vox`, one-mesh `.glb`, `.png`, sequences) read the
output and nothing else.

Its inputs are the layers (bottom first), the frame being evaluated (raster content is per
frame; shape steps are the same in every frame), and the grid (`size` and `resolution`).
Session state, such as the slice, hidden values, floating content and drafts, is not an input.
It applies after the pipeline, as display filters, which is what `ComposeOptions.shows` and
`skip` already are. Keep it that way: a display filter must never change what an export writes.

### Stages: content and blend

Every stage produces **content** for each cell, `(alpha, value)`:

- *alpha* is whether the stage has anything to say about the cell;
- *value* is 0 (empty) or a palette index.

| content source | alpha | value |
|---|---|---|
| raster layer | `value ≠ 0` | its `data` in the frame |
| override layer | its `coverage` | its `data` (0 = covered empty) |
| shape (inside a step) | inside the shape | the step's material or fill |
| group | the group's own result is solid | that result |

A stage's **blend** has two settings. Because values are palette indices and not colors, a blend
can't average colors. It can only decide which cells are solid and which color wins:

- **occupancy**: what the stage does to the cells below where its alpha is set:
  - `union`: solid content fills the cell.
  - `replace`: the cell becomes the content, so empty content erases.
  - `subtract`: solid content empties the cell.
  - `intersect`: empties every cell where the stage's content isn't solid, including cells
    outside its alpha.
  - `none`: solidity is unchanged; only color can change.
- **keep**: where the cell is solid below and stays solid, keep the color below instead of
  taking the stage's own.

Everything that exists today is a pair of these:

| today | occupancy | keep |
|---|---|---|
| raster layer | union | no |
| override layer | replace | no |
| step *add* | union | no |
| step *add* with `keep` | union | yes ("behind") |
| step *cut* | subtract | — |
| step *intersect* | intersect | no (what stays takes its material) |
| step *intersect* with `keep` | intersect | yes |
| step *paint* | none | no (recolors only where solid below: a clipping mask) |

A step's `keep` flag already is this setting, so steps need no format change.

### Groups

A **group** is a stage whose content is the output of its own sub-pipeline, started from empty.
It then blends as one unit. A shape layer is a group of steps that can only be shapes. That is
the only thing that makes it a separate layer kind.

Today a step acts only on the steps below it in the same layer, and a cut across layers has to be
an override (`vector-raster.md`, "Step stacks"). That rule was there to keep results predictable.
Groups give the same predictability without the restriction:

- A stage's blend acts on everything below it **in its group**.
- To scope a cut to some layers, put the cut and those layers in a group.

This is Photoshop's answer too: a group isolates whatever is inside it. With groups, a shape
layer whose blend is `subtract` cuts everything below it in its group, and the override layer
stops being the only way to remove voxels across layers.

What this enables later, each as its own change:

- **Layer groups** in the layers panel: a group row that folds, plus a blend for the group.
- **Mixed groups**: raster layers and steps in one stack. A shape layer then becomes a group that
  happens to hold only steps, and "layer kind" becomes a description of a group's contents rather
  than a type.
- **Masks**: an alpha that limits a stage. Coverage is already one. A mask is a second
  coverage-shaped array, or a group used as alpha (a clipping group). Masks have the same shape
  as the selection, so the selection tools edit them.
- **Effects**: functions from content to content, applied to a stage before it blends: shell or
  hollow, outline, mirror, repeat, noise recolor, grow and shrink. Repeat and mirror steps from
  the "Later" list in `vector-raster.md` are effects. An effect runs in output cells, after the
  stage's content is evaluated on the grid.

None of these needs a new pipeline concept, which is the point of fixing the contract now.

### Caching

Caching works for each stage. `SourceCache` already checkpoints inside a step stack. The same
idea works across the layer stack: keep the composite of everything below the active layer, so
editing the top layer only re-blends that layer. Stage results are keyed by identity, since
content is immutable, as sources are now. Region re-evaluation (only the union of the old and new
bounds of what changed) applies at both levels.

### Editing against a pipeline

You see the output but edit a stage, which is how Photoshop works too:

- **Picking** hits the output. **Tools write** to the active stage: cells for raster and override
  layers, steps for a shape layer.
- An edit to a lower layer can be hidden by a stage above it. That is expected. The layers panel
  is where you find out why (later, with a "show only this layer" toggle).
- **Bake** (`bakeShapeLayer`) generalizes to any group: evaluate it and replace it with an
  override layer holding exactly that result, in one undo step.

### Order of work

1. **Name the parts without changing behavior.** Give each stage an explicit
   `{ occupancy, keep }` in the evaluator, derived from today's layer kinds and step modes, and
   make `composeLayers` and `applyStep` share one blend function. Files don't change. Every
   existing evaluation test must pass unchanged, and a new table test covers each row above.
2. **Composite caching across layers**, with a measurement on a 128³ model of many layers.
3. Groups, then blends on layers, then masks and effects, each when a real model needs it.

## Markers

### What a marker is

A **marker** is a named object in a model that is not a voxel and is not part of the pipeline.

```ts
interface Marker {
  id: string;                  // "marker:…", unique in the model
  name: string;                // "bell.1", "shoulder.L", "hurtbox"
  shape: MarkerShape;          // a point, or a volume
  role?: string;               // "mount" | "collision" | "hitbox" | "hurtbox" | a host's word
  keys?: MarkerKey[];          // placement per frame (Frames, below); unset = one placement
  data?: Json;                 // host data, kept as is, within the document's budget
}

type MarkerShape =
  | { kind: "point"; at: Vec3; turn?: Turn }        // a transform: a mount, a socket, a spawn
  | { kind: "volume"; shape: StepShape };           // box, sphere, capsule, ... as shape steps have

/** A rotation in quarter turns: the marker's axes are the model's, turned. */
type Turn = { up: Axis6; forward: Axis6 };          // as StepShape's up/forward
```

- **Units.** Positions are in source units (like shape steps), so markers keep their place
  through resolution changes. They snap to half an output voxel: on a boundary between voxels, or
  in the middle of one. This is the snapping pivots have today.
- **Rotation** is in quarter turns, written as an `up` and a `forward` the way oriented shapes
  are. That covers mounts ("the bell hangs down"), and it keeps the principle that nothing inside
  a model turns by an arbitrary angle. Arbitrary angles belong to scenes.
- **Volumes** reuse `StepShape` and `insideShape`, so a collision capsule is drawn, resized and
  tested by the same code that draws a capsule step. A volume's `turn` is its shape's `up` and
  `forward`.
- **Roles** don't change how Voxeltoy edits a marker. They choose the marker's color in the
  viewport, its default shape, and how it exports. Voxeltoy ships `mount`, `collision`, `hitbox` and
  `hurtbox`. A host can add its own with a role name, an icon and a color, as host kinds do.
- **Not voxels.** Markers are never composited, never meshed, never in `.vox` or flat `.png`
  exports, and never picked by voxel tools. The slice doesn't hide them, but the viewport's
  markers toggle does.

Markers are part of the document. Adding, removing, renaming, placing and keying markers are
document ops (`ops.ts`), so they are undoable, checked and shareable. Showing markers is UI
state, like layer visibility.

### Frames

A marker either has one placement, or **keys**:

```ts
interface MarkerKey {
  frame: string;               // a frame id
  shape: MarkerShape;          // the placement from this frame on
  hidden?: boolean;            // absent from this frame on (a hitbox that is only out mid-swing)
}
```

A key holds from its frame until the next key, in frame order. Frames before the first key use the
marker's own `shape`, so a marker always has a placement, whatever happens to its frames. This is
how Aseprite keys slices, and it suits flipbooks: a sword-tip marker follows a swing that is keyed
only where the tip moves. A still model never has keys.

- **Editing** a marker without keys moves it in every frame. **Key per frame** starts keys, with
  one on the open frame where the marker is now; from then on, editing on a frame adds or changes
  the key there. **Same in every frame** drops the keys, keeping the marker where it is on the
  open frame. A hidden key keeps the last place the marker was shown, so showing it again puts it
  back there.
- **Frame ops** carry markers: duplicating a frame copies its keys, deleting a frame drops them
  (the next key takes over, or the previous one), and moving a frame moves its keys with it, so a
  key always belongs to the same pose.
- `editor.markerAt(id, frameId)` resolves a marker's placement on a frame. Scenes call it with the
  frame an instance is showing.

### Where markers come from

- **Placing**: **Model > Markers and origin...** (`Shift+M`) opens the **marker bar**:
  - Its first button chooses what to place: the **Origin**, a marker, or **Add** (Mount point,
    Point, Collision box, Hitbox, Hurtbox). A new point starts on top of the model and a new
    collision box around it.
  - **Tap or drag on the model** to place the chosen one: a point on the middle of the face under
    your finger, a volume resting on that face. **X / Y / Z, -, +** nudge it (half voxels for
    points, whole voxels for volumes); a volume's **Move / Size** switch makes the steppers size
    it instead.
  - The options menu: Rename, Role, Key per frame or Same in every frame, Hide or Show from this
    frame, Delete. For the origin: Center of the floor.
  - **Done**, Enter or Esc closes the bar. So does picking a tool.
- The viewport shows markers while the bar is open, and always with **Model > Show markers**:
  points as small axes (their up the longest), volumes as wireframes, in their role's color.
  Every action has a tappable path. Drags and nudges need neither hover nor a modifier.
- **API and agents**: `editor.addMarker`, `updateMarker`, `placeMarker`, `setMarkerKeyed`,
  `setMarkerHidden`, `removeMarker`, `setOrigin`, `markers`, `markerAt`; the marker bar is
  `startMarkerEdit`, `selectMarker`, `nudgeMarker`, `resizeMarker`, `stopMarkerEdit`. Agents use
  `edit_markers`, one undo step per action; `get_document` reports markers and the origin.

### Files and export

- **`.voxeltoy`** stores `markers` on each model.
- **`.glb`** (one mesh, and scenes): each marker becomes an empty node beside the model's mesh,
  named after the marker, at its position on the exported frame (a hidden one is left out) and
  turned by its rotation. A volume's node is at its center. `extras.voxeltoy` holds
  `{ marker, role, shape, size?, options?, data? }`, sizes in the mesh's units. Blender imports
  these as empties, and Godot as `Node3D`s (with dots in names turned into underscores).
  - **Collision** markers get no name suffix: Godot's glTF importer has ignored `-colonly` on
    empties ([issue](https://github.com/godotengine/godot/issues/32363)), and a suffix would
    change the name a game looks up. The Godot addon reads `extras.voxeltoy` and makes the body and
    its `CollisionShape3D`. `KHR_physics_rigid_bodies` with `KHR_implicit_shapes` is the eventual
    standard, but it is still a draft. Revisit it when it is ratified.
  - **Keyed markers** export where they are on the exported frame, as the mesh does. Animating
    them in the `.glb` waits for flipbooks to export as glTF animation
    ([animation-export.md](animation-export.md)).
- **`.vox`** drops markers. Its scene graph has transform nodes, but no reader treats them as
  markers.
- **Sequences and sheets** (not yet) should list each frame's markers in the manifest
  (`formats/sequence.ts`), projected into the image, so a 2D engine gets its hitboxes per frame.

### What markers are not

- **Not a collider made of voxels.** In most voxel games the visual voxels are the collider
  (greedy boxes from the mesher). A collision shape made of voxels but different from the visual
  one would be a **second output** of the pipeline (layers marked "collision only"). That is the
  one change here that would blur the line between the pipeline and markers. Leave it out until a
  real asset needs it.
- **Not level objects.** Spawn points, triggers and paths that belong to one level are scene
  instances of host kinds, with field handles (`packages/three/src/field-handles.ts`). The rule:
  if every copy of the model should have it, it is a marker. If it belongs to one placement, it
  is the scene's.

## Rigs as scenes

### The model

- **A part is a model.** A rigged character is a scene, the **rig**, whose instances are its
  parts.
- **A model has an origin**: `origin?: Vec3`, in source units, snapping to half voxels as markers
  do. Unset means the center of the floor, as now. The origin is what an instance's position
  places and what a part turns around: the part's pivot. Exports put it at the node's (0, 0, 0).
- **Parts attach to markers.** An instance's parent becomes
  `{ instance: string; marker: string | null }`. The child's origin is placed at the marker,
  with the marker's rotation. `null` attaches it to the parent's origin, as `part: null` does
  today. A shoulder is a `mount` marker on the torso, and the arm instance hangs from it.
- **Attachment follows frames.** An attached instance follows its marker at the frame its parent
  is showing (`markerAt` with `scene.frameOf(parent)`). A held item stays in the hand through the
  hand's flipbook.
- **Posing is instance rotation.** Turning the arm instance in the rig scene is a pose. The rig's
  saved instance placements are its rest pose. A quick test pose is just editing the rig and
  undoing.

The bellpost becomes a model with `bell.1`…`bell.4` mount markers. Bells are instances in the
level, each attached to a marker on the post.

### Scenes in scenes

A rig used once could be a group of instances in its level. A rig used many times needs scenes
to place other scenes:

- An instance names a model, a kind, or a **scene** (`scene?: string`, mutually exclusive with
  `model`, as `model` and a kind's model are now). Cycles are refused.
- A scene instance draws, picks and exports as the placed scene's instances under its node.
  Instances can attach to its instances' markers: the parent becomes
  `{ instance, path?: string[], marker }`, where `path` names an instance inside the placed scene.
- **Going in** works as with models: `Library › Level 1 › Knight` opens the rig in place, with the
  level dimmed around it, and `› Arm.L` goes one step further into a part.
- **Overrides** (a different pose for one copy of the rig) are left for later. An override would
  be a set of instance-property changes stored on the scene instance, like Godot's editable
  children. Until then, every copy shows the rig's rest pose, and posing happens in the engine.

### Editing parts that fit together

Parts are modeled apart but have to fit together. Editing in place already supports this: going
into the torso from the rig shows the other parts around it, dimmed, in their placements. What
gets harder is work across a seam: one selection or one paint stroke over both the arm and the
torso. Accept that cost. If it turns out to be too clumsy, the fallback is to keep the model
whole and have it output several named volumes (top-level groups as parts). That would
reintroduce identity after composition, so try editing in place first.

The library list gets noisy if every part is a top-level model. A model that only one scene uses
could be listed under that scene. That is an open question for [library.md](library.md), not
this doc.

### Export

- **Scene `.glb`** already writes a node per instance following attachment. With markers, an
  attached instance's node hangs under its parent's marker node, so Blender and Godot show the
  hierarchy and the joint. A rig exports as nested nodes with meshes, ready for an
  `AnimationPlayer`, as the rigged export does today.
- **A placed scene** exports as a node holding its instances.
- The **rigged parts** export of a single model goes away. A skinned-mesh export (one mesh, one
  bone per part) moves to scenes as "Export rig as skinned mesh" and stays under Later.

### What goes

`Layer.parent`, `Layer.pivot`, `packages/core/src/parts.ts`, the pivot bar, `setLayerParent`,
`setLayerPivot`, `nudgePivot`, `startPivotEdit`, `edit_layer`'s `set_parent` and `set_pivot`, the
rigged glTF export, and `Instance.parent.part`. [parts.md](parts.md) is replaced by this doc.

### Older files

Rigs have one user, so migration is minimal and happens on read:

- Each layer with a pivot gives the model a `mount` marker named after the layer, at the pivot.
- An instance attached to a part attaches to that marker instead, keeping its world placement.
- Parents between layers are dropped. The layers stay as they are, composited.

An optional **Split into parts** command can come later: it makes a rig scene from a layered
model, one model per root layer and its descendants, with origins at the old pivots.

## Principles

[principles.md](principles.md) changes in two places once this is built:

- "Layers can be **parts** of a rigged model…" becomes: a model is its voxels and its markers. A
  rigged character is a scene of part models attached to each other's markers.
- "Pivots are the one thing that may sit between voxels" becomes: markers and model origins may
  sit on half voxels and turn in quarter turns. Free placement stays in scenes.

## Phases

Each phase ships on its own and has tests.

1. **Pipeline names.** Blends as `{ occupancy, keep }` in the evaluator, one blend function, the
   table test. No behavior or file change. *Done when* all evaluation tests pass unchanged.
2. **Markers in core.** The type, ops, frame keys and frame-op handling, `markerAt`, `.voxeltoy`
   read and write, agent tools. *Done when* a keyed marker survives duplicating, moving and
   deleting frames, undo, and a save and reload.
3. **Markers in the UI and exports.** The marker bar, View → Markers, `.glb` empties with
   `extras`, sequence manifests, and the Godot addon reading collision markers. *Done when* the
   bellpost's mounts import into Godot as named `Node3D`s, on a phone as well as a desktop.
4. **Origins and marker attachment.** `origin` on models, `parent.marker` on instances, migration
   of pivots, removal of layer parents and pivots. *Done when* a bellpost's bells hang from the post's
   markers after the old file is opened, and a sword follows a keyed hand marker through a
   flipbook.
5. **Scenes in scenes.** Scene instances, going in through them, attachment into a placed scene,
   and nested export. *Done when* two copies of a knight rig in a level export to Godot as two
   node trees with their joints.
6. **Groups, blends, masks and effects**, each when a model needs it (see [Groups](#groups)).

## Sources

- Aseprite slices are keyed by frame, each key holding until the next one:
  [asefile's slice model](https://docs.rs/crate/asefile/latest/source/src/slice.rs). People use
  them for hitboxes and pivots ([Aseprite2Unity pivots](https://aseprite2unity.readthedocs.io/en/latest/manual/sprite-pivots.html)),
  but per-frame keys have been unreliable in the editor
  ([forum](https://community.aseprite.org/t/slice-behavior-change-in-aseprite/28638)).
- Godot's import suffixes: [node type customization](https://docs.godotengine.org/en/4.2/tutorials/assets_pipeline/importing_3d_scenes/node_type_customization.html).
- glTF physics, still a draft: [KHR_physics_rigid_bodies](https://github.com/KhronosGroup/glTF/pull/2258).
- Unreal sockets, and Unity's child transforms in prefabs, put attach points on the asset and
  leave what is attached to the level, which is the split this doc follows.
