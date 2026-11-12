# Voxeltoy — agent guide

Voxeltoy is a minimal voxel editor in the browser. Think tldraw's simplicity (UI _and_ API)
with Qubicle's voxel tools.

## Tenets

1. **Touch first, mouse equal.** Every feature must work with one finger on a phone. Never
   ship something that needs hover, right-click, a keyboard modifier or a scroll wheel. Those
   are fine as _shortcuts_ to things that also have a tappable path.
   - Standalone buttons are at least 40px (44px on `pointer: coarse`); use `var(--hit)`. List rows
     use `var(--row)` (28/36px) and buttons inside a row `var(--hit-inline)` (24/32px), at most one
     at rest per row (see `docs/shapes.md`, Layers panel › Sizes).
   - Use pointer events, never mouse/touch events. The canvas is `touch-action: none`.
   - One finger on the model uses the tool; on empty space it orbits. Two fingers
     pinch-zoom and pan, and a second finger cancels (reverts) a stroke the first one started.
   - Gate hover-only styles behind `@media (hover: hover)`.
   - Check every UI change at phone width (≤ 640px, "compact" mode) as well as desktop.
2. **Minimal and calm.** Floating, rounded, softly shadowed panels over a full-bleed canvas.
   Few controls, short labels, no chrome. If a feature needs a new panel, it probably wants
   to be a menu item instead.
3. **Simple API.** All document and editing state lives in the headless `Editor`
   (`packages/core/src/editor.ts`), a session on its `VoxelDocument` (`editor.doc`). The UI only reads its reactive getters and calls its methods.
   Anything the UI can do, a script can do with `window.editor`.
4. **Everything undoable** that changes the document (voxels, layers, markers, origin, palette, size, name), and the
   selection (it is not saved in files). UI state (tool, color, mirror, slice, layer
   visibility/lock) is not.
5. **Local and file-based.** The document autosaves to `localStorage`; files are the
   interchange (`.voxeltoy`, legacy `.moxel`, MagicaVoxel `.vox`, `.glb`, `.png`, common palette formats).

## Layout

A pnpm workspace. Packages depend only on packages above them in this list; apps use packages.

