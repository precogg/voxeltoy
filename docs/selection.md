# Selection

How selection works in Voxeltoy, and why.

## What other editors do

| Editor | Selection is | Tools | Combining | Transform |
| --- | --- | --- | --- | --- |
| MagicaVoxel | A set of voxels | Select is an action next to Attach / Erase / Paint, so it combines with the Voxel, Face and Box brushes; region select by color | Shift adds, Shift+Alt removes; select all, none, invert | Ctrl-drag moves, Shift locks to an axis; rotate, flip, loop; copy, cut, paste |
| Qubicle | A set of voxels | Rectangle, color and face selection | Add / remove; all, none, invert | Move, rotate, mirror, copy to a new matrix |
| Goxel | One box | A box with resize and move modes | None | Alt-drag a face to move the contents; cut or copy into a "placer" |
| Photoshop | A grayscale mask, separate from the pixels | Marquee, lasso, wand, plus Quick Mask, which lets any brush paint the selection | New / add / subtract / intersect, as tool options and as Shift / Alt shortcuts; grow, similar, expand, contract | Selected pixels "float" until committed; Transform Selection moves the outline without the pixels; painting is clipped to the selection |
| Blender | Selected elements | Box, circle, lasso; select linked, similar | Set / extend / subtract / invert / intersect as tool modes; grow, shrink, all, none, invert | Modal grab / rotate / scale with axis locks |
| Aseprite | A mask | Marquee, lasso, wand | New / add / subtract / intersect as toolbar toggles | Moving lifts the pixels; Enter or a click outside drops them; rotate and flip while floating |

The tools that people praise share four ideas:

1. **The selection is a mask over the grid, not an object.** It is its own data,
   separate from the content, and the content tools respect it.
2. **The selection is drawn with the same kinds of brushes as the content.**
   MagicaVoxel combines Select with its brushes. Photoshop's Quick Mask lets any
   brush paint the selection.
3. **Combining modes are tool options with keyboard shortcuts.** New, add,
   subtract and intersect appear on screen, and Shift / Alt are optional
   shortcuts. This matters for touch, where there are no modifier keys.
4. **Moving lifts the content into a floating state.** The content stays
   floating until it is committed, so it can be rotated, flipped and nudged as
   one undoable edit.

## Voxeltoy's model

### The selection is a mask

The selection is one bit per cell of the volume. It is independent of layers,
can include empty cells, and is not saved in files. Changes to it are undoable,
because a careful selection can take a lot of work.

### Selecting is an operation; the brush is the shape

The **Select** tool works like Add, Erase and Paint. It uses the same brushes, and
does the same things with them:

| Brush | Selects |
| --- | --- |
| Voxel | The voxels you drag over |
| Box | A rectangle on the plane of the voxel you start on |
| Face | The connected, coplanar face you tap |
| Shape | A box, sphere, cylinder, pyramid, diamond or torus. It has the same handles, rotation, hollow option and square base (Shift) as the shape brush, and stays pending until you apply it |
| Color | The connected voxels of the color you tap, or every voxel of that color (the fill tool's "Connected / All of color" option) |

Mirror and slice apply to selection the same way they apply to content. A
second finger cancels a selection stroke, like any other stroke.

Every selection gesture uses the current **mode**: **Replace**, **Add**,
**Subtract** or **Intersect**. The mode is a tool option, so it works on a phone.
On desktop, holding Shift (add) or Ctrl/⌘ (subtract) as a drag or tap starts
overrides the mode. A pending selection shape uses the mode in the panel when
you apply it, because Shift squares a shape's base. With Replace, a tap on empty
space deselects.

Selection commands do not depend on a brush: **All**, **None**, **Invert**,
**Grow**, **Shrink** and **Connected**. Connected adds every voxel touching the
selection, so you can tap one voxel and then pick up the whole object. All and
Invert work on visible voxels, not empty space. They select what you can see.

### Content edits respect the selection

When something is selected, Add, Erase, Paint, Fill and the shape brush change
only selected cells. This works like painting inside a selection in a 2D editor.
If an edit is fully outside the selection, a short message says why nothing
changed.

### Acting on the selection

Commands that act on the selected content of the active layer:

- **Delete** (Delete / Backspace)
- **Fill**: set every selected cell to the current color
- **Recolor**: repaint the selected voxels
- **Copy**, **Cut**, **Paste**
- **Duplicate**
- **Copy to new layer** / **Move to new layer**

### Transforms float until applied

Moving, rotating (90°), flipping, duplicating and pasting **lift** the selected
content into a floating state. This follows Photoshop and Aseprite:

- The floating content is drawn where it will land, and its source is hidden.
- The **Move** tool drags it in the plane of the face you grab. Shift locks the
  drag to one axis, and the arrow keys nudge it by one voxel. With nothing
  selected, Move drags the whole active layer.
- A **gizmo** sits on the content while it floats, and on whatever Move would lift.
  Drag an **arrow** to slide along that axis, or a **ring** to turn around it in
  quarter turns. It keeps its size on screen, and a finger can grab its handles
  from 24 pixels away. While one handle is dragged, the others hide. Arrows that point
  at the camera, and rings seen edge-on, hide too, because a drag couldn't control them.
- Rotate and flip act on the floating content, around the center of its bounds.
  **R** turns it around Y, and **Shift+R** turns it back.
- The bar shows how far the content has moved, such as "X +3  Y −1".
- When a whole layer is lifted, its pivot moves, turns and flips with it.
- **Apply** (✓, Enter, or a tap on empty space) commits everything as one undo
  step. **Cancel** (✕, Esc, or Undo) puts it back.
- The selection moves with its content.

Only whole-voxel moves and 90° rotations exist, as the product principles
require.

### What the gizmo borrows

Blender, Goxel and most 3D tools use a three-axis gizmo: arrows to move along one axis
and rings to turn around one. Voxeltoy keeps those two parts. Dragging the content already
moves it in the plane of the face you grab, so the gizmo has no plane squares. The rings
snap to quarter turns because Voxeltoy only rotates in 90° steps, and they turn the content
live while you drag. The handles have finger-sized hit targets, which the gizmos in
desktop tools often lack.

### Touch

A floating bar above the toolbar appears while something is selected. It
shows the selection size, Transform (rotate / flip), Duplicate, Delete, a menu of
everything else, and Deselect. While content is floating, the bar shows Apply and
Cancel instead. Every command is reachable by tapping, and every shortcut is
optional.

## API

Everything is on `Editor` (and `window.editor`):

```ts
editor.setTool("select");
editor.setSelectBrush("shape");
editor.setSelectMode("add");

editor.selectCells(cells, "replace");   // mirrored and clipped like a brush
editor.selectBox({ min, max });
editor.selectShape(spec, "subtract");
editor.selectColor(cell, "all");
editor.selectAll(); editor.deselect(); editor.invertSelection();
editor.growSelection(); editor.shrinkSelection(); editor.selectConnected();

editor.hasSelection; editor.isSelected(cell); editor.selectionBounds();

editor.deleteSelection(); editor.fillSelection(); editor.recolorSelection();
editor.copy(); editor.cut(); editor.paste(); editor.duplicateSelection();
editor.selectionToLayer({ move: true });

editor.moveSelection([1, 0, 0]);
editor.rotateSelection(1); editor.rotateSelection(1, -1); editor.flipSelection(0);
editor.floating;                         // the lifted content, or null
editor.floatingDelta;                    // how far its center has moved
editor.transformBox;                     // what the gizmo surrounds, or null
editor.applyTransform(); editor.cancelTransform();
```
