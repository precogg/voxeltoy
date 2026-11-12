# Animation export: a voxel sprite sheet for game engines

Draft, October 28, 2026. A proposal, not an implemented feature. It continues
[animation.md](animation.md), which designs the editing side (frames, layers,
cels, holds, onion skins) and leaves engine export open. This document answers
one question: what file does Voxeltoy write so that an animated voxel model plays in
Godot, three.js and other engines with as little work as possible?

## Summary

- **Not one GLB per frame.** Write one `.glb` that holds every distinct frame
  mesh once, one shared material, and one glTF animation per tag (Idle, Walk).
  A later parts mode stores one mesh per distinct cel of each layer instead. A
  frame shows its meshes and hides the others with STEP-interpolated scale keys.
  Every glTF loader plays this with no plugin. glTF-Transform's `sequence`
  function uses the same method.
- **No per-frame textures.** Voxels need one color per face, not a texture.
  Use one 256×1 palette texture for the whole animation, and give each quad a UV
  at the center of its palette entry. Vertex colors stay available as an option.
- **Aseprite's metadata, in the GLB.** Frame durations, tags, directions and
  repeats go in the root node's `extras`, in the same shape as Aseprite's JSON
  `frameTags`. Engines that ignore it still play the baked clips. A small player
  for three.js and an addon for Godot read it to get Aseprite behavior: ping-pong,
  repeat counts, frame signals and palette swaps.
- **Two more outputs from the same manifest.** A *slice sheet* PNG holds the raw
  voxels of every frame, for sprite stacking, shader ray marching or meshing at
  run time. A *rendered sheet* holds 2D images from several view angles, with
  Aseprite-compatible JSON, for 2D games.

The first step is a short spike that writes a test GLB from four volumes and
checks it in Godot 4.6 and 4.7, three.js, Blender and the glTF validator. It does
not need the timeline UI.

## The problem

A voxel flipbook changes topology from frame to frame. An arm that moves one
voxel adds faces, removes faces and changes greedy-mesh merges. That rules out
the usual tools for mesh animation:

| Method | Why it does not fit |
| --- | --- |
| Morph targets (blend shapes) | Every target needs the same vertex count and order. Voxel frames differ. A union mesh with collapsed quads is possible, but it is large, fragile and can draw stray faces when frames blend. |
| Skinning (bones) | Good for rigid parts, and Voxeltoy already exports parts (see [parts](parts.md)). It cannot add or remove voxels. |
| Vertex animation textures | Built for a fixed vertex count. They also need a custom shader in every engine. |
| One file per frame | Works, and the Godot "Voxel Animation Plugin" (Wild Ox Studios, 2026) takes this approach. Each file repeats its material, has no shared timing and no tags, and needs a custom player to swap meshes. |
| Mesh sequence extension | None exists. [glTF#2175](https://github.com/KhronosGroup/glTF/issues/2175) is still open; the answers there point to scale keys or morph targets. |

So the format must swap whole meshes, and it must use only features that common
loaders already support.

## Mesh swapping in glTF

glTF can't animate which mesh a node uses. It can animate a node's transform,
and a node scaled to zero draws nothing visible. The established method is:

- One node for each mesh that is visible in at least one frame.
- One animation for each clip. Each node has a `scale` channel with `STEP`
  interpolation: `1` while the node shows, `0` otherwise.

Support, checked October 2026:

| Loader | Scale keys with STEP | `KHR_node_visibility` |
| --- | --- | --- |
| three.js (r186) | Yes, as discrete tracks | No (an external Needle plugin adds it) |
| Godot | Yes, imported as nearest-interpolation tracks | Static from 4.5, animated from 4.6 (through `KHR_animation_pointer`) |
| Blender (glTF IO 5.4) | Yes | No |
| Unity glTFast | Yes | No |
| UnityGLTF 2.24 | Yes | Yes |

Scale keys are the baseline. `KHR_node_visibility` is ratified, but three.js,
Blender and glTFast don't read it yet. Write it as well, behind an option. List
it only in `extensionsUsed`, never in `extensionsRequired`, so loaders that
don't know it still open the file.

Known risks to test in the spike:

- **Scale zero makes a singular matrix.** Godot reports `det == 0` errors when
  something inverts such a basis, for example editor gizmos, decals or physics.
  three.js inverts it to a zero matrix without a warning. A plain
  `MeshInstance3D` may be fine; this is not verified. If it is not, use a very
  small scale such as `1e-4` and measure again.
- **Hidden frames still cost draw calls.** A zero-scale mesh is probably still
  submitted. With 30 hidden meshes that is 30 empty draws. Voxeltoy's own players
  avoid this by setting `visible` or swapping meshes. Plain loaders pay the cost.

## Structure: merged frames first, then parts

The export has two modes. Both use the same manifest and the same mesh
swapping. Merged mode ships first, and parts mode follows.

**Merged mode (first release).** Mesh the visible layers of each frame as one
composite, and give each distinct composite one node:

```
root ("Knight", extras.voxeltoy = manifest)
├─ frame#0              one mesh per distinct frame
├─ frame#1
└─ frame#2
```

- **Deduplicate by content.** Hash each composite and mesh it once. A hold, or
  a frame that repeats an earlier pose, costs nothing.
- One draw call for each visible frame, and no hidden faces where layers touch.
- It is the simplest file for engines and the simplest exporter to build.
- It stores more geometry when only one part changes, because every changed
  frame stores the whole model. Measure this in the spike.

**Parts mode (later).** [animation.md](animation.md) stores each frame as one
cel per layer. Parts mode keeps that structure, because most frames change
only one or two parts:

```
root ("Knight", extras.voxeltoy = manifest)
├─ torso (part node, pivot origin)
│  └─ torso#0           one mesh, shown in every frame
├─ arm.L (part node, parent torso)
│  ├─ arm.L#0           cel meshes, one per distinct cel
│  ├─ arm.L#1
│  └─ arm.L#2
└─ ...
```

- **Deduplicate cels by content.** A hold, a linked cel and an unchanged layer
  each cost nothing. A 12-frame walk where only the legs move stores one torso
  mesh, not twelve.
- **Part nodes come from the rig.** A layer's parent and pivot work as they do
  in the parts export today. Each cel mesh is a child of its layer's node, with
  its origin at the layer pivot. Transform keys on part nodes and cel swaps can
  then share one clip; see [later](#later).
- One draw call for each visible part, and hidden faces where parts touch, as
  in today's parts export.

**In both modes:**

- **Same bounds and origin in every frame.** All frames share the document grid,
  so nothing jumps between frames. The origin is the floor center, or the pivot
  for parts, as in today's exports.
- **Voxels per unit is an export setting.** The export dialog sets how many
  voxels make one engine unit: 1 (today's default), 16 for a 16-voxel meter, or
  any positive number. The manifest records it as `voxelsPerUnit`, so players and
  scripts can convert. It is an export setting, not document state, because the
  same model can go to engines with different scales. The dialog remembers the
  last value.

## Color: palette texture

The current GLB export writes `COLOR_0` vertex colors with no baked shading or
AO, and the mesher merges quads only within one palette index. Each quad
therefore maps to exactly one palette entry.

For animation export, use a palette texture by default:

- One 256×1 PNG, the document palette, shared by every cel. Each quad's four
  vertices get the UV of the center of its palette entry. Set the sampler to
  `NEAREST`, and don't use mipmaps: a smaller mip level averages neighboring
  colors. If an engine forces mipmaps, write a 16×16 palette with each entry
  repeated in a 2×2 block, or fix the import settings in the Godot addon.
- **Palette swaps for free.** Team colors, damage flashes and day/night palettes
  become a texture swap. Vertex colors can't do this without a shader.
- **It avoids a Godot regression.** Godot 3.x to 4.6 turns `COLOR_0` into albedo
  automatically. 4.7.0–4.7.2 don't
  ([#120625](https://github.com/godotengine/godot/issues/120625), fixed for
  4.8), so vertex-colored GLBs import untinted on the current stable release.
- **Room to grow.** An emissive palette texture (glowing voxels) and roughness or
  metal per palette entry fit the same UVs, like MagicaVoxel materials.

Keep **vertex colors** as an option for tools that prefer them. **Baked AO** is
an option on top of either mode. glTF multiplies `COLOR_0` with the base color,
so a gray AO value in `COLOR_0` darkens the palette texture as the spec
requires. AO stops greedy merges across shading gradients, so it costs
geometry; the default leaves it to the engine.

Godot's "Generate LODs" import setting corrupts vertex colors
([#107621](https://github.com/godotengine/godot/issues/107621)). The Godot
documentation for Voxeltoy must say to turn it off for voxel meshes.

## Timing and the manifest

glTF clips are plain timelines. They don't describe direction, repeat count or
events. Voxeltoy writes those in a manifest, shaped like the `meta` block of
Aseprite's JSON export, so artists and existing tools recognize it:

```jsonc
{
  "voxeltoy": {
    "version": 1,
    "fps": 12,                          // per animation.md: fps + integer holds
    "voxelsPerUnit": 16,                // export setting
    "frames": [
      { "duration": 2, "nodes": ["frame#0"] },  // parts mode lists one
      { "duration": 1, "nodes": ["frame#1"] }   // node per visible part
    ],
    "tags": [
      { "name": "walk", "from": 0, "to": 7, "direction": "forward", "repeat": 0 },
      { "name": "attack", "from": 8, "to": 11, "direction": "pingpong", "repeat": 1 }
    ],
    "palette": "palette"                // image name inside the GLB
  }
}
```

- Put the manifest in the **root node's** `extras`. Godot (4.4 and later) imports
  node extras as `get_meta("extras")`, and ignores scene and animation extras.
  three.js copies node extras to `userData`.
- **Each tag becomes one baked glTF animation** with direction and repeats
  expanded: a ping-pong tag stores its frames forward and back. This keeps the
  file correct in loaders that know nothing about Voxeltoy.
- **Export requires at least one tag.** Clip names, loops and the player API all
  come from tags, so an untagged export would need a second set of rules. If the
  document has no tags, the export dialog says so and offers "Tag all frames",
  which adds one tag (named after the document) over every frame.
- **Looping in Godot without the addon.** Godot loops an imported clip when its
  name starts or ends with `loop` or `cycle`. Offer a "Godot loop names" option
  that exports looping tags as `walk-loop`.
- Durations stay in ticks (`fps` plus whole holds), as animation.md proposes.
  If that model changes to milliseconds before release, the manifest follows.

## Players

The baked clips work everywhere. Two small players add Aseprite behavior on top.

**three.js, in `@voxeltoy/three`:** `VoxelSprite` wraps a loaded GLTF scene and
reads `userData.voxeltoy`. Its API matches the familiar sprite players:
`play("walk")`, `stop()`, `frame`, `speed`, an `onFrame` callback, and
`setPalette(texture)`. It sets `visible` rather than relying on scale keys, so
hidden meshes cost no draw calls. It has no dependency on the editor. A
`<model-viewer>`-style demo page on the Voxeltoy site doubles as its test.

**Godot addon, in this repository at `integrations/godot/addons/moxel`,** so
the format and the player change together and are tested together:
- A `GLTFDocumentExtension` or post-import script that reads the manifest.
  It fixes the palette texture filter and mipmaps, and converts scale tracks to
  `visible` tracks.
- A `MoxelSprite3D` node with the API of `AnimatedSprite3D`: `play()`,
  `animation_finished`, `frame_changed`, `speed_scale`, and `palette`.
- Released to the Godot Asset Library from this repository.

Other engines get the baked clips, and the manifest is simple enough to read by
hand.

## Other outputs from the same frames

**Slice sheet (voxel data).** [voxel-runtime.md](voxel-runtime.md) proposes
splitting this into a colored sheet and grayscale per-frame volumes; see its
"Changes to the export proposal". One indexed PNG: a column for each frame, a row for
each Y slice, a transparent pixel for an empty voxel. The manifest goes beside it
as JSON (the same `frames` and `tags`, plus grid size and layout). Use cases:
- Sprite stacking in 2D engines. Godot addons and GameMaker tutorials use one
  strip of slices drawn bottom to top. No official layout exists, so check
  Voxeltoy's axis and order against MagicaVoxel's slice export.
- Ray marching in a shader, through a `Data3DTexture` in three.js or a
  `Texture3D` in Godot.
- Meshing at run time, for games that destroy or recolor voxels.
A 32×32×32 model at 12 frames fits in a 384×1024 PNG.

**Rendered sheet (2D sprites).** Render every frame from N view angles (4 or 8
directions, an isometric or a custom camera) into one PNG. Write Aseprite's JSON
array format, with a tag for each direction and clip (`walk_N`, `walk_NE`).
Godot, Phaser, PixiJS and Unity already have Aseprite importers that read it.
This extends the "PNG sequence or sprite sheet" first export in animation.md
and reuses the export framing in roadmap item 5.

**MagicaVoxel `.vox` with frames.** MagicaVoxel 0.99.7 and later stores
animation as several models in an `nSHP` node, each with an `_f` frame
attribute. This is useful for a round trip with MagicaVoxel and vengi, but
engines mostly ignore it: three.js `VOXLoader` reads only the first model, and
Zylann's `godot_voxel` rejects animated files. It is not the engine format.

## Precedents

- **glTF-Transform `sequence`:** one node per frame and STEP scale keys. It
  converts Quill animations for three.js.
- **MagicaVoxel 0.99.7:** frame-based model swaps plus transform keys in `.vox`.
  The closest voxel precedent, but engines can't read it.
- **Godot "Voxel Animation Plugin"** and the `FramedMeshInstance` node from the
  MagicaVoxel importer fork: both swap one mesh per frame at run time. This shows
  demand for a voxel flipbook player in Godot.
- **VoxEdit, Blockbench and vengi** animate with bones or transform keys, not
  frames. **SpriteStack** has experimental keyframes and exports 2D sheets.
  **Goxel** has no animation. No editor found exports a frame-based voxel
  flipbook that game engines read directly.

## Size

Positions are whole numbers on the voxel grid, so the format suits compact
storage:
- `KHR_mesh_quantization` stores positions as int16 (or int8 below 128 voxels)
  and normals as int8, with no loss. Check that each target loader supports it
  before enabling it by default.
- `EXT_meshopt_compression` can follow if files are still large.
- Deduplicated frames and cels matter more than either. Measure representative models
  (32³ and 64³, 8 to 60 frames) in the spike before choosing defaults.

## Plan

| Stage | Deliverable | Exit evidence |
| --- | --- | --- |
| 0. Engine spike | A headless `exportFlipbookGlb(frames, tags, options)` in `packages/three`. Feed it hand-made volumes: four `.voxeltoy` files as a walk cycle. Write palette-texture and vertex-color versions, with and without `KHR_node_visibility`, in merged mode. Also write a parts-mode file by hand to compare sizes. | The file passes the glTF validator. It plays with correct timing in three.js, Godot 4.6 and 4.7, and Blender. Decide scale `0` or `1e-4`, record sizes and draw calls. |
| 1. Frame model | Stage 2 of animation.md: frames, cels, holds, history, `.voxeltoy` v3 (v2 now holds shape layers). | As listed there. |
| 2. Animated GLB | Export menu item "glTF, animation (.glb)". Merged mode, frame deduplication, tags as clips (at least one required), voxels per unit, manifest, palette texture. | A tagged walk and attack open in Godot and three.js with no addon. Holds, ping-pong and loops play correctly. |
| 3. Players | `VoxelSprite` in `@voxeltoy/three`; the Godot addon with `MoxelSprite3D` and import fixes; a docs page for each engine. | Signals and callbacks fire at frame boundaries. A palette swap at run time works. No draw calls for hidden meshes. |
| 4. Sheets | Slice sheet and rendered multi-angle sheet with Aseprite JSON. `.vox` frames. | An Aseprite importer in Godot loads the rendered sheet unchanged. A sprite stacking addon draws the slice sheet. MagicaVoxel opens the `.vox` frames. |
| 5. Parts mode and poses | Parts mode export (one mesh per distinct cel, part nodes from the rig). Then frames can also store part transforms (see below). | A rigged walk exports with one torso mesh. One clip combines a cel swap with a turning arm. |

Stage 0 can start now. It answers the open format questions before the frame
model is fixed, and it needs no UI.

## Later

- **Part poses in frames.** A frame can hold a rotation and offset for each part,
  in addition to cels. This combines rigid part animation (a swinging arm) with
  flipbook changes (a hand that opens). The export adds TRS channels on part
  nodes; the parts export already writes TRS for this reason. It is also the
  "quick test pose" from [parts](parts.md).
- **Events.** Named markers on frames (footstep, hit), exported in the manifest
  and fired by the players.
- **Skinned export.** One mesh with one bone per part, from parts.md, with cel
  swaps still done by visibility.

## Decisions

Decided October 28, 2026:

1. **Both modes, merged first.** Merged mode is the first release. Parts mode
   follows in stage 5.
2. **Tags are required.** An export needs at least one tag; the dialog offers
   "Tag all frames" when there are none.
3. **Voxels per unit is configurable at export time.** It is an export setting,
   not document state. The default is 1, as in today's exports.
4. **The Godot addon lives in this repository**, under `integrations/godot/`.
5. **The Godot addon reads `.glb`, not `.voxeltoy`.** Importing `.voxeltoy` would
   need a second parser and a second mesher in Godot, so the two meshers could
   drift apart. The only gain would be keeping source files in the Godot
   project, and a `.glb` re-imports when it changes anyway. Rendering voxels
   directly in Godot, without meshes, is a separate subject: a voxel runtime.
   The slice sheet is the data format that would feed it.
