import { readMigratedKey } from "@voxeltoy/core/migrate-key";
import { createEffect, createRoot, createSignal, untrack } from "solid-js";
import {
  BoxGeometry,
  BufferGeometry,
  EdgesGeometry,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
} from "three";
import type { Editor } from "@voxeltoy/core/editor";
import type { LibraryEditor } from "@voxeltoy/core/library";
import { raycastVolume } from "@voxeltoy/core/raycast";
import type { Vec3 } from "@voxeltoy/core/types";
import { Mesher } from "@voxeltoy/three/mesher";
import type { XRHand } from "../input";
import type { MenuNeed, XRMenuItem, XRMenus } from "../menu";
import { startXR, type FrameInfo, type XRShell } from "../shell";
import type { XRMode } from "../support";
import { around, XRWindow, type Viewer } from "../windows";
import { tabletop } from "../workspace";
import { Palette, type XRSwatch } from "./palette";
import { cellBox, lifeSize, standOn, turnAbout, workspaceYaw, type CellOp, type XRReach, type XRTool } from "./reach";
import { SceneView } from "./scene";
import { BoxDraw, ModelHandles, RayStroke, Stroke, VoxelTool } from "./tools";
import { layersView, menuView, objectsView, timelineView, type ViewContext, type WindowView } from "./views";

export type { MenuNeed, XRMenuItem, XRMenus } from "../menu";
export type { XRSwatch } from "./palette";
export type { XRReach, XRTool } from "./reach";

export interface XROptions {
  editor: Editor;
  /** The model's mesh from another view of the same editor (`Viewport.modelGeometry`); without it the session meshes the model itself. */
  modelGeometry?: () => BufferGeometry;
  /** The host's menus, for the windows: the main menu, a layer's options, the frame commands. */
  menus?: XRMenus;
  /** What the headset view can do of what menu items need (`MenuNeed`): items needing more stay on the page. None by default. */
  supports?: readonly MenuNeed[];
  /** Defaults to what `xrMode` finds. */
  mode?: XRMode;
  /** Once the session is over, however it ended. */
  onEnd?: () => void;
  /**
   * The library whose open scene has this editor's model as its stage (a level whose stage is its
   * course): its objects show about the model, and Move picks them up, puts them down and adds
   * more from the Objects window.
   */
  library?: LibraryEditor;
  /** The colors the palette offers, in place of the model's palette: a host's named blocks. Read as it draws, so it can follow the layer. */
  swatches?: () => readonly XRSwatch[];
  /** The tools the palette offers now (Add, Erase, Paint, and Move with a library), read as it draws: a layer that only holds objects offers Move alone. All by default. */
  tools?: () => readonly XRTool[];
  /** Metres a cell is at life size: the palette gets Life, which stands you on the model at that size. */
  lifeSize?: number;
  /** The host's own additions once the view is up (its objects in voxel space, its targets and windows); what it returns runs when the view ends. */
  extend?: (view: XRView) => void | (() => void);
}

/** Most cells a brush preview shows (a 16-cell ball is about 2,100). */
const MAX_GHOST = 4096;
/** The thumbstick past this changes the brush size or turns, once per push. */
const STICK = 0.6;
/** A thumbstick pushed left or right turns the model about you by this much. */
const SNAP_TURN = Math.PI / 6;
/**
 * A ray points at windows from a hand at least this far from the model's grid (metres; once
 * pointing, until `MODEL_CLEAR_LEAVE`), or at a window nearer than `RAY_NEAR`: by the model, the
 * hand draws, though windows are behind it.
 */
const MODEL_CLEAR = 0.12;
const MODEL_CLEAR_LEAVE = 0.08;
const RAY_NEAR = 0.6;
/** Where the palette hand's choice is kept, on this device. */
const SIDE_KEY = "voxeltoy.xr.paletteHand";
const LEGACY_SIDE_KEY = "moxel.xr.paletteHand";
/** Where how the drawing hand reaches is kept, on this device. */
const REACH_KEY = "voxeltoy.xr.reach";
const LEGACY_REACH_KEY = "moxel.xr.reach";
/** Which windows are open, kept on this device. */
const WINDOWS_KEY = "voxeltoy.xr.windows";
const LEGACY_WINDOWS_KEY = "moxel.xr.windows";

