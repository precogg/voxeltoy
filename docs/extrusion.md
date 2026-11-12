# Extrusion

How the extrude tool works in Voxeltoy, and why.

## What other editors do

| Editor | Extrude is | Picks the face by | Depth | Pushing in |
| --- | --- | --- | --- | --- |
| SketchUp (Push/Pull) | A tool: press a face, move, click | The face under the cursor | The pointer, or a typed distance; a double-click repeats the last distance | Carves, and cuts through when it meets the far side |
| MagicaVoxel | The Face brush with Attach or Erase | The connected face, by color or shape, 4 or 8 neighbors | A drag along the face's normal | Erase + Face |
| Goxel | A tool: drag a surface | The connected, coplanar, visible face, limited to the selection; optionally by color | A drag along the normal, then an editable delta | A negative delta carves |
| Qubicle | A tool: drag a rectangle, then handles | The rectangle (unselected voxels only, if asked) | Handles; Enter applies | — |
| Blender | An operator on selected faces | The selection | A modal drag, typed value, gizmo | Extrude Manifold carves |

The tools that people praise share four ideas:

1. **The face is found for you.** One press picks the whole connected face, as in
   SketchUp, MagicaVoxel and Goxel. Nobody draws a rectangle to extrude a wall.
2. **One gesture does both directions.** Pull out to add, push in to carve. SketchUp's
   Push/Pull is loved because it doesn't make you switch tools.
3. **Depth is direct but adjustable.** A drag sets it, and a number (typed, or Goxel's delta)
   fixes it exactly.
4. **Repeating is cheap.** SketchUp's double-click repeats the last distance, so a row of
   windows takes a row of clicks.

## Voxeltoy's model

**Extrude** is a tool next to Move (shortcut U).

- **Press a face and drag** along its normal. Dragging out adds layers and dragging in carves
  them, starting with the face itself. The preview shows the added voxels in their colors,
  or the carved ones in red.
- **The face** is every connected, coplanar voxel of the active layer whose side looks into
  empty space, the same region as the Face brush. While something is selected, only selected
  voxels count, so a selection marks out part of a face (select a rectangle on a wall, then
  extrude a window). Pressing a voxel outside the selection says so.
- **Colors run through.** Each added voxel copies the face voxel it grows from, so stripes and
  patterns on a face become stripes and patterns along the extrusion (Goxel and MagicaVoxel
  do the same).
- **The extrusion stays pending** until it is applied, like a shape or floating content:
  - Drag the handle on its end, or the extrusion itself, to change the depth.
  - **−** and **+** in the bar (↓ and ↑ on a keyboard) step the depth one layer at a time.
    They also work when the camera looks straight along the face, where a drag can't
    measure depth.
  - **Apply** with ✓, Enter, a tap on empty space, or by starting the next extrusion.
    **Cancel** with ✕, Esc or Undo.
- **A tap on a face repeats the last depth**, like SketchUp's double-click. Tapping face after
  face extrudes each one by the same amount, and each tap applies the one before.
- **The selection follows.** It grows over added voxels and drops carved ones, so a selected
  face can be extruded again and again.
- Mirror applies, as with every brush. Extrusions stop at the edge of the volume.

Applying is one undo step, labelled "Extrude" or "Carve".

## API

```js
editor.setTool("extrude");

// one step
editor.extrude([4, 0, 4], [0, 1, 0], 3);   // pull the top face at (4, 0, 4) up 3 layers
editor.extrude([4, 3, 4], [0, 1, 0], -2);  // carve 2 layers into it

// pending, as the tool does it
editor.startExtrusion([4, 0, 4], [0, 1, 0]);
editor.setExtrusionDepth(2);
editor.pendingExtrusion;                    // { layerId, normal, base, depth } or null
editor.applyExtrusion(); editor.cancelExtrusion();

editor.extrusionRegion([4, 0, 4], [0, 1, 0]); // the face's voxels
```

Agents use the `extrude` tool, with `at`, `direction` (`+y` for a top face) and `depth`.