```
packages/
  mesher/                 @voxeltoy/mesher: AssemblyScript mesher (wasm). Flat-memory API, no objects across the boundary.
    src/assembly/index.ts mesh(): greedy faces + baked face shading and vertex AO
  core/src/               @voxeltoy/core: the headless, DOM-free editor
    document.ts           VoxelDocument: the data (layers, palette, frames, size), its op target, load/save, evaluation, change events
    editor.ts             Editor: an editing session on a document: tools, history, selection, layers, mirror, slice, composite volume
    editor-*.ts           the session's parts, reached through `EditorInternals`: frames, shapes, extrusion, floating content
    ops.ts                document ops: every shared change as data; apply (checked) and invert
    history.ts            undo entries of ops and local selection changes; conditional undo for shared work
    library.ts            LibraryEditor: a library's models and scenes, one open at a time, one history across all of it and every model's Editor
    scene-ops.ts          scene ops (instances, attachment, settings, models, stage): apply (checked) and invert
    scene-kinds.ts        host instance kinds, fields and settings resolved against defaults
    scene-math.ts         quaternions, Euler degrees, matrices for scene transforms
    scene-agent-tools.ts  WebMCP tools for scenes
    animation.ts          frame animation timing: ticks, fps, the frame showing at an elapsed time
    spatial-brush.ts      a brush at a point in voxel space, empty space included (`editor.spatial`): the headset's tip, scripts
    tools.ts              pointer rays -> edits (add/erase/paint/select × voxel/box/face/shape, fill, pick, move, extrude, gizmo)
    selection.ts          selection masks and floating (lifted) content: combine, grow, flood, rotate, flip
    source.ts             shape layers: step stacks (shape + mode + color) in source space, validation, source <-> output-grid conversion
    evaluate.ts           the evaluator: shape steps + raster/override layers -> one dense volume; resolution resampling
    shapes.ts             shapes inscribed in a box + orientation (prism, sphere, capsule, wedge, diamond, torus, limb; presets such as box, cylinder, cone, arch): `insideShape`, shared by the brush and shape steps; settings handles
    extrude.ts            extrude tool: face regions, pulled-out and carved cells
    markers.ts            markers (named points and volumes, keyed per frame) and the model origin: checks, placement per frame, axes
    effects.ts            layer and group effects (mirror, outline, hollow, noise): checks and application to a stage's content
    raycast.ts            DDA voxel traversal, plane picking
    render.ts             software renderer: shaded shots of a volume (mesher-matching face shade + AO) without a GPU, tiled by view and frame
    palette.ts            built-in palettes; GPL/HEX/PAL/TXT/ACT/ASE/image parsers and writers
    formats/              .voxeltoy (JSON + RLE; `"format": "voxeltoy"`, legacy `"moxel"` still reads; version 4 is a library of models and scenes), .vox, frame sequences and sheets, voxel volumes; small zip and PNG codecs
    agent-tools.ts        WebMCP tools for browser agents: validated wrappers over the Editor, JSON results
  cli/src/                @voxeltoy/cli: the `voxeltoy` command (Bun; `moxel` is an alias for one step): info, convert, new, render, and `voxeltoy mcp`, the agent tools over stdio MCP on an open library (model, library and scene tools) with file and render tools under a root folder
  sync/src/               @voxeltoy/sync (private): live rooms, DOM-free: protocol (wire format), room (authority + host), client (sync), harness
  three/src/              @voxeltoy/three: viewport, input gestures, transform gizmo, orbit camera, wasm mesher wrapper, glTF export, `VoxelVolume` (ray-marched voxels, no mesh)
    scene-layer.ts        a scene's instances in a Viewport: meshes, ground, selection, gizmo, picking, drags onto surfaces, playback
    field-handles.ts      handles from a host kind's fields: points, paths, sizes, radii, refs
    scene-export.ts       a scene as glTF: nodes per instance and marker, shared meshes, settings in extras
    marker-export.ts      markers as named empty glTF nodes with `extras.voxeltoy` (`extras.moxel` still reads)
  xr/src/                 @voxeltoy/xr: a toolkit for headset (WebXR) UIs, editor-free: shell, hands, a router (one focus and capture per hand), panels in millimetres, windows, menus; see `docs/xr.md`
    editor/               Voxeltoy's headset view on it, loaded when opened: the brush (tip, ray, box), holding the model, life size, palette, menu/layers/timeline windows; on a scene's stage, its objects (Move, the Objects window). Hosts add theirs through `EditorHost.headset`
  sdk/src/                @voxeltoy/sdk: the embeddable editor. Solid components; actions.ts is the single list of commands + shortcuts
    menus.ts              the menus as data (main, layer, group, frame), shared by the page and the headset; `command()` makes an item from an action
    editor-view.tsx       EditorView: the whole editor UI; `EditorHost` (context.ts) is how an app adds commands, menu items, buttons and dialogs
    mount.tsx             mountEditor(): the same, for hosts that don't use Solid
    files.ts              browser file pickers, downloads, open/save/export
    library-view.tsx      LibraryView: the library, a model on its own, a scene (tree, instance bar, add and snap) and models gone into; `LibraryHost` is how an app adds kinds and hooks
    library-files.ts      open and save a library, import files into it, export a model
    inspector.tsx         a selected instance's settings, a control per field of its kind
apps/
  web/                    the Voxeltoy website: autosave, sharing, PWA, WebMCP. Plugs into the SDK through an EditorHost
    src/session.ts        local draft vs shared snapshot vs live room; share links, owner keys, room socket
    src/webmcp.ts         registers the agent tools with `document.modelContext` when the browser has it
    src/library-store.ts  the library on this device, in IndexedDB (the old model draft becomes its primary on first start)
    dev/example-kinds.ts  example host kinds, for reference only (the app has none): how a host gives scenes its objects
  worker/                 Cloudflare Worker: /api for snapshots and live rooms (one Durable Object each)
integrations/
  godot/                  Godot 4 project: addons/moxel (voxel runtime shaders, MoxelVolume loader; class names stay); spike/ and fixtures/ check it against three.js
```

