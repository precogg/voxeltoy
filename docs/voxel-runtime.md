# A voxel runtime: rendering Voxeltoy models from voxel data in three.js and Godot

Draft, October 28, 2026. A proposal, not an implemented feature. It follows
[animation.md](animation.md), which designs frame editing, and the animation
export proposal ([animation-export.md](animation-export.md)), which makes an
animated `.glb` the default engine path. This document covers the other path:
an engine draws a Voxeltoy model, and its frame animation, straight from the voxel
data, with no exported mesh. three.js comes first, in `@voxeltoy/three`; Godot
follows, with the same shader ported.

## Summary

- **three.js first, then Godot.** A `VoxelVolume` in `@voxeltoy/three` is a
  runtime for web games on desktop browsers; phones are not a target. It is also
  the reference implementation: it can render a document's voxels directly, so
  the first spike needs no export format and no Godot, and it gives the Godot
  port fixture images to match.

- **Ray-march a box.** Each model is one box mesh. A spatial shader walks the
  voxel grid along each pixel's ray (a DDA) through a small 3D texture of
  palette indices. It writes the depth of the voxel that it hits, so the model
  intersects other geometry correctly. It also casts and receives shadows, and
  uses the engine's own lighting at the hit point. In Godot 4.5 and later,
  built-ins cover this (`IN_SHADOW_PASS` came in 4.5; `LIGHT_VERTEX` in 4.3).
  In three.js, shadows need a custom depth material and shadow lookups
  recomputed at the hit (see [three.js](#threejs)).
- **One R8 `Texture3D` per distinct frame, and a 256×1 palette texture.** A
  64³ frame is 256 KiB. Changing frame changes one shader parameter. Palette
  swaps, flashes and dissolves are a few lines in the shader.
- **A complement to the `.glb`, not a replacement.** The animated `.glb` stays
  the default: it runs on every renderer, in every engine, with no plugin.
  The voxel runtime is opt-in, for games that need per-voxel effects, run-time
  edits or voxel-exact hits. Both read the same manifest and tags, and their
  nodes share one player API.
- **The slice sheet changes.** An indexed PNG loses its indices when Godot or a
  browser decodes it. One sheet with every frame also exceeds texture limits.
  Write one 8-bit grayscale PNG for each distinct frame, and a separate palette
  PNG. Keep a colored slice sheet only for sprite stacking and for people to
  view. See [changes to the export proposal](#changes-to-the-export-proposal).
- **Godot: desktop first, Forward+ only.** The Godot target is desktop games
  on Steam and itch.io, so the runtime is built and tested for Forward+.
  Mobile and Compatibility (which includes web export) are not targets. The
  shader may work there, but nothing promises it. This avoids the main risk the
  research found: phones' tile-based GPUs lose their hidden-pixel rejection
  when a shader writes depth.
- **Opaque voxels, aliased edges.** No transparent voxels. Voxel edges are not
  antialiased; that suits the look.

## Research

Sources were read on October 28, 2026. The current Godot release is 4.7.2
(August 18, 2026). The Godot findings come from the 4.7 documentation and the
`4.7.2-stable` source. No shader in this document has run yet: everything about
Godot's behavior with a ray-marching shader comes from documentation and from
reading the source, so the Godot spike (stage 4) must confirm it. The research covers all three
renderers, because it was done before the target was settled; only Forward+
matters now.

### Rendering approaches

| Approach | How it works | Strengths | Problems |
| --- | --- | --- | --- |
| **Ray-marched box** | Draw the model's bounding box. The fragment shader steps through the grid from cell to cell (Amanatides & Woo DDA) and stops at the first solid cell. It sets `ALBEDO`, `NORMAL`, `LIGHT_VERTEX` and `DEPTH`. | Uses the voxel data as it is. Every voxel can change each frame with no remeshing. Exact per-voxel effects. One draw for each model. | Fragment cost scales with screen coverage times steps. Writing depth disables early-Z and hidden-surface removal. Voxel edges are not smoothed by MSAA. More shader work per renderer. |
| **Instanced cubes (`MultiMesh`)** | One cube instance per surface voxel, with a color for each instance. A frame is a buffer of transforms and colors. | Ordinary rasterization: early-Z, MSAA, shadows and every renderer work as usual. Simple to build. | Every instance draws all 12 triangles, including faces hidden by a neighbor. Changing frame uploads a new buffer. The whole MultiMesh is culled as one object and shares one light limit. |
| **Meshing at run time** | Build greedy meshes in the game: GDScript, a GDExtension, or Zylann's `godot_voxel`. | Best rendering cost once built. Run-time edits are possible. | A second mesher, which [the export proposal](#relation-to-the-glb-path) rejects. `godot_voxel` has no prebuilt web build. Voxeltoy's mesher is AssemblyScript, which Godot can't run. |
| **Sprite stacking** | Draw the Y slices as 2D sprites, each offset slightly upward. | Very cheap, and it works in 2D games. | It only looks right from above at a fixed tilt. It is not a 3D renderer. |

Godot details that decide the design:

| Topic | Finding | Source |
| --- | --- | --- |
| Writing depth | `DEPTH` is a fragment output in `[0, 1]`. If a shader writes it in one branch, it must write it in every branch. Godot uses reverse-Z in all three renderers. The NDC z range is `[0, 1]` in Forward+ and Mobile and `[-1, 1]` in Compatibility, so Compatibility needs `z * 0.5 + 0.5`. That formula is derived from the source, not from documentation. | [Spatial shaders](https://docs.godotengine.org/en/stable/tutorials/shaders/shader_reference/spatial_shader.html), [reverse-Z article](https://godotengine.org/article/introducing-reverse-z/), [#88328](https://github.com/godotengine/godot/pull/88328), [advanced post-processing](https://docs.godotengine.org/en/stable/tutorials/shaders/advanced_postprocessing.html) |
| Early depth test | `DEPTH` compiles to `gl_FragDepth`, and Godot never declares early fragment tests, so the GPU tests depth after the shader runs. | `servers/rendering/renderer_rd/forward_clustered/scene_shader_forward_clustered.cpp` at `4.7.2-stable`; [Khronos: Early Fragment Test](https://wikis.khronos.org/opengl/Early_Z) |
| Depth prepass | Forward+ draws opaque objects in a depth prepass, then again in the color pass. A ray-marching material therefore marches twice. Mobile has no prepass. The cost has not been measured. | `render_forward_clustered.cpp` at `4.7.2-stable` |
| Shadow pass | `IN_SHADOW_PASS` was added in 4.5 and works in all three renderers. In a shadow pass, the view matrices belong to the light, and a directional light uses an orthographic projection. | [#93142](https://github.com/godotengine/godot/pull/93142), [spatial shaders](https://docs.godotengine.org/en/stable/tutorials/shaders/shader_reference/spatial_shader.html) |
| Shared shadow material | A material that uses none of `discard`, `cull_front`/`cull_disabled`, vertex changes or alpha clip casts its shadow with Godot's default material, which ignores the custom depth. A ray-marcher that uses `discard` and `cull_front` gets its own shader in the shadow pass. | `scene_shader_forward_clustered.h` and `forward_mobile/scene_shader_forward_mobile.h` at `4.7.2-stable` |
| Shadow edge cases | A directional shadow pass clamps vertex z ("pancaking"), and a `DEPTH` write skips that clamp. Dual-paraboloid omni shadows bend vertices, so a projected depth is wrong there; cube mode should be correct. Compatibility omni shadows overwrite the depth with `length(vertex)` after setting `vertex` from `LIGHT_VERTEX`, so setting `LIGHT_VERTEX` should be enough. All three are inferred from the source. | `scene_forward_clustered.glsl` and `drivers/gles3/shaders/scene.glsl` at `4.7.2-stable` |
| Lighting at the hit | `LIGHT_VERTEX` (4.3, all renderers) moves the point that lights and shadows use, without moving the fragment. `NORMAL` is in view space and can be written in `fragment()`. | [#91136](https://github.com/godotengine/godot/pull/91136), [spatial shaders](https://docs.godotengine.org/en/stable/tutorials/shaders/shader_reference/spatial_shader.html) |
| 3D textures | `sampler3D`, `usampler3D` and `texelFetch` work in every renderer. `Image` has no 8-bit integer format, so use `FORMAT_R8` and read `round(r * 255.0)`. `ImageTexture3D.update` replaces every slice; there are no partial updates. | [Shading language](https://docs.godotengine.org/en/stable/tutorials/shaders/shader_reference/shading_language.html), [ImageTexture3D](https://docs.godotengine.org/en/stable/classes/class_imagetexture3d.html), `core/io/image.h` |
| Per-instance uniforms | They don't accept textures: "only regular scalar and vector types", at most 16 for each shader. Instances that show different frames need a separate material, or one atlas texture and a frame index. | [Shading language](https://docs.godotengine.org/en/stable/tutorials/shaders/shader_reference/shading_language.html) |
| Antialiasing | MSAA shades once per pixel, so it smooths the box outline but not the voxel edges that the march finds. TAA and FSR2 exist only in Forward+. Motion vectors come from the box vertices, so a moving camera may show slight TAA ghosting at the hit depth (inferred). Compatibility offers only MSAA and SSAA. | [3D antialiasing](https://docs.godotengine.org/en/stable/tutorials/3d/3d_antialiasing.html) |
| Transparency | Transparent objects are drawn after opaque ones and sorted back to front by origin, with no order-independent transparency. | [3D rendering limitations](https://docs.godotengine.org/en/stable/tutorials/3d/3d_rendering_limitations.html) |
| Web | Godot's web export uses Compatibility on WebGL 2. A GDExtension must be built for the web separately. | [Exporting for the web](https://docs.godotengine.org/en/stable/tutorials/export/exporting_for_web.html) |
| MultiMesh | One draw, culled as one object with one AABB. `visible_instance_count` limits what is drawn without resizing buffers, and `RenderingServer.multimesh_set_buffer` uploads in bulk. | [Using MultiMesh](https://docs.godotengine.org/en/stable/tutorials/performance/using_multimesh.html), [MultiMesh](https://docs.godotengine.org/en/stable/classes/class_multimesh.html) |

### Mobile GPUs

Phones are not a target (see [decisions](#decisions)). This section explains
why ray-marching would be a risk there, in case that changes. The GPU vendors
agree. A shader that writes depth, or uses `discard`, loses the
hardware's early rejection of hidden pixels, and they advise drawing such objects
after ordinary opaque geometry.

- Apple: "if we discard or update the depth, we will need to go back to HSR".
  Apple's advice is to draw opaque objects first, then alpha-tested, discard or
  depth-writing objects, then translucent ones.
  [WWDC20 session 10602](https://developer.apple.com/videos/play/wwdc2020/10602/).
- Arm: `gl_FragDepth` or `discard` forces late depth testing. On the
  Immortalis-G925, the fragment pre-pass then runs part of the shader twice.
  [Arm blog](https://community.arm.com/arm-community-blogs/b/graphics-gaming-and-vr-blog/posts/immortalis-g925-the-fragment-prepass).
  The Mali best-practices page itself could not be read.
- Adreno: writing depth disables LRZ completely, and `discard` disables it for a
  while. [Igalia, Turnip driver](https://blogs.igalia.com/dpiliaiev/adreno-lrz/).
  This describes the open-source driver; Qualcomm's own guide could not be read.

No published measurements compare ray-marched voxel objects with meshes on a
phone. On desktop, Majercik et al. report about 20 times the primary-ray
throughput of rasterizing optimized meshes of the same voxels
([JCGT 2018](https://jcgt.org/published/0007/03/04/paper.pdf)). That result
used a desktop GPU and doesn't transfer to tile-based GPUs. On desktop GPUs,
a shader that writes depth still loses early-Z, but they have the fill rate to
pay for it; stage 0 measures how much.

For a sense of scale: a DDA ray crosses at most `sx + sy + sz` cells, so 192
steps for 64³. Most rays hit the surface much sooner. The cost per frame is
roughly *covered pixels × average steps*. A character that covers a tenth of
the screen is a different problem from one that fills it.

### Texture limits and layouts

| Limit | GL ES 3.0 / WebGL 2 minimum | Typical devices (web3dsurvey) |
| --- | --- | --- |
| 3D texture side | 256 | All ≥ 2048; about half of Android ≥ 4096; iOS 2048 |
| Array texture layers | 256 | Some Android 256, 95% ≥ 512; iOS 2048 |
| 2D texture side | 2048 | Android: 76% ≥ 8192, 3% ≥ 16384; iOS ≥ 8192 |

Sources: [ES 3.0 spec, table 6.28](https://registry.khronos.org/OpenGL/specs/es/3.0/es_spec_3.0.pdf),
[web3dsurvey MAX_3D_TEXTURE_SIZE](https://web3dsurvey.com/webgl2/parameters/MAX_3D_TEXTURE_SIZE),
[D3D11 limits](https://learn.microsoft.com/en-us/windows/win32/direct3d11/overviews-direct3d-11-resources-limits)
(2048 for 3D and arrays), [Metal feature set tables](https://developer.apple.com/metal/Metal-Feature-Set-Tables.pdf)
(2048 for 3D and arrays). The survey percentages are a sample, not a guarantee.

For 60 frames of 64³:

| Layout | Size | Result |
| --- | --- | --- |
| One `Texture3D` per frame | 60 × (64×64×64) | Fits everywhere. 15 MiB in total. |
| A 3D atlas, frames stacked along one axis | 64×64×3840 | Fails on iOS, Metal, D3D11 and every 2048 device. |
| A 3D atlas, frames tiled in X and Z | 512×64×512 (64 frames) | Fits most devices, but not the ES 3.0 minimum of 256. |
| `Texture2DArray`, one layer per slice | 3840 layers | Fails nearly everywhere. |
| The proposed slice sheet as one 2D image | 3840×4096 | Fits 4096. At 128³ it is 7680×16384, which fails on about 97% of Android devices. Also needs 3D addressing written by hand. |

What the loaders do with the data:

- **Godot decodes indexed PNGs to RGB or RGBA.** Its PNG loader expands the
  palette (`drivers/png/png_driver_common.cpp`), so the index is lost. An 8-bit
  grayscale PNG imports as `FORMAT_L8`, byte for byte. Browsers also expand
  indexed PNGs.
- **Godot's layered importer** turns one image into one `Texture3D` or
  `Texture2DArray`. `slices/horizontal` and `slices/vertical` (1–256) cut it
  into cells in row-major order. Its default compression (lossy WebP) and its
  default mipmaps both destroy indices; use Lossless, and turn off mipmaps.
  ([ResourceImporterLayeredTexture](https://docs.godotengine.org/en/stable/classes/class_resourceimporterlayeredtexture.html),
  [importer source](https://github.com/godotengine/godot/blob/master/editor/import/resource_importer_layered_texture.cpp)).
- **L8 is not the same in every Godot renderer.** On GLES it becomes
  `GL_LUMINANCE`, and on the web the swizzle code is compiled out. Converting
  to `FORMAT_R8` at load time avoids the difference.
- **Without `source_color`**, Godot samples a texture as stored data, with no
  sRGB conversion. The documentation only implies this.
- **three.js** creates an R8 `Data3DTexture` from `RedFormat` and
  `UnsignedByteType`, or R8UI for a `usampler3D` from `RedIntegerFormat`. It
  filters with Nearest and makes no mipmaps by default. R8 data never gets sRGB
  conversion. `Data3DTexture` re-uploads the whole volume on change.
  ([WebGLTextures.js](https://github.com/mrdoob/three.js/blob/dev/src/renderers/webgl/WebGLTextures.js)).
  To get exact bytes from a PNG, decode it in JavaScript, or call
  `createImageBitmap` with `colorSpaceConversion: "none"`.

### Precedents

| Precedent | What it does | What Voxeltoy takes from it |
| --- | --- | --- |
| **Teardown** (Tuxedo Labs) | Each object is a box drawn with a shader that ray-marches an 8-bit volume of palette indices, with a 256-wide palette texture and one row per palette. Two mip levels skip empty 2³ and 4³ blocks. The shader writes depth, so Teardown makes its own early depth test and draws front to back. Shadows, AO and lights use a separate one-bit world volume. Gustafsson himself describes the palette and the per-object grids; the box proxy, the mips and the depth details come from analyses of captured frames. | The same core: a box proxy, palette indices, a palette texture, depth writes. Occupancy levels for empty space are a later optimization. Teardown targets desktop GPUs. |
| **Majercik et al. 2018** | A fast ray-box test, and primary rays through voxels faster than meshes, with no precomputation. Includes GLSL. | The box entry test and evidence that dynamic voxels need no remeshing. |
| **Amanatides & Woo 1987** | The grid traversal: each step costs two comparisons and one addition. | The DDA itself. |
| **viktor-ferenczi/godot-voxel** (MIT, Godot 4.3+) | A two-level DDA in a fragment shader on a front-culled box, with separate opaque, transparent and shadow shaders. Stores data in 2D and array textures and a palette texture. Its README lists unfinished parts. | A working Godot reference for structure and the shadow pass. Whether it writes depth was not confirmed. |
| **Voxelbox** (godotshaders.com) | A `sampler3D` DDA on a front-culled cube. Writes `DEPTH`, and flips the box in the shadow pass with `IN_SHADOW_PASS`. Lights the proxy face, not the hit point. | The smallest example of the Godot recipe. Voxeltoy adds `LIGHT_VERTEX` and normals. |
| **three.js `webgl_volume_instancing`** | Loads `.vox` into a `Data3DTexture`, marches a fixed 100 steps (not a DDA), writes `gl_FragDepth`, and draws 50,000 instances. Its helper stores occupancy only (255 or 0), not palette indices. | Proof that the same method works in `@voxeltoy/three` on WebGL 2. |
| **Zylann's `godot_voxel`** | A C++ module and GDExtension (Godot 4.5+ for release 1.7x). `VoxelMesherCubes` greedy-meshes by color and supports palettes. `VoxelTool` edits at run time. Prebuilt for desktop, Android and iOS, not the web. Its `.vox` loader reads only the first model. | The run-time meshing option, for games that already use it. Too large a dependency for Voxeltoy's addon. |
| **Godot sprite stacking addons** | SpriteStack2D, Shader-Stacker. | Readers of the colored slice sheet. |

Sources: [Gustafsson, "Spraycan"](https://blog.voxagon.se/2020/12/03/spraycan.html),
[Gustafsson, "From screen space to voxel space"](https://blog.voxagon.se/2018/10/17/from-screen-space-to-voxel-space.html),
[Gustafsson, year summary 2024](https://blog.voxagon.se/2024/12/29/year-summary.html),
[Software Engineering Daily transcript](https://softwareengineeringdaily.com/wp-content/uploads/2024/12/SED1772-Teardown.txt),
[Wittens, "Teardown Frame Teardown"](https://acko.net/blog/teardown-frame-teardown/),
[Montoya, Teardown breakdown](https://juandiegomontoya.github.io/teardown_breakdown.html),
[Majercik et al.](https://jcgt.org/published/0007/03/04/paper.pdf),
[Amanatides & Woo](https://www.eecs.yorku.ca/~amana/research/grid.pdf),
[godot-voxel](https://github.com/viktor-ferenczi/godot-voxel),
[Voxelbox](https://godotshaders.com/shader/voxelbox/),
[three.js volume instancing](https://github.com/mrdoob/three.js/blob/dev/examples/webgl_volume_instancing.html),
[godot_voxel](https://github.com/Zylann/godot_voxel) and [its docs](https://voxel-tools.readthedocs.io),
[SpriteStack2D](https://godotengine.org/asset-library/asset/edit/15121),
[Shader-Stacker](https://godotengine.org/asset-library/asset/edit/6635).

**Unverified:** that `godot_voxel` currently builds for the web (its docs say
5.0.0 did not, as of February 2026); meshing-speed figures for it or for
GDScript; whether viktor-ferenczi's shader writes depth; and any mobile
performance figures for ray-marched voxels.

## Choosing an approach

**Ray-march for the first version.** It is the only approach that uses the
data as it is, and the voxel features of this runtime depend on that. Instanced
cubes are simpler, but every effect would need a buffer rewrite on the CPU, and
cubes still need a GPU-side palette to make palette swaps cheap. Meshing at run
time brings back the second mesher. Sprite stacking is a separate 2D output.

**Keep instanced cubes as the measured fallback.** If stage 0 shows that
ray-marching is too slow on the low-end target (see the plan), the next thing to test is a
`MultiMesh` of surface cubes. It reads the same volume texture and palette:
each instance stores its cell, and the shader fetches the color. Hit tests and
palette effects still work. Run-time edits rebuild the instance buffer.

## What voxels make possible

| Capability | With a `.glb` mesh | With the voxel runtime | First version? |
| --- | --- | --- | --- |
| Palette swaps (team colors, damage flash, day and night) | Yes, with the proposed palette texture. | Yes. | Yes |
| Per-voxel effects: dissolve by a hash of the cell, flash the cells near a hit, glow by palette index | Needs per-vertex data or a custom shader, and greedy quads cover many cells. | Yes, in the shader, per cell. | Dissolve, tint and emissive palette entries |
| Cutaways: hide cells beyond a plane, like the editor's slice | Clipping the mesh shows hollow insides. | Shows solid insides: the march treats hidden cells as empty and finds the next solid face. | Yes, it is cheap |
| Voxel-exact hit tests (which voxel did the bullet hit?) | Needs a raycast against the mesh and a lookup back into the grid. | A DDA over a `PackedByteArray` in GDScript. | Yes |
| Editing at run time (destruction, digging, painting) | Remesh: a second mesher. | Write the byte, then re-upload the texture: 256 KiB at 64³. | Single voxel and box edits in stage 3 |
| Physics collision | The mesh, or simple shapes. | Godot has no voxel shape. Build a compound of boxes from the volume (greedy boxes), or use the hit test for projectiles only. | No: use a simple shape |
| Debris that breaks off as separate bodies | Hard. | Split connected cells into new volumes. This is a game feature, not a renderer feature. | No |
| Transparent voxels | Standard. | Needs a second march, sorting or dithering. | Not planned: voxels are opaque |

## Frame animation

- **One R8 `Texture3D` per distinct frame.** Deduplicate by content, as the
  `.glb` export does: a hold or a repeated pose costs nothing. Changing frame
  sets the `volume` shader parameter on the node's material.
- **Crop each volume to its content.** The manifest records the offset of each
  volume in the document grid. This saves memory, keeps the box tight around the
  model (fewer wasted rays), and still places every frame in the same frame of
  reference. The node resizes its box when the frame changes.
- **Memory**, before cropping:

  | Grid | One frame | 60 distinct frames |
  | --- | --- | --- |
  | 32³ | 32 KiB | 1.9 MiB |
  | 64³ | 256 KiB | 15 MiB |
  | 128³ | 2 MiB | 120 MiB |
  | 256³ (Voxeltoy's maximum) | 16 MiB | 960 MiB |

  Mipmaps would add a seventh, but averaging palette indices is meaningless, so
  there are none.
- **Many instances in different frames.** Per-instance uniforms can't hold a
  texture, so each node owns a material. That is fine for a few characters.
  For crowds, the addon can build one atlas at load time: frames tiled in X and
  Z, each axis at most 2048 (512 for wide Android coverage), with the frame index
  as an `instance uniform`. The atlas is a load-time structure, not a file format.
- **Streaming is not needed at first.** Every texture of a 64³ animation
  together is a few megabytes. For large models, load the textures of a tag when
  it starts playing, and keep the textures of the current and next tag.
  `ImageTexture3D.update` and `RenderingServer.texture_3d_update` replace whole
  volumes; that is enough for animation, and for run-time edits at a modest rate.

## Design

### Shader

One spatial shader, with `render_mode cull_front` so that the camera can be
inside the box. A sketch, not tested:

```glsl
shader_type spatial;
render_mode cull_front;

uniform sampler3D volume : filter_nearest; // R8, value = palette index / 255
uniform sampler2D palette : source_color, filter_nearest; // 256×1
uniform ivec3 size; // cells; the box spans [0, size] in model space

void fragment() {
	// Ray in cell space. From the camera; in a directional shadow pass
	// (orthographic projection), along the light's view direction instead.
	// March from where the ray enters the box (slab test) to where it leaves.
	// DDA: step to the next cell boundary on the axis with the nearest crossing.
	// No hit: discard. Hit: index = int(round(texelFetch(volume, cell, 0).r * 255.0)).
	ALBEDO = texelFetch(palette, ivec2(index, 0), 0).rgb;
	NORMAL = /* the face crossed last, in view space */;
	LIGHT_VERTEX = hit_view; // lights and shadows at the voxel, not the box
	vec4 clip = PROJECTION_MATRIX * vec4(hit_view, 1.0);
	DEPTH = clip.z / clip.w; // Forward+; Compatibility would need * 0.5 + 0.5
}
```

- **Ray setup** goes in `vertex()`, where the inverse model matrix is cheap, and
  passes to `fragment()` as varyings. A perspective ray starts at the camera; an
  orthographic ray (an orthographic camera, or a directional shadow pass) runs
  along view −Z through the fragment.
- **Shadows.** `cull_front` and `discard` make Godot compile this shader for the
  shadow pass too, rather than use the default shadow material. Stage 0 checks
  directional, spot and omni lights, and the pancaking clamp.
- **Antialiasing.** None for voxel edges. MSAA smooths only the box outline,
  and that is acceptable.
- **Faces and normals.** The DDA knows which face it crossed, so the normal is
  exact, without gradients. Face shading and AO, as the editor viewport bakes
  them, are optional later. AO can use the mesher's rule (two sides and a
  corner) from neighbor lookups at the hit.
- **Empty space.** Up to 64³, a plain DDA is likely enough. Later, add an
  occupancy volume at 4³ blocks, as Teardown does, built by the loader. Never use
  texture mipmaps for this.

### Godot addon

In the same addon as `MoxelSprite3D`, at `integrations/godot/addons/moxel`:

- **An import plugin** reads the volume manifest (below), its grayscale PNGs and
  its palette. It saves one resource holding the `ImageTexture3D`s
  (`FORMAT_R8`, no mipmaps), their offsets, the palette, the frames and the
  tags. The PNGs also open in Godot's own layered importer, for users without
  the addon.
- **A `MoxelVolume3D` node** (a `GeometryInstance3D` that owns a box mesh and a
  material). It has the same player API as `MoxelSprite3D`: `play(tag)`,
  `stop()`, `frame`, `speed_scale`, `frame_changed`, `animation_finished`,
  `palette`. Both nodes share one timing class, so holds, ping-pong and repeats
  behave the same.
- **Voxel access** on the node: `get_voxel(cell)`, `set_voxel(cell, index)`,
  `raycast(from, to)` returning the cell, face and index. Edits change the
  current frame's volume only, and re-upload it at most once per rendered frame.
- **Effects** as in three.js (stage 3): dissolve, cutaway, flash, glowing
  palette entries in the palette's alpha. Port `voxelHash` bit for bit (32-bit
  unsigned multiplies, the top 16 bits), so the same cells dissolve in both
  engines and in GDScript picking.
- **Requirements:** Godot 4.5 or later, Forward+; tested on 4.6 and 4.7, as
  the `.glb` addon is. Other renderers are not supported. The node could warn
  when the project uses one.

### three.js

`@voxeltoy/three` gets a `VoxelVolume`: a `Mesh` subclass whose geometry is a
box the size of the volume, drawn with `side: BackSide` so the camera can be
inside it. Sources were read at three.js r182, the version Voxeltoy uses.

- **A game runtime, not an editor part.** `VoxelVolume` depends only on
  three.js and on small DOM-free modules of `@voxeltoy/core` (the volume
  decoder and the DDA in `raycast.ts`), never on `Editor`, the viewport or the
  SDK. A game imports it into its own three.js scene, with its own renderer,
  lights and camera.
- **Data.** One R8 `Data3DTexture` (`RedFormat`, `UnsignedByteType`) for each
  distinct frame, read with `texelFetch`, and a 256×1 palette `DataTexture`.
  R8UI through a `usampler3D` would also work; R8 keeps the shader the same as
  the Godot one. The source can be a `.voxeltoy` composite from `@voxeltoy/core`
  (`editor.evaluate()` or a decoded file) or the volume export; neither needs a
  mesher.
- **Two shading modes.**
  - `lit`, the main mode for games: a `MeshStandardMaterial` (or Lambert)
    changed with `onBeforeCompile`. The march replaces the diffuse color, the
    normal and the view-space position that three.js lights with.
  - `flat`: unlit, with the editor's directional face shading computed from the
    face the DDA crossed, and optional AO from neighbor lookups by the mesher's
    rule. It looks like Voxeltoy's viewport, which also draws unlit. It is built
    first only because it is the smallest step that proves depth and speed;
    games with a stylized look can keep it.
- **Depth.** Write `gl_FragDepth` from `projectionMatrix * hitView`, mapped
  from NDC `[-1, 1]` to `[0, 1]` for the default depth buffer. three.js defines
  `USE_REVERSED_DEPTH_BUFFER` and `USE_LOGARITHMIC_DEPTH_BUFFER` in every
  program, so the shader handles those modes too.
- **Casting shadows.** three.js never runs an object's own material in a shadow
  map. It uses `object.customDepthMaterial`, or `customDistanceMaterial` for
  point lights, and otherwise a plain `MeshDepthMaterial` of the box. It also
  flips `BackSide` to `FrontSide` for shadows unless `material.shadowSide` is
  set. In r182 every shadow map is a hardware depth texture, point lights'
  cube maps included, so one depth-only march serves as both custom materials;
  no distance encoding is needed. `VoxelVolume` sets `shadowSide` to
  `BackSide`.
  ([WebGLShadowMap.js](https://github.com/mrdoob/three.js/blob/r182/src/renderers/webgl/WebGLShadowMap.js))
- **Back faces in shadow maps.** For a front-sided mesh, three.js draws the
  back faces into the shadow map, so a lit face is compared with the far side of
  its voxels and cannot shadow itself. The shadow march does the same: it keeps
  going through the first run of solid voxels and writes the depth where the
  ray leaves it. Writing the first face instead gave visible acne on every lit
  face (7.9% of pixels differed from the mesh under a sun; 0.2% after).
- **Receiving shadows.** three.js computes shadow-map coordinates in the vertex
  shader, from the vertex position
  ([shadowmap_vertex](https://github.com/mrdoob/three.js/blob/r182/src/renderers/shaders/ShaderChunk/shadowmap_vertex.glsl.js)).
  For a box proxy those are the box face's coordinates, not the voxel's. The
  `lit` material runs that same chunk in the fragment shader, at the hit, into
  arrays that stand in for the varyings.
- **Picking.** `VoxelVolume.raycast` overrides `Object3D.raycast`: it
  transforms the ray into cell space and runs the DDA from
  `@voxeltoy/core/raycast` over the CPU copy of the volume. A three.js
  `Raycaster` then returns the voxel, its face and its palette index, with the
  same answer as the shader.
- **Frames and edits.** Changing frame swaps the texture uniform and resizes
  the box to the volume's crop. An edit writes the CPU array and sets
  `needsUpdate`, which re-uploads the whole volume (256 KiB at 64³).
- **Player.** The same manifest and API as the proposed `VoxelSprite`: `play`,
  `stop`, `frame`, `speed`, `onFrame`, `setPalette`. Both share one timing
  module, which the Godot addon mirrors.
- **WebGPU later.** three.js WebGPU has `Texture3DNode` and a fragment depth
  output (`NodeMaterial.depthNode`), so a TSL version is possible. Start with
  WebGL 2, which is what Voxeltoy's viewport uses.
- **Desktop browsers only.** Phones are not a target. The mobile findings
  above would apply in full there: depth writes disable early rejection on
  tile-based GPUs. Games that must run on phones use the `.glb`.

The Godot shader is a hand port of the three.js one; the two languages are
close. Shared fixture volumes and reference images from three.js keep them in
step, and they make the format testable in CI without Godot.

## Relation to the `.glb` path

- **The `.glb` stays the default.** It runs everywhere, including phones and
  web builds, needs no plugin, has normal MSAA and early depth testing, and
  costs the same on any GPU. Most games only need to play the animation.
- **The voxel runtime is for games that need voxels at run time:** per-voxel
  effects, hits, edits, cutaways.
- **They share one manifest shape** (`fps`, `frames`, `tags`, `voxelsPerUnit`,
  palette) and one player API, so a game can change a node from
  `MoxelSprite3D` to `MoxelVolume3D` without changing the code that plays
  animations.
- **They don't share a mesher.** The runtime has no mesher, which keeps
  decision 5 of the export proposal intact: there is still one mesher, in
  Voxeltoy.
- **Matching the look.** A lit `.glb` and the ray-marched volume should look the
  same under the same lights, apart from aliasing at voxel edges. Stage 0 checks
  this by rendering both side by side.

## Changes to the export proposal

The slice sheet proposed in [animation-export.md](animation-export.md) serves two different
readers, and they need different files:

1. **Split it in two.**
   - A **colored slice sheet** (RGBA) for sprite stacking and for people: one
     strip of Y slices for each frame, bottom slice first. No standard layout
     exists; check the order against the Godot addons and MagicaVoxel's slice
     export. Indexed color is fine here, because nothing
     reads the index.
   - **Voxel volumes** for runtimes: palette indices, described below.
2. **Grayscale, not indexed.** A volume PNG is 8-bit grayscale (color type 0):
   value = palette index, 0 = empty. Write no `gAMA`, `sRGB`, `iCCP` or `cICP`
   chunks. Godot and browsers expand indexed PNGs to RGB, so the index would be
   lost.
3. **One PNG for each distinct frame,** not one sheet for the whole animation.
   One image becomes one `Texture3D` in Godot's importer, and per-frame files
   stay far below every 2D size limit. A single sheet of 128³ × 60 frames needs
   7680×16384 pixels.
4. **Z slices in a grid, in Voxeltoy's byte order.** Each cell of the grid is one Z
   slice: an `sx` × `sy` image, row = y, column = x. The cells run left to
   right, then top to bottom, z = 0 first; the grid has `ceil(sqrt(sz))`
   columns. Reading the cells in order gives exactly Voxeltoy's x-major layer bytes
   (`x + sx * (y + sy * z)`), which are also the slice order of a `Texture3D` of
   width `sx`, height `sy` and depth `sz`. No axis swap is needed anywhere. The
   cost: each slice appears upside down to a person, since image rows go down
   while y goes up. Spare cells at the end are empty; Godot's own importer
   keeps them as extra empty slices, which the shader never reaches.
5. **Crop and deduplicate.** Each volume is cropped to its content, and the
   manifest gives its offset. Frames refer to volumes by index.
6. **The palette is its own file:** the same 256×1 RGBA PNG as the `.glb`
   palette texture.
7. **A manifest, `volumes.json`,** shaped like the sequence manifest of the
   PNG frame exports (`formats/sequence.ts`), with `volumes` in place of images.
   This is what `formats/volumes.ts` writes:

   ```jsonc
   {
     "format": "voxeltoy-volumes",
     "version": 1,
     "name": "Knight",
     "fps": 12,
     "durationMs": 250,
     "size": [32, 48, 32],              // document grid
     "palette": "palette.png",
     "volumes": [
       // columns × rows of Z slices in the image
       { "file": "volume-01.png", "size": [20, 46, 12], "offset": [6, 0, 10], "columns": 4, "rows": 3 },
       { "file": "volume-02.png", "size": [22, 46, 12], "offset": [5, 0, 10], "columns": 4, "rows": 3 }
     ],
     "frames": [
       { "id": "…", "index": 0, "duration": 2, "startMs": 0, "durationMs": 166.67, "volume": 0 },
       { "id": "…", "index": 1, "duration": 1, "startMs": 166.67, "durationMs": 83.33, "volume": 1 }
     ]
   }
   ```

   Tags and `voxelsPerUnit` join it when the document and the `.glb` export
   have them, in the same shape as the `.glb` manifest.
8. **Package it as a zip named `.voxeltoyvol`**, "Voxel volumes" in the export
   menu. Godot chooses an importer by the file's last extension, so a `.zip`
   importer would claim every zip in a project. A runtime can also read the
   files unpacked, fetched next to `volumes.json`. A raw binary (`.bin` with zstd) or KTX2 `R8_UNORM` 3D textures can
   follow if PNG decoding turns out to be slow; three.js's `KTX2Loader` reads
   uncompressed `R8_UNORM` 3D textures, but not `R8_UINT`.

## Plan

three.js first. Each three.js stage produces the fixtures the Godot stages
check against.

| Stage | Deliverable | Exit evidence |
| --- | --- | --- |
| 0. three.js spike | `VoxelVolume` in `@voxeltoy/three`, `flat` mode only, rendering a static document's composite. A dev page that shows it beside today's mesh render of the same model, and next to ordinary meshes. | Depth is correct against other meshes, from outside and inside the box. With AO off, its image matches the mesh render apart from voxel-edge aliasing. `raycast` returns the same cell as `@voxeltoy/core`. Frame times are recorded in Chrome and Firefox for 1, 10 and 50 models at a quarter and the full screen, on a laptop with integrated graphics and a mid-range GPU, against the mesh. Decide whether to go ahead, fall back to instanced cubes, or stop. |
| 1. three.js lighting | `lit` mode: standard lighting at the hit, custom depth and distance materials, shadow lookups recomputed at the hit. | Casts and receives shadows from directional, spot and point lights, including self-shadowing between voxels. Matches a lit `.glb` of the same model under the same lights. |
| 2. Animation in three.js | Volume export ("Voxel volumes") with a decoder in `@voxeltoy/core`. `VoxelVolume` plays the manifest: tags, holds, ping-pong, palette swaps. A timing module shared with `VoxelSprite`. Needs the frame model (stage 2 of [animation.md](animation.md)); before that, a static model exports as one frame. | `bun test` round trip: exported and decoded bytes equal the document's. A tagged walk and attack play with correct timing and callbacks, the same as the `.glb` with `VoxelSprite`. |
| 3. Voxel features in three.js | Edits (`setVoxel`, boxes), dissolve, hit flash, emissive palette entries, a cutaway plane. | A small web game demo shoots voxels out of an animated character at a steady frame rate on integrated graphics. Effects and edits are covered by fixture images. |
| 4. Godot spike (done) | The shader ported to a Godot 4.7 Forward+ test project, with the stage 0–1 fixture volumes. | Godot's images match the three.js fixtures. Depth and shadows (directional, spot, omni) are correct, including the pancaking clamp. Frame times on a low-end target (proposed: a Steam Deck or a laptop with integrated graphics) and a mid-range GPU. The Forward+ prepass cost is measured. |
| 5. Godot node (done) | Import plugin, `MoxelVolume3D`, shared timing with `MoxelSprite3D`, palette swaps, `get_voxel`, `set_voxel`, `raycast`, the stage 3 effects. A docs page. | The stage 2 and 3 demos behave the same in Godot. Godot's own layered importer, set to Lossless with no mipmaps, gives the same bytes as the decoder. |
| 6. Scale | Occupancy blocks for empty-space skipping, the frame atlas for crowds. In both engines, only as measurements show the need. | Measured gains on 64³ and 128³ models, and on a crowd of 100 characters. |

Stage 0 needs no export format, no frame model and no Godot. Its result
decides whether the later stages happen at all.

## Implementation status

Stages 0 to 3 are built in three.js, and stages 4 and 5 in Godot. Not done:
three.js timings on real hardware, tags (the document has none yet), and
`MoxelSprite3D`, which belongs to the `.glb` path.

Stage 5 (Godot node), in `integrations/godot` (see its
[README](../integrations/godot/README.md)):

- **`MoxelVolumeAnimation`**, a resource: grid, fps, palette, each pose's
  voxels and place, and the frames. It builds each pose's 3D texture once and
  shares it between nodes. `load_file` reads a folder, zip or `.voxeltoyvol` at
  run time.
- **An import plugin** (`addons/moxel/plugin.cfg`) imports `.voxeltoyvol` files
  as that resource. The Voxeltoy export now writes `.voxeltoyvol`.
- **`MoxelTiming`**, Voxeltoy's frame clock in GDScript, for `MoxelVolume3D` now
  and `MoxelSprite3D` later.
- **`MoxelVolume3D`**, a `MeshInstance3D` that manages its own box, material
  and bounds: `play`, `pause`, `stop`, `frame`, `speed_scale`, `loop`,
  `autoplay`, `frame_changed`, `animation_finished`; `LIT` or `FLAT`
  lighting; `palette` swaps and `set_emission`; `dissolve`, `clip_plane` and
  `flash`; `get_voxel`, `set_voxel`, `fill_box`, `fill_sphere` (one pose or
  all), `get_voxel_count` and `raycast` in world space. Edits are copied on
  write, so the resource and other nodes keep their voxels. It is a `@tool`, so
  the editor shows the model.
- **The shooting gallery in Godot** (`demo/shooting_gallery.tscn`), ported
  from the three.js demo: eight lit critters with glowing eyes, picking,
  carving every pose, debris in a `MultiMesh`, dissolve and respawn. The
  spike's `demo` mode plays it with scripted shots: 3 hits threw 287 voxels,
  10 more knocked the critter out, and it came back whole.
- **`spike/tests.gd`**: 41 checks, all passing. The hash equals three.js's on
  sample cells; timing, reading, import, playback and signals, copy-on-write
  edits, fills across poses, picking through a moved and scaled node, dissolve,
  cutaway, palette swaps, emission and flash.
- **Godot's own 3D texture importer**, set to Lossless with no mipmaps and the
  manifest's columns and rows, gives exactly the decoder's bytes for every
  slice: the stage's exit check.
- The spike now renders through `MoxelVolume3D`; every comparison under stage
  4 gives the same numbers.

Stage 4 (Godot spike), in `integrations/godot`:

- `addons/moxel/voxel_volume.gdshaderinc` is the three.js shader ported to
  Godot's shading language, with the same march, depth, AO, hidden cells,
  effects and hash. `voxel_volume_flat.gdshader` (unshaded) and
  `voxel_volume.gdshader` (lit) use it. `moxel_volumes.gd` (`MoxelVolumes`)
  reads a voxel volumes export, folder or zip, into one `ImageTexture3D` per
  pose and a palette texture.
- `fixtures/make-fixtures.ts` writes the dev pages' two sample models as voxel
  volumes, and `views.json`: four camera setups. `spike/spike.gd` renders them
  in Godot (`views`), compares a lit volume with a mesh of the same voxels
  (`lit`), and times both (`perf`). `apps/web/dev/voxel-fixtures.html` renders
  the same views with three.js, and `spike/compare.ts` diffs the images.
- It runs headless under `xvfb-run`. The RTX 3070 works as it is; the AMD
  integrated GPU needs `MESA_VK_WSI_DEBUG=sw` to present without DRI3.

Results, Godot 4.7.2 and 4.6.1 (identical), Forward+, pixels that differ by
more than 3 of 255:

| Comparison | Differ |
| --- | --- |
| Godot against three.js, flat: perspective, cropped frame without AO, orthographic, camera inside the tunnel | 0.15%, 0.18%, 0.10%, 0.23% |
| Godot lit volume against Godot mesh, no shadows: sun, spot, omni | 0.004% each |
| The same with shadows: sun, spot, omni (cube) | 0.005%, 0.003%, 0.004% |
| The same, omni with dual-paraboloid shadows | 19% |
| The same, marching through solid in the shadow pass: sun, spot, omni (cube) | 0.28%, 0.98%, 1.9% |

What the spike found:

- **Godot draws front faces into shadow maps**, unlike three.js. The shadow
  pass therefore stops at the first face (`shadow_through_solid` off), which
  matches meshes; marching through the solid run does not. three.js keeps the
  through-solid march.
- **Dual-paraboloid omni shadows are wrong**, as the source reading predicted:
  that mode bends vertices in the vertex shader, which a written depth can't
  follow. Cube mode is correct. The node should switch omni lights to cube
  shadows, or warn.
- **A custom spatial shader does not get Burley diffuse** unless it asks for
  it: without `diffuse_burley`, the lit volume was 2–4% darker than a
  `StandardMaterial3D` mesh in direct light (it matched with Lambert on both).
  The lit shader now sets it, so a volume looks like an imported `.glb`.
- **Godot only lets `vertex()` write varyings**, not functions it calls, and
  not through `out` arguments. The include hands values back for `vertex()`
  to store.
- **A camera exactly in the plane of a box face broke three.js** in the
  software renderer: that face's vertices sit at w = 0, and its varyings came
  out wrong near the screen edges (29% of the tunnel view differed). Godot on
  the RTX 3070 was fine. Both engines now draw the box 0.0137 voxels larger on
  each side (`BOX_MARGIN`); the march still clips to the volume.
- **Cost** at 1920×1080 on the AMD Raphael integrated GPU (2 compute units,
  weaker than a Steam Deck), GPU time per frame, median of 240, critters lit by
  a sun with shadows:

  | Case | Mesh | Volume | Volume, no depth prepass |
  | --- | --- | --- | --- |
  | 1 small | 1.4 ms | 1.4 ms | 1.4 ms |
  | 10 | 1.2 ms | 2.2 ms | 2.3 ms |
  | 50 | 3.2 ms | 5.3 ms | 4.2 ms |
  | 1 filling the screen | 3.0 ms | 8.0 ms | 7.1 ms |

  Unlit, a volume filling the screen took 3.9 ms against 1.0 ms. The depth
  prepass marches a second time and costs about 1 ms in the larger cases; it
  is a project setting, so turning it off affects everything else too. The RTX
  3070's timings under Xvfb were not usable: it stayed at low clocks under this
  light load (one small flat volume took 2.8 ms there, 1.4 ms on the iGPU).

Not covered: the directional pancaking clamp, which needs a caster outside
the camera's view, and TAA.

Stage 3 (voxel features):

- **Dissolve:** `dissolve` (0 to 1) hides that share of voxels, chosen by a
  hash of each grid cell, so the same cells always go first and frames agree.
  `dissolveEdge` and `dissolveColor` make the next cells to go glow.
- **Cutaway:** `clipPlane`, a three.js `Plane` in grid space, hides the voxels
  on its positive side. The ray carries on, so the model looks solid inside.
- Dissolved and cut voxels are hidden in one place in the shader, so they
  also cast no shadow and add no AO. `isHidden(x, y, z)` and `voxelHash` give
  the same answer on the CPU, and `raycast` skips hidden voxels.
- **Hit flash:** `flash(cell, { color, radius, duration })` lights up the
  voxels around a cell and fades out as `update` runs, even while paused.
- **Glowing palette entries:** `setEmission(index, 0…1)` keeps the strength in
  the palette texture's alpha. Lit, it adds the color as emission, times
  `emissiveIntensity`; flat, the voxel ignores face shading and AO. Glow and
  flash add to three.js's emissive term in lit lighting.
- **Edits:** `fillBox(min, max, value)` and `fillSphere(center, radius, value)`
  in grid coordinates, one upload per changed pose. With `{ allFrames: true }`
  they change every pose: the same grid cells, which suits parts that hold
  still.
- **The dev page** has Dissolve and Cutaway sliders, a Glow toggle, a flash on
  every tap, and **Check picking**: it draws the volumes alone and casts a ray
  through every second pixel. With and without dissolve and a cutaway, at most
  0.04% of covered samples disagree, all on voxel edges.
- **A game demo**, `apps/web/dev/voxel-game.html`: eight lit critters walk
  around an arena with glowing eyes. A tap carves a sphere out of every pose
  with `fillSphere`, throws the removed voxels as instanced debris, and
  flashes the hit. A critter that loses 40% of its voxels dissolves, then
  dissolves back in elsewhere.

Not done from the stage's exit evidence: the frame rate on integrated
graphics, and image fixtures, which need a GPU in CI. The picking check and
unit tests cover the effects' logic instead.

A dev-page bug, fixed in stage 3: offscreen renders for the image diff called
`setViewport` after binding the render target, so three.js scaled the
viewport by the pixel ratio (2) and drew a quarter of the view at twice the
size. Both sides were drawn the same way, so the comparisons below were fair,
but over that quarter only. Over the full view, on the bouncing sample:

| Shading | Pixels that differ from the mesh by more than 3 of 255 |
| --- | --- |
| Flat, faces, AO off | 0.11% |
| Flat, faces and AO | 0.85% |
| Lit sun / spot / lamp, AO off | 0.15% / 0.12% / 0.18% |

Voxels are smaller on screen than in the zoomed quarter, so edges, where the
ray and the rasterizer disagree, are a larger share of the pixels.

Stage 2 (animation):

- `@voxeltoy/core/formats/volumes`: `toVoxelAnimation` crops every frame and
  keeps each distinct pose once; `writeVolumes` and `readVolumes` (or
  `readVolumesZip`) write and read the files described under
  [changes to the export proposal](#changes-to-the-export-proposal). A small
  PNG codec (`formats/png.ts`, 8-bit gray and RGBA, every row filter) and a zip
  reader (`readZip`, stored and deflated) support it, with deflate from the
  web-standard `CompressionStream`, so core stays DOM-free.
- **Export › Voxel volumes (.voxeltoyvol)** writes every frame of the document
  (named `.zip` until stage 5). It sits
  with the animation exports when there are frames, and with the others when
  there is one.
- `VoxelVolume.fromAnimation(animation)` plays one: a texture and a box for each
  distinct pose, placed by a `uOffset` uniform. `play()`, `pause()`, `frame`,
  `time`, `speed`, `loop`, and `update(seconds)` from the render loop; `frame`
  and `finished` events. `getVoxel`, `setVoxel` and `raycast` stay in document
  coordinates. An edit changes the pose on show, so every frame that shares it.
  `loadVoxelAnimation(url)` reads the zip, or `volumes.json` with its files
  beside it.
- The dev page sends the document's frames, or a bouncing sample, through a
  real export and read, zip included, and plays them beside a mesh of each
  pose. Each pose differs from its mesh by under 0.03% of pixels.

Stage 1 (lighting):

- `lighting: "lit"` swaps in `VoxelStandardMaterial`, a `MeshStandardMaterial`
  patched in `onBeforeCompile`. Its color multiplies the palette, and its
  roughness, metalness and emissive work as usual. AO darkens indirect light
  only. `lighting` can change at any time.
- Casts and receives shadows from directional, spot and point lights, as
  described under [three.js](#threejs), including onto itself.
- The dev page has Flat and Lit, and a sun, a spot and a lamp, all casting
  shadows onto the model, a floor and a pole.

Lit, AO off, against a `MeshStandardMaterial` mesh of the same voxels (over a
quarter of the view at 2×; see stage 3):

| Light | Pixels that differ by more than 3 of 255 |
| --- | --- |
| Sun (directional) | 0.21%; 0.24% orthographic; 0.34% with 10 models |
| Spot | 0.15% |
| Lamp (point, cube shadow map) | 0.19% |

About half of the differing pixels are darker on each side, so they are edge
noise rather than a bias. With the model casting only, or receiving only,
0.13–0.15% differ.

Stage 0:

- `VoxelVolume` (`packages/three/src/voxel-volume.ts`): `flat` mode with face
  shading and AO, depth for the default, reversed and logarithmic depth
  buffers, perspective and orthographic cameras, a camera inside the box,
  `setVolume`, `setVoxel` and `setPalette`, and a `raycast` that returns the
  voxel through `@voxeltoy/core`'s DDA. Unit tests cover picking, edits and
  sizes.
- A dev page, `apps/web/dev/voxel-volume.html` (run `pnpm dev:app`, open
  `/dev/voxel-volume.html`). It shows the autosaved document, or a sample
  with `?sample`, as a mesh and as a volume side by side, with a floor and a
  pole cutting through it. It diffs the two images, times frames (with the GPU
  timer where the browser offers it), draws 1, 10 or 50 copies, and removes the
  voxel you tap.

Measured on the 32³ sample, perspective and orthographic, in a software
renderer (SwiftShader), over a quarter of the view at 2× (see stage 3):

| Shading | Pixels that differ from the mesh by more than 3 of 255 |
| --- | --- |
| None | 0.009% |
| Faces | 0.017–0.024% |
| Faces and AO | 0.18–0.23% |

The differences are single pixels on voxel edges, where the rasterizer and
the ray choose different sides. AO differs more, because the shader blends the
four corner values bilinearly while the mesh interpolates them across two
triangles. Depth against the floor and the pole, and the view from inside the
box, match the mesh. With 50 small copies, 1.9% of pixels differ: at that
distance most voxel edges are smaller than a pixel.

Still to do for stages 0 to 3: frame times on real GPUs (a laptop with
integrated graphics and a mid-range GPU, in Chrome and Firefox), flat and lit.
The software renderer's timings mean nothing.

## Decisions

Decided October 28, 2026:

1. **three.js first, as a runtime for web games.** `VoxelVolume` in
   `@voxeltoy/three` is built and proven before the Godot port. It targets
   desktop browsers; phones are not a target in either engine.
2. **Godot: desktop, Forward+.** The Godot runtime targets desktop games (Steam,
   itch.io) on Godot's Forward+ renderer. Mobile and Compatibility, including web
   export, are not supported. Games that need those use the `.glb`.
3. **Voxel edges stay aliased.** No supersampling or edge coverage.
4. **No transparent voxels.**
5. **Voxeltoy's own viewport is out of scope** for now; see [later](#later).
6. **Volumes use Voxeltoy's byte order** (Z slices of x-by-y images). The bytes
   are the texture, in Voxeltoy, three.js and Godot, with no axis swap or row flip
   at export or load. Slices look upside down to a person; that is accepted.

Proposed, not yet agreed:

7. **Ray-marching is the first approach**, with instanced cubes as the fallback
   if stage 0 is too slow on the low-end target.
8. **The runtime complements the `.glb` path.** The `.glb` stays the default
   engine format.
9. **The slice sheet is split** into a colored sheet for people and sprite
   stacking, and grayscale per-frame volumes for runtimes, as described above.
10. **Godot 4.5 is the minimum** for the runtime, because the shadow pass needs
    `IN_SHADOW_PASS`.
11. **No run-time mesher.** Physics uses simple shapes; voxel hits use the CPU
    DDA.
12. **The low-end performance target** is a Steam Deck or a laptop with
    integrated graphics, at 1080p.
13. **The spike is unlit** (`flat` mode), to prove depth and speed with the
    least code. Lighting and shadows (`lit` mode) follow straight after, before
    animation, because games need them.

## Open questions

- **Is it fast enough on the low-end target?** In Godot, on an integrated GPU
  weaker than a Steam Deck, yes for a handful of characters and for 50 small
  ones (about 5 ms at 1080p); one filling the screen takes 8 ms, about 2.7
  times a mesh. three.js on real hardware is still unmeasured. Should the node
  switch to the `.glb` mesh at a distance, or when close?
- **The Forward+ depth prepass marches twice**, about 1 ms of the 8 above. It
  is a project setting; can a material avoid it without losing its depth?
- **The directional pancaking clamp** is untested: a volume outside the view
  that casts into it. Dual-paraboloid omni shadows are confirmed wrong (stage
  4); the node should use cube shadows.
- **TAA ghosting.** Motion vectors come from the box, not the hit. How visible
  is that in Forward+ with TAA or FSR2?
- **Godot web builds.** Godot exports browser games only through
  Compatibility, which decision 2 leaves to the `.glb`. Browser games that want
  voxels can use the three.js runtime instead. Is that split enough?

## Later

- **Ray-marching in Voxeltoy's own viewport.** Once the three.js `VoxelVolume`
  exists, the editor could draw onion skins, playback frames or large models by
  ray-marching instead of meshing. Revisit after stage 3.
