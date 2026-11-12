# Workplane

Where new voxels go when there is nothing to build against, and how to move that place.

## The problem

Add, the box brush and the shape brush place voxels against the nearest visible face. With no face
under the pointer, they fall back to a plane. That plane used to be the floor (`y = 0`), or the
exposed face of the slice while slicing. So the only way to build in mid-air was to turn on slicing,
and the select tool could not start anywhere but on a voxel.

## What other editors do

| Editor | Plane | How it moves |
| --- | --- | --- |
| Qubicle | A drawing plane on each axis | Moves with the slice; per-axis ortho views |
| MagicaVoxel | The floor, or the face you start on | Box and line brushes stay on the plane of the start face |
| Goxel | A movable "plane" with its own panel | Offset along its normal, rotate, or snap to a face |
| Blender | The 3D cursor and snapping | Click to place the cursor, then align to view or face |
| SketchUp | Inferred from the face under the cursor | Hold Shift to lock it |

Goxel is closest to Voxeltoy: one explicit plane that a few buttons can move.

## Voxeltoy's model

### One plane, which can also clip

There is one **workplane**: an axis, a level (the layer of cells new voxels land in), and a
**clip** mode. Slicing is the clip mode, so the slice and the workplane are always the same plane:

| Clip | Shows |
| --- | --- |
| Off | Everything |
| − | The workplane's layer and below |
| + | The workplane's layer and above |
| = | Only the workplane's layer |

The default, the Y axis at level 0 with clip off, is the floor, so nothing changes until you move it.

What the clip hides on the far side of the workplane, as seen from the camera, is drawn faintly, like
onion skin: with only one layer showing, the layers behind it are still there for reference. Orbiting
to the other side shows the other side's. **Show clipped faintly** in the Views menu turns it off.
The near side is never drawn, because it would cover the cut.

The workplane is UI state like the tool or mirror. It is not undoable and not saved in files. A new
document resets it, and a resize keeps it inside the volume.

### What it does

- **Add** (voxel, box and shape brushes) places on the nearer of a visible face and the workplane.
  With the workplane moved into the model, you can draw through it without anything to build on.
- **Select** with the box or shape brush can start on the workplane, so a selection no longer has
  to start on a voxel. The face, color and voxel brushes still need a voxel, because they act on
  what you tap.
- A free stroke keeps to the layer it started in, as before.
- The grid is drawn on the workplane. When the workplane is not the floor, it is drawn in the accent
  color, and the floor grid stays unless the workplane is horizontal.

Tapping inside the workplane counts as "on the model": the tool gets the pointer, as Add always has
on the floor. Outside it, a drag still orbits.

### The panel

The **Workplane** button (W) in the view controls opens a panel:

- **Axis**: X / Y / Z. Changing the axis puts the plane at the middle while clipping, and at 0 otherwise.
- **Level**: − / slider / + ( `[` and `]` ).
- **Pick** (the target): the next tap on a face puts the workplane against it. The face's normal
  becomes the axis and the layer of cells just outside it the level, so what you draw next sits on
  that face. Hovering shows the layer it would take. The clip stays as it was. A tap off the model, Esc
  or the button again stops picking without moving the plane.
- **Clip**: Off / − / + / =.
- **More** (…): **Face the workplane** turns the camera to look straight along its normal, in
  orthographic projection, from the side the camera is already on. This is also where
  [2D mode](2d-mode.md) will start. **Reset workplane** puts it back on the floor with clipping off.

While the panel is open, a double **arrow** in the accent color sits at the middle of the grid's edge
nearest the camera. Drag it to slide the plane along its normal. A tap on it does nothing, so a
stray touch can't move the plane, and a second finger puts the plane back where the drag started. The
arrow hides when you look straight along it, because a drag couldn't control it, and while the gizmo,
a pending shape or an extrusion has the pointer.

Closing the panel leaves the workplane where it is; its grid shows where.

### For agents

`set_workplane` moves the workplane and sets its clip. `get_document` reports it, because while it
clips, edits and selections skip the hidden cells.

## API

```ts
editor.workplane;                                   // { axis, level, clip }
editor.setWorkplane({ axis: 2, level: 8 });         // a partial update; the level is clamped
editor.setWorkplane({ clip: "-" });
editor.resetWorkplane();                            // the floor, clip off
editor.setWorkplaneFromFace([2, 3, 2], [0, 1, 0]);  // against a face: { axis: 1, level: 4 }
editor.startWorkplanePick();                        // the next tap on a face does that
editor.cancelWorkplanePick();
editor.workplaneHandle(eye);                        // where the arrow sits, seen from `eye`

// the slice is the workplane while it clips
editor.slice;                                       // { axis, level, mode } or null when clip is off
editor.setSlice({ axis: 1, level: 4, mode: "-" });  // same as setWorkplane({ axis: 1, level: 4, clip: "-" })
editor.setSlice(null);                              // clip off; the plane stays where it is

editor.clipped;                                     // per cell, the value the clip hides (0 elsewhere)
editor.clippedBehind(side);                         // just the far side, seen from side 1 or -1
editor.setShowClipped(false);
```
