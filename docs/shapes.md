# Vector layers: the spec

November 8, 2026. This replaces the earlier plan for shapes. Phases 1–4 (PRs #11–#14) built the
engine this rests on: steps with names, prisms and presets, sweeps, tubes, open ends, paths,
handles and quarter turns, number fields, undo. Their UI put shapes in the color panel, needed a
shape layer before you could draw, changed the toolbar in surprising ways and had no clear way to
select a shape and then edit its points. This spec rebuilds the UI on the same engine.

Mockups (desktop and phone, clickable in Play):
https://claude.ai/artifact/UsVm7CTJT485Fq1xrA4gMr

## Words

- **Raster layer**: voxels, edited with the voxel tools. In code: a layer with `data` (or an
  override layer, with `coverage`).
- **Vector layer**: an ordered stack of **shapes**, bottom first. Each shape adds to, cuts out of,
  intersects with or paints what is below it in that layer. In code: a layer with `shape`, whose
  `steps` are the shapes. The UI never says "step" or "shape layer"; the code keeps its names.
- **Shape**: a box, cylinder, cone, … (a kind and its settings in a box) or a path (tube, wall,
  slab). Each has a name, a mode (Add, Cut, Intersect, Paint) and a fill.
- **Editing in place**: a mode one level inside a shape, where its points (paths) or its setting
  handles (other shapes) are what you touch.

## Principles

1. **Vector tools on vector layers, voxel tools on raster layers.** Nothing converts silently.
   A raster layer has no shape tools and no offer to make a vector layer; vector layers are made
   from the Layers panel's +. Bake to voxels is an explicit command.
2. **Draw, then you are holding it.** Making a shape ends on Select with that shape selected
   (Figma). The tool doesn't stay armed.
3. **Two levels.** Select a shape to move, size, turn and set it. Edit it in place to work on its
   points. The breadcrumbs show the level.
4. **Each thing has one place.** Color is in the color panel. Shapes are in the Layers panel.
   The selection's settings are in Properties. The selection's actions are in the bar over the
   toolbar.
5. **Touch first** (AGENTS.md). Every action is a tap or a one-finger drag; hover and keys are
   shortcuts. Mouse may do better where hover helps (drawing in three clicks), never instead.

## Layers panel

Mockups: section 5 of the canvas above. A tree in the manner of Figma's layers and Pierre's Trees:
flat rows, hierarchy from aligned columns, one selected row.

- **Columns.** Every row: indent (one step per level), a chevron gutter (empty on rows with
  nothing under them, so siblings line up), the tile, the name, then the trailing slot. A 1px
  guide line runs under an open row's chevron past everything it holds; the guides of the branch
  that holds the selection are lit. No nested cards.
- **The tile says the kind**, never a word. A layer's tile is its thumbnail (the layer alone,
  framed on its own voxels so small parts still read) with a corner badge: a path for vector (in the
  accent, like the toolbar's `VECTOR`), a grid for voxels, an eraser for override. A group's is a
  folder. A shape's is its kind's glyph in its own color; Cut, Intersect and Paint add a badge
  (−, ∩, brush).
- **One selected row.** The selected shape's row if a shape is selected, else the active layer's
  (or a tapped group's). The layer and groups that hold the selection show it with a bolder name
  and lit guides, never a second fill.
- **The trailing slot shows state, not controls.** Eye-off when hidden, a lock when locked (tap
  either to undo it). ⋯ shows on the selected row; with a mouse, hovering a row also shows Hide,
  Lock and ⋯. Everything is in ⋯ too (Hide/Show, Lock/Unlock, Rename, …), so touch never needs
  hover. A long-press (touch) or right-click selects a row and opens its menu, as a shortcut; on a
  scene object a held finger drags instead. Rows that open or fold on a tap (the library's models
  and scenes, Objects' kind headers) are never selected, so their ⋯ always shows.
- The scene tree's Objects and the library list are the same tree rows.
- Groups and vector layers fold with their chevron (UI state, open by default). Selecting a shape
  on the canvas opens what holds it and scrolls its row into view.
- Tap a shape row: its layer becomes active and the shape is selected. Double-tap a name (or
  ⋯ › Rename) to rename. Drag a shape's tile to reorder it within its layer. ⋯ on a shape row:
  Edit shape (Edit points for a path: editing in place), Rename, Duplicate, Move up, Move down,
  Delete. An empty vector layer says "No shapes yet".
- Blend, effects and mask stay as quiet tags after the name.
- The panel's + offers Layer and Vector layer. A new vector layer is empty and becomes active,
  with Box armed.

### Sizes

`--hit` (40px, 44px on `pointer: coarse`) is for buttons that stand alone: toolbars, the top bar,
sheet headers. Rows in lists are `--row` (28px / 36px): a row is one target as wide as the panel,
so a tap can only miss up or down. Buttons inside a row are `--hit-inline` (24px / 32px) with a
14–16px icon, and a row shows at most one at rest. Indent `--indent` (14px / 16px) per level;
tiles `--thumb` (20px / 24px).

## Toolbars

The toolbar follows the active layer. Orbit and Select keep their place on both; the layer kind is
labelled at the toolbar's start (`VOXELS` / `VECTOR`) so the change is never a mystery.

- **Raster**: as today (Orbit, Select, Move, Extrude, Add, Erase, Paint, Fill, Pick).
- **Vector**: Orbit, Select | Box, Cylinder, Sphere, Cone, Torus, More ▾ | Pen | Fill.
  - More ▾ opens a small grid over the toolbar (tldraw): Pyramid, Hex prism, Capsule, Wedge,
    Diamond, Arch. Picking one arms it; the More button then shows its icon until another is picked.
  - Pen draws paths; what it makes (Tube, Wall, Slab) is in its options bar.
  - Fill: tap a shape to give it the current color (one undo step). A Cut shape has no color; Fill
    says so. The pattern (ramp, checker, stripes) stays in Properties.
  - On a phone: Orbit, Select, Box, Cylinder, Sphere, More ▾ (with Cone and Torus in it), Pen,
    Fill.
- **Shortcuts on a vector layer**: H orbit, M select, 1–5 Box/Cylinder/Sphere/Cone/Torus, P pen,
  G fill. List them in the shortcuts dialog. On a vector layer P is the Pen rather than Play (the
  timeline's button still plays), and the voxel tools' keys do nothing.
- **Raster shape brush**: it keeps its pending shape with ✓ (see Later). Its shape is picked in the
  style panel's Shape row, beside Solid / Hollow; its draw bar has only From center and Uniform.

### Options bar

While a shape tool or the Pen is armed, a bar sits over the toolbar:

- Shape tools: Add / Cut / Intersect / Paint, From center, Uniform. (The kind is the armed button,
  not in this bar.)
- Pen: Tube / Wall / Slab, Add / Cut / Intersect / Paint, Smooth.

Its choices stick for the next shape (UI state, not undoable).

## Drawing a shape

On the model or the workplane, like the voxel tools find where to build.

**Mouse** (pointer that hovers): three clicks.
1. Click: the origin. A footprint follows the pointer with a `W × D` label.
2. Click: the footprint is set. Moving up or down raises the height, with its label.
3. Click: the shape is made.
Esc, a right click, or a second finger cancels at any step (a right drag still orbits, and the
shape waits). Enter makes it as it stands. A drag at step 1 (press, move, release) sets the
footprint in one go and goes on to the height, so drag-then-click works too. The height starts at
the shape's default and follows the pointer up or down from where the second click was.

**Touch** (no hover):
- Tap: a default-size shape centered where you tapped (as the current `TAP_SHAPE_SIZE`).
- Drag: the footprint follows your finger; on release the shape is made at its default height
  (`defaultHeight`).

Either way, once made: one undo step ("Add box"), the shape is added on top of the active vector
layer's stack with the options bar's mode and the current color, and the tool goes back to
**Select** with the shape selected. From center and Uniform (Shift) apply to the footprint.

## A selected shape

- **On the canvas**: its box outlined; a handle on each face (fainter on faces turned away) moves
  that face; dragging the body (with Select) slides it across the axis you look along most; the
  gizmo's rings turn it a quarter turn. Each drag is one undo step. A path shows the same box
  handles; its points are for editing in place.
- **Selecting**: with Select, tap a shape on the canvas (the topmost Add or Paint shape there, then
  an Intersect around it), or its row in Layers. Tap empty space or press Esc to deselect.
- **Bar over the toolbar**: the shape's name, Edit, Duplicate, Delete, ⋯ (Move up, Move down,
  Bake layer to voxels).
- **Properties panel**, on the right, only while a shape is selected (the color panel stays above
  it, collapsible as today). Its sections fold: tap a title to fold it shut, leaving what it is
  set to beside the title (Add, 9 × 7 × 10, a swatch). On a phone they start folded (the sheet is
  a short list of what is set), on a desktop open; what you fold or open is kept from one selection
  to the next. Its controls are list-sized (`--row`), labels in a column with X Y Z lined up.
  - Header: the kind with ▾ to change it (the same list as the toolbar, paths too), ⋯.
  - **Combine**: Add / Cut / Intersect / Paint, and for Add and Intersect, Paint over / Keep
    colors.
  - **Transform**: Position X Y Z, Size X Y Z (number fields: drag to scrub, tap to type), Turn
    ↻X ↻Y ↻Z, Points (where it points) where the kind has a direction.
  - **The kind** (titled with it: Sphere, Tube, …): only what the kind takes. Prism: Sides, Taper, Corners (box), Top and Bottom
    edges (straight boxes and cylinders). Torus: Tube. Prism, sphere, torus: Sweep. Wedge:
    Slope. Limb: From, Base, Tip. Path: Smooth, Closed, Radius (tube), Width (wall), Height
    (wall, slab). All but paths: Wall, and Open top / bottom when it has a wall.
  - **Fill**: a row of the palette's colors (the shape's marked) and All… to open the color
    panel; Solid / Ramp / Check / Stripe with their second color, axis and size.
- Picking a color in the color panel while a shape is selected recolors it (as today).

## Editing in place

- **Enter it**: Edit in the bar, double-tap the shape (or its row's icon; double-tapping the name
  renames it), or Enter. Enter again is Done.
- The breadcrumbs gain the shape: `Library › Robot › Details › Tube`. Everything but the shape
  dims; the Layers panel stays, the shape's row marked.
- **Paths**: a handle on each point and a fainter + in each segment's middle (the closing one
  too). Tap a point to pick it (amber); drag a point to move it across the axis you look along
  most; tap or drag a + to add a point there. Properties shows the picked point's X Y Z (cells)
  and its own radius (tubes), above the path's settings. The bar: Editing Tube, Smooth, Closed,
  Delete point (when one is picked), Done.
- **Other shapes**: their setting handles, in amber (taper, top edge radius, tube, wall), each
  dragged along its axis; the box handles are hidden. The bar: Editing Box, Done.
- **Leave it**: Done, Esc (first Esc lets go of a picked point), tapping an earlier breadcrumb, or
  tapping empty space with nothing picked. You go back to the shape selected.
- Undo works inside; leaving doesn't make an undo step of its own. Selecting another shape leaves.
- While editing, Delete (or Backspace) deletes the picked point, not the shape; the shape's own
  commands (Duplicate, Delete) wait until you leave.

## The Pen

- Each tap puts a point on the model or the workplane; a drag slides it along that surface before
  it lands. A dashed line runs from the last point to the pointer (mouse).
- The bar: Tube / Wall / Slab, the count ("3 points"), Smooth, Done. Tapping the first point (with
  three or more) closes the path and finishes it. Enter finishes; Esc finishes too (and with one
  point, cancels it).
- Each point is one undo step while drawing; finishing ends on Select with the path selected.

## On a phone (≤ 640px)

- **One bottom sheet** holds Layers and Properties, with Layers | Properties in its header (just
  "Layers" while nothing is selected), so the canvas keeps the top of the screen. The layers button
  opens it on Layers; selecting a shape on the canvas with Layers closed opens it on Properties.
  While it is up, the view's middle moves to the middle of the space above it (a lens shift:
  orbiting still turns about it) and Zoom to fit fits into that space.
