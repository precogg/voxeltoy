# Headset view (WebXR)

**Open in headset** (main menu, shown when the browser offers WebXR) edits the open model in a
headset: Quest Browser in passthrough (`immersive-ar`), or a dark room where only VR is offered.
It is a second view of the same `Editor`, so every edit lands in the same history and shows in the
page's viewport too. The code is `packages/xr`, loaded when the view opens.

## Controls

Hands or controllers: Quest switches as you put the controllers down or pick them up.

One hand carries the palette and holds the model; the other draws. That is the left and the
right until **Swap hands** on the palette, which the device remembers.

| Hands | Does |
| --- | --- |
| Pinch (drawing hand) | Draw (see *Reach* below): at the pinch with the tip, where the hand points with the ray, or a box. With Move, take hold of an object (see *A scene's objects*). |
| Pinch (palette hand) | Hold the model and carry it. Keep holding it and draw on it with the other. |
| Pinch both together | Move, turn, tip and scale it, like an object held in both hands. Pinching the palette hand while the other draws does this too, and takes the stroke back. |
| Pinch the ring | Drag around the ring under the model to spin it like a turntable. |
| Turn the palette palm up | The palette shows, flat on the palm like a painter's and turned 45°; palm away, it hides. |
| Push the palette | Press a button with the drawing hand's index finger: a ring follows the fingertip, and a push in (or through) presses once until you back off. Pointing at it and pinching works too. |
| Push a window | The same, with either hand. Away from the model, point at a window and pinch. |
| Pinch a window's frame | Carry the window: the point you pinched stays under your fingers, and the window turns to face you. Pinch it from afar along the ray and move your hand away or toward you to push it back or pull it in, three times as far. |

The brush follows the pinch through a One Euro filter (`smoothing.ts`): steady while your hand is
nearly still, quick when it moves.

| Controllers | Does |
| --- | --- |
| Trigger | Draw: Add, Erase or Paint, per the tool, and how it reaches (see *Reach* below). With the tip (the small ball ahead of the controller), press to place, hold and move to draw, anywhere in the grid, empty space included. With Move, take hold of an object. |
| Trigger on the panel | Press a panel button (point the other hand at it), or a window's (either hand). |
| Grip or trigger on a window's frame | Carry the window, along the ray: move the controller away or toward you, or push the thumbstick, to push it back or pull it in. Grip with the controller at the frame to carry it in the hand. |
| Other trigger while drawing | Take the stroke back. |
| Grip | Hold the model and carry it. Near the ring under it, spin it instead (so does the trigger). |
| Both grips | Move, turn and scale it about your hands: shrink it to a toy, or grow it until you stand inside. |
| Thumbstick up / down | Brush size. |
| Thumbstick left / right | Turn the model about you, 30° a push (a snap turn: at life size, it turns the course around you). |
| A / X, B / Y | Undo, redo. |

The palette (on the palm with hands, above the wrist with controllers) has the tool (Add, Erase,
Paint, and Move with a scene), how it reaches (Tip, Ray, Box), colors with the chosen one's name
under them, brush size, undo, redo, **Fit** (back on the table in front of you), **Life** (when the
host gives a life size) and a button for each window.
Under them, the page's notices show for a moment (a locked layer, nothing selected). Its last line is timings: frames per second, the worst frame
and the worst brush move (which includes meshing) in the last half second, and the mesh's quads.

## Reach

How the drawing hand reaches cells, from the palette's second row (remembered on the device):

- **Tip**: the brush ball at the pinch or the controller's tip, anywhere in the grid, empty space
  included (`editor.spatial`, below).
- **Ray**: the cell the hand's ray points at: Add the empty cell before the face it hits (the
  grid's floor when it hits nothing), Erase and Paint the cell hit. Hold and sweep to keep going
  across that layer of cells (a floor, a wall), as a block game builds. As a ray, it ranks with
  windows by distance: a window in front of the model takes it, one behind doesn't. The brush size
  still applies.
- **Box**: a box from the cell the tip goes down in to the cell it lets go in, filled, erased or
  painted as one undo step. A tip off the grid takes the nearest cell in it.

The cells each would change show as a ghost before you press. `reach.ts` has the cell math.

## Life size

A host that knows how big a cell is in the world passes `lifeSize` (metres a cell; a block can be
a metre). **Life** on the palette (and **Life size** in the menu) then stands you on the model where
you look: the top of the column there comes under your feet, the model upright at that scale and
turned as it was. Hold it with one hand to walk it past you; turn with the thumbstick. Scaling it
with two hands, Life again, or Fit leaves life size.

## A scene's objects

When the model is a library scene's stage (a level whose stage is its course: `XROptions.library`,
which `LibraryView` passes for a stage), the scene's instances stand about it in the headset as on
the page: their models, boxes for kinds without one in the kind's color, the selection outlined in
the accent and what a hand is at in white. `editor/scene.ts` draws them and is their target.

