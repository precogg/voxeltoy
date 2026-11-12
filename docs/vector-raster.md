# Vector + raster: product and technical design

Proposal, October 27, 2026. The architecture discovery examined commit `f885472`.
File references below describe that baseline; proposed types and method names are
illustrative. Milestones 1–4 are now implemented behind a flag, with the Boolean tree since
replaced by [step stacks](#step-stacks-shape-volume-and-material); see
[Implementation status](#implementation-status). This is still not a release commitment.

## Product intent

Let an artist keep a shape editable while adding voxel detail by hand. Changing
the shape should regenerate its voxels without erasing the artist's separate
raster work. The result should still feel like Voxeltoy: one model, a calm canvas,
simple tools, local files, and an API that can do everything the UI can do.

The first useful experience is a solid box with an editable subtracting box and
a raster override layer. An artist can:

1. Create a box and drag a face to change its dimensions.
2. Add a second box that cuts a hole in the first, then adjust either box.
3. Add, paint, and erase voxels in the override layer over the evaluated model.
4. Adjust the boxes again and see the overrides compose predictably.
5. Undo those source edits, save and reopen the editable document, and export
   the flattened result.

The word **vector** means continuous, mathematical source geometry here. The
display and normal model exports remain voxelized. This is not a promise of a
polygon modeling editor, smooth surface export, or a general CAD system.

### Relationship to existing product principles

[Product principles](principles.md) currently put editable geometry in one voxel
grid and exclude sub-voxel object placement. This proposal deliberately changes
that boundary for procedural source. Raster editing keeps whole output-cell
steps. Continuous procedural coordinates do not require exposing arbitrary
rotation or unrestricted object placement in the first UI.

Keep the current principles in force for shipped behavior until this proposal is
accepted. Update them when the feature becomes a product commitment. Preserve
touch-first interaction, headless editing, undo, local autosave, and portable
files throughout the transition.

### First release scope

- Local authoring of box primitives and a small Boolean expression tree.
- Raster layers with explicit solid, empty, and unset states.
- Palette-index material assignment and constant materials on primitives.
- Persistent, re-editable parameters and one undo step per gesture.
- One output grid shared by every raster layer, a power-of-two output
  resolution, native persistence, and flat voxel/mesh exports.
- Hybrid sources in the Voxeltoy app; embedding hosts opt in (see
  [Embedded editors](#embedded-editors)).
- Explicit layer and operand selection, with draggable handles and numeric
  controls that work on a phone.

Defer a graph editor, arbitrary user expressions, constraints, animation,
surface-attached paint, rich physical materials, general affine transforms,
GPU evaluation, and procedural collaboration. Spheres and the other existing
brush shapes can follow after the boundary works for boxes.

## Current implementation and reuse

The authoritative source today is `Layer.data: Uint8Array`, one dense volume per
layer, sharing document size and palette. Zero is empty and contributes nothing
over lower layers; the nonzero value of the highest visible layer wins. See
[`types.ts`](../packages/core/src/types.ts) and `rebuildComposite()` /
`updateCompositeCell()` in [`editor.ts`](../packages/core/src/editor.ts).

`ShapeSpec`, `shapeMask()`, and `shapeCells()` in
[`shapes.ts`](../packages/core/src/shapes.ts) already define and rasterize boxes,
spheres, cylinders, pyramids, diamonds, and toruses. Pending shapes have live
handles, but `commitShape()` writes raster cells and discards the definition.
There is no persistent CSG tree, SDF system, or heterogeneous source-layer model.

`Viewport.remesh()` sends `Editor.composite` through
[`Mesher.build()`](../packages/three/src/mesher.ts) to the
[AssemblyScript mesher](../packages/mesher/src/assembly/index.ts), then displays
the greedy surface in Three.js. Keep that dense output contract initially.
The renderer does not need to know how the source was authored.

Reuse `ToolController` ray/plane calculations and pending-shape interactions,
the SDK's `EditorHost`, commands in `actions.ts`, and the headless `Editor` API.
Extend checked document operations and history for source changes. Do not use
brush-writing APIs to populate procedural caches: derived voxels are not edits.

Several current consumers read source arrays directly: selections, transforms,
palette replacement, operations, files, sync, and exports. Move them deliberately
to either raster-source access or evaluated-output access. Do not make `data`
silently mean an editable source in one layer and a disposable cache in another.
Position hiding (`hideCells`) also reads layer data directly to find filled cells.

Embedding hosts can redefine what a value means through the SDK extension points
added so a host can give a cell value its own meaning. Values are palette indices only in the Voxeltoy
app. See [Embedded editors](#embedded-editors).

## Source and evaluation boundary

The document owns authored content. The evaluator owns disposable results. The
viewport owns meshes and GPU resources. `Editor` remains the public owner of
editing state, transactions, source access, and evaluation requests.

The conceptual flow is document source → layer evaluation → composition → dense
voxel volume → display or export. Display clipping is a subsequent view filter.
Export must not accidentally depend on a temporary slice or unfinished drag.

### Proposed source model

Use a discriminated layer union. Keep metadata separate from content so a future
animation design can reference content without requiring a second competing
layer model. The first implementation may store the content inline.

```ts
type LayerSource = RasterSource | ProceduralSource;

interface RasterSource {
  kind: "raster";
  // Always laid out on the document's output grid; no per-layer grid.
  values: Uint8Array; // 0 = empty; 1..255 = palette index
  coverage?: Uint8Array; // absent = legacy nonzero-only contribution
}

interface ProceduralSource {
  kind: "procedural";
  root: GeometryNode;
}

type GeometryNode =
  | { id: string; kind: "box"; min: Vec3; max: Vec3; material: number }
  | { id: string; kind: "subtract"; left: GeometryNode; right: GeometryNode }
  | { id: string; kind: "union"; left: GeometryNode; right: GeometryNode }
  | { id: string; kind: "intersect"; left: GeometryNode; right: GeometryNode };
```

Only box and subtract are necessary for the first experiment. Other operators
above establish intended semantics without requiring their UI in that milestone.
Use a bounded tree with stable node IDs, no cycles, and no shared references in
the first schema. Bound depth, node count, numeric ranges, and total allocation.

Layer IDs identify sources; node IDs identify editable operands. Existing rig
`parent` links describe exported parts. They are neither Boolean operands nor
transform inheritance. Never reuse that field for either relationship.

Runtime revisions belong to evaluation bookkeeping, not the saved geometry
definition. All source changes pass through `Editor` and checked operations.
Mutable arrays returned by existing APIs are a compatibility risk: new source
views must have a documented read-only contract and controlled write methods.

### Coordinates, bounds, and resolution

Use continuous, Y-up **source space** for procedural geometry. A source unit
initially equals one voxel in an imported legacy grid (the **reference grid**);
there is no implied meter scale. Physical unit metadata can be added later.

The document has a finite source-space evaluation region and a saved output-grid
setting. Voxel spacing is uniform so displayed cells remain cubes. The output
resolution is a power-of-two multiplier over the reference grid (1×, 2×, 4×, …).
Doubling it doubles cell counts on every axis while preserving source bounds.
Do not expose independently chosen counts that silently stretch voxels. Powers
of two keep every resolution change an integer ratio, so raster resampling is
exact going finer, and `cellSize` stays exactly representable in floating
point. The output grid is limited to `MAX_SIZE` (256) cells per axis, which is
also the `.vox` coordinate limit, so the reference size bounds the multipliers
offered.

An output cell at integer index `i` samples source position
`origin + (i + 0.5) * cellSize` on each axis. Source boxes use half-open bounds
`[min, max)`. Integer cell boxes in the current brush API use inclusive maxima;
conversion must be explicit. Output is clipped to the evaluation region.

The first schema stores box coordinates as multiples of the finest supported
cell size (1 / the largest multiplier), and validation rejects anything else.
Every coordinate, cell size and sample position is then an exact binary
fraction, so membership tests give identical results on the main thread, in a
worker or in WASM. An implementation may compare in integer output units
(`2m·min ≤ 2i + 1 < 2m·max` for multiplier `m`) instead of floating point.
A box has a positive extent on every axis.

Handles and numeric fields snap to the current output cell, so every edit moves
in whole displayed voxels, as the principles require. Box coordinates are kept
exactly across resolution changes. Refining always leaves faces on cell
boundaries. Coarsening can leave a face partway through a cell; it voxelizes
deterministically by the half-open rule, its outline shows the exact bounds,
and the next drag snaps it to the new grid.

Changing output resolution preserves source geometry and pivots, and resamples
the selection and every raster layer onto the new grid (see
[Raster grid and resampling](#raster-grid-and-resampling)). It is one undoable
step that restores the previous raster contents exactly. It does not call today's
`resize()`, which repositions and crops stored cells. Changing the evaluation
region is another explicit command; destructive raster resize/crop remains a
raster operation. Preserve current resize behavior for legacy documents.

Rig pivots stay in reference-grid units with half-voxel steps, as today. Output
resolution does not move or re-snap them.

Keep the first renderer in output-grid coordinates. Centralize conversions
between source space and output-grid space for rays, bounds, pivots, helpers,
and export geometry. One output voxel remains one visual grid unit internally;
export scaling can map those units back to the same source-space extent.
Reject grids above supported cell or memory budgets before allocating them.

### Evaluation contract

A DOM-free evaluator reads validated source plus an explicit evaluation grid
and returns a dense palette-indexed volume. It must not mutate source, allocate
palette entries, invoke editor editing methods, create history, or touch Three.js.
Identical committed source and settings must produce identical CPU output.

Separate three concerns:

- Geometry membership and material choice within a procedural tree.
- Sampling each source layer and resolving ordered layer contributions.
- Display-only filtering, such as slice, hidden cells, and lifted raster content.

For a procedural sample, carry an internal solid flag and material index. Final
output can encode these as zero or a palette index. Raster contributions also
need a presence flag, because covered empty and absent are different inputs.
Do not allocate an object per sampled cell; use direct writes and scratch data.

An illustrative API is `evaluateDocument(source, grid, options)`, returning the
volume and revision/grid identity. Display and export choose explicit layer
visibility inputs. Derived arrays are read-only to tools. Evaluation errors keep
the previous valid display, report the failure, and prevent exporting stale data
as though it were current.

## Composition and materials

### Boolean semantics

Boolean operators act only on their own subtree, in continuous source space:

- Subtract: solid where left is solid and right is empty; material comes from left.
- Union: solid where either operand is solid; right wins material where both are solid.
- Intersect: solid where both are solid; material comes from left.

Subtract does not carve unrelated lower layers. Outside its resulting solid,
a procedural layer contributes unset, so it reveals lower layers. A global cut
is expressed with a raster empty override or a future explicit layer operator.
Do not let layer order implicitly change which operands a subtraction owns.

Keep material resolution distinct from geometry membership in the evaluator,
even though the first public materials are just existing palette slots.
Position-dependent material fields can later return a slot without changing the
renderer. A cut face initially shows the left solid's material; assigning cutter
or surface materials is deferred.

### Raster override semantics

For a coverage-backed raster cell:

- Coverage 0: unset; retain lower evaluated content.
- Coverage 1, value 0: explicitly empty; clear lower evaluated content.
- Coverage 1, value 1..255: explicitly solid with that palette slot.

Compose visible layers bottom to top. An unset sample leaves the accumulated
value alone; a covered sample replaces it, including zero. A higher solid can
therefore fill a hole cut by a lower empty override. Hidden layers contribute
nothing. Lock affects editing, not evaluation.

Legacy raster layers retain their existing rule: nonzero contributes solid;
zero is unset. Avoid allocating a full coverage array for every legacy layer.
Explicit conversion creates coverage from nonzero cells without changing the
result. History and serialization must preserve whether coverage exists.

**Erase** on an override writes covered empty. **Clear override** removes
coverage and reveals the source below. Give both commands tappable paths and
distinct labels. Ordinary legacy-layer Erase keeps its existing behavior, which
cannot cut procedural geometry because a legacy zero is unset. In a hybrid
document, new raster layers are coverage-backed. When Erase on a legacy layer
hits a voxel that layer doesn't own, say so, and offer the explicit
conversion to an override layer.
Clearing the entire override layer removes its coverage, rather than replacing
its entire bounds with covered empty cells.

The first Paint command stamps the visible hit's material override as covered
solid in the active raster source. Because rasters share the output grid, the
painted cell is exactly the visible voxel that was hit, so Paint never adds
solid voxels in empty space. It does not promise paint that disappears
when underlying geometry moves away. Conditional color-only painting needs a
separate material-override channel and is deferred. Explain this behavior when
introducing override layers; do not silently change it later.

### Raster grid and resampling

Every raster layer is stored on the document's output grid: one raster cell per
output cell, with the same size and indexing as today's `Layer.data`. There are
no per-layer origins or cell sizes, so evaluation never samples a raster at a
different resolution. A raster cannot be finer or coarser than the output, so
there are no cell-center ties to resolve and no single edit that spans several
displayed voxels.

Changing output resolution resamples every raster layer, inside the same undo
step as the setting:

- **Finer** (×2ᵏ): each cell becomes a uniform 2ᵏ×2ᵏ×2ᵏ block with the same
  coverage and value. This is exact and loses nothing. It does not invent
  smaller brush marks.
- **Coarser** (÷2ᵏ): each block becomes one cell holding the block's most
  common state, where unset, covered empty and each covered palette value are
  distinct states. Break ties in favor of covered over unset, then solid over
  empty, then the lowest palette index. For legacy layers, zero counts as unset.
  When any block is not uniform, warn before applying that raster detail will be
  merged; undo restores it exactly.

Coarsening then refining does not restore lost detail; only undo does.
Conservative or coverage-preserving reductions are later work, not an invisible
change to the first rule.

Pointer hits arrive in output coordinates and address raster cells directly.
Paint and Erase target the hit cell; Add targets the adjacent output cell,
exactly as brushes do today. A stroke deduplicates cell indices. The brush
footprint is always one displayed voxel.

The selection mask also lives on the output grid. A resolution change resamples
it in the same undo step: refining repeats each cell, and coarsening selects a
cell if any of its block was selected.

Overrides stay at their source-space positions when an underlying box changes.
They are spatial edits, not marks attached to a shape's surface. Moving a
procedural object can leave a painted solid behind or move it away from an erased
region. Surface attachment would require an explicit binding model and is deferred.

## Editing, picking, and undo

### Interaction

Keep the procedural layer in the layer list. A compact operand list lets the
artist select the solid box or cutter even when the cutter produces no visible
surface. Selection draws its bounds and handles. Start with axis-aligned box
faces and numeric dimensions; reuse existing shape interactions where suitable.

**Add box** creates a procedural layer and draws its box with the existing
box-shape interaction. **Cut** on a selected operand starts the same
interaction for a new box. Apply replaces the operand with
`subtract(operand, newBox)` as one undo step. Removing a cutter puts its left
operand back in place of the subtraction. Both commands live in `actions.ts`
and the operand list, so they are tappable.

One finger on a handle edits its parameter. Empty space orbits; two fingers
cancel the parameter draft and enter pan/zoom. Use pointer events and
`touch-action: none`, `var(--hit)` targets of at least 40px/44px for coarse
pointers, and tappable Apply/Cancel and numeric alternatives. Check desktop and
compact layouts at 360px and 640px. No essential action depends on hover,
right-click, modifiers, or a wheel.

Procedural operand selection is separate from the existing voxel selection
mask. Do not allow lifting or painting a procedural cache. Offer an explicit
Bake to raster command when destructive editing is wanted, with undo restoring source.
Baking is not required for the first experiment.

### Raster tools on override layers

Today, selecting reads the visible composite and editing reads the active layer
(`faceCells()` in [`tools.ts`](../packages/core/src/tools.ts), `fill()` in
`editor.ts`). On an override layer, the active layer alone is mostly unset, so
those tools would find nothing over procedural geometry. On a coverage-backed
layer, tools therefore *find* regions in the evaluated display volume and
*write* covered cells to the active raster only:

- **Add, Paint, Erase** (voxel, box, face, shape): as above; Erase writes
  covered empty.
- **Fill** (connected and all): floods or matches the visible value and writes
  covered solid. Like Paint, the result stays put when geometry moves.
- **Extrude**: finds the visible face region; pulling writes covered solid,
  carving writes covered empty.
- **Select** and **Pick**: unchanged, they already read what is visible.
- **Move, rotate, flip** of a selection: lift only the active raster's coverage
  and values. The cells left behind become unset, revealing what is beneath, not
  covered empty. Unset cells stay unset when they land. `transformValue` applies
  as today.
- **Mirror**: unchanged. Rasters share the output grid, so mirrored cells
  always exist.

Legacy layers keep today's behavior for every tool. Disable a tool rather than
guessing when it has no defined meaning on the active source.

### Picking

Continue DDA picking against the evaluated display volume for voxel tools.
Transform hits into source coordinates at a single boundary. Initially, select
procedural operands explicitly and hit-test their handles; a dense provenance
buffer is unnecessary. Later surface-based object selection can use an auxiliary
owner buffer or targeted source reevaluation after a hit.

Do not confuse visible ownership with editing target: an override can cover a
procedural surface, while raster tools still write only the active raster layer.
Slice and hiding must agree between display and picking. Export ignores these
temporary display filters by default.

### Source operations and drafts

Extend [`ops.ts`](../packages/core/src/ops.ts) with checked operations for source
creation/removal, node parameters and tree changes, evaluation settings, and
raster patches containing both coverage and value before/after states. Stable
IDs identify the target. Validate finite bounds, palette indices, tree limits,
grid sizes, and read-only state before mutation; apply batches atomically.

Extend [`history.ts`](../packages/core/src/history.ts) to invert these operations.
A raster override edit must restore coverage as well as value. A parameter drag
records one source operation, never the thousands of regenerated cells.

Draft parameter state lives in `Editor`, apart from committed document source.
It can invalidate a preview evaluation, but must not autosave or emit document
ops on each pointer move. Apply commits the final checked source change; Cancel,
Escape, or a second pointer restores the committed result. Undo first cancels a
draft, matching existing pending-shape behavior. Switching source, opening a
file, and changing resolution must resolve drafts explicitly and consistently.

Expose these commands through the headless API and consider agent tools in
`agent-tools.ts`. Add UI commands and shortcuts through SDK `actions.ts`.
The UI must not own geometry definitions or evaluator state.

### Embedded editors

The SDK lets a host give voxel values its own meaning: `EditorOptions`
`transformValue` and `replaceHiddenValue`, `updateCells`, value and position
hiding, custom tools, and `EditorHost.decals`. A host can rely on
these. Hybrid sources break
their assumptions. A 2× output turns one game block into eight. A cut face takes
a value from the left operand without passing it through `transformValue`.
Decals, hidden positions and custom tools address output cells, which move when
the resolution changes.

Hybrid sources were therefore first disabled unless the host opted in through
`EditorOptions.hybrid`. That flag is gone (November 2026): every editor opens and
edits shape layers, override layers and resolutions. A host that supplies
`transformValue`, `replaceHiddenValue` or decals gets the resolution locked to 1×
(as does `lockResolution`), primitives take plain values, and a host can leave the
authoring commands out of the UI with `EditorHost.shapes: false`.
Unlocking more resolutions requires a further explicit opt-in and a defined
value contract: split/merge hooks for resampling, and a hook to choose cut-face
values. Specify that contract only when a host needs it.

Keep the headless API identical whether or not the host opts in. A disabled
command reports the reason, as other blocked edits do. Position-hidden cells
(`hideCells`) live on the output grid, and a resolution change clears them, as
a resize does today.

## Display, exports, and persistence

### Canonical output and migration of consumers

Introduce an evaluated-volume interface rather than replacing all callers at
once. A legacy adapter can initially produce today's result. Keep the raster-only
editing and sharing paths operational while hybrid documents use new source-aware
commands. Do not maintain two independently editable copies of the same source.

`Editor.composite` can remain a compatibility view of displayed output, but its
slice/hiding semantics make it unsuitable as the canonical export result.
Move flat exporters to an explicit committed evaluation request. Keep temporary
floating raster content and drafts outside saved/exported state unless a user
commits them first.

Flat hybrid `.vox` export writes the evaluated result as a voxel model. Flat GLB
meshes that same result and applies source-space scaling. PNG captures the chosen
view after resolving drafts. Preserve existing multi-layer `.vox` and parts GLB
behavior for legacy documents. Hybrid part export is unsupported initially:
offer flat export explicitly rather than guessing how subtraction and overrides
belong to rigged parts. Cross-layer cuts cannot generally become independent
part meshes without a defined ownership rule.

### Native format and autosave

Use a new native schema version for heterogeneous sources. Store stable layer
and node identities, source bounds, output settings (including the multiplier),
raster values/coverage on the output grid, tree structure, palette references,
and existing metadata. Keep IDs and all references consistent when copying or
importing. Saving layer IDs is a change: v1 files omit them, and opening a v1
file still assigns fresh IDs.

Import v1 layers as legacy raster sources at unit spacing with their existing
composition. New apps must continue opening those files. Old apps already reject
unknown versions; retain that clear failure instead of embedding editable source
in ignored v1 fields. Keep a legacy save path for documents that remain fully
representable without loss. Never silently discard sources to make a file fit v1.

The [animation proposal](animation.md) also discusses a future v2 schema. Select
one version/migration plan when implementing persistence; these proposals do not
independently own the version number. Separating layer metadata from content now
avoids choosing an animation design as an accidental side effect.

Validate decoded lengths, coverage/value pairs, references, tree depth, numeric
ranges, and resource budgets before allocating or installing a document. Optional
voxel caches are disposable and should be omitted initially. If added later,
key them by source, grid, palette, and evaluator version and revalidate them.

Autosave stores committed source, not the current preview or mesh. Preserve the
localStorage contract for the bounded first release, measure incompressible
coverage/value payloads, and expose save failure without destroying the last
successful draft. IndexedDB is a separate persistence decision if measured
document sizes exceed the existing storage contract.

### Collaboration boundary

Defer procedural collaboration until local source operations and semantics are
stable. Keep existing raster-only live rooms working. Block creating or joining
a room with hybrid source before conversion, upload, or local replacement can
lose it. Do not flatten silently, and do not assume the current snapshot service
will accept the new schema. Explain that the editable native file remains local
and downloadable; enable new snapshot sharing only after its validator preserves
the full schema.

Later collaboration requires protocol negotiation, source-aware snapshots and
operations, conditional undo for node parameters and dependencies, palette and
resolution races, quotas, and deterministic replay. Transmit authored changes,
not derived voxel patches. Follow the ownership model in
[collaboration.md](collaboration.md) without treating its current wire format as
already extensible to these sources.

## Performance and invalidation

Start with CPU evaluation and the current WASM mesher. Box membership and
subtraction do not require SDFs or GPU compute. Write dense output directly;
avoid `Vec3[]` allocation and per-voxel editor calls during evaluation.

The discovery's synthetic container probe measured a warm median of about 58 ms
for a full solid `128³` `Mesher.build()`, even though it emitted only six quads.
That includes the CPU wrapper but excludes browser drawing/GPU upload. A solid
`64³` took about 7.4 ms; fragmented geometry costs more in output buffers. These
are starting observations, not supported-device limits or release benchmarks.

At `128³`, each dense byte channel is 2 MiB; at `256³`, it is 16 MiB. Coverage,
selection, composites, WASM staging, history, and meshes add to source storage.
Set byte budgets as well as dimension limits, including derived and in-flight
data. RLE can expand incompressible data. Count retained undo data too.

Initially cache a complete evaluated result by source revision, grid settings,
palette-dependent inputs, visibility inputs, and evaluator version. Keep
display-filter and draft identities distinct from committed output. Palette RGB
changes need remeshing with the current baked-color renderer; they need not
rerun geometry membership. Palette slot remapping must update source material
references and raster values as one undoable change.

Coalesce parameter previews to at most one scheduled update per animation frame,
using the latest draft. A scheduling limit does not make a 58 ms task fit a frame.
If evaluation becomes asynchronous, attach revision/job IDs, discard stale
results, and support cancellation between bounded units of work. Publish volume,
grid metadata, and matching picking state together. Never pair a new ray mapping
with an old volume.

After measurements, consider bounded-region reevaluation using the union of old
and new bounds, layer dependency invalidation, and worker execution. Current
meshing still scans the full volume; region evaluation alone will not remove
that cost. Chunk meshing needs neighbor occupancy/AO halos and its own seam tests.
GPU evaluation is useful only if transfers, CPU picking/export, and numerical
agreement justify it. Keep the CPU path as the reference implementation.

## Milestones and acceptance evidence

Each milestone should leave the default raster workflow usable. Use a feature
flag for incomplete hybrid authoring. No milestone requires a graph editor or
procedural collaboration.

### 0. Agree on semantics and establish the baseline

Record decisions for source coordinates, output sampling, Boolean scope,
material precedence, raster coverage, Paint/Erase/Clear, and spatially fixed
overrides. Review these with a few concrete artist tasks, including moving a
box away from painted detail. Confirm that this behavior is understandable.

Add repeatable performance scenes for solid and fragmented `32³`, `64³`, and
`128³` output. Separate evaluation, composition, meshing, allocation, and browser
frame latency. Record desktop and a real phone. Re-run existing tests; the
discovery baseline was 188 passing Bun tests plus mesher correctness checks.

**Exit evidence:** accepted semantic examples and device measurements; a list of
direct `layer.data` consumers classified as source editors or evaluated readers.
No application schema migration yet.

### 1. Establish the evaluation boundary without changing raster behavior

Introduce a pure evaluator contract and a legacy raster adapter. Add explicit
display versus committed-export evaluation. Route flat-output consumers through
the boundary incrementally, keeping raster editing and sync compatible.

**Exit evidence:** legacy overlapping layers, visibility, slice/picking, floating
content, palette changes, resize, and exports retain documented behavior. Tests
prove evaluation does not mutate source or create history. Old file fixtures and
existing sync convergence tests still pass. Raster performance does not regress
materially against milestone 0.

### 2. Build the headless box/subtraction/override experiment

Add typed procedural and coverage-backed raster sources, box/subtract evaluation,
source operations and inversion, explicit grids, and resolution settings. Keep
the experiment bounded to small local documents. Add source-aware commands to
`Editor`; UI work can wait until the semantics pass independently.

**Exit evidence:** parameter changes regenerate output; subtraction affects only
its subtree; covered empty cuts lower geometry; clearing coverage reveals it.
Test every pair of unset/empty/solid contributions, reorder, visibility, lock,
palette remapping, invalid input rollback, and source non-mutation. Undo/redo
restores parameters and coverage exactly, not cache contents. Resolution changes
preserve source bounds; refining rasters is exact, coarsening follows the
majority rule, warns when lossy, and undo restores the original cells.

### 3. Deliver the focused local editing experience

Add operand selection, face handles, numeric dimensions, and a compact parameter
bar through the SDK. Add raster override mode, the coarsening warning, and
distinct Erase/Clear commands. Implement draft evaluation, commit, and cancellation
with one source undo step per gesture. Disable raster-only commands on procedural
sources with a clear reason rather than applying them to caches.

**Exit evidence:** on desktop and a phone, complete Product intent steps 1–4
(step 5 needs milestone 4). Test Add box and Cut, second-finger cancellation,
Escape, undo during a draft, layer switching, hidden cutters, overlap picking,
each tool on an override layer, legacy Erase over procedural geometry, and
snapping after finer/coarser resolution changes. No draft enters
autosave/history. A proposed interaction target is
95th-percentile pointer-to-visible update within 50 ms at `64³` on the chosen test
phone; record misses and reduce preview resolution or scope before expanding it.

### 4. Make the experiment portable and recoverable

Implement the versioned native schema, v1 migration, source autosave and failure
feedback, and canonical flat `.vox`/GLB export. Apply the hybrid collaboration and
snapshot gates before enabling hybrid documents outside the experiment.

**Exit evidence:** create → paint/erase → modify boxes → undo/redo → save → reopen
preserves editable source and evaluates identically. Exports match committed
evaluation at the requested resolution and preserve source-space extent. Test
v1 fixtures, malformed/oversized files, storage failures, unsupported versions,
and failed sharing attempts without losing the local model. This completes the
smallest end-to-end proof; it is not complete at the preview-only milestone.

### 5. Harden and expand only after the proof succeeds

Profile representative models, set supported budgets, and add bounded caches,
workers, or chunk meshing only where measurements justify them. Then add union,
intersection, additional primitives, explicit transforms, bake-to-raster, and
position-based materials in separate changes with independent acceptance tests.
Revisit Paint's material-only alternative before promising it publicly.

**Exit evidence:** default raster workflows and embedding remain compatible;
cache invalidation and stale jobs cannot mismatch rendering/picking; native files
stay portable; budgets reject expensive work before mutation. Decide whether
the product model is ready to replace the current principles and leave the flag.

### 6. Design shared procedural documents separately

Once local semantics settle, extend protocol, authority, snapshots, undo
ownership, and reconnect behavior together. Do not enable hybrid live rooms by
merely lifting the gate.

**Exit evidence:** clients converge while changing operands, raster overrides,
palette slots, resolution, and source structure; conditional undo preserves peer
work; deletion during a draft resolves safely; incompatible clients fail clearly.
This milestone is not a prerequisite for the local product.

## Decisions to make now and later

Before milestone 2, settle units and grid mapping, coordinate snapping and
storage, raster and selection resampling rules, override tool behavior,
override versus paint-only semantics, Boolean/material rules, ID ownership,
source operations, and the distinction between source and display evaluation.
Before milestone 4, settle native migration/versioning, export scaling and
visibility, storage budgets, and sharing rejection behavior.

Defer arbitrary rotations, shared expression DAGs, user code, SDFs, constraints,
surface bindings, animation integration, GPU backend choice, and procedural
collaboration until the focused experience supplies evidence for them. The
principal design test is whether an artist can predict what remains after
changing geometry beneath raster detail.

## Step stacks: shape, volume, and material

Added after milestone 4. The first experiment proved the boundary, but a Boolean
tree of boxes is too rigid to author with. Its material rules were tied to the
operator: a union always repainted what it overlapped, a cut had no color, and
an intersect kept the colors below. A shape layer is now a stack of steps
instead, and each step has three separate settings:

```ts
interface ShapeSource { steps: Step[] } // bottom first

interface Step {
  id: string;
  mode: "add" | "cut" | "intersect" | "paint"; // what it does to the volume below
  shape: StepShape;                             // where it acts: kind, box, options
  material: number;                             // the palette slot its cells take
  fill?: StepFill;                              // or a ramp, checks or stripes from it to a second slot
  keep?: boolean;                               // keep the colors below where it overlaps
}
```

Each step applies to the result of the steps below it in the same layer, never
to other layers. This keeps the earlier rule that operators act only on their
own operands. A cross-layer cut or recolor is still a raster override.

| mode | volume | color inside the shape |
|---|---|---|
| add | fills the shape | its material; with `keep`, only newly filled cells take it |
| cut | empties the shape | — |
| intersect | empties everything outside the shape | keeps the colors below; without `keep`, its material |
| paint | unchanged | recolors solid cells with its material |

A paint step recolors geometry that comes from steps below it. When those steps
change, the paint follows them. This is the shape-layer answer to the deferred
"material-only override" for content that is itself procedural.

Any step can be at the bottom of the stack, and any step can be removed while
another remains. A cut, intersect, or paint at the bottom has nothing to act on.
The Boolean tree form is no longer read. It only ever existed behind the flag,
so there is no migration.

### Next

Each item is a separate change with its own acceptance tests:

1. **More shapes** (done). Steps take every brush shape (box, sphere,
   cylinder, cone, capsule, pyramid, diamond, torus; cone and capsule are new
   to the brush too). A shape is its source-space box plus `up`, for the kinds
   that point somewhere. One inside test, `insideShape` in `shapes.ts`, serves
   the brush (in cells) and steps (in source units at cell centers), so at 1× a
   step covers exactly the brush's cells, and a shape keeps its size at every
   resolution. It uses only `+ − × ÷` and `sqrt`, which IEEE rounds the same
   everywhere (`**` and `Math.hypot` aren't promised to). The shape row in the
   stack picks what Box, Cut and Paint draw and reshapes the selected step;
   Rotate turns it, its box swapping extents around its center.
2. **Orientation and shape parameters** (done). A wedge (a ramp), whose
   `forward` says which way its slope faces across `up`; a `shell` wall
   thickness for any shape (the shape less the same shape inset by it); a
   `round` radius for box edges and corners, with its own `roundTop` and
   `roundBottom` for the top and bottom edges where they differ (the upright
   edges keep `round`; 0 is a flat, sharp-edged top or bottom on a rounded box);
   and a `top` for cones and pyramids, in eighths of the base (a frustum). A
   `limb` is a tapered tube from one corner of its box to the opposite one:
   `corner` (0 to 7, bits for max x, y, z) is the base, `radius` and `tip` its
   radii (unset: half the box's smallest side, and the base's). Both ends pull in
   by the thicker radius, so it stays inside its box, and an upright box makes an
   upright tube, tapered or not; Rotate steps the base corner. It is the one shape whose angle
   isn't a multiple of 90°: the box's proportions lean it, so it still moves and
   resizes as a box on the lattice. Sizes are source units on the
   1/8 lattice. `stepShape` keeps a shape canonical: only the options its kind
   takes, no zeros, a wedge's `forward` across its `up`. The step editor steps
   each in displayed voxels; Rotate and Turn change `up` and `forward`.
3. **Incremental evaluation** (done). `SourceCache` keeps, per layer, its
   last two results (a draft and the committed source take turns while a step
   is dragged) and a checkpoint: the volume below the first step that differs
   between its last two evaluations. A drag then re-evaluates only the dragged
   step and those above it. Keeping two results per layer, rather than one per
   source still referenced, also stops undo history from holding old volumes.
   On a 128³ layer of 21 mixed steps, a full evaluation takes about 42 ms; a
   drag frame of the top step takes 2.4 ms, of the middle one 18 ms. Region
   re-evaluation (only the union of old and new bounds) would cut the rest.
4. **Color fields** (done). A step's optional `fill` varies its color from
   `material` to `fill.to`: a `gradient` along an axis through every palette
   slot between the two (palettes keep a hue's ramp side by side; each slot
   covers an equal share of the box, so a ramp longer than the box has cells
   skips slots), a 3D `checker`, or `stripes` across an axis, `size` source
   units each. Patterns are measured from the step's box, so they move with it.
   `material` stays the step's main color, so swatches, recoloring and palette
   checks work as before; palette removal and remapping cover `fill.to` too.
   Fills are resolved per cell during evaluation; the renderer is unchanged.
5. **Bake to voxels** (done). `bakeShapeLayer` turns a shape layer into an
   override layer holding exactly its evaluated voxels, in one undo step: the
   same id, place, name, part and children, and the same look. Undo brings the
   steps back. Later: repeat and mirror steps, and groups (a step whose shape
   is a nested stack).

## Implementation status

Milestones 1–4 are implemented and on for everyone: every editor supports them, and
the Voxeltoy app shows the authoring commands. A host can hide them with
`EditorHost.shapes: false` (a model that already uses shapes still gets them).
`editor.isFlat` says whether a model is plain raster layers at 1×.

- **Source model** (`types.ts`, `source.ts`): a layer is a legacy raster (`data`), an
  override raster (`data` + `coverage`), or a shape layer (`shape`, a stack of steps; see
  [Step stacks](#step-stacks-shape-volume-and-material), with an empty `data`). Box
  corners are source units in 1/8 steps, half-open. `checkSource` bounds the step count,
  coordinates and materials.
- **Evaluator** (`evaluate.ts`): `applyStep`, `evaluateSource`, `composeLayers` and
  `evaluateDocument` are pure; `SourceCache` keys evaluations by source object and grid. The
  display composite is the same composition with display filters (hidden values and cells,
  lifted content, slice) and the current draft. `Editor.evaluate()` is the committed result
  for exports.
- **Ops and history** (`ops.ts`, `history.ts`): `layer.shape` (whole-source replacement),
  `layer.coverage`, `resolution`, a `coverage` channel on `voxels`, and shape/coverage
  data on `layer.add`/`layer.remove`. Resize moves shapes with the voxels. Palette
  removal and replacement check (and `loadPalette` remaps) step materials in the same
  step. Strict (shared) application and the room protocol turn all of these down.
- **Editor API**: `newShapeLayer`, `addBoxLayer`, `shapeStack`, `startStep`, `addStep`,
  `setStepMode`, `setStepKeep`, `setStepBox`, `setStepShape`, `rotateStep`, `turnStep`,
  `setStepMaterial`, `setStepFill`, `moveStep`, `removeStep`, `bakeShapeLayer`,
  `selectStep`, `selectedStep`, `pickStep`, `convertToOverride`, `clearOverride`,
  `setResolution`, `resolutionLoses`, `resolutionChoices`, `evaluate`, `layerValues`,
  `flatDocument`, `getOverride`. Faces nobody moved keep their exact source coordinates.
  Raster tools on override layers find what is visible and write covered cells, as
  specified above.
- **Tools follow the layer**: on a shape layer the toolbar is Orbit, Select shape, Shape, Cut
  and Paint (the select, add, erase and paint tool ids, so their shortcuts carry over). Shape,
  Cut and Paint draw a shape like the shape brush; it previews live as a new step and applies
  with Apply. Select picks the step under the pointer (an add or paint step before an
  intersect around it); its handles drag its box, one undo step per drag. Coming back to a
  raster layer restores the raster tool.
- **UI** (SDK): see [shapes.md](shapes.md). On a shape layer, the style panel shows the
  Shapes list (top step first) under the palette instead of the brush and mirror rows, and
  the selected step's inspector under it; a bar over the toolbar picks what Shape, Cut and
  Paint draw. Picking a palette color recolors the selected step. The layers panel's “+” offers a layer or a shape layer
  (Shift+B), and tags shape and override layers. Layer menus offer Convert to override layer
  and Clear override, and a shape layer's offers Bake to voxels; the main menu has the
  resolutions.
- **Files and sharing**: `.voxeltoy` version 2 (resolution, layer ids, kinds, coverage,
  shape steps), checked before anything is installed. Flat documents
  still save as version 1. Flat `.vox` and GLB export the committed evaluation, GLB
  scaled to source units. Rigged parts export, snapshot links and live rooms refuse
  documents that aren't flat with a reason. Autosave reports when local storage fails.
- **Agent tools**: `edit_shapes` (steps by id: add, set box, shape and options, mode,
  keep, color, fill, move, remove; bake); `get_document` lists each shape layer's steps, and
  `get_voxels` reads evaluated output.

Differences from the text above:

- Pivots are stored in output-grid units as before, so a resolution change scales them
  with the grid. Refining is exact; coarsening snaps them to half cells, and undo
  restores them exactly.
- Above 1×, resize rounds sizes and shifts to whole source units.
- Coarsening is offered only down to 1×; the reference grid is the grid at 1×.

Not done yet: milestone 0's device measurements and performance scenes, the
50 ms pointer-to-update target on a phone, and milestone 6. Of milestone 5, the
[step stack](#step-stacks-shape-volume-and-material) items are done; budgets,
workers and chunk meshing wait for device measurements. A drag re-evaluates the
dragged step and those above it, and the composite and mesh in full.
