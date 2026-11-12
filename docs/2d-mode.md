# 2D mode

Edit the whole model from a flat projection, like a 2D image with depth. The view, column
selection, transforms, 2D drawing tools and the 3D thumbnail are all built.

## The problem

Simple changes to the whole model are hard in 3D. Take the top half of a character and move it down
two voxels: you have to select a volume, which in 3D means starting on a voxel and dragging on the
plane of its face, and then you can only see one side of what you selected. In a 2D editor this is
one rectangle and one drag.

## What other editors do

- **Kenney Shape** draws a 2D pixel image. Each pixel has a depth, and the shape is the image
  extruded by that depth, optionally on both sides and with bevels. You never orbit. Voxeltoy takes
  the depth and the both-sides fill but not bevels or rounded edges: it stays whole voxels.
- **Qubicle** and **MagicaVoxel** have orthographic views, but the tools still act on the voxel under
  the pointer, so the view only helps with aiming.
- **Aseprite** and **Photoshop** show that a mask, marquee, lasso and floating move are enough for
  most rearranging.

## Voxeltoy's model

### A pixel is a column

2D mode looks straight down the [workplane](workplane.md) normal. Each pixel `(u, v)` stands for the
**column** of cells along that axis, within the **depth window**, which is the part the workplane's
clip shows: the whole model with clip off, the layers on one side with − or +. Slicing therefore sets
how deep a 2D edit reaches.

The projection shows the front visible voxel of each column. Shading, or a heat-map tint you can
switch on, shows how far each pixel is from the workplane.

Since the selection is already a 3D mask and transforms already act on any mask, most of 2D mode is
tools that turn pixels into masks or edits:

| In 2D | In 3D |
| --- | --- |
| Select rectangle, lasso, wand (same front color) | Every cell of those columns in the depth window |
| Move, nudge, flip, rotate 90° | The existing floating transform, in the plane. Nudging in depth moves along the axis |
| Paint | Recolors the front visible voxel of each column |
| Erase | Removes the front visible voxel of each column |
| Pencil (Add, or Brush with Shift) | Fills the column from the workplane toward you for the set **depth**, optionally on both sides of it (Kenney Shape) |
| Depth brush (Extrude) | Pulls a column's front surface out by one, in its own color. Erase pushes it in |

Paint and Erase act on the front voxel because that is what you see; a "whole column" option can come
later. Moving the top half down two voxels is a rectangle, a drag and Apply: one undo step through the
floating path.

### What is built

- **2D view** (the grid button in the view controls, or D) enters and leaves 2D mode. It looks from
  the side of the workplane the camera was on, in orthographic projection, framed on the model.
  Leaving puts back the view and projection from before. Choosing a view from the Views menu also
  leaves it. Changing the workplane's axis while in 2D turns the view to match.
- **Select**: the box and shape brushes draw a rectangle of columns, and the voxel brush paints
  columns. Both start anywhere on the grid, on a voxel or not. A tap without a drag deselects, as on
  empty space. Face and color select act on the voxel you see, as in 3D.
- **Move** drags the selection in the plane: a column selection can be grabbed anywhere inside it,
  empty cells included, because grabbing picks the selection mask. The arrow keys nudge in screen
  directions; Page Up and Page Down move it toward you and away.
- **Rotate or flip** in the selection bar turns left or right and flips horizontally or vertically,
  as the content looks on screen. R and Shift+R turn on screen too.
- The **depth window** is the workplane's clip: with clip − or +, a column stops at the workplane,
  so you can move just the front half of a model.
- **Pencil, Erase and Paint** work on pixels with the Voxel brush (each pixel the stroke passes, once)
  and the Box brush (a rectangle of them, as one edit). The Brush tool paints, adds with Shift and
  erases with Ctrl/Cmd, as in 3D. The Face and Shape brushes keep their 3D behavior.
- The **Depth** row in the style panel sets how many cells the pencil fills, from the workplane
  toward you; **Both** fills that far on each side of it. Put the workplane where the drawing should
  start: at the back of the volume for a relief, or Pick a face to build on it.
- **Extrude** becomes the depth brush, because a face seen head-on can't be pulled. Each pixel it
  passes is raised by one, in the color of the voxel it raises. A pixel with nothing in it is left
  alone, and Erase pushes back in.
- **Depth colors** (Views menu, in 2D) tints each pixel by how near its front voxel is, from blue
  (farthest) through green to orange (nearest), spread over the depths in view so a one-voxel step
  shows.

### The view

2D mode is the existing viewport, not a second canvas, so picking, meshing, previews and the gizmo
stay on one code path:

- The orthographic camera is locked to the workplane normal and does not orbit. Selecting starts
  anywhere on the grid, because empty pixels can be selected. A drag the tool doesn't take pans
  instead of orbiting. Two fingers pan and zoom, and a second finger still cancels a stroke.
- A pixel grid lies over the projection, drawn on top of the voxels.
- The workplane's arrow hides, because it points at you; the panel still moves the plane.
- A small 3D thumbnail above the view controls shows the model from the angle 2D mode will go back
  to, with the workplane in the accent color. Tap it to go back to 3D.
- While the workplane clips, the layers it hides behind it are drawn faintly, so a cut through the
  model still shows what is around it (see [workplane](workplane.md)).

Shape layers follow the same rules as in 3D: 2D edits go to raster and override layers. Mirror
applies within the plane.

### API

```ts
editor.enter2D(side);           // 1 or -1: look along the workplane's axis from that side
editor.exit2D();
editor.mode2D;                  // { side } or null
editor.selectColumns(box, mode); // whole columns along the workplane's axis, within the clip
editor.columnBox(box);          // a box stretched through the volume along that axis

editor.setThickness(3);         // how deep the pencil fills
editor.setBothSides(true);
editor.pencilCells(pixel);      // the cells it would fill in that pixel's column
editor.setDepthColors(true);

// the model as a 2D image along an axis, from one side; clip included
editor.project(axis, side): { u, v, width, height, color: Uint8Array; depth: Int16Array; thickness: Uint16Array }
```

Agents select columns with the `select` tool's box, stretched across the volume, and read a view
with `get_projection`: the colors and depths of a front, side or top view as screen rows, cropped
to the model.

`projection()` also makes a good read-only agent tool: the front or top view as an image plus a
height map is much cheaper for an agent to reason about than raw voxels.

## Phases

1. **Workplane core**: done. See [workplane](workplane.md).
2. **Workplane UI**: done. The drag arrow, Pick, Face the workplane, and the `set_workplane` agent tool.
3. **2D mode v1**: done. The locked view, column selection, move / flip / nudge, the depth window.
4. **2D editing**: done. Pencil with depth, Erase and Paint on the front voxel, the depth brush,
   depth colors, and the `get_projection` agent tool.
5. **Context**: done. The 3D thumbnail, and the clipped layers behind the workplane drawn faintly.

Bevels and rounded edges are left out on purpose: they belong to Kenney Shape, and Voxeltoy stays whole
voxels.
