# Product principles

## What Voxeltoy is

Voxeltoy is a voxel editor for making voxel shapes, rigged voxel characters and
frame animations. It keeps modeling simple, with a minimal interface and a
scriptable editing API.

Everything Voxeltoy edits lives in the voxel grid, except reference images and
reference meshes. Each voxel is either empty or a single palette color.
Selections and layers help organize and edit voxels within that grid.

## What Voxeltoy is not

Voxeltoy is not a rendering suite for elaborate MagicaVoxel-style renders. Export
framing and turntables help present a model; they do not turn the editor into
one.

Inside a model there is no separate object model with precise placement outside
the grid. Editable content moves in whole voxel steps and rotates in multiples
of 90 degrees. Arbitrary-angle rotation and sub-voxel placement are outside the
scope of model editing.

Scenes (proposed; see [Scenes](scenes.md)) are the one place things move
freely: they place instances of whole models, to check scale and composition
and to export them together. A scene is for composing and checking, not for
rendering, and the models in it are ordinary on-grid models.

A model is its voxels and its **markers**: named points and simple volumes
that aren't voxels, such as a mount where something attaches, a collider or a
hitbox. A model also has an **origin**, the point it is placed by and turns
around. Markers and origins are the one thing that may sit between voxels: they
snap to half voxels and turn in quarter turns. A **rigged character** is a
scene of part models, each attached to a mount marker on its parent part;
Voxeltoy exports that rig to tools such as Blender and Godot, which pose and
animate it. See [the pipeline](pipeline.md).

Voxels do not contain multiple colors, textures, or materials. Reference assets
can sit outside these constraints, but converting a reference into editable
content brings it into the voxel grid.

## Principles for every feature

- Make the full workflow usable on a phone with tappable controls.
- Keep the interface minimal and calm.
- Expose editing operations through the headless `Editor` API.
- Make document changes undoable and preserve them in local autosave and files.