function readDevice(key: string, legacy: string): string | null {
  try {
    return readMigratedKey(
      (k) => localStorage.getItem(k),
      (k, value) => localStorage.setItem(k, value),
      (k) => localStorage.removeItem(k),
      key,
      legacy,
    );
  } catch {
    return null;
  }
}

type WindowId = "menu" | "layers" | "timeline" | "objects";

/**
 * Edit the editor's model in a headset (WebXR). The model floats in front of you in passthrough
 * (or a dark room without it). With controllers: grip to hold it, both grips to turn and scale it
 * (shrink it to a toy, or grow it until you stand inside), trigger to draw: with the brush tip
 * anywhere in its grid, empty space included, along the ray on the face it points at, or a box
 * from the tip. With hands: pinch with the drawing hand to draw, with the palette hand to hold,
 * with both to turn and scale. The palette on the palette hand picks the tool, how it reaches,
 * the color and brush size; the menu, the layers and the timeline (and for a scene's stage, its
 * objects) are windows in the room, moved by their frames. Push them, or point at them and pinch.
 *
 * Built on the headset toolkit (`XRShell`): every edit goes through the editor (and the library,
 * for a scene's objects), so it is undoable and shows in the page's own view of the model.
 * Resolves once the session has started; `end()` leaves it.
 */
export async function enterXR(options: XROptions): Promise<XRView> {
  readDevice(WINDOWS_KEY, LEGACY_WINDOWS_KEY);
  const shell = await startXR({ mode: options.mode, colors: "baked", windowsKey: WINDOWS_KEY });
  return new XRView(shell, options);
}