Data model: each layer is a `Uint8Array` (x-major, `x + sx * (y + sy * z)`); `0` is empty,
otherwise an index into `palette` (`palette[0]` is reserved). Y is up. The selection is a mask of
the same shape; content edits only touch selected cells while anything is selected. See
`docs/selection.md` and `docs/extrusion.md`. Where voxels land with nothing to build on is the workplane, which is also the slice; see `docs/workplane.md`. 2D mode (`editor.mode2D`) edits a projection along it; see `docs/2d-mode.md`. A layer can instead be a shape
layer (`shape`: a stack of steps that are evaluated, with an empty `data`) or an override layer (`coverage`:
a covered 0 erases what is below), and the document has an output `resolution`; read voxels through
`editor.evaluate()` / `layerValues()` rather than `layer.data`. See `docs/vector-raster.md`. Layers are stages of one evaluation
pipeline (`evaluate.ts`: content and a blend per stage; layers can have a blend, a mask and effects, and sit in groups,
which are isolated stages). Beside the voxels, a model has markers (named points and volumes:
mounts, colliders, hitboxes, in source units, optionally keyed per frame) and an `origin`; a rigged character is a scene of
part models attached to each other's markers. See `docs/pipeline.md`. A document can be a flipbook of frames, each with every
raster layer's voxels; `layer.data` is the open frame's, and other frames are read with
`editor.frameCel()` / `evaluateFrame()`; see `docs/animation.md`. A scene (`SceneEditor`) places instances of
embedded models freely, each model with its own `Editor` writing to the scene's one history; documents carry a
`docId`, `revision` and host data; see `docs/scenes.md`.

## Commands

- `pnpm install`
- `pnpm dev` — builds the wasm, then starts Vite on :4321 (also on your LAN for phone testing)
  and the sharing API in Wrangler on :8787 (Vite proxies `/api`); `pnpm dev:app` is Vite alone
- `pnpm test` — editor/format tests (`bun test`) and mesher tests
- `pnpm typecheck`, `pnpm build`
- Headset view: `?xr=emulate` on the dev server emulates a Quest; on a real one, see `docs/xr.md`
- `pnpm voxeltoy <command>` — the CLI from source (`pnpm moxel` is the same command); `pnpm --filter @voxeltoy/cli compile` builds a standalone `voxeltoy` binary

After changing `packages/mesher/src/assembly/index.ts`, run `pnpm build:wasm` (the dev script does
it on start). Build output in `packages/mesher/build/` is gitignored.

## Conventions

- Add commands to `packages/sdk/src/actions.ts` so menus, buttons and shortcuts stay in sync, and list new
  shortcuts in the shortcuts dialog. An action that needs more than the editor (a file picker, a dialog,
  markers drawn) says so in `needs`, so the headset view leaves it out.
- Mutate the document only inside `editor.transact(...)` / strokes so changes land in history.
  Structural changes go through a document op (`ops.ts`), never by swapping layer or palette
  arrays, so they can be shared, undone and checked. See `docs/collaboration.md`.
- Keep `@voxeltoy/core` DOM-free so it stays testable with `bun test`. Nothing in `packages/` imports from `apps/`;
  app features reach the SDK through `EditorHost`.
- When an editing capability is added, consider exposing it to agents in `agent-tools.ts`. Tools change the
  document as one undo step each and throw an `Error` with a reason the agent can act on.
