# Roadmap

Planned directions for Voxeltoy, in a suggested order. These are feature goals, not
release commitments.

## 1. Selection and transforms

Select and manipulate parts of a model. This is essential for everyday modeling
and later frame animation. The first version is in; see [selection](selection.md).

- Select a box or connected region of voxels.
- Move, copy, rotate, flip, or delete the selection.
- Preview transforms before committing them as one undoable edit.
- Provide tappable controls for selection and transforms on a phone.
- Drag arrows and rings on a gizmo to move along an axis or turn in quarter turns.

## 2. Extrusion

Pull a face or slice into a volume. The first version is in; see
[extrusion](extrusion.md).

- Extrude a connected face or selected shape by a chosen number of voxels.
- Preview the direction and depth before committing as one undoable edit.
- Support a simple touch workflow for setting extrusion depth.
- Later: pick a face by color as well as by shape, and grow the face out at an angle
  (a draft) for tapered shapes.

This is a core modeling tool and a natural next step after importing an image
as a slice.

## 3. Orthographic views

A quick win for precise modeling, slice editing, and future reference images.

- Add tappable front, back, left, right, top, and bottom views.
- Switch between orthographic and perspective projection.
- Keep orbiting and returning to an axis view simple on a phone.

## 4. Resizing and cropping

Make it easier to change the workspace around an existing model.

- Grow or shrink the document along each axis.
- Choose where the model sits within the resized workspace.
- Crop to occupied voxels across layers.
- Preview bounds and any voxels that would be removed before committing.
- Make resizing and cropping undoable.

## 5. Export framing

Control how a model appears in an exported image.

- Adjust camera angle, framing, background, shadows, and image size.
- Preview the result before exporting.
- Keep transparent backgrounds easy to select.

## 6. Turntable export

Share a model as a short rotating video or animated image.

- Choose rotation speed, duration, and output size.
- Reuse export framing controls for a consistent appearance.
- Preview a full rotation before exporting.

## 7. WebMCP

Expose Voxeltoy's editing capabilities to browser agents through WebMCP. The first
version is in (`packages/core/src/agent-tools.ts`).

- Provide tools to inspect the document and perform edits through the headless
  `Editor` API.
- Give tools clear inputs and results so agents can build and modify models.
- Keep document edits undoable, with related changes grouped into one transaction.

## 8. Rigs, markers and the pipeline

Build characters from parts that animate in other tools, the common "rigged
voxel" look, and give models the points and volumes games need. See
[the pipeline](pipeline.md).

- Markers: mount points, collision volumes, hitboxes and hurtboxes, keyed per
  frame in a flipbook, placed by tapping a face and nudged in half voxels.
- A model origin, the point it is placed by and turns around.
- A rig is a scene of part models, each attached to a mount on its parent;
  glTF exports markers as nodes, and the Godot addon makes colliders of them.
- Later: scenes placed in scenes (one rig, many copies), layer groups, blends,
  masks and effects, and a skinned-mesh export.

## 9. Collaboration and sharing

Share models and work on them together.

See the [collaboration research and plan](collaboration.md) for the proposed
sharing flow, state ownership, sync design, and delivery stages. Snapshot links have
shipped; live sessions work behind a flag (see its status section).

- Start with shareable links that let someone view a model or open their own copy.
- Explore live editing with shared document state and participant presence.
- Define editing permissions, conflict handling, and undo behavior for shared work.
- Keep local editing and file import/export available alongside shared workflows.

## 10. Import an image as a slice

Turn a 2D image into an editable voxel slice.

- Choose the X, Y, or Z axis, slice position, and image size in voxels.
- Map image colors to the document palette, with transparent pixels left empty.
- Preview placement before importing into a layer as one undoable edit.

This gives pixel art a direct path into Voxeltoy and a starting point for building
models slice by slice.

## 11. Reference images and meshes

Keep visual guides in the viewport while modeling.

- Add reference images for each axis, such as front, side, and top views.
- Adjust their position, scale, opacity, and visibility.
- Load a glTF (`.gltf` / `.glb`) mesh as a reference, with controls for placement
  and visibility.
- Keep references selectable through explicit controls so they do not get in
  the way of voxel tools.

Decide how reference assets travel with `.voxeltoy` files so documents remain
portable and work locally.

## 12. Mesh to voxels

Convert a mesh into editable voxels.

- Start with static glTF meshes.
- Choose voxel resolution and placement, then preview the result.
- Map mesh colors to the palette and import the result into a layer as one
  undoable edit.
- Explore surface-only and solid conversion, including how to handle open meshes.

Later exploration: pose a rigged mesh before voxelizing it. Keep this optional
until static conversion works well; posing needs its own simple touch controls.

## 13. Frame animation

Bring the frame-by-frame workflow of Aseprite into 3D.

- Add a timeline with frames and layers, plus controls to create, duplicate,
  reorder, and delete frames.
- Edit voxel content per frame, with frame durations and looping playback.
- Show neighboring frames with onion skinning to help compare poses.
- Save animation in `.voxeltoy` documents and make frame edits undoable.
- Define animation exports and how existing static exports use the current frame.

Start with manual frame editing. Explore voxelizing poses from a rigged mesh
into a frame sequence after mesh conversion and animation are established.

## 14. Vector + raster source layers (proposal)

Keep mathematical shapes editable while composing hand-edited raster detail over
their evaluated voxels. Start with one box, one subtracting box, and one raster
override layer; preserve the existing raster workflow during the transition.

See [Vector + raster: product and technical design](vector-raster.md) for the
source/evaluator boundary, resolution and override semantics, and milestones.
This direction proposes a change to the current grid-only product principles;
it is not implemented or an accepted release commitment.

## 15. Scenes (proposal)

Place instances of models in one space, Qubicle-style, to judge scale and
composition and to design a model against its neighbors. Edit any model in
place with the rest of the scene around it, attach instances to rigged parts,
and export the scene as glTF. Scenes are `.moxscene` files of embedded models,
local only at first.

Scenes are also how an app embedding Voxeltoy builds a level editor: one grid
model as the stage, always editable, with the host's own kinds of object
placed freely over it, their settings edited in an inspector and by handles in
the viewport, all in one undo history.

See [Scenes: product and technical design](scenes.md). Posing and tweening are
later stages; in the web app, linked models wait for cloud storage (a host
with its own files can link them sooner).

Every shipped milestone follows the [product principles](principles.md).