export class XRView {
  /** The model and everything in voxel space, as placed in the room. */
  private workspace = new Group();
  /** Voxel space: cell (x, y, z) spans [x, x + 1). The workspace's origin is the grid's base center. */
  private voxels = new Group();
  private model = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ vertexColors: true }));
  private bounds = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
  /** The turntable: a ring under the model, in voxel units about its base center. */
  private ring = new LineLoop(new BufferGeometry(), new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
  /** A box being drawn, in voxel units. */
  private boxGhost = new Mesh(
    new BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5),
    new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false }),
  );
  private handles: ModelHandles;
  private tool: VoxelTool;
  private palette: Palette;
  /** The library scene about the model, when it is a scene's stage. */
  private scene: SceneView | null = null;
  private brushes: { tip: Mesh; ghost: InstancedMesh; key: string; buttons: boolean[]; stick: number; turn: number }[] = [];
  private views = {} as Record<WindowId, WindowView>;
  private mesher: Mesher | null = null;
  private place = true;
  private disposeRoot: () => void = () => {};
  /** The hand the palette rides on; the other draws. Left for the right-handed. */
  private paletteSide: "left" | "right" = readSide();
  private reachSignal = createSignal<XRReach>(readReach());
  private lifeSignal = createSignal(false);
  private stats = { frames: 0, cpu: 0, since: 0, start: 0 };

  constructor(
    readonly shell: XRShell,
    private options: XROptions,
  ) {
    const { editor, library } = options;
    const { router, scene, windows } = shell;
    this.workspace.matrixAutoUpdate = false;
    this.workspace.add(this.voxels);
    this.boxGhost.visible = false;
    this.voxels.add(this.model, this.bounds, this.ring, this.boxGhost);
    scene.add(this.workspace);
    // a shared model mesh belongs to the view that built it
    this.model.userData.shared = !!options.modelGeometry;

    // the scene's objects, when the model is its stage (not one opened in place, nor alone)
    const stage = library ? untrack(() => library.stage) : null;
    if (library && stage && untrack(() => library.modelOfEditor(editor)) === stage && !untrack(() => library.open)) {
      this.scene = new SceneView(library, stage, {
        router,
        moving: () => untrack(() => this.currentTool()) === "move",
        isPaletteHand: (hand) => hand === this.palette.on,
        notify: (message) => this.notify(message),
      });
      this.voxels.add(this.scene.group);
    }

    this.handles = new ModelHandles(this.workspace, router);
    this.tool = new VoxelTool(editor, router, this.handles, this.voxels, {
      op: () => untrack(() => this.op()),
      reach: () => untrack(() => this.reachSignal[0]()),
      isPaletteHand: (hand) => hand === this.palette.on,
    });
    this.palette = new Palette({
      editor,
      windows,
      windowButtons: [
        { id: "menu", label: "Menu" },
        { id: "layers", label: "Layers" },
        { id: "timeline", label: this.scene ? "Frames" : "Timeline" },
        ...(this.scene ? [{ id: "objects", label: "Objects" }] : []),
      ],
      fit: () => this.fit(),
      colorSpace: shell.panelColorSpace,
      tools: () => this.offered(),
      tool: () => this.currentTool(),
      setTool: (tool) => this.setTool(tool),
      reach: () => this.reachSignal[0](),
      setReach: (reach) => this.setReach(reach),
      swatches: () => options.swatches?.() ?? editor.palette.slice(1).map((color, i) => ({ value: i + 1, color, label: `Color ${i + 1}` })),
      life: options.lifeSize ? { on: () => this.lifeSignal[0](), toggle: () => this.toggleLife() } : undefined,
    });
    router.add(this.handles.ring);
    router.add(this.palette.target);
    if (this.scene) router.add(this.scene);
    router.add(this.tool);
    // by the model, a hand draws though a window is behind it: rays reach windows from a hand clear of the grid, or a window near
    router.allow = (hand, hit, focused) =>
      hit.reach !== "ray" || !(hit.target instanceof XRWindow) || hit.distance <= RAY_NEAR || this.tool.fromModel(hand) > (focused ? MODEL_CLEAR_LEAVE : MODEL_CLEAR);
    for (let i = 0; i < shell.hands.length; i++) this.brushes.push(this.makeBrush());
    this.makeWindows();

    shell.onConnect((hand) => {
      // the palette rides on the palette hand (or the only one)
      if (hand.handedness === this.paletteSide || (!this.palette.on && hand.handedness === "none")) this.palette.attach(hand);
    });
    shell.onFrame((info) => this.beforeInput(info), { beforeInput: true });
    shell.onFrame((info) => this.afterInput(info));
    shell.onEnd(() => this.cleanup());

    createRoot((dispose) => {
      this.disposeRoot = dispose;
      createEffect(() => {
        const size = editor.size;
        this.voxels.position.set(-size[0] / 2, 0, -size[2] / 2);
        this.bounds.geometry.dispose();
        this.bounds.geometry = new EdgesGeometry(new BoxGeometry(...size).translate(size[0] / 2, size[1] / 2, size[2] / 2));
        // around the grid's footprint, with a little room
        this.handles.ringRadius = Math.hypot(size[0], size[2]) / 2 + Math.max(1, Math.max(...size) * 0.06);
        const points = Array.from({ length: 128 }, (_, i) => {
          const a = (i / 128) * Math.PI * 2;
          return new Vector3(size[0] / 2 + Math.cos(a) * this.handles.ringRadius, 0, size[2] / 2 + Math.sin(a) * this.handles.ringRadius);
        });
        this.ring.geometry.dispose();
        this.ring.geometry = new BufferGeometry().setFromPoints(points);
      });
      if (!options.modelGeometry) {
        this.mesher = new Mesher();
        createEffect(() => {
          editor.geometryVersion;
          editor.palette;
          this.remesh();
        });
      }
      // each panel draws again when what it shows changes (and only uploads when it looks different)
      createEffect(() => this.palette.panel.redraw());
      for (const win of windows.all) createEffect(() => win.panel.redraw());
      createEffect(() => {
        editor.tool;
        editor.color;
        editor.palette;
        editor.spatial.size;
        this.reachSignal[0]();
        for (const b of this.brushes) b.key = "";
      });
      // the page's notices (a locked layer, nothing selected) show on the palette
      createEffect(() => {
        const toast = editor.toast;
        if (toast) this.palette.notify(toast.message);
      });
      if (library) {
        createEffect(() => {
          const toast = library.toast;
          if (toast) this.palette.notify(toast.message);
        });
      }
      // a tool that can't place takes back placing
      createEffect(() => {
        if (this.currentTool() !== "move" && untrack(() => this.scene?.placing)) this.scene?.setPlacing(null);
      });
    });
    windows.onChange(() => this.palette.panel.redraw());

    const undo = options.extend?.(this);
    if (undo) shell.onEnd(undo);
  }

  /** Voxel space, as placed in the room: cell (x, y, z) spans [x, x + 1). A host's own objects about the model go in it. */
  get voxelSpace(): Group {
    return this.voxels;
  }

  /** Show `message` on the palette for a moment. */
  notify(message: string) {
    this.palette.notify(message);
  }

  /** Leave the headset view. */
  end() {
    this.shell.end();
  }

  /** Put the model back on the table in front of you, at its starting size. */
  fit() {
    this.place = true;
    this.lifeSignal[1](false);
  }

  /**
   * Stand on the model at life size (`XROptions.lifeSize` metres a cell), where you look: the top of
   * the column there comes under your feet, turned as it was. Again, back on the table.
   */
  toggleLife() {
    const size = this.options.lifeSize;
    const viewer = this.shell.viewer();
    if (!size || !viewer) return;
    if (untrack(() => this.lifeSignal[0]())) return this.fit();
    const { editor } = this.options;
    const grid = untrack(() => editor.size);
    const composite = editor.composite;
    const solid = (i: number) => composite[i] !== 0;
    const inv = this.voxels.matrixWorld.clone().invert();
    const o = viewer.eyes.clone().applyMatrix4(inv);
    const d = viewer.forward.clone().transformDirection(inv);
    const hit = raycastVolume({ origin: [o.x, o.y, o.z], dir: [d.x, d.y, d.z] }, grid, solid);
    const from: Vec3 = hit ? hit.cell : [Math.floor(grid[0] / 2), grid[1] - 1, Math.floor(grid[2] / 2)];
    const stand = standOn(from, grid, solid);
    const offset: Vec3 = [this.voxels.position.x, this.voxels.position.y, this.voxels.position.z];
    this.workspace.matrix.copy(lifeSize(stand, offset, size, workspaceYaw(this.workspace.matrix), new Vector3(viewer.eyes.x, 0, viewer.eyes.z)));
    this.workspace.matrixWorldNeedsUpdate = true;
    this.handles.regrab();
    this.lifeSignal[1](true);
  }

  /** Put the open windows back around you. */
  gatherWindows() {
    this.shell.windows.gather();
  }

  /** Show or hide a window (toggle without `shown`). */
  showWindow(id: WindowId, shown?: boolean) {
    this.shell.windows.show(id, shown);
  }

  /** Put the palette on the other hand, and draw with this one. Remembered on this device. */
  swapHands() {
    this.paletteSide = this.paletteSide === "left" ? "right" : "left";
    try {
      localStorage.setItem(SIDE_KEY, this.paletteSide);
    } catch {
      // private browsing: the choice lasts this session
    }
    // what either hand was doing belongs to the old arrangement
    this.shell.router.cancelAll();
    this.palette.attach(this.shell.hands.find((h) => h.handedness === this.paletteSide) ?? null);
    this.shell.windows.redraw();
  }

  // #region Tools

  /** The tools the palette offers: the voxel tools, Move with a scene, less what the host leaves out now. */
  private offered(): readonly XRTool[] {
    const all: XRTool[] = this.scene ? ["add", "erase", "paint", "move"] : ["add", "erase", "paint"];
    const host = this.options.tools?.();
    return host ? all.filter((t) => host.includes(t)) : all;
  }

  /**
   * The palette's tool, from the editor's: Add, Erase and the brush are themselves; any other tool
   * (the view tool, a host's) is Move with a scene, and adds without one. One not offered is Move
   * if that is, or none.
   */
  private currentTool(): XRTool | null {
    const t = this.options.editor.tool;
    const tool: XRTool = t === "add" ? "add" : t === "erase" ? "erase" : t === "brush" ? "paint" : this.scene ? "move" : "add";
    const offered = this.offered();
    if (offered.includes(tool)) return tool;
    return offered.includes("move") ? "move" : null;
  }

  private setTool(tool: XRTool) {
    const { editor } = this.options;
    editor.setTool(tool === "move" ? "orbit" : tool === "paint" ? "brush" : tool);
  }

  /** What the drawing hand does to cells now, or null while it doesn't draw. */
  private op(): CellOp | null {
    const tool = this.currentTool();
    return tool === "add" || tool === "erase" || tool === "paint" ? tool : null;
  }

  private setReach(reach: XRReach) {
    this.reachSignal[1](reach);
    try {
      localStorage.setItem(REACH_KEY, reach);
    } catch {
      // private browsing: the choice lasts this session
    }
  }

  /** Place `kind` (from the Objects window) where the drawing hand points, until stopped (null). */
  private placeKind(kind: string | null) {
    if (kind && this.currentTool() !== "move") this.setTool("move");
    this.scene?.setPlacing(kind);
  }

  // #endregion

  // #region Windows

  private makeWindows() {
    const { editor } = this.options;
    const { windows } = this.shell;
    const context = (id: WindowId): ViewContext => ({
      editor,
      menus: this.options.menus ?? {},
      supports: new Set(this.options.supports ?? []),
      redraw: () => windows.get(id)?.panel.redraw(),
      close: () => windows.show(id, false),
    });
    const headset = (): XRMenuItem[] => [
      { id: "fit", label: "Put the model in front of me", onSelect: () => this.fit() },
      ...(this.options.lifeSize ? [{ id: "life", label: "Life size", checked: this.lifeSignal[0](), onSelect: () => this.toggleLife() }] : []),
      { id: "gather", label: "Gather windows", onSelect: () => this.gatherWindows() },
      { id: "swapHands", label: "Swap hands", detail: `palette on the ${this.paletteSide}`, onSelect: () => this.swapHands() },
      { id: "exit", label: "Exit headset", onSelect: () => this.end() },
    ];
    this.views = {
      menu: menuView(context("menu"), headset),
      layers: layersView(context("layers")),
      timeline: timelineView(context("timeline")),
      objects: this.scene ? objectsView(context("objects"), this.scene, (kind) => this.placeKind(kind)) : { layout: () => [], reset: () => {} },
    };
    const animated = untrack(() => editor.isAnimated || editor.tags.length > 0);
    // the menu and the layers to either side at arm's length, the layers by the drawing hand; the
    // timeline over the model, beyond it; the objects further round on the drawing hand's side
    const side = (id: WindowId) => ((id === "layers" || id === "objects") === (this.paletteSide === "left") ? 1 : -1);
    const spots: Record<WindowId, (v: Viewer) => ReturnType<typeof around>> = {
      menu: (v) => around(v, { turn: side("menu") * 42, distance: 0.7, drop: 0.18 }),
      layers: (v) => around(v, { turn: side("layers") * 42, distance: 0.7, drop: 0.18 }),
      timeline: (v) => around(v, { turn: 0, distance: 1.0, drop: -0.02 }),
      objects: (v) => around(v, { turn: side("objects") * 80, distance: 0.7, drop: 0.18 }),
    };
    const sizes: Record<WindowId, [number, number]> = { menu: [300, 410], layers: [300, 410], timeline: [560, 190], objects: [300, 470] };
    const ids: WindowId[] = this.scene ? ["menu", "layers", "timeline", "objects"] : ["menu", "layers", "timeline"];
    for (const id of ids) {
      const view = this.views[id];
      windows.add({
        id,
        width: sizes[id][0],
        height: sizes[id][1],
        layout: view.layout,
        place: spots[id],
        open: id === "timeline" ? animated : true,
        onShow: view.reset,
      });
    }
  }

  // #endregion

  // #region Frame

  private makeBrush() {
    const tip = new Mesh(new SphereGeometry(0.006, 16, 8), new MeshBasicMaterial({ color: 0xffffff }));
    tip.visible = false;
    this.shell.scene.add(tip);
    const ghost = new InstancedMesh(
      new BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5),
      new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
      MAX_GHOST,
    );
    ghost.count = 0;
    ghost.frustumCulled = false;
    this.voxels.add(ghost);
    return { tip, ghost, key: "", buttons: [] as boolean[], stick: 0, turn: 0 };
  }

  /** The hands' poses are in: put the model and the palette where they go, before the router looks. */
  private beforeInput({ viewer }: FrameInfo) {
    this.stats.start = performance.now();
    const { editor } = this.options;
    if (this.place && viewer) this.placeModel(viewer);
    // the page doesn't get animation frames while a headset shows: playback advances here
    if (untrack(() => editor.playing)) editor.advance(performance.now());
    const geometry = this.options.modelGeometry?.();
    if (geometry && geometry !== this.model.geometry) this.model.geometry = geometry;
    this.palette.updateShown(viewer?.eyes);
    const held = this.handles.update();
    if (held) {
      this.workspace.matrix.copy(held);
      this.workspace.matrixWorldNeedsUpdate = true;
    }
    // life size is a size: scaling away from it turns it off
    const life = this.options.lifeSize;
    if (life && untrack(() => this.lifeSignal[0]())) {
      const scale = new Vector3().setFromMatrixScale(this.workspace.matrix).x;
      if (Math.abs(scale - life) > life * 0.02) this.lifeSignal[1](false);
    }
  }

  /** The router has run: show the brush where a hand would draw, and read the controllers' buttons. */
  private afterInput({ viewer }: FrameInfo) {
    const { router } = this.shell;
    this.ring.material.opacity = this.handles.spinner || this.handles.ringHot ? 0.9 : 0.35;
    let box: BoxDraw | null = null;
    this.shell.hands.forEach((hand, i) => {
      const brush = this.brushes[i];
      const capture = router.captureOf(hand)?.interaction;
      if (capture instanceof BoxDraw) box = capture;
      this.showBrush(hand, brush, capture);
      this.pollGamepad(hand, brush, viewer);
    });
    this.showBox(box);
    this.scene?.frame(this.shell.hands);
    this.measure();
  }

  /** The brush on a hand that would draw, or is: the tip and the cells it covers, the cell a ray points at, or a box's first corner. */
  private showBrush(hand: XRHand, brush: (typeof this.brushes)[number], capture: unknown) {
    const { router } = this.shell;
    const reach = untrack(() => this.reachSignal[0]());
    const drawing = hand.tracking && hand !== this.palette.on && !!untrack(() => this.op());
    const free = drawing && !capture && router.focusOf(hand)?.target === this.tool;
    let point: Vec3 | null = null;
    let tip = false;
    let size: number | undefined;
    if (drawing && reach === "tip" && (free || capture instanceof Stroke)) {
      point = this.tool.point(hand);
      tip = true;
    } else if (drawing && reach === "ray") {
      const cell = capture instanceof RayStroke ? capture.cell : free ? this.tool.aim(hand)?.target.cell : undefined;
      if (cell) point = [cell[0] + 0.5, cell[1] + 0.5, cell[2] + 0.5];
    } else if (drawing && reach === "box" && free) {
      const cell = this.tool.tipCell(hand);
      point = [cell[0] + 0.5, cell[1] + 0.5, cell[2] + 0.5];
      tip = true;
      size = 1;
    } else if (drawing && capture instanceof BoxDraw) {
      tip = true;
    }
    brush.tip.visible = tip;
    brush.tip.position.copy(hand.tip);
    this.updateGhost(brush, point, size);
  }

  /** A box being drawn, as a box. */
  private showBox(box: BoxDraw | null) {
    this.boxGhost.visible = !!box;
    if (!box) return;
    const { min, max } = cellBox(box.from, box.to);
    this.boxGhost.position.set(...min);
    this.boxGhost.scale.set(max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1);
    const { editor } = this.options;
    const op = untrack(() => this.op());
    const material = this.boxGhost.material as MeshBasicMaterial;
    material.color.set(op === "erase" ? 0xff5a5a : op === "paint" ? (untrack(() => editor.palette)[untrack(() => editor.color)] ?? 0xffffff) : 0xffffff);
  }

  /** Put the model on the table in front of the viewer. */
  private placeModel(viewer: Viewer) {
    this.workspace.matrix.copy(tabletop(this.options.editor.size, viewer.eyes, viewer.forward));
    this.workspace.matrixWorldNeedsUpdate = true;
    this.place = false;
    this.handles.regrab();
  }

  /** Show the cells the brush would change at `point` (none for null). */
  private updateGhost(brush: (typeof this.brushes)[number], point: Vec3 | null, size = this.options.editor.spatial.size) {
    const { editor } = this.options;
    const { ghost } = brush;
    if (!point) {
      ghost.count = 0;
      brush.key = "";
      return;
    }
    const odd = size % 2 === 1;
    const key = point.map((v) => (odd ? Math.floor(v) : Math.round(v))).join() + `|${size}|${editor.size.join()}`;
    if (key === brush.key) return;
    brush.key = key;
    const cells = editor.spatial.cells(point, size).slice(0, MAX_GHOST);
    const m = new Matrix4();
    cells.forEach((c, i) => ghost.setMatrixAt(i, m.makeTranslation(c[0], c[1], c[2])));
    ghost.count = cells.length;
    ghost.instanceMatrix.needsUpdate = true;
    const op = untrack(() => this.op());
    const material = ghost.material as MeshBasicMaterial;
    material.color.set(op === "erase" ? 0xff5a5a : op === "paint" ? (editor.palette[editor.color] ?? 0xffffff) : 0xffffff);
    material.opacity = op === "add" ? 0.35 : 0.5;
  }

  /**
   * A / X undo and B / Y redo; the thumbstick up or down sizes the brush, left or right turns the
   * model about you, unless what the hand holds reads it (a window on its ray).
   */
  private pollGamepad(hand: XRHand, brush: (typeof this.brushes)[number], viewer: Viewer | null) {
    const pad = hand.gamepad;
    if (!pad) return;
    const { editor } = this.options;
    const pressed = pad.buttons.map((b) => b.pressed);
    const rose = (i: number) => pressed[i] && !brush.buttons[i];
    if (rose(4)) editor.undo();
    if (rose(5)) editor.redo();
    brush.buttons = pressed;

    const reads = !!this.shell.router.captureOf(hand)?.interaction.axes;
    const x = pad.axes[2] ?? 0;
    const y = pad.axes[3] ?? 0;
    // a push mostly one way is that way only
    const across = Math.abs(x) > Math.abs(y);
    const stick = reads || across ? 0 : y < -STICK ? 1 : y > STICK ? -1 : 0;
    if (stick && stick !== brush.stick) editor.spatial.setSize(editor.spatial.size + stick);
    brush.stick = stick;
    const turn = reads || !across ? 0 : x > STICK ? 1 : x < -STICK ? -1 : 0;
    if (turn && turn !== brush.turn && viewer) {
      this.workspace.matrix.copy(turnAbout(this.workspace.matrix, viewer.eyes, turn * SNAP_TURN));
      this.workspace.matrixWorldNeedsUpdate = true;
      this.handles.regrab();
    }
    brush.turn = turn;
  }

  /** Frames per second, the worst frame's work and the worst brush move (which includes meshing) in the last half second, and the mesh's quads. */
  private measure() {
    const s = this.stats;
    const now = performance.now();
    s.frames++;
    s.cpu = Math.max(s.cpu, now - s.start);
    if (!s.since) s.since = now;
    if (now - s.since < 500) return;
    const fps = (s.frames * 1000) / (now - s.since);
    const index = this.model.geometry.index;
    const quads = index ? index.count / 6 : 0;
    this.palette.panel.setFooter(`${fps.toFixed(0)} fps · ${s.cpu.toFixed(1)} ms · edit ${this.tool.stats.edit.toFixed(1)} · ${quads} q`);
    this.stats = { frames: 0, cpu: 0, since: now, start: s.start };
    this.tool.stats.edit = 0;
  }

  private remesh() {
    const { editor } = this.options;
    const size = untrack(() => editor.size);
    if (!this.mesher || editor.composite.length !== size[0] * size[1] * size[2]) return;
    const geometry = this.mesher.build(editor.composite, size, untrack(() => editor.palette));
    this.model.geometry.dispose();
    this.model.geometry = geometry;
  }

  // #endregion

  private cleanup() {
    this.disposeRoot();
    this.scene?.dispose();
    this.palette.dispose();
    this.options.onEnd?.();
  }
}

function readSide(): "left" | "right" {
  try {
    return readDevice(SIDE_KEY, LEGACY_SIDE_KEY) === "right" ? "right" : "left";
  } catch {
    return "left";
  }
}

function readReach(): XRReach {
  try {
    const saved = readDevice(REACH_KEY, LEGACY_REACH_KEY);
    return saved === "ray" || saved === "box" ? saved : "tip";
  } catch {
    return "tip";
  }
}
