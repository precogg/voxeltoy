# One workspace: the scene tree

Draft, November 7, 2026. It replaces the web app's two modes (a model, or a scene) and the
words that move between them (**Place in the scene**, **Go to the scene**, **Back to my
model**, **Done**). The scene model itself is [docs/scenes.md](scenes.md); this changes how
it is presented, and adds groups and a scratch scene per model.

> **Superseded in part by [library.md](library.md).** The tree, groups, the breadcrumb and
> going into models stand. What a file holds and what the device keeps do not: there are no
> scratch scenes, no separate model and scene drafts, and no `.moxscene`; one library is open
> at a time, and "Opening a model", "Opening a scene" and "Data" below describe the interim.

## Status

The scene tree, groups, inherited visibility and locks, and the breadcrumb are built.
The file model this note first described is not: there is no scratch scene, no
`scene-store.ts`, and no separate model and scene drafts. [library.md](library.md) is
what a file holds and what the device keeps. The sections below that talk about opening
a model into a scratch scene, or saving a `.moxscene`, describe that interim and not
the app as it is.

Tree rows drag to re-parent and reorder (`scene.placeInTree`): a finger holds a row first, so a
quick swipe still scrolls. There is no Objects tool: around a model being edited (or a stage),
the view tool (Orbit) picks and drags instances, as on a scene of its own, and every other tool
goes through them to the model; the tree and the gizmo work too (`SceneLayerOptions.pickWhen`).
Menus open submenus in place (a row back at the top), so they work by tap.

The tree has two parts (November 7, 2026). **Layers** lists the model being edited, or the stage,
with its own new-layer button. **Objects** files the instances under headers that open and close: a
kind's add-menu group, its kind, or its model. Each header shows a count and can show, hide or lock
everything under it. An object's eye, lock and menu appear on hover, or always when the object is hidden
or locked. A filter appears past eight objects. Choosing something in the scene opens its header and
scrolls to its row. Hosts may order each group (`outlinerSort`, such as along a course) and add quiet
text at the end of a row (`outlinerDetail`).

Not yet: the document mark (●) on the model's row; scenes inside scenes.

## Why

Today the app holds two documents at once, the model draft and the scene draft, and a mode
says which one you see. The model you are working on lives in the first; the scene has its own
copy of it once placed there; editing in place changes the copy, not the draft. Checking a
model's scale against the player means placing a copy in the scene, editing the copy, and
remembering which one is the real one. Nothing on screen says which document you are in.

## What others do

- **Godot.** Everything is a scene, a tree of nodes. A character is its own scene that a level
  instances; opening an instanced scene opens it in its own tab, alone. The tree is always the
  truth, and plain nodes group and nest anything.
- **Blender.** One Outliner tree holds every object. Tab on an object edits its mesh in place,
  with the world still around it. No object is special: the one being edited is the one you
  went into. Objects can share a mesh, so editing one edits them all.
- **Unity prefabs.** A prefab opens in context: the scene stays around it, greyed, with a
  breadcrumb (`Scene › Knight`) and a back arrow. Going into a prefab is navigation.
- **Flash.** Double-click a symbol to edit it in place, the rest dimmed, with a breadcrumb bar.
  What confused people was two kinds of content on one stage: loose shapes and symbols (and
  graphic versus movie clip symbols), each with its own rules.
- **MagicaVoxel.** World mode is a tree of models and groups; pick a model to edit it. No model
  is primary, and `.vox` stores the tree.

## Rules

1. **There is always a scene, and always a tree.** It is the one panel on the left.
2. **Going into a model is navigation, not a mode.** A breadcrumb says where you are
   (`Level 1 › Knight`); tapping a crumb goes back up. No Done, no mode label.
3. **A scene holds one kind of thing: instances.** Voxels live only in models. Groups are
   instances with nothing to draw, so nesting needs no second kind of node.
4. **At scene level, no model is special.** The model you opened is an instance like the others
   once you step out; it only keeps a mark saying it is the document.
5. **What you opened is what is saved.** Open a model and Save saves the model; the scene
   around it is scratch. Open a scene and Save saves the scene.

## Opening a model

Opening a `.voxeltoy` (or starting a new model) puts you inside it, in a **scratch scene** of its
own: the model is an instance at the origin, entered. Every tool works as it does today.

- **Add the player next to it** from the tree's **Add** menu (From file…, New model, a host's
  kinds). The added instance appears in the tree beside the model; you stay in the model.
- **The scene around the model is live.** Choose an instance in the tree and its gizmo moves it;
  every other touch goes to the model's tools. The scene can be hidden from the bar.
