# Frame animation: research and technical proposal

Draft, October 3, 2026. The first workflow is **voxel flipbooks**: edit the model
frame by frame. This is a proposal, not an implemented feature or a release
commitment.

## Status

Implemented (October 2026): the headless foundation of stage 2, and a first timeline.

- **Model.** Frames are ordered records of an id and a `duration` in ticks; the document has
  one `fps` (12 by default). Each raster layer has a dense cel in every frame. The open frame's
  cels are the layers' `data`, so every tool keeps working unchanged; the other frames keep
  theirs in `FrameRecord.cels` (`packages/core/src/ops.ts`). Switching frames swaps arrays, never
  documents. A document saved without frames has one frame with the fixed id `frame:0`, so every
  copy of a still model (and every client in a live room) agrees on it.
- **Ops.** `frame.add` (with the author's copy of the content), `frame.remove`, `frame.move`,
  `frame.duration` and `fps`, all checked and invertible. Voxel ops and cropped cells carry
  their frame; layer add/remove, resize and palette checks cover every frame. Override layers
  and resolution changes are refused in documents with more than one frame. A total budget
  (`MAX_ANIMATION_BYTES`, 256 MiB) bounds frames × layers × cells.
- **Editor.** `frames`, `activeFrameId`, `displayFrameId`, `fps`, `setFrame(id, { pending })`,
  `nextFrame`, `previousFrame`, `insertFrame({ after, content })`, `moveFrame`, `removeFrames`,
  `setFrameDuration`, `setFps`, `copyCel`, `frameCel`, `evaluateFrame`, `play(time)`,
  `advance(time)`, `pause`, `setOnionSkin` and `onionFrames`. Changing frames reverts a
  stroke in progress, commits (or with `pending: "cancel"`, drops) floating content and
  extrusions, and drops a shape being placed. Undo and redo open the frame they change.
  Any edit pauses playback on the frame showing; a touch on the model only pauses.
- **Clock.** `packages/core/src/animation.ts` resolves the frame for an elapsed time in whole
  ticks, so tests drive playback with fake times.
- **Files.** `.voxeltoy` version 3 holds frames; still models stay version 1 or 2. Older apps turn
  version 3 down. The wire codec refuses frame ops.
- **Sharing.** View links (snapshots) carry animations: the Worker accepts version 3 files of
  raster layers (`apps/worker/check.ts`), counting cells × layers × frames against its limit,
  and the recipient gets every frame, with playback but no editing. Live sessions still refuse
  animated documents, with a reason in the share dialog.
- **Agents.** `get_document` reports `animation`; `get_voxels` reads any `frame`; `edit_frames`
  selects, duplicates, adds blank, deletes, moves and retimes frames, and copies a layer
  between frames.

- **Timeline** (`packages/sdk/src/timeline.tsx`). A floating panel above the tools, toggled from
  the main bar (`T`) and opened automatically for an animated document: Previous, Play/Pause,
  Next, the frame count and loop length, Onion skin, Duplicate frame, and a frame menu (blank
  frame, copy layer to next frame, hold longer/shorter, move left/right, onion options, frames
  per second, delete). Below it, a strip of equal-width pose tiles with hold badges and an
  onion cue; it scrolls sideways on a phone. Shortcuts: `P` play, `,` / `.` previous/next,
  `Alt+N` duplicate frame, `Shift+O` onion skin. Playback runs on `requestAnimationFrame` and
  pauses when the page is hidden.
- **Onion skins** (`packages/three/src/viewport.ts`). The previous and next poses as tinted,
  shaded, colorless ghosts (orange before, green after), depth-tested without depth writes,
  hidden during playback and in PNG exports.

- **Sequence exports** (`packages/sdk/src/export-animation.ts`). Menu → Export animation, shown
  once there are frames: *Frames (.png sequence)* saves a zip of `frame-01.png`… plus
  `animation.json`; *Sprite sheet (.png)* saves a zip of `sheet.png` plus `sheet.json`. Frames are
  drawn from the current view on a transparent background, each with its committed voxels only,
  all with one crop around what any frame covers. The manifest (`formats/sequence.ts`) gives each
  frame's id, ticks, start and length in milliseconds, and its file or sheet position; a hold is
  a duration, never a repeated image. Sheets shrink to fit browser canvas limits. Zips are
  stored, uncompressed (`formats/zip.ts`). The static exports' menu heading names the frame they
  hold ("Export frame 3").

- **Pose thumbnails** (`packages/sdk/src/thumbnails.ts`). Each tile shows its pose from the
  three-quarter view, drawn off screen (`Viewport.snapshot`), all framed on what any frame
  covers so tiles line up. They catch up 250 ms after the document goes still, never during
  playback; a hash of each frame's voxels decides which to redraw, at most four per animation
  frame. The hashing evaluates every frame after each change: fine at 32³, to measure on
  large animations.

- **Scrub lane and reordering.** Under the strip, a scrub lane: a time ruler where each pose's
  segment is as long as it shows, so it doubles as the proportional timing view. Dragging along
  it moves through the poses (a slider for assistive tech, arrows/Home/End from the keyboard).
  The strip itself only scrolls. Frame menu → *Reorder frames…* swaps the controls for a reorder
  bar (Move left, Move right, Done); in that mode the tiles are drag handles, with a drop
  marker and edge scrolling, and each drop is one undo step.

Not yet: range selection, the mesh cache, animated GIF/video, live sessions and linked cels.

## Proposal

Use Aseprite's layers-and-frames model, adapt the controls for a phone, and make
timing and pose comparison easy. Preserve one document, one palette, one grid,
and one layer tree across the animation. Part transforms, tweening, audio, and
camera animation can follow as separate capabilities.

**Research and strength of evidence**

Product manuals establish behavior. First-person artist discussions establish
that particular people value a workflow; they do not establish a universal UX
ranking. The recommendations below are design judgments based on both. This
research did not include hands-on comparative testing or artist interviews.
Older discussions describe the versions people used then, not necessarily the
current product. The resemblance between Flash and Aseprite's timelines is
useful, but direct historical influence was not verified.

| Reference | What is useful for Voxeltoy | What needs care |
| --- | --- | --- |
| Aseprite | A grid of layers and frames; cels at their intersections; duplicate, blank, reorder, timing, tags, and linked content. This is the closest match to short voxel asset loops. | Dense cells, context menus, and modifier gestures need explicit touch alternatives. |
| Flash / Adobe Animate | Clear distinction between content changes and how long content is exposed; a timeline that makes timing visible. | Symbols, tweens, and nested timelines introduce concepts the first voxel flipbook does not need. |
| Procreate Animation Assist | A small strip, direct playback, tap-to-select, and a frame menu with hold and duplicate. Strong reference for entering animation without reorganizing the whole workspace. | Its layer/frame relationship should not replace Voxeltoy's independent layers and frames. |
| ToonSquid / Callipeg | Touch-oriented timelines with room for layers, drawings, timing, and selection. ToonSquid explicitly supports collapsing the timeline. | Tablet layouts still need redesign at phone width; hidden gestures must have tappable alternatives. |
| RoughAnimator / TVPaint | Timing drawings and comparing poses are central. RoughAnimator exposes drawing lengths; TVPaint is a useful traditional-animation timeline reference. | Do not carry a full production workspace into Voxeltoy just to obtain its timing controls. |
| Krita | Clearly documented blank, duplicate, clone, and held frames; separate transport and editing concepts. | A selected timeline range and the active drawing can differ. Voxeltoy should make that distinction unmistakable. |
| Toon Boom Harmony | Separation of reusable drawings from their exposure in time; explicit reuse and replacement. | Automatic exposure extension can have far-reaching effects. Prefer explicit actions for the first version. |
| Blockbench / Blender Grease Pencil | Blockbench helps identify the later part-animation workflow. Grease Pencil provides a 3D reference for layer-scoped onion skins. | Transform keyframes and voxel replacement solve different problems. They should not share ambiguous editing rules. |
| SpriteStack | A direct voxel-to-sprite reference with animation and retro rendering. | Its site describes keyframe animation as experimental. It is a relevant comparison, not established evidence of best-in-class animation UX. |

These observations come from [Aseprite's animation guide](https://www.aseprite.org/docs/animation),
[sprite structure](https://www.aseprite.org/docs/sprite/),
[linked cels](https://www.aseprite.org/docs/linked-cels/),
[Animate's timeline guide](https://helpx.adobe.com/co/animate/desktop/workspace-and-workflow/timeline.html),
[Procreate's frame options](https://help.procreate.com/procreate/handbook/animation/animation-options),
[ToonSquid's timeline](https://toonsquid.com/handbook/interface/timeline/),
[Callipeg's timeline](https://callipeg.com/learn-timeline/),
[RoughAnimator](https://www.roughanimator.com/),
[TVPaint's timeline manual](https://doc.tvpaint.com/docs/interface/timeline-overview),
[Krita's animation timeline](https://docs.krita.org/en/reference_manual/dockers/animation_timeline.html),
[Harmony's exposure controls](https://docs.toonboom.com/help/harmony-25/advanced/timing/extend-single-exposure.html),
[Blockbench's overview](https://blockbench.net/wiki/guides/blockbench-overview-tips/),
[Blender's onion skin manual](https://docs.blender.org/manual/en/latest/grease_pencil/properties/onion_skinning.html),
and [SpriteStack](https://spritestack.io/).

The most useful artist evidence is specific about the task:

- An artist working on game projects preferred Aseprite's animation handling to
  Photoshop's frame workflow, while identifying interchange as an obstacle.
  Their requirements included named animation ranges, trimmed exports, reuse,
  and onion skins. [First-person account](https://www.reddit.com/r/gamedev/comments/f3tfwn/).
- A filmmaker described Animate as quick and intuitive for motion, but wanted
  better drawing tools. This supports studying timeline UX separately from
  the quality of the drawing toolset.
  [First-person account](https://www.reddit.com/r/animation/comments/11r45ur/).
- Artists comparing Clip Studio and TVPaint praised TVPaint's timeline while
  disagreeing about its wider interface. There is no single winner across
  drawing, animation, and overall UI.
  [Discussion](https://www.reddit.com/r/ClipStudio/comments/1dmol32/clipstudio_ex_vs_tvpaint/).
- An artist comparison of RoughAnimator, ToonSquid, Callipeg, and Dreams examines
  concrete needs such as separate line/color layers and onion skins. Treat it
  as a dated workflow report, not a current feature matrix.
  [Comparison](https://www.reddit.com/r/2DAnimation/comments/182z654/toonsquid_vs_callipeg_vs_procreate_dreams/).

The resulting shortlist for detailed design work is **Aseprite, ToonSquid,
Procreate Animation Assist, and RoughAnimator/TVPaint**. The other references
help check the design's limits and future direction.

**The editing contract**

Use four terms consistently:

- A **frame** is a complete pose in the ordered flipbook, with a duration.
- A **layer** is a named part of the model that exists across the flipbook.
- A **cel** is the voxel content at one layer/frame intersection.
- A **hold** makes a pose last longer. It does not create another editable pose.

The primary loop is: model a pose → duplicate frame → change some voxels →
compare neighbors → play → adjust timing. A new document starts with one frame.
Opening animation controls does not convert or replace the document.

| Action | Proposed result |
| --- | --- |
| Duplicate frame | Insert after the current frame; copy every layer's cel and the duration; select the copy. Subsequent edits are independent. |
| Blank frame | Insert after the current frame with all cels empty. Layer structure stays intact. |
| Hold | Change the duration of the entire pose. Show the duration on its timeline tile. |
| Reorder frame | Move its identity, duration, and all cels together. Preserve the active frame by identity. |
| Delete frame | Remove a whole pose and close the gap. Keep at least one frame; clearing the final frame is a separate action. |
| Clear cel | Empty the active layer in the current frame without changing duration or frame order. |
| Duplicate cel | Copy just one layer's content to a chosen existing frame. |
| Link cels, later | Explicitly reuse one cel in several frames of the same layer. Editing it changes every linked occurrence. |
| Make independent, later | Copy a linked cel for this occurrence. Editing the copy affects only this occurrence. |

No implicit "use the previous nonempty cel" rule: an empty cel means empty.
That avoids blank/held ambiguity. The first release uses independent duplicate
cels. Storage sharing must not change that promise. Linked cels require a visible
link indicator and a tap-accessible way to make them independent before shipping.

Layer names, order, parents, pivots, palette, and grid size are document-wide.
Renaming a layer changes its name throughout the animation. Deleting a layer
removes its cels from every frame, as one undo step. Visibility and lock remain
local UI state, as they are today. Animated disappearance uses an empty cel.
Resizing affects every cel; crop-to-content computes bounds across all frames.

**Timing: a decision to test early**

Recommended first model: document FPS plus positive integer hold lengths. At
12 FPS, a hold of 3 lasts 250 ms. Changing FPS changes the speed of the whole
animation; changing a hold affects one pose. Start at 12 FPS with a hold of 1.
This is a proposed default, not an industry requirement.

Aseprite instead supports individual frame durations in milliseconds.
[Frame duration](https://www.aseprite.org/docs/frame-duration/).
That gives arbitrary timing, but a global FPS control then needs a clear rule
for rescaling nonuniform durations. For Voxeltoy's initial manual flipbooks, whole
holds are easier to explain and support animating on twos or threes.

Keep one authoritative representation, `fps` and `durationTicks`; calculate
seconds as `durationTicks / fps`. Do not store both milliseconds and ticks.
Prototype retiming before fixing the file schema. If artists need arbitrary
millisecond durations, choose that model before shipping rather than maintaining
two competing clocks. Rational broadcast rates and audio synchronization are
outside the first release.

**Desktop and phone interaction**

Animation opens a floating bottom panel. Collapse it to recover canvas space.
Desktop shows a frame header and layer rows. Phone width defaults to a strip of
complete-pose thumbnails plus an active-layer control; an explicit expand action
reveals layer rows. Both views edit the same data and offer the same commands.

Use equal-width pose tiles initially, each with a visible hold badge and total
duration readout. A longer hold does not consume an arbitrarily long strip on a
phone. This view is a pose sequence, not a proportional time ruler; label it
accordingly. A proportional timing view is a later option if testing supports it.

- Keep Play/Pause, Previous, Next, Duplicate, and the frame menu directly
  accessible. Put less frequent commands in the menu. Onion skin is a visible
  toggle when the timeline is expanded.
- Tap a thumbnail to select a frame; tap a grid cel to select both frame and
  layer. Show the current frame number and active layer near the editing area.
- Swiping the strip scrolls it. A separate scrub lane moves through poses.
  Avoid interpreting the same drag as scrolling, reordering, and scrubbing.
- Reorder through an explicit Move action with a drag handle; offer Move Left
  and Move Right as tappable alternatives. Long press can be a shortcut.
- Add a Select action for range operations. Range selection is local, undoable
  selection state; it is distinct from the active cel and voxel mask. Painting
  always affects only the active cel, even when a frame range is selected.
- Use `var(--hit)` with at least 44px coarse-pointer targets, pointer events,
  accessible labels, and focus states. Desktop shortcuts come from `actions.ts`
  and appear in the shortcuts dialog. No command depends on hover or modifiers.
- Timeline pointer handling stays separate from canvas gestures. A second
  canvas finger must still cancel the first finger's stroke before orbit/pan.

**Switching frames, selections, and playback**

Keep the existing voxel selection mask across frames. This lets an artist edit
the same spatial region repeatedly. It stays visible and undoable, and never
becomes a broadcast edit across selected frames. Copying selected voxels across
frames is an explicit command.

A stroke captures its source frame/layer/cel IDs at pointer-down. Frame changes
during an unfinished pointer stroke cancel and revert that stroke. They never
redirect its remaining writes into another frame. Proposed behavior for settled
previews: commit an explicit floating transform or extrusion on its source cel
before switching; cancel an uncommitted shape draft. Match the final choice to
existing tool conventions and test it with users. The headless interface must
expose an explicit pending-edit policy for automation.

Playback is local view state and creates no history entries or autosaves. Keep
the editing frame separate from the preview frame. Play starts from the current
frame; Pause adopts the displayed frame for editing. Disable painting during
playback; the first canvas editing attempt pauses without creating a stroke.
Orbit remains available. Hide selection handles and onion skins during playback.
Pause when the document becomes hidden; do not leap through a hidden interval
when it returns.

Use elapsed monotonic time and cumulative durations, not one pose per animation
callback. The browser schedules ticks; a DOM-free clock function resolves the
frame for an elapsed time. Fake times exercise the same interface in tests.
Late rendering may skip display frames while preserving intended timing. Show
a small performance message if playback cannot keep up. Export evaluates every
required frame deterministically and never depends on live playback speed.

**3D onion skins**

Start with previous and next poses at low opacity, with distinct colors and a
non-color cue in the timeline. Defaults should show the active layer only so
static scenery does not obscure the motion. Offer all visible layers and opacity
in the onion menu. Ghosts use the same camera and coordinate system, never take
part in raycasting, and never enter exports or the composite used by tools.

Render ghosts separately from the active model. Start with depth-tested ghosts,
depth writes disabled, and an optional x-ray mode. Evaluate outlines or changed
voxel regions if overlapping surfaces are unreadable. Color-only changes and
removed voxels must remain understandable. Disable loop wrapping by default;
make first/last-frame comparison an explicit option. Compare neighboring poses,
not repeated timing ticks within a hold.

The main design test is whether an artist can judge an arm's motion while
orbiting. A technically correct transparent mesh is not sufficient evidence.

**Document design and editor interface**

The current `Layer.data` stores one dense volume. Separate stable layer metadata
from cel content. Keep one source of truth; never swap whole documents when the
playhead moves.

```ts
type FrameId = string;
type LayerId = string;
type CelId = string;

interface AnimationFrame {
  id: FrameId;
  durationTicks: number; // positive integer
  cels: Record<LayerId, CelId | null>; // null is explicitly empty
}

interface CelRecord {
  id: CelId;
  layerId: LayerId; // first version restricts links to one layer
  data: Uint8Array;
}

// Inside the document, alongside size, palette, and layer metadata:
// fps: number; frames: AnimationFrame[]; cels: CelRecord[];
```

Frame order is an array; references and edits use stable IDs, not positions.
Require at least one frame, valid cel ownership, valid palette indices, matching
volume lengths, bounded FPS/durations, and unique IDs. Empty cels allocate no
dense array until the first write.

`Editor` remains the public interface. Suggested additions:

```ts
editor.frames;
editor.activeFrameId;
editor.displayFrameId;
editor.playing;
editor.setFrame(id, { pending: "commit" });
editor.insertFrame({ after: id, content: "duplicate" });
editor.moveFrame(id, { before: otherId });
editor.removeFrames(ids);
editor.setFrameDuration(ids, ticks);
editor.setFps(fps);
editor.play();
editor.pause();
editor.setOnionSkin({ enabled: true, scope: "active-layer" });
```

Names are provisional. Add blank creation, cel copy/clear, and selection through
the same interface. Every document command enforces read-only state, validates
its input, and creates one history entry. Export and agent tools resolve frames
without changing the editing frame. Extend existing inspection and editing agent
tools with frame context rather than adding a separate animation-only editor.

Use a small DOM-free animation module for duration resolution, frame order, and
cel lookup. `Editor` owns editing state and transactions; the viewport owns GPU
resources. Preserve `activeLayer.data` as a read-only current-cel view only if
that reduces caller churn. Audit all write paths: a read view cannot become a
second mutable store or bypass cel history.

**History and collaboration**

`VoxelsOp` currently identifies a layer and grid generation. `CellLog` also
resolves a current array by layer. Both must gain cel identity. Include source
frame context where needed to validate that a write still targets the intended
cel; never consult the recipient's current playhead to apply an operation.

Add checked operations for frame insert/remove/move/duration, FPS, and cel
creation/assignment. A duplicate copies the source as observed by the author;
replaying it must not copy whatever the source happens to contain later.
Record exact content or a retained immutable revision. Apply each command's
structural and voxel operations atomically, including rollback on rejection.

Conditional undo must account for cel content and frame/cel references. It must
not remove a frame or cel containing a collaborator's later changes just because
the local author created it. Retain removed data while history or pending edits
can still refer to it. Add explicit ownership checks for structural dependencies.
Grid generation continues to reject stale cell indices after resizing.

Frame deletion during a remote stroke cancels/rejects that stroke safely;
reordering does not change its target. Presence includes a frame ID so a pointer
from another pose is not drawn as though it belongs to the current one.
Playheads, playback, and onion settings stay local. Shared saved timing remains
document state.

Update the room authority, client replay/rebase, snapshot schema, and wire codec
together. Bump the protocol version and reject incompatible clients clearly.
Existing room limits count cells across layers; animation limits must count
retained cel data and bound frame/reference counts too. The wire splitter today
only divides voxel operations: large frame/cel payloads need their own bounded
transfer path with atomic assembly. Local animation must not silently disappear
when entering a shared room.

**Rendering, memory, and storage**

Today `viewport.ts` remeshes the composite when geometry changes and disposes
the previous geometry. Animation needs a bounded cache of composite meshes.
Key it by cel IDs/revisions, layer order/visibility, grid, palette, slice, and
mesh settings. Floating previews stay outside reusable cached frames. Camera
movement does not invalidate voxel geometry; thumbnail camera changes do.

Keep current and neighboring frames warm, then prefetch the playback range
within a byte budget. Dispose evicted GPU geometry. Onion skins share geometry
where possible but use their own materials. Prioritize the frame the user is
scrubbing to and discard stale jobs. Measure before moving meshing to a worker;
the WASM wrapper and volume transfers need a separate design if synchronous
meshing exceeds the interaction budget.

A 64³ dense cel takes 256 KiB. Eight layers across 60 independent frames take
120 MiB of voxel bytes alone; composites, history, mesh buffers, and snapshots
are additional. At 128³, the same count takes 960 MiB. Set a total allocation
budget, not just per-axis limits, and reject oversized edits before mutation.

Independent duplicates may share backing bytes with copy-on-write: distinct cel
IDs, detach before the first write. Audit every write path before enabling this.
Explicit linked cels instead share the same cel ID and intentionally share edits.
Do not conflate these two forms of sharing. Dense deep copies are acceptable for
an initial bounded implementation; measure representative projects before
choosing copy-on-write as a release requirement. Avoid delta chains between
frames in the initial model: they complicate random access and deletion.

Native format version 3 (version 2 now holds shape layers) stores frame order/durations, layer metadata, and RLE
cel payloads once per cel. Preserve graph references within the file. An import
may remap IDs, but must remap all references together. Version 1 imports as one
frame. Validate decoded lengths, resource budgets, references, and durations
before allocation. Continue loading old files; older apps should reject v3
explicitly rather than load a misleading static subset.

Autosave currently writes the whole document to `localStorage` and silently
catches failures. Keep the present storage contract for the first bounded
release, but expose save failures and preserve the last successful draft.
Debounce document changes, never playback. Test incompressible documents as
well as sparse ones: RLE can grow data. A larger-scale animation release likely
needs IndexedDB for payloads; that is a deliberate change to the localStorage
tenet, with migration and recovery work, not an incidental refactor.

Snapshot sharing must use the new native format, preserve every frame, and
enforce limits after decompression. Update the room cache as well as the local
draft path. A failed save or upload must leave the in-memory animation intact.

**Export behavior**

- `.voxeltoy`: the full animation, independent of which frame is selected.
- Existing `.vox`, `.glb`, and `.png`: the selected editing frame. Label this
  explicitly in the UI; do not silently substitute the playback frame.
- First animation export: PNG sequence or sprite sheet plus JSON containing
  order, durations, FPS, and frame names/IDs. Use one camera, scale, origin, and
  bounds across the sequence so frames do not jump. Include transparent output.
- Later: named ranges such as Idle and Walk, animated image/video exports, and
  game-engine-oriented voxel sequences. Named range behavior is defined below.
- Animated GLB and other engine formats: see
  [animation export](animation-export.md). Changing voxel topology cannot reuse
  the static part export as transform animation; that document proposes cel
  meshes switched by STEP scale keys.

**Delivery and validation**

| Stage | Deliverable | Exit evidence |
| --- | --- | --- |
| 1. Interaction prototype | Desktop grid and phone strip; duplicate, blank, hold, scrub, reorder; two onion treatments. Use representative voxel poses. | Artists can make and retime a six-pose loop on desktop and a phone without hidden gestures. Decide ticks versus milliseconds. |
| 2. Headless foundation | Frame/cel model, checked ops, history, version 2 files, legacy import, selection/tool transitions, agent access. | Duplicate isolation, exact undo/redo, multi-frame resize/palette changes, file round trips, and read-only enforcement pass. |
| 3. First usable animation | Timeline, elapsed-time playback, onion skins, bounded cache, save-status handling, selected-frame static exports, PNG sequence/sheet. | End-to-end creation, save/reload, timing, export, and touch gesture checks pass on phone and desktop. |
| 4. Sharing compatibility | New snapshots, live protocol, cel-aware rebase/undo, quotas and payload transfer. | Two clients editing different frames converge; deletion and structural races preserve collaborators' work; old clients fail clearly. Complete before animation is allowed in live rooms. |
| 5. Reuse and organization | Linked cels, range editing, named animation ranges, richer export. | Artists can predict the scope of every edit, especially linked edits and changes within ranges. |

Stages 2–4 can be developed behind a feature flag. Do not expose animated
documents through existing sharing paths until those paths preserve them.

Targeted verification should include:

- Duplicate a frame, edit its cel, undo/redo, save/reload: the source is unchanged.
- Switch frames with a live stroke, floating selection, pending extrusion, and
  shape draft. No content crosses frames by accident; undo shows the source edit.
- Keep a voxel selection while changing frames; only the active cel changes.
- Remove/reorder frames and layers, undo, then resize and change palette entries.
  All frames remain valid, including frames outside the current playback range.
- Resolve exact duration boundaries, uneven holds, delayed ticks, one-frame
  loops, pause/resume, and hidden-tab behavior using fake time.
- Edit different frames concurrently; edit and delete the same frame; undo a
  frame creation after a peer adds content; reconnect with pending cel edits.
- Exercise allocation limits, malformed RLE/references, storage quota failures,
  interrupted saves, and oversized multipart messages without partial mutation.
- Test 32³, 64³, and 128³ documents with sparse and dense content. Measure memory,
  mesh latency, cached scrub latency, and 12/24 FPS playback on a real phone.
  Proposed target: cached scrubs display within 50 ms at the 95th percentile.
  Treat this as a target to measure, not a present capability.
- At 360px and 640px widths, create a loop using one finger. Repeat on desktop;
  verify hit targets, menu reachability, keyboard alternatives, and canvas
  second-finger cancellation while the timeline is open.

Before implementation, test three questions with a few artists: do they expect
Duplicate to copy all layers; do whole-number holds cover their timing needs;
and do 3D onion skins help more than quickly flipping between poses? Those
answers should shape the interface before optimizing storage or adding reuse.

## Animation tags

Implemented October 29, 2026. A tag names an inclusive, contiguous range of frames.
Tags have stable IDs, unique names (1–100 characters), two frame IDs, a direction
(`forward`, `reverse`, or `pingpong`) and a repeat count (0–999). Overlaps are allowed.
At most 512 tags can be saved. Repeat 0 loops forever; a positive count stops after
that many cycles. Ping-pong visits interior frames on the return trip without
repeating either endpoint. Each visit uses that frame's hold.

Endpoints follow frame IDs. Inserting between them includes the new frame.
Reordering keeps the range between its endpoints, even if they cross; playback
uses their current order. Deleting frames shrinks each affected range to its
first and last surviving members. Deleting its entire range removes the tag.
Frame deletion and tag changes form one undo step.

In the timeline, tags are colored bands above the pose tiles, in a grid column
per frame. `tagLanes` (`animation.ts`) stacks them: longer ranges take rows
first, so a nested tag sits under the one around it, and tags that share no
frames share a row. A band's color comes from its tag ID. Tapping a band plays
only that tag. Frames outside the tag dim on the strip and on the scrub lane.
Tapping the playing tag's band again opens tag edit mode. The transport has a
range chip ("All frames", or the tag's name and how it plays) that opens a list
of tags, New tag here, and Edit. New tag here tags the current frame and opens
edit mode. In edit mode, the transport row becomes the tag's name, a direction
control (→ ← ⇄), a menu (Start here, End here, Delete tag) and Done. A second
row has a repeat stepper (∞, ×1, ×2…) and the range. Handles at both ends of
the range drag to whole frames, or move by one frame with the arrow keys. Each
change is one undo step. Selecting a tag limits playback; it does not limit editing or scrubbing.
Playback starts at the current frame when it is inside the tag, otherwise at
the first frame in the tag's playback order. Selection is local UI state.

`editor.tags`, `activeTagId`, `setActiveTag(id | null)`, `createTag(name, from?, to?)`,
`updateTag(id, changes)` and `removeTag(id)` expose the same behavior to scripts.
Tag document edits are checked operations and undoable. `.voxeltoy` v3 saves tags,
including tags on single-frame documents. PNG sequence and sheet manifests carry
the same tags, referencing their frame IDs. Snapshot links preserve them; live
rooms still reject animation operations. Agents use `edit_animation_tags`;
`get_document` includes tags and the selected playback range.