**Move** on the palette (the page's view tool) puts the drawing hand on them:

- **Take hold** of an object at its box with the pinch or the grip, or point at it and pinch or
  pull the trigger. It is selected. Held, it follows the hand; along the ray, it lands where the
  ray meets the stage or another object: on tops, on walls and ceilings only for a kind that stands
  out of faces (otherwise it drops onto what is below the cell the face opens onto). Either way it
  lines up with the stage's cells as its kind snaps, and the move is one undo step.
- A box without a model (a zone) is taken by its sides, not from inside it, and a ray takes it only
  when nothing with a model is in the way: it holds other things.
- The selected object's **path stops** (`points` fields) show as dots joined by its path: take one
  the same way to drag it (held, freely; along the ray, at its height), snapped to the object's step.
- The palette hand still holds the model, and the drawing hand pinching empty space holds it too.

The **Objects** window has the selection's commands (Duplicate, Delete, Deselect, and Add stop and
Delete stop for a path, after the stop last taken), then the kinds to add, grouped as the page's add
menu. Choosing one places it where the drawing hand points, a ghost cell showing where, each pinch
or trigger adding another, until **Stop** (or another tool).

The selection, every move and every new object go through the library, so they are on the one
history with the stage's voxels (A / X undoes them) and show on the page.

## Hosts

`EditorHost.headset` (the SDK) returns what the headset view takes beyond the editor and the
page's menus (`HeadsetOptions`: `XROptions` less what the editor view fills in):

| Option | Is |
| --- | --- |
| `library` | The scene whose stage the model is. `LibraryView` passes it on a stage. |
| `swatches` | The palette's colors (`{ value, color, label }`), in place of the model's palette: a host's named blocks. Read as the palette draws, so it can follow the layer. |
| `tools` | The tools the palette offers now (`"add"`, `"erase"`, `"paint"`, `"move"`): a layer that only holds objects offers Move alone. An editor tool the palette doesn't have (a host's own) shows as Move. |
| `lifeSize` | Metres a cell is at life size. |
| `extend` | Called with the `XRView` once it is up, to add the host's own: objects in `view.voxelSpace`, targets on `view.shell.router`, windows on `view.shell.windows`. What it returns runs when the view ends. |

## Windows

The menu, the layers and the timeline are windows in the room (`editor/views.ts` on the toolkit's
`windows.ts`). They start around you: the menu and the layers to either side at arm's length, the
layers by the drawing hand, and the timeline over the model, beyond it. The palette's buttons show
and hide them, as does each window's ×; a window shown behind you or across the room comes back in
front. **Gather windows** in the menu puts them all back. Which are open is remembered on the device
(at first the menu and the layers, and the timeline for an animation); where they are is the
view's, like the model's place.

Each has a frame: a bar under it, and a rim that lights when a hand is at it. Grab anywhere on the
frame to move the window (see the tables above). One hand holds a window at a time; the other
taking it lets the first go. A window keeps between 25 cm and 4 m from your eyes, and past 1 m it
grows with distance, so it looks as big and its buttons are as easy to point at as at arm's length.
By the model, a hand draws, though a window is behind it: rays reach windows from a hand clear of
the model's grid, or for a window within 60 cm.

- **Menu**: the page's main menu, then the headset's own: put the model in front of you, life size,
  gather windows, swap hands, exit. Submenus open in place, with a row back; long menus come in pages.
- **Layers**: the layers and groups, topmost first. Tap a layer to draw on it, a group to fold it,
  the eye to hide either, ⋯ for its options (the page's layer menu, but Rename), + for a new layer.
- **Timeline**: step, play, the playback range (all frames, or a tag's), duplicate, and ⋯ for the
  frame commands. The strip shows a page of frames, following the one showing; hold the trigger or
  a fingertip on the lane under it and move along to scrub (lost tracking takes a scrub back to the
  frame it started on). Playback runs from the session's own frames, since the page gets none while
  a headset shows. With a scene, its palette button reads **Frames**, to fit beside **Objects**.
- **Objects**: with a scene, the selected objects' commands and the kinds to add (see *A scene's
  objects*). It starts further round on the drawing hand's side.

The menus are the host's (`XROptions.menus`; the SDK passes its own, `headsetMenus` in
`packages/sdk/src/menus.ts`), so a command added to the page's menu shows in the headset too, if
the headset can do what it needs. Each action says what it needs of the view offering it
(`Action.needs`: `files`, `dialog`, `keyboard`, `navigation`, `markers`, `onion-skin`, `page`; see
`MenuNeed`), and menu items made from actions with `command()` carry it. The headset view meets
none of these yet (`XROptions.supports`), so file pickers, dialogs, other models, markers and onion
skins stay on the page, and a submenu left empty goes too. A host's own item says the same with
`needs`.