- Properties: grabber, then Edit and ⋯ (Duplicate, Delete) beside the Layers | Properties switch,
  then the same folding sections as the desktop (the kind's ▾ heads its own section). It opens half way when something is
  selected and can be pulled up or down (to just its header, half, or most of the screen; a tap on
  the grabber steps it up); the canvas stays usable above it. It stands in for the desktop's bar
  over the toolbar.
- Editing in place: the top bar becomes a back button with the shape's name and "editing" (and
  Undo); the picked point is a small card over the bar (its X Y Z); the bar, in the toolbar's
  place, has Smooth, Closed, Delete (icon), Done.
- Standalone buttons at least `var(--hit)`; rows and the buttons in them as in Layers › Sizes.

## What changes in code

Keep (engine, from PRs #11–#14): `source.ts`, `shapes.ts`, `evaluate.ts`, step names, prisms and
presets, sweeps, tubes, open ends, paths, `turnPendingShape` / `rotateStepAbout`, face and setting
handles, `NumberField`, agent tools.

Change:
- Editor state: the armed shape tool is a tool, not `shapeKind` in a style panel. Vector layers
  take the tools `"orbit"`, `"select"`, `"shape"` (drawing `editor.shapePreset`; `setShapeTool(preset)`
  arms both), `"pen"` and `"fill"` (`VECTOR_TOOLS`); `SHAPE_LAYER_TOOLS`' add/erase/brush
  stand-ins are gone. The mode for new shapes is `editor.shapeMode`, and the Pen's `penProfile` and
  `penSmooth` (UI state). Each layer kind keeps the tool it had last when you switch between them.
- Drawing: a three-click mouse flow and the touch flow above, ending on Select with the shape
  selected; the pending-shape-with-✓ step goes away on vector layers (it stays for the raster
  shape brush).
- Editing in place: an `editor.editingShape` state (enter, leave, picked point) that the
  breadcrumbs and the viewport read; path point and setting handles only show in it.
- SDK: Layers panel shows shapes nested; a Properties panel component (desktop card, phone
  sheet); the selection bar; the options bar; the More ▾ grid; remove `ShapeStack` from the style
  panel and the kind menu from the draw bar.
- `newShapeLayer()` makes an empty vector layer (no default box); a vector layer with no shapes
  evaluates to nothing.

## Order of work

Each step is a PR, checked on screen at desktop and phone width before the next. If the app can't
be seen, stop and say so rather than build on it.

1. Vector toolbar (shape buttons, More ▾, Pen, Fill), options bar, layer-kind label; no shape
   tools on raster layers; empty new vector layers.
2. Drawing: mouse three clicks, touch tap/drag; back to Select with the shape selected.
3. Layers panel: shapes nested under vector layers; select, rename, reorder there. Remove the
   style panel's shape list.
4. Properties panel (desktop) and the selection bar.
5. Editing in place: breadcrumbs, dimming, path points, setting handles, Done.
6. Pen and Fill on the new model.
7. Phone: the Properties sheet, editing in place, the toolbar.

## Later

Snapping to other shapes' faces and edges with guides; mirror for shapes; a handle for sweep;
rounding tapered and polygon prisms; limbs as two-point tubes; slabs on other planes; a raster
shape brush that matches the vector drawing flow.