- **Step out** by tapping the scene's crumb, or the scene row in the tree. Now the model is an
  instance like the others: select it, move it, double-tap it (or **Edit model** in its menu) to
  go back in.
- **Saving saves the model.** `.voxeltoy` save, export, share links and live rooms are all about
  the model, as today. Undo is one history across the model and its scratch scene.
- **The scratch scene is kept on this device** with that model (by `docId`), so the player is
  still beside the knight next time. It is never written into the `.voxeltoy`.
- **Save scene as…** makes the scratch scene a real scene (a `.moxscene` with the model
  embedded), the way to start a level from the model you are working on.

The model's document is shared, not copied: the scratch scene holds the open model's
`VoxelDocument` itself (see [editor-architecture.md](editor-architecture.md)), so there is
never a second copy to keep in step. Other models in the scratch scene are embedded copies, as
in any scene.

## Opening a scene

Opening a `.moxscene` (or **New scene**) shows the same tree with nothing entered. Tap selects,
double-tap (or **Edit model**) enters, and the breadcrumb reads `Level 1 › Knight`. Edits go
into the scene's copy of that model, and Save saves the scene. **Export model…** writes the
entered model out as its own `.voxeltoy`. Linked models, when they arrive, write to the model's
own file instead.

## The tree

One panel, in the layers panel's place (a sheet on phones):

```
Level 1                       ← the scene (its menu: rename, Add, ground, snap)
▾ Knight            ● ⋯       ← the entered model: its layers below
    Body              👁 🔒
    Sword hand        👁 🔒
  ▾ Sword                     ← attached to Knight's "Sword hand"
▾ Props (group)
    Crate
    Barrel
  Player
```

- **Rows are instances.** Attached and grouped instances nest under their parent; a part they
  hang from shows after the name. Each row has visibility, lock and a menu (Rename, Duplicate,
  Group, Attach to…, Edit model, Export model…, Delete). Dragging rows to re-parent is a
  shortcut for **Attach to…**.
- **The entered model's layers** show under its row: the layers panel, moved into the tree.
  Its layer actions (new, kinds, parts) are in that row's menu and the layer rows' menus.
- **The document mark** (●) is on the instance of the model you opened, in a scratch scene.
- **Groups** are instances with no model and no kind. **Group** in a row's menu (or the
  selection's) puts the selected instances in a new group at their center, keeping where they
  are; **Ungroup** lifts them out. A group has a transform, visibility and lock like any
  instance, and draws only its outline when selected.

Scenes inside scenes come later: an instance whose model is a scene, so a set of props or a
character with its sword can be placed as one thing.

## What goes away

- The web app's mode (`loadMode`, `Mode`), **Place in the scene**, **Go to the scene**,
  **Back to my model**, and the separate model and scene drafts: the app opens one document,
  a model with its scratch scene or a scene.
- **Done**: the breadcrumb.
- **The stage** as a separate idea in the app. A model with its scratch scene is a stage that
  isn't saved; a scene that opens with a model entered is a stage that is. Hosts keep
  `scene.setStage` for levels whose course is always being edited.
- **Edit in place's dimmed, unpickable context**: the context is live, as on the stage, and can
  be dimmed or hidden.

## Data

- **Groups** need no new fields: an instance with `model: null` and no `kind`. Today such an
  instance draws nothing and can't be made; it becomes a group.
- **Scratch scenes** are `SceneDocument`s stored on the device under the model's `docId`,
  holding everything but the model itself, which is filled in from the open document when the
  scratch scene loads (`SceneModel.doc` is omitted for it; `SceneDocument.document` names it).
- **Entered** (which instance's model is being edited) is UI state, as `openModel` is today.

## Phases

1. **The tree.** Groups (core and UI); nested rows; the entered model's layers in the tree;
   one panel on desktop and phones. *Done when* a scene's props can be grouped, moved together
   and ungrouped with one undo step each, and an entered model's layers are edited from the
   tree.
2. **Navigation.** The breadcrumb; entering and stepping out; live context with the Move tool;
   no Done, no stage in the app. *Done when* a phone user can go into a model, move the
   instance beside it, and come back out, without a mode or a Done button.
3. **One document.** The scratch scene per model on the shared `VoxelDocument`, kept by `docId`;
   Save scene as…; the app opens one document; the drafts and the mode go. *Done when* opening
   a model, adding the player beside it, reloading and saving gives the player still there and
   a `.voxeltoy` with nothing of the scratch scene in it.