Holding is by the pinch points (a controller's grip). One hand moves the model without turning
it, so placing it is steady. Two hands handle it like an object held in both: the points you
pinched stay under your pinches as you move, turn and spread them (twice as far apart, twice as
big), raising one hand tips it, and twisting both wrists rolls it about the line between them.
Within 6° of upright it snaps upright. The ring spins it about its own axis, tilted with it
(`workspace.ts`).

Where the model is and how big it looks is the view, not the document: nothing about it is
undoable or saved. Taking the headset off or opening the system menu takes a stroke back.

## The brush

`editor.spatial` (`packages/core/src/spatial-brush.ts`) is a brush at a point in voxel space: a
ball `size` cells across. A stroke (`begin`, `to`…, `end`) fills every cell the ball sweeps through
however far apart the samples are, as one undo step, through `applyCells` (so it follows the
layer, selection and mirror). Scripts can use it too, and agents through `brush_stroke`.

## How it is built

`packages/xr` is a small toolkit for headset UIs, and Voxeltoy's headset view built on it. The toolkit
knows nothing of the editor (nothing in it imports `@voxeltoy/core`), so another app (a level
editor, say) can build its own headset UI the same way.

| Toolkit | Is |
| --- | --- |
| `shell.ts` | `startXR()` / `XRShell`: the session, renderer and frame loop, both hands, the router, the windows, and their feedback (a ray to what a hand points at, a ring under a fingertip). The session hidden or ended, or an input gone, takes back what hands were doing, in one place. |
| `input.ts` | `XRHand`: one controller or tracked hand as plain state each frame: its ray, where it holds (the pinch, a controller's grip), its tip, its index fingertip, its wrist. |
| `interaction.ts` | `Router`: every frame each hand resolves one focus, the best `Hit` any `Target` offers it, by reach (grab, then touch, then ray, then free space) and distance, holding on a little longer than it took to get it. What lights is what a press starts. A press hands the hand to an `Interaction` until the trigger that started it lets go (a grip's hold ignores the trigger); a captured hand works nothing else. A fingertip presses by pushing in (`poke`). Tracking lost for under 300 ms resumes the capture without a jump; longer takes it back (`cancel`). |
| `panel.ts` | `Panel`: controls drawn to a canvas, laid out in millimetres, so a 32 mm row is 32 mm in the room. A `Control` has a stable id (hover and a press under way follow it across redraws), a name (an icon's shows as a tip while a hand is at it), and `onPress`, or `onDrag` / `onRelease` / `onCancel` for one that holds the hand. `activate(id)` presses one without a hand. |
| `surface.ts` | `PanelTarget`: a panel as a target: pushed with a fingertip, or pointed at and pinched. |
| `windows.ts` | `XRWindows` / `XRWindow`: windows with frames to carry them by, placed about the viewer (`around`), shown, hidden and gathered, which are open kept on the device. |
| `menu.ts` | Menus as data (`XRMenuItem`, with `needs`) and `MenuView`, a menu as rows of controls, submenus in place, in pages. |
| `workspace.ts` | `WorkspaceGrab` and `Turntable`: an object held in one hand or both, and spun by a ring. |

Voxeltoy's view is `editor/`: `session.ts` (`enterXR` / `XRView`), `tools.ts` (the brush at the tip,
along the ray and as a box, holding the model, the ring: targets and interactions), `reach.ts` (the
cell math: what a ray changes, boxes, where to stand at life size, turning about the viewer),
`scene.ts` (a stage's scene: its objects and path stops drawn, held, carried and placed),
`palette.ts` and `views.ts` (the windows' contents). An app adds its scene to `shell.scene`, its targets to `shell.router` (its own tool goes
in last, at reach `free`), windows with `shell.windows.add`, and per-frame work with `shell.onFrame`.

## Working on it

- **On the desk:** open the dev server with `?xr=emulate` for Meta's emulated Quest 3 (IWER, dev only).
  `window.xrDevice` moves its head and controllers from a script.
- **On a Quest:** WebXR needs https. With Tailscale on both, serve the dev server on the tailnet
  (`tailscale serve --bg --https=4321 http://127.0.0.1:4321`) and open
  `https://<machine>.<tailnet>.ts.net:4321` in Quest Browser. Or connect it by USB and
  `adb reverse tcp:4321 tcp:4321`, then open `http://localhost:4321`.

## Next

Measure on the headset (large models, long strokes); mesh in chunks if edits stutter; resize
windows by their corners, and thumbnails in the layers and timeline; markers and onion skins in the
headset (then it `supports` them); a cutaway
for working inside solid models; tune the pinch (a stroke can grow a cell as the fingers part)
and the filter on a real headset. For scenes: turning objects (a kind's `rotate`, and standing out
of the face a ray drops one on, as the page does); size and radius handles (a zone's box); the
inspector's settings; the ghosts at a path's stops; looping instances' animation. A box drawn along
the ray (corners on faces) beside the tip's.
