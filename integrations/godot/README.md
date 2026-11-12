# Voxeltoy for Godot: voxel volumes

Draws Voxeltoy models in Godot from their voxels, with no exported mesh. A
`MoxelVolume3D` is one box; its shader walks the voxel grid along each pixel's
ray and writes the depth of the voxel it hits. It plays Voxeltoy's frame
animations and can swap palettes, pick, edit, dissolve, cut away and flash
single voxels.

For a model that only needs to play, export a `.glb` instead: it works in every
renderer and engine. Use voxel volumes when a game needs the voxels at run
time. The design, research and measurements are in
[docs/voxel-runtime.md](../../docs/voxel-runtime.md).

## Requirements

- Godot 4.5 or later (tested on 4.6.1 and 4.7.2), Forward+ renderer. Mobile and
  Compatibility, which includes web export, are not supported.
- Give omni lights **cube** shadows (`omni_shadow_mode`). Dual-paraboloid
  shadows bend vertices, which a ray-marched depth can't follow.
- Desktop GPUs. On an integrated GPU weaker than a Steam Deck, 50 small
  characters took about 5 ms a frame at 1080p, and one filling the screen 8 ms.

## Install

1. Copy `addons/moxel` into your project's `addons` folder.
2. Enable **Voxeltoy** in Project Settings › Plugins. The addon folder stays `addons/moxel`, and the node class names stay `MoxelVolume3D` and `MoxelVolumeAnimation`.

## Use

In Voxeltoy, choose **Export › Voxel volumes (.voxeltoyvol)**. A `.voxeltoyvol` file is
a zip of `volumes.json`, `palette.png` and one grayscale PNG per distinct pose.
`.moxelvol` still imports. Put it in your project: the plugin imports it as a `MoxelVolumeAnimation`.

Add a **MoxelVolume3D** node and set its `animation`. The node's origin is the
corner of the grid, and one voxel is one unit; scale the node to change
that.

```gdscript
var knight := MoxelVolume3D.new()
knight.animation = preload("res://knight.voxeltoyvol")
knight.scale = Vector3.ONE / 16.0   # 16 voxels per meter
add_child(knight)
knight.play()
knight.frame_changed.connect(func(): print(knight.frame))
```

A folder or zip can also be read at run time with
`MoxelVolumeAnimation.load_file(path)`.

### Playing

| Member | |
| --- | --- |
| `play()`, `pause()`, `stop()` | `stop` also goes back to frame 0. `autoplay` starts on ready. |
| `frame` | The frame on show; setting it moves playback to that frame's start. |
| `speed_scale`, `loop` | Without `loop`, playback stops on the last frame. |
| `frame_changed`, `animation_finished` | Signals, as on `AnimatedSprite3D`. |
| `advance(seconds)` | Called for you every frame while playing. |

Frames last whole ticks of `1 / fps` seconds, as in Voxeltoy; `MoxelTiming` holds
that clock.

### Looks

| Member | |
| --- | --- |
| `lighting` | `LIT` (Godot's lights, shadows and ambient light, like a `StandardMaterial3D`) or `FLAT` (unlit, shaded like Voxeltoy's viewport). |
| `ambient_occlusion`, `shade` | Voxel AO (lit: indirect light only), and face shading (flat). |
| `palette` | The 256 colors on show, sRGB. Set it to swap palettes; the animation is unchanged. |
| `set_emission(index, strength)`, `emissive_intensity` | Make palette entries glow. |

### Voxels

Cells are in grid coordinates, `Vector3i`.

| Member | |
| --- | --- |
| `get_voxel(cell)`, `get_voxel_count()` | The palette index at a cell (0 = empty) in the frame on show. |
| `set_voxel(cell, value)` | Changes the pose on show, so every frame that shares it. Cells outside the pose's crop are ignored. |
| `fill_box(from, to, value, all_frames)`, `fill_sphere(center, radius, value, all_frames)` | With `all_frames`, every pose changes the same grid cells: right for parts that hold still. |
| `raycast(origin, direction, max_distance)` | World space. Returns `cell`, `normal`, `value`, `position` and `distance`, or an empty Dictionary. Skips dissolved and cut-away voxels. |

Edits are copied on write: the animation resource, and other nodes showing it,
keep their voxels. Assign `animation` again to start over.

### Effects

| Member | |
| --- | --- |
| `dissolve` (0 to 1), `dissolve_edge`, `dissolve_color` | Hides that share of voxels, picked by a hash of each grid cell, so the same cells go first every time; the next to go glow. |
| `clip_enabled`, `clip_plane` | A cutaway: hides the voxels above the plane, in grid coordinates. The model looks solid inside. |
| `flash(cell, color, radius, duration)` | Lights up the voxels around a cell, fading out: a hit. |

Dissolved and cut-away voxels cast no shadow and can't be picked. `voxel_hash`
and `is_hidden` give the shader's answer on the CPU, and match Voxeltoy's three.js
runtime.

## Demo

`demo/shooting_gallery.tscn`, the project's main scene: critters walk around an
arena; click or tap one to blast voxels out of it. It ports the three.js demo
in `apps/web/dev/voxel-game.html`.

## Tests and the spike

From this folder, with Godot on the path:

```sh
godot --headless --path . --import          # once, and after changes
xvfb-run -a godot --path . -s spike/tests.gd # the addon's tests; exits 1 on failure
xvfb-run -a godot --path . -s spike/spike.gd -- views|lit|perf|demo
bun spike/compare.ts                         # diffs the images spike.gd writes to spike/out
```

`views` renders `fixtures/views.json` for comparison with three.js
(`apps/web/dev/voxel-fixtures.html` renders the same views); `lit` compares a
lit volume with a mesh of the same voxels; `perf` times both at 1080p. On a
machine without a display, `xvfb-run` works with NVIDIA's driver; Mesa's AMD
driver also needs `MESA_VK_WSI_DEBUG=sw`. `bun fixtures/make-fixtures.ts`
regenerates the fixtures from `apps/web/dev/samples.ts`.
