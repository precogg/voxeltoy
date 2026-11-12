import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ColorManagement,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  LinearSRGBColorSpace,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  NearestFilter,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Raycaster,
  Scene,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { createEffect, on, untrack } from "solid-js";
import { ORIGIN, type Editor, type PendingShape } from "@voxeltoy/core/editor";
import { markerAxes } from "@voxeltoy/core/markers";
import { sourceOutline } from "@voxeltoy/core/source";
import { shapeHandles } from "@voxeltoy/core/shapes";
import type { Floating } from "@voxeltoy/core/selection";
import type { Axis, Box, CameraView, GizmoHandle, Handle, PointerInput, Preview, ProjectionMode, Vec3 } from "@voxeltoy/core/types";
import { OrbitCamera } from "./camera";
import { buildDecalGeometry, type DecalSet } from "./decals";
import { Mesher, MESH_NO_AO, MESH_NO_SHADE } from "./mesher";

// Palette colors are authored in sRGB and shading is baked into vertex colors, so
// render without color management: what you pick is exactly what you see.
ColorManagement.enabled = false;

export interface ViewportTheme {
  background: string;
  grid: string;
  gridStrong: string;
  accent: string;
  danger: string;
  /** Onion skins: the previous pose's ghost, and the next one's. */
  onionBefore?: string;
  onionAfter?: string;
}

/**
 * Something else in the viewport that takes pointers before the editor's tool: a scene's
 * instances and their handles. See `Viewport.setPointerLayer`.
 */
export interface PointerLayer {
  /** A primary pointer went down. Return true to take the gesture; its moves and release then come here. */
  down(input: PointerInput, e: PointerEvent): boolean;
  move?(input: PointerInput, e: PointerEvent): void;
  up?(input: PointerInput, e: PointerEvent): void;
  /** A second finger landed or the gesture was lost: put back what the gesture changed. */
  cancel?(): void;
  /** A tap that nothing took (on empty space, or on the model when the editor's content is hidden). */
  tap?(input: PointerInput): void;
  /** A mouse moved with no button down; null when it left. Return true if something is under it. */
  hover?(input: PointerInput | null, e: PointerEvent | null): boolean;
}

type Gesture =
  | { kind: "none" }
  | { kind: "tool"; pointerId: number }
  | { kind: "layer"; pointerId: number }
  /** `tap` holds the start point until the pointer travels, so a tap on empty space can be told apart */
  | { kind: "orbit"; pointerId: number; tap?: { x: number; y: number }; secondary?: boolean }
  | { kind: "pan"; pointerId: number }
  | { kind: "pinch"; distance: number; mid: Vector2 }
  /** after a pinch, ignore the remaining finger until it lifts */
  | { kind: "idle" };

const MAX_PREVIEW_BOXES = 4096;
/** How far a pointer may travel and still count as a tap, in CSS pixels. */
const TAP_SLOP = 6;
/** Drawn size of a shape handle, in CSS pixels. */
const HANDLE_SIZE = 14;
/** How far from a handle a finger may land and still grab it, in CSS pixels. */
const TOUCH_REACH = 24;

/** The transform gizmo, in CSS pixels: arrows reach past the rings, so each has room to grab. */
const GIZMO = { arrowFrom: 22, arrowTo: 78, head: 16, headRadius: 6, shaft: 1.75, ring: 56, tube: 1.75 };
/** The workplane's double arrow, in CSS pixels from its middle to the tip of each head. */
const PLANE_ARROW = { length: 44, head: 14, headRadius: 6, shaft: 1.75 };
/** The views straight along X, Y and Z, from the + side and from the − side. */
const VIEWS_ALONG: [CameraView, CameraView][] = [
  ["right", "left"],
  ["top", "bottom"],
  ["front", "back"],
];
/** X, Y and Z, the usual red, green and blue. */
const AXIS_COLORS = ["#e5484d", "#30a46c", "#3e7cf7"];
/** Handles that set a shape's settings (taper, edge radius, tube, wall), apart from its face handles. */
const PARAM_COLOR = "#f59e0b";

export class Viewport {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly orbit = new OrbitCamera();
  private mesher = new Mesher();
  private voxelMesh: Mesh;
  /** The host's face decals, drawn over the voxels they belong to. */
  private decalMesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  /** The shape being edited in place, at full strength over the rest of the model, which dims. */
  private focusMesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  private decals: DecalSet | null = null;
  private decalTexture: CanvasTexture<HTMLCanvasElement | OffscreenCanvas> | null = null;
  private helpers = new Group();
  private previewGroup = new Group();
  private handleGroup = new Group();
  /** Markers (and the origin, while placing them): see `rebuildMarkers`. */
  private rigGroup = new Group();
  /** The selection: a tinted overlay of the selected cells, also seen through the model. */
  private selectionGroup = new Group();
  /** Arrows and rings to slide and turn floating content (or what the move tool would lift). */
  private gizmoGroup = new Group();
  private gizmoParts = new Map<GizmoHandle, Group>();
  /** The box the gizmo surrounds, its center, and the handle under the mouse or being dragged. */
  private gizmo: { box: Box; center: Vector3 } | null = null;
  private gizmoHover: GizmoHandle | null = null;
  private gizmoDrag: GizmoHandle | null = null;
  /** The workplane's arrow, at the edge of its grid nearest the camera: drag it to move the plane. */
  private planeArrow = new Group();
  private planeArrowShown = false;
  private planeArrowHover = false;
  private planeArrowDrag = false;
  /** In 2D with depth colors on: each pixel tinted by how near its front voxel is. */
  private depthOverlay: Mesh<BufferGeometry, MeshBasicMaterial> | null = null;
  /** The 3D view 2D mode left, to go back to (and to show in the thumbnail). */
  private before2D: { yaw: number; pitch: number; projection: ProjectionMode } | null = null;
  /** While clipping: what the clip hides on the far side of the workplane, drawn faintly. */
  private clippedMesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  /** Onion skins: ghosts of the previous and next poses. Drawn only; never picked or exported. */
  private onionMeshes: [Mesh<BufferGeometry, MeshBasicMaterial>, Mesh<BufferGeometry, MeshBasicMaterial>];
  /** The side of the workplane the faint mesh was built for; it rebuilds when the camera crosses. */
  private clippedSide: 1 | -1 | 0 = 0;
  /** In 2D, the element a small 3D view of the model is drawn behind, and its camera. */
  private thumbnail: HTMLElement | null = null;
  private thumbnailCamera = new PerspectiveCamera(30, 1, 0.1, 5000);
  /** Drawn only in the thumbnail: where the workplane is. */
  private thumbnailPlane = new Group();
  /** Whether leaving 2D mode puts back the angles from before it; not when a new view is what ends it. */
  private restoreAngles = true;
  /** Floating content, positioned at its offset. */
  private floatGroup = new Group();
  private floatOverlay = new Group();
  /** The buffers the float meshes were built from; moving only repositions them. */
  private floatBuilt: { voxels: Uint8Array; mask: Uint8Array; palette: readonly number[]; accent: string } | null = null;
  private handleTexture: CanvasTexture | null = null;
  /** Which of the pending shape's face handles face the camera, as drawn: one flag per handle. */
  private handleFacing: string | null = null;
  private theme: ViewportTheme;

  private pointers = new Map<number, { x: number; y: number; type: string }>();
  private gesture: Gesture = { kind: "none" };
  private pointerLayer: PointerLayer | null = null;
  /** Whether the editor's model, its helpers and its tools are shown; off in a scene without a model open. */
  private contentShown = true;
  /** Called before each frame is drawn, for layers that place things relative to the camera. */
  private beforeRender = new Set<() => void>();
  private spaceHeld = false;
  private needsRender = true;
  private frame = 0;
  private resizeObserver: ResizeObserver;
  private disposers: (() => void)[] = [];

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly editor: Editor,
    theme: () => ViewportTheme,
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.theme = untrack(theme);

    this.voxelMesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ vertexColors: true }));
    this.decalMesh = new Mesh(
      new BufferGeometry(),
      new MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    );
    this.decalMesh.renderOrder = 1;
    this.clippedMesh = new Mesh(
      new BufferGeometry(),
      new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.16, depthWrite: false }),
    );
    this.clippedMesh.renderOrder = 2;
    const ghost = () => {
      const mesh = new Mesh(
        new BufferGeometry(),
        new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
      );
      mesh.renderOrder = 3;
      return mesh;
    };
    this.onionMeshes = [ghost(), ghost()];
    this.thumbnailPlane.visible = false;
    this.floatGroup.add(this.floatOverlay);
    this.focusMesh.visible = false;
    this.scene.add(
      this.voxelMesh,
      this.focusMesh,
      this.decalMesh,
      this.clippedMesh,
      ...this.onionMeshes,
      this.thumbnailPlane,
      this.helpers,
      this.selectionGroup,
      this.floatGroup,
      this.previewGroup,
      this.handleGroup,
      this.rigGroup,
      this.gizmoGroup,
      this.planeArrow,
    );

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();

    createEffect(() => {
      this.theme = theme();
      this.renderer.setClearColor(new Color(this.theme.background), 1);
      this.handleTexture?.dispose();
      this.handleTexture = null;
      this.rebuildHelpers();
      this.rebuildPreview(untrack(() => editor.preview));
      this.rebuildHandles(untrack(() => editor.pendingShape));
      this.floatBuilt = null;
      this.rebuildSelection();
      this.rebuildMarkers();
      this.buildGizmo();
      this.buildPlaneArrow();
      for (const [n, mesh] of this.onionMeshes.entries()) mesh.material.color.set(n ? (this.theme.onionAfter ?? "#22c55e") : (this.theme.onionBefore ?? "#f97316"));
    });

    createEffect(() => {
      const box = editor.transformBox;
      this.gizmo = box && {
        box,
        center: new Vector3(...box.min).add(new Vector3(...box.max).addScalar(1)).multiplyScalar(0.5),
      };
      this.requestRender();
    });

    createEffect(() => {
      editor.markerEditing;
      editor.markersShown;
      editor.markerTarget;
      editor.resolution;
      editor.shownOrigin;
      for (const m of editor.markers) editor.shownMarker(m.id);
      this.rebuildMarkers();
    });

    createEffect(() => {
      editor.playing;
      editor.selectionVersion;
      editor.floating;
      editor.palette;
      this.rebuildSelection();
    });

    createEffect(() => {
      editor.geometryVersion;
      editor.palette;
      this.remesh();
    });

    createEffect(() => {
      const frames = editor.onionFrames;
      const onion = editor.onionSkin;
      editor.documentVersion;
      editor.activeLayerId;
      editor.layers;
      editor.size;
      untrack(() => this.rebuildOnion(frames, onion));
    });

    createEffect(() => {
      editor.size;
      editor.mirror;
      editor.workplane;
      editor.mode2D;
      this.rebuildHelpers();
    });

    createEffect(() => this.rebuildPreview(editor.preview));
    createEffect(() => {
      editor.pendingExtrusion;
      editor.shapeParamHandles;
      editor.selectedPathPoint;
      this.rebuildHandles(editor.pendingShape);
    });

    createEffect(() => {
      this.orbit.setProjection(editor.projection);
      this.requestRender();
    });

    this.follow2D();

    // editing a shape in place: it stays bright and everything else dims
    createEffect(() => {
      editor.editingShape;
      editor.geometryVersion;
      editor.palette;
      untrack(() => this.rebuildFocus());
    });

    createEffect(() => {
      editor.geometryVersion;
      editor.workplane;
      editor.showClipped;
      editor.mode2D;
      untrack(() => this.rebuildClipped());
    });

    createEffect(() => {
      editor.geometryVersion;
      editor.workplane;
      const on = !!editor.mode2D && editor.depthColors;
      untrack(() => this.rebuildDepthOverlay(on));
    });

    // Frame the model whenever a different document is loaded.
    createEffect(
      on(
        () => editor.size,
        () => this.fit(),
      ),
    );

    this.attachInput();
    this.loop();
  }

  /**
   * The model's mesh, rebuilt (a new geometry) whenever the composite changes. Another view of
   * the same editor, such as a headset's, can show it rather than mesh every edit again.
   */
  get modelGeometry(): BufferGeometry {
    return this.voxelMesh.geometry;
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    for (const d of this.disposers) d();
    this.focusMesh.geometry.dispose();
    this.focusMesh.material.dispose();
    this.decalMesh.geometry.dispose();
    this.decalMesh.material.dispose();
    this.decalTexture?.dispose();
    if (this.snapshotScene) {
      this.snapshotScene.mesh.geometry.dispose();
      this.snapshotScene.mesh.material.dispose();
      this.snapshotScene.target.dispose();
    }
    this.renderer.dispose();
  }

  /**
   * Draw pictures on voxel faces, or clear them with null. Pass a new set whenever the decals
   * or the atlas drawing change; the viewport keeps them in step with what is visible.
   */
  setDecals(set: DecalSet | null) {
    if (set?.atlas !== this.decals?.atlas) {
      this.decalTexture?.dispose();
      this.decalTexture = set && new CanvasTexture(set.atlas);
      if (this.decalTexture) this.decalTexture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      this.decalMesh.material.map = this.decalTexture;
      this.decalMesh.material.needsUpdate = true;
    } else if (this.decalTexture) {
      this.decalTexture.needsUpdate = true;
    }
    this.decals = set;
    this.rebuildDecals();
  }

  private rebuildDecals() {
    const editor = this.editor;
    const [sx, sy, sz] = untrack(() => editor.size);
    // As in remesh: wait for the composite to catch up with a new document's size.
    if (editor.composite.length !== sx * sy * sz) return;
    this.decalMesh.geometry.dispose();
    this.decalMesh.geometry = this.decals
      ? buildDecalGeometry(this.decals, editor.composite, untrack(() => editor.size))
      : new BufferGeometry();
    this.requestRender();
  }

  requestRender() {
    this.needsRender = true;
  }

  /** Give pointers to `layer` before the editor's tool (or stop with null). */
  setPointerLayer(layer: PointerLayer | null) {
    if (this.gesture.kind === "layer") this.cancelGesture();
    this.pointerLayer = layer;
  }

  /**
   * Show or hide the editor's model, its grid and helpers, and stop its tools taking pointers.
   * A scene with no model open hides them: its instances are drawn by a layer instead.
   */
  setContentShown(shown: boolean) {
    this.contentShown = shown;
    for (const object of [
      this.voxelMesh, this.decalMesh, this.clippedMesh, ...this.onionMeshes, this.helpers, this.selectionGroup,
      this.floatGroup, this.previewGroup, this.handleGroup, this.rigGroup, this.gizmoGroup, this.planeArrow,
    ]) object.visible = shown;
    if (shown) {
      // put back what the effects keep, which may have changed while hidden
      this.rebuildHelpers();
      this.rebuildSelection();
      this.rebuildMarkers();
    }
    this.requestRender();
  }

  /** Run `fn` before every frame drawn. Returns a function that stops. */
  onBeforeRender(fn: () => void): () => void {
    this.beforeRender.add(fn);
    return () => this.beforeRender.delete(fn);
  }

  /** Frame a box in world units. */
  frameBox(min: Vec3, max: Vec3) {
    const a = new Vector3(...min);
    const b = new Vector3(...max);
    this.orbit.frame(a.clone().add(b).multiplyScalar(0.5), Math.max(4, a.distanceTo(b) / 2));
    this.requestRender();
  }

  /** Where a point in world units is on screen, in client CSS pixels (as pointer events give them); null if behind the camera. */
  screenPoint(p: Vec3): { x: number; y: number } | null {
    const v = new Vector3(...p);
    const s = this.toScreen(v);
    return s ? { x: s.x, y: s.y } : null;
  }

  /** How many world units one CSS pixel spans at a point. */
  worldPerPixel(p: Vec3): number {
    return this.pixelSize(new Vector3(...p));
  }

  // #region View

  /** What Zoom to fit frames instead of the model, such as a scene's instances; null for the model. */
  fitOverride: (() => void) | null = null;

  /** Frame the model (or the whole volume, if empty). */
  fit() {
    if (this.fitOverride) return this.fitOverride();
    const editor = untrack(() => this.editor);
    const size = untrack(() => editor.size);
    const bounds = editor.contentBounds() ?? { min: [0, 0, 0] as Vec3, max: size.map((s) => s - 1) as Vec3 };
    const min = new Vector3(...bounds.min);
    const max = new Vector3(...bounds.max).addScalar(1);
    const center = min.clone().add(max).multiplyScalar(0.5);
    const radius = Math.max(4, max.distanceTo(min) / 2);
    this.orbit.frame(center, radius);
    this.requestRender();
  }

  /** Snap to an axis-aligned or the default three-quarter view. This leaves 2D mode, whose view is locked. */
  setView(view: CameraView) {
    if (untrack(() => this.editor.mode2D)) {
      // the new view replaces the one 2D mode would put back
      this.restoreAngles = false;
      this.editor.exit2D();
    }
    this.applyView(view);
  }

  private applyView(view: CameraView) {
    const angles: Record<CameraView, [number, number]> = {
      front: [0, 0],
      back: [Math.PI, 0],
      right: [Math.PI / 2, 0],
      left: [-Math.PI / 2, 0],
      top: [0, Math.PI / 2 - 0.0001],
      bottom: [0, -Math.PI / 2 + 0.0001],
      iso: [Math.PI / 4, Math.PI / 6],
    };
    const [yaw, pitch] = angles[view];
    this.orbit.yaw = yaw;
    this.orbit.pitch = pitch;
    this.orbit.update();
    this.requestRender();
  }

  /** Look straight along an axis, from the side of the workplane the camera is on. */
  viewAlong(axis: Axis) {
    this.setView(VIEWS_ALONG[axis][this.sideOf(axis) > 0 ? 0 : 1]);
  }

  /** Which side of the workplane the camera is on: where 2D mode looks from. */
  workplaneSide(): 1 | -1 {
    return this.sideOf(untrack(() => this.editor.workplane.axis));
  }

  /** Which side the camera is on along an axis: of the workplane across it, of the target otherwise. */
  private sideOf(axis: Axis): 1 | -1 {
    const plane = untrack(() => this.editor.workplane);
    const from = plane.axis === axis ? untrack(() => this.editor.workplaneFace) : this.orbit.target.getComponent(axis);
    return this.orbit.camera.position.getComponent(axis) >= from ? 1 : -1;
  }

  /** Which side of the workplane the view is on: 2D mode's side, or the camera's in 3D. */
  private viewSide(): 1 | -1 {
    return untrack(() => this.editor.mode2D)?.side ?? this.workplaneSide();
  }

  /** Mesh what the clip hides behind the workplane, as seen from the camera's side of it. */
  private rebuildClipped() {
    const editor = this.editor;
    const side = this.viewSide();
    const volume = untrack(() => editor.showClipped) ? editor.clippedBehind(side) : null;
    this.clippedSide = side;
    this.clippedMesh.geometry.dispose();
    this.clippedMesh.geometry = volume
      ? this.mesher.build(volume, untrack(() => editor.size), untrack(() => editor.palette), MESH_NO_AO)
      : new BufferGeometry();
    this.requestRender();
  }

  /**
   * Ghost the poses before and after the one being edited, tinted, shaded but colorless: they
   * show where things moved, not what color they are.
   */
  private rebuildOnion(frames: { before: string | null; after: string | null }, onion: Editor["onionSkin"]) {
    const editor = this.editor;
    const size = editor.size;
    const white = editor.palette.map(() => 0xffffff);
    const only = onion.scope === "active-layer" ? { layers: [editor.activeLayerId] } : {};
    const tints = [this.theme.onionBefore ?? "#f97316", this.theme.onionAfter ?? "#22c55e"];
    [frames.before, frames.after].forEach((id, n) => {
      const mesh = this.onionMeshes[n];
      mesh.geometry.dispose();
      mesh.geometry = id ? this.mesher.build(editor.evaluateFrame(id, only), size, white, MESH_NO_AO) : new BufferGeometry();
      mesh.material.color.set(tints[n]);
      mesh.material.opacity = onion.opacity;
    });
    this.requestRender();
  }

  /**
   * In 2D, draw a small 3D view of the model behind `element` (a transparent panel over the
   * canvas), from the angle 2D mode will go back to. Pass null to stop.
   */
  setThumbnail(element: HTMLElement | null) {
    this.thumbnail = element;
    if (element) this.resizeObserver.observe(element);
    this.requestRender();
  }

  /** Render the thumbnail into its element's rectangle of the canvas, after the main view. */
  private renderThumbnail() {
    const element = this.thumbnail;
    if (!element || !untrack(() => this.editor.mode2D)) return;
    const canvas = this.canvas.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    // inside the panel's rounded corners
    const inset = 4;
    const width = rect.width - 2 * inset;
    const height = rect.height - 2 * inset;
    if (width <= 0 || height <= 0) return;
    const x = rect.left - canvas.left + inset;
    const y = canvas.bottom - rect.bottom + inset;

    // frame the model from the 3D view's angle
    const editor = this.editor;
    const size = untrack(() => editor.size);
    const bounds = editor.contentBounds() ?? { min: [0, 0, 0] as Vec3, max: size.map((n) => n - 1) as Vec3 };
    const min = new Vector3(...bounds.min);
    const max = new Vector3(...bounds.max).addScalar(1);
    const center = min.clone().add(max).multiplyScalar(0.5);
    const radius = Math.max(2, max.distanceTo(min) / 2);
    const { yaw, pitch } = this.before2D ?? { yaw: Math.PI / 4, pitch: Math.PI / 6 };
    const camera = this.thumbnailCamera;
    camera.aspect = width / height;
    const fov = (camera.fov * Math.PI) / 180;
    const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * camera.aspect));
    const distance = (radius / Math.sin(fit / 2)) * 1.05;
    camera.position.set(
      center.x + distance * Math.cos(pitch) * Math.sin(yaw),
      center.y + distance * Math.sin(pitch),
      center.z + distance * Math.cos(pitch) * Math.cos(yaw),
    );
    camera.lookAt(center);
    camera.updateProjectionMatrix();

    // the model (with what is clipped, faintly) and where the workplane is, nothing else
    const shown = [this.voxelMesh, this.decalMesh, this.clippedMesh];
    const hidden = this.scene.children.filter((o) => o.visible && !shown.includes(o as never));
    for (const o of hidden) o.visible = false;
    this.thumbnailPlane.visible = true;
    const renderer = this.renderer;
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, width, height);
    renderer.setViewport(x, y, width, height);
    renderer.render(this.scene, camera);
    renderer.setScissorTest(false);
    const full = new Vector2();
    renderer.getSize(full);
    renderer.setViewport(0, 0, full.x, full.y);
    this.thumbnailPlane.visible = false;
    for (const o of hidden) o.visible = true;
  }

  /** Tint the 2D projection by depth: near pixels warm, far ones cool, empty ones clear. */
  private rebuildDepthOverlay(on: boolean) {
    if (this.depthOverlay) {
      this.scene.remove(this.depthOverlay);
      this.depthOverlay.material.map?.dispose();
      disposeObject(this.depthOverlay);
      this.depthOverlay = null;
    }
    this.requestRender();
    if (!on) return;
    const editor = this.editor;
    const { axis, side, u, v, width, height, depth } = editor.project();
    // spread the colors over the depths there are, so a step of one voxel shows
    let lo = Infinity;
    let hi = -Infinity;
    for (const d of depth) {
      if (d < 0) continue;
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    const data = new Uint8Array(width * height * 4);
    const far = new Color("#2f6fe4");
    const near = new Color("#ffb347");
    const c = new Color();
    for (let p = 0; p < width * height; p++) {
      if (depth[p] < 0) continue;
      // 1 for the nearest pixels, 0 for the farthest
      const t = hi === lo ? 1 : side > 0 ? (depth[p] - lo) / (hi - lo) : (hi - depth[p]) / (hi - lo);
      c.copy(far).lerpHSL(near, t);
      data.set([c.r * 255, c.g * 255, c.b * 255, 210], p * 4);
    }
    const texture = new DataTexture(data, width, height);
    texture.magFilter = NearestFilter;
    texture.minFilter = NearestFilter;
    texture.needsUpdate = true;
    // a quad over the whole face, in front of everything
    const at = side > 0 ? editor.size[axis] : 0;
    const corner = (cu: number, cv: number) => {
      const point = [0, 0, 0];
      point[axis] = at;
      point[u] = cu;
      point[v] = cv;
      return point;
    };
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new Float32BufferAttribute([...corner(0, 0), ...corner(width, 0), ...corner(width, height), ...corner(0, height)], 3),
    );
    geometry.setAttribute("uv", new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    this.depthOverlay = new Mesh(geometry, material);
    this.depthOverlay.renderOrder = 10;
    this.scene.add(this.depthOverlay);
  }

  /** Lock the camera onto the workplane in 2D mode; leaving it puts back the view and projection from before. */
  private follow2D() {
    createEffect(() => {
      const mode = this.editor.mode2D;
      const axis = this.editor.workplane.axis;
      untrack(() => {
        if (mode) {
          const entering = !this.before2D;
          if (!this.before2D) {
            this.before2D = { yaw: this.orbit.yaw, pitch: this.orbit.pitch, projection: this.editor.projection };
            this.editor.setProjection("orthographic");
          }
          this.applyView(VIEWS_ALONG[axis][mode.side > 0 ? 0 : 1]);
          if (entering) this.fit();
        } else if (this.before2D) {
          const before = this.before2D;
          if (this.restoreAngles) {
            this.orbit.yaw = before.yaw;
            this.orbit.pitch = before.pitch;
          }
          this.restoreAngles = true;
          this.editor.setProjection(before.projection);
          this.orbit.update();
          this.before2D = null;
          this.requestRender();
        }
      });
    });
  }

  zoomBy(factor: number) {
    this.orbit.zoom(factor);
    this.requestRender();
  }

  /** Render a PNG of the model, without editor helpers, on a transparent background. */
  async screenshot(): Promise<Blob> {
    const shown = [
      this.helpers, this.previewGroup, this.handleGroup, this.selectionGroup, this.floatOverlay,
      this.rigGroup, this.gizmoGroup, this.planeArrow, ...this.onionMeshes, this.depthOverlay,
    ].filter((child) => child !== null).filter((child) => child.visible);
    const original = this.voxelMesh.geometry;
    const geometry = this.editor.playing
      ? this.mesher.build(this.editor.evaluateFrame(this.editor.activeFrameId), this.editor.size, this.editor.palette)
      : original;
    let capture: Promise<Blob | null>;
    try {
      for (const child of shown) child.visible = false;
      this.voxelMesh.geometry = geometry;
      this.renderer.setClearColor(new Color(this.theme.background), 0);
      this.orbit.centred(() => this.renderer.render(this.scene, this.orbit.camera));
      capture = new Promise((resolve) => this.canvas.toBlob(resolve, "image/png"));
    } finally {
      this.voxelMesh.geometry = original;
      if (geometry !== original) geometry.dispose();
      for (const child of shown) child.visible = true;
      this.renderer.setClearColor(new Color(this.theme.background), 1);
      this.requestRender();
    }
    const blob = await capture;
    if (!blob) throw new Error("Could not capture the canvas");
    return blob;
  }

  private snapshotScene: { scene: Scene; mesh: Mesh<BufferGeometry, MeshBasicMaterial>; camera: OrthographicCamera; target: WebGLRenderTarget } | null = null;

  /**
   * A small picture of `volume` (a frame's voxels) from the three-quarter view, framed on `bounds`
   * (inclusive cells), on a transparent background. Drawn off screen: the view doesn't change.
   * Pass the same bounds for every frame so pictures of different poses line up.
   */
  snapshot(volume: Uint8Array, bounds: Box, pixels: number): HTMLCanvasElement {
    const editor = this.editor;
    this.snapshotScene ??= {
      scene: new Scene(),
      mesh: new Mesh(new BufferGeometry(), new MeshBasicMaterial({ vertexColors: true })),
      camera: new OrthographicCamera(-1, 1, 1, -1, 0.1, 5000),
      target: new WebGLRenderTarget(pixels, pixels),
    };
    const { scene, mesh, camera, target } = this.snapshotScene;
    if (!mesh.parent) scene.add(mesh);
    if (target.width !== pixels) target.setSize(pixels, pixels);
    mesh.geometry.dispose();
    mesh.geometry = this.mesher.build(volume, untrack(() => editor.size), untrack(() => editor.palette));
    // the default three-quarter view (yaw 45°, pitch 30°), looking at the middle of the bounds
    const min = new Vector3(...bounds.min);
    const max = new Vector3(...bounds.max).addScalar(1);
    const center = min.clone().add(max).multiplyScalar(0.5);
    const radius = Math.max(1, max.distanceTo(min) / 2) * 1.02;
    const pitch = Math.PI / 6;
    const yaw = Math.PI / 4;
    const dir = new Vector3(Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw));
    camera.left = camera.bottom = -radius;
    camera.right = camera.top = radius;
    camera.position.copy(center).addScaledVector(dir, radius * 4);
    camera.near = radius;
    camera.far = radius * 8;
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const renderer = this.renderer;
    const clear = renderer.getClearAlpha();
    renderer.setRenderTarget(target);
    renderer.setClearColor(new Color(this.theme.background), 0);
    renderer.clear();
    renderer.render(scene, camera);
    const pixelsOut = new Uint8Array(pixels * pixels * 4);
    renderer.readRenderTargetPixels(target, 0, 0, pixels, pixels, pixelsOut);
    renderer.setRenderTarget(null);
    renderer.setClearColor(new Color(this.theme.background), clear);
    // GL rows run bottom up
    const out = document.createElement("canvas");
    out.width = out.height = pixels;
    const context = out.getContext("2d")!;
    const image = context.createImageData(pixels, pixels);
    const row = pixels * 4;
    for (let y = 0; y < pixels; y++) image.data.set(pixelsOut.subarray((pixels - 1 - y) * row, (pixels - y) * row), y * row);
    context.putImageData(image, 0, 0);
    return out;
  }

  /**
   * Draw frames of the animation as images from the current view, on a transparent background:
   * each frame's committed voxels and nothing else (no slice, guides or onion skins). They share
   * one crop, around what any of them covers, so poses never jump between images.
   */
  renderFrames(ids: readonly string[], padding = 4): { images: HTMLCanvasElement[]; width: number; height: number } {
    const editor = this.editor;
    const size = untrack(() => editor.size);
    const palette = untrack(() => editor.palette);
    const canvas = this.renderer.domElement;
    const shown = this.scene.children.filter((c) => c.visible && c !== this.voxelMesh);
    const geometry = this.voxelMesh.geometry;
    const shots: HTMLCanvasElement[] = [];
    for (const c of shown) c.visible = false;
    this.renderer.setClearColor(new Color(this.theme.background), 0);
    try {
      for (const id of ids) {
        const g = this.mesher.build(untrack(() => editor.evaluateFrame(id)), size, palette);
        this.voxelMesh.geometry = g;
        this.renderer.render(this.scene, this.orbit.camera);
        // read back in the same task, before the drawing buffer is cleared
        const shot = document.createElement("canvas");
        shot.width = canvas.width;
        shot.height = canvas.height;
        shot.getContext("2d")!.drawImage(canvas, 0, 0);
        shots.push(shot);
        g.dispose();
      }
    } finally {
      this.voxelMesh.geometry = geometry;
      for (const c of shown) c.visible = true;
      this.renderer.setClearColor(new Color(this.theme.background), 1);
      this.requestRender();
    }
    // the union of every frame's opaque pixels
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -1;
    let y1 = -1;
    for (const shot of shots) {
      const { data, width, height } = shot.getContext("2d")!.getImageData(0, 0, shot.width, shot.height);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          if (!data[(y * width + x) * 4 + 3]) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    }
    if (x1 < 0) {
      x0 = y0 = 0;
      x1 = canvas.width - 1;
      y1 = canvas.height - 1;
    } else {
      x0 = Math.max(0, x0 - padding);
      y0 = Math.max(0, y0 - padding);
      x1 = Math.min(canvas.width - 1, x1 + padding);
      y1 = Math.min(canvas.height - 1, y1 + padding);
    }
    const width = x1 - x0 + 1;
    const height = y1 - y0 + 1;
    const images = shots.map((shot) => {
      const out = document.createElement("canvas");
      out.width = width;
      out.height = height;
      out.getContext("2d")!.drawImage(shot, x0, y0, width, height, 0, 0, width, height);
      return out;
    });
    return { images, width, height };
  }

  // #endregion

  // #region Scene

  private remesh() {
    const editor = this.editor;
    const size = untrack(() => editor.size);
    // Opening a document changes the size and palette before the composite is rebuilt for
    // it; the rebuild bumps the geometry version and meshes again.
    if (editor.composite.length !== size[0] * size[1] * size[2]) return;
    const geometry = this.mesher.build(editor.composite, size, untrack(() => editor.palette));
    this.voxelMesh.geometry.dispose();
    this.voxelMesh.geometry = geometry;
    if (this.decals) this.rebuildDecals();
    this.requestRender();
  }

  private rebuildFocus() {
    const editor = this.editor;
    const volume = editor.editingShape ? editor.editingVolume() : null;
    const focused = !!editor.editingShape;
    const size = editor.size;
    this.focusMesh.geometry.dispose();
    this.focusMesh.geometry =
      volume && volume.length === size[0] * size[1] * size[2] ? this.mesher.build(volume, size, editor.palette) : new BufferGeometry();
    this.focusMesh.visible = !!volume;
    const main = this.voxelMesh.material as MeshBasicMaterial;
    if (main.transparent !== focused) {
      main.transparent = focused;
      main.opacity = focused ? 0.22 : 1;
      main.depthWrite = !focused;
      main.needsUpdate = true;
    }
    this.requestRender();
  }

  /** Mesh a volume the size of the document for export: flat colors, in grid units. */
  buildExportGeometry(volume: Uint8Array): BufferGeometry {
    const editor = this.editor;
    return this.mesher.build(volume, editor.size, editor.palette, MESH_NO_SHADE | MESH_NO_AO);
  }

  private rebuildHelpers() {
    const editor = this.editor;
    const size = untrack(() => editor.size);
    const mirror = untrack(() => editor.mirror);
    const plane = untrack(() => editor.workplane);
    const face = untrack(() => editor.workplaneFace);
    const theme = this.theme;

    for (const child of [...this.helpers.children]) {
      this.helpers.remove(child);
      disposeObject(child);
    }

    clearGroup(this.thumbnailPlane);
    {
      const u = (plane.axis + 1) % 3;
      const v = (plane.axis + 2) % 3;
      const quad = new Mesh(
        new PlaneGeometry(size[u], size[v]),
        new MeshBasicMaterial({ color: theme.accent, transparent: true, opacity: 0.25, side: DoubleSide, depthWrite: false }),
      );
      const at = [0, 0, 0];
      at[plane.axis] = face;
      at[u] = size[u] / 2;
      at[v] = size[v] / 2;
      quad.position.set(at[0], at[1], at[2]);
      // PlaneGeometry spans X and Y, facing Z: turn it to face the workplane's axis, with X and Y on u and v
      if (plane.axis === 0) quad.rotation.set(0, Math.PI / 2, Math.PI / 2);
      if (plane.axis === 1) quad.rotation.set(-Math.PI / 2, 0, -Math.PI / 2);
      this.thumbnailPlane.add(quad);
    }

    // in 2D, a pixel grid over the whole projection
    if (untrack(() => editor.mode2D)) {
      this.helpers.add(gridLines(plane.axis, face, size, theme.grid, theme.gridStrong, 0.7, true));
    }
    // the floor grid, unless a horizontal workplane replaces it; a workplane anywhere else is drawn in the accent
    const floor = plane.axis === 1 && face === 0;
    if (plane.axis !== 1 || floor) {
      this.helpers.add(gridLines(1, 0, size, theme.grid, theme.gridStrong));
    }
    if (!floor) {
      this.helpers.add(gridLines(plane.axis, face, size, theme.accent, theme.accent, 0.35));
    }

    mirror.forEach((on, axis) => {
      if (!on) return;
      const dims = [0, 1, 2].filter((a) => a !== axis);
      const plane = new Mesh(
        new PlaneGeometry(size[dims[0]], size[dims[1]]),
        new MeshBasicMaterial({
          color: theme.accent,
          transparent: true,
          opacity: 0.08,
          side: DoubleSide,
          depthWrite: false,
        }),
      );
      plane.position.set(size[0] / 2, size[1] / 2, size[2] / 2);
      if (axis === 0) plane.rotation.y = Math.PI / 2;
      if (axis === 1) plane.rotation.x = Math.PI / 2;
      plane.renderOrder = 2;
      this.helpers.add(plane);
      const outline = new LineSegments(
        new EdgesGeometry(plane.geometry),
        new LineBasicMaterial({ color: theme.accent, transparent: true, opacity: 0.5 }),
      );
      outline.position.copy(plane.position);
      outline.rotation.copy(plane.rotation);
      this.helpers.add(outline);
    });

    this.requestRender();
  }

  private rebuildPreview(preview: Preview | null) {
    for (const child of [...this.previewGroup.children]) {
      this.previewGroup.remove(child);
      disposeObject(child);
    }
    if (!preview) return this.requestRender();

    const editor = this.editor;
    const palette = untrack(() => editor.palette);
    const color =
      preview.kind === "erase" || preview.kind === "deselect"
        ? this.theme.danger
        : preview.kind === "paint"
          ? "#" + (palette[untrack(() => editor.color)] ?? 0).toString(16).padStart(6, "0")
          : this.theme.accent;

    if (preview.cells?.length) this.previewGroup.add(this.ghost(preview, color));
    if (preview.outlines?.length) {
      const removing = preview.kind === "erase" || preview.kind === "deselect";
      this.previewGroup.add(outlineBoxes(preview.outlines, removing ? color : this.theme.accent));
    }
    if (preview.lines?.length) {
      const geometry = new BufferGeometry().setFromPoints(preview.lines.flatMap(([a, b]) => [new Vector3(...a), new Vector3(...b)]));
      const dashes = new LineSegments(
        geometry,
        new LineDashedMaterial({ color: this.theme.accent, dashSize: 0.4, gapSize: 0.3, transparent: true, opacity: 0.9, depthTest: false }),
      );
      dashes.computeLineDistances();
      dashes.renderOrder = 11;
      this.previewGroup.add(dashes);
    }
    if (preview.boxes.length === 0) return this.requestRender();

    const boxes = preview.boxes.slice(0, MAX_PREVIEW_BOXES);
    const pad = 0.02;
    const fill: number[] = [];
    const edges: number[] = [];
    for (const { min, max } of boxes) {
      const a = [min[0] - pad, min[1] - pad, min[2] - pad];
      const b = [max[0] + 1 + pad, max[1] + 1 + pad, max[2] + 1 + pad];
      pushBox(fill, edges, a, b);
    }

    const fillGeometry = new BufferGeometry();
    fillGeometry.setAttribute("position", new Float32BufferAttribute(fill, 3));
    const fillMesh = new Mesh(
      fillGeometry,
      new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: preview.kind === "erase" || preview.kind === "deselect" ? 0.3 : 0.45,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      }),
    );
    fillMesh.renderOrder = 3;

    const edgeGeometry = new BufferGeometry();
    edgeGeometry.setAttribute("position", new Float32BufferAttribute(edges, 3));
    const edgeLines = new LineSegments(
      edgeGeometry,
      new LineBasicMaterial({ color: preview.kind === "paint" ? this.theme.accent : color }),
    );
    edgeLines.renderOrder = 4;

    this.previewGroup.add(fillMesh, edgeLines);
    this.requestRender();
  }

  /**
   * The cells a shape would cover, meshed like the model. Added voxels show in their
   * color; erased and painted ones show through the model so buried parts stay visible.
   */
  private ghost(preview: Preview, color: string): Mesh {
    const cells = preview.cells!;
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const c of cells)
      for (let a = 0; a < 3; a++) {
        if (c[a] < min[a]) min[a] = c[a];
        if (c[a] > max[a]) max[a] = c[a];
      }
    const size: Vec3 = [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
    const volume = new Uint8Array(size[0] * size[1] * size[2]);
    const value = preview.value ?? 1;
    cells.forEach(([x, y, z], k) => {
      volume[x - min[0] + size[0] * (y - min[1] + size[1] * (z - min[2]))] = preview.values?.[k] ?? value;
    });

    const geometry = this.mesher.build(volume, size, untrack(() => this.editor.palette), MESH_NO_AO);
    geometry.translate(...min);
    const xray = preview.kind !== "add";
    // added and painted cells show their color; the rest are tinted
    const colored = preview.kind === "add" || preview.kind === "paint";
    const mesh = new Mesh(
      geometry,
      new MeshBasicMaterial({
        vertexColors: colored,
        color: colored ? 0xffffff : color,
        transparent: true,
        opacity: xray ? 0.35 : 0.75,
        depthWrite: false,
        depthTest: !xray,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      }),
    );
    mesh.renderOrder = 3;
    return mesh;
  }

  /**
   * The selection, or the floating content and the selection travelling with it. Moving
   * floating content only repositions its meshes.
   */
  private rebuildSelection() {
    const editor = this.editor;
    const floating = untrack(() => editor.floating);
    const palette = untrack(() => editor.palette);
    const accent = this.theme.accent;

    this.selectionGroup.visible = this.contentShown && !untrack(() => editor.playing);
    this.floatOverlay.visible = !untrack(() => editor.playing);
    clearGroup(this.selectionGroup);
    if (!floating) {
      clearGroup(this.floatGroup, this.floatOverlay);
      clearGroup(this.floatOverlay);
      this.floatBuilt = null;
      const mask = untrack(() => editor.selectionMask);
      if (untrack(() => editor.hasSelection)) {
        this.selectionGroup.add(this.selectionOverlay(mask, untrack(() => editor.size)));
        const bounds = untrack(() => editor.selectionBounds());
        if (bounds) this.selectionGroup.add(outlineBoxes([bounds], accent, 0.35));
      }
      return this.requestRender();
    }

    const built = this.floatBuilt;
    if (!built || built.voxels !== floating.voxels || built.mask !== floating.mask || built.palette !== palette) {
      this.buildFloat(floating, palette);
      this.floatBuilt = { voxels: floating.voxels, mask: floating.mask, palette, accent };
    }
    this.floatGroup.position.set(...floating.offset);
    this.requestRender();
  }

  private buildFloat(floating: Floating, palette: readonly number[]) {
    clearGroup(this.floatGroup, this.floatOverlay);
    clearGroup(this.floatOverlay);
    const geometry = this.mesher.build(floating.voxels, floating.size, palette);
    // drawn over the source it may still overlap (a duplicate in place)
    const voxels = new Mesh(
      geometry,
      new MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
    );
    this.floatGroup.add(voxels);
    this.floatOverlay.add(this.selectionOverlay(floating.mask, floating.size));
    const box: Box = { min: [0, 0, 0], max: floating.size.map((n) => n - 1) as Vec3 };
    this.floatOverlay.add(outlineBoxes([box], this.theme.accent, 0.8));
  }

  /** A tint over the surface of the selected cells, plus a faint copy seen through the model. */
  private selectionOverlay(mask: Uint8Array, size: Vec3) {
    const accent = new Color(this.theme.accent).getHex();
    const geometry = this.mesher.build(mask, size, [0, accent], MESH_NO_AO);
    const surface = new Mesh(
      geometry,
      new MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -4,
      }),
    );
    surface.renderOrder = 2;
    const xray = new Mesh(
      geometry,
      new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.12, depthTest: false, depthWrite: false }),
    );
    xray.renderOrder = 1;
    const group = new Group();
    group.add(xray, surface);
    return group;
  }

  /** Grab handles for the pending shape, drawn on top at a constant screen size. */
  private rebuildHandles(shape: PendingShape | null) {
    for (const child of [...this.handleGroup.children]) {
      this.handleGroup.remove(child);
      disposeObject(child);
    }
    // a shape being drawn has no handles until it is made; one edited in place has its own, not its box's
    const handles = shape && !shape.drawing && !shape.editing ? this.faceHandles(shape) : null;
    this.handleFacing = handles && handles.map((h) => (h.front ? "1" : "0")).join("");
    const depth = untrack(() => this.editor.extrusionHandle());
    if (shape && !shape.drawing) {
      // the faces turned away still have handles, fainter and smaller, behind the ones in front
      const back = (handles ?? []).filter((h) => !h.front).flatMap((h) => h.point);
      const front = (handles ?? []).filter((h) => h.front).flatMap((h) => h.point);
      if (back.length) this.handleGroup.add(this.pivotPoints(back, HANDLE_SIZE * 0.75, 0.45));
      if (front.length) this.handleGroup.add(this.pivotPoints(front, HANDLE_SIZE, 1));
      // a selected step's settings (taper, edge radius, tube, wall) in their own color; a path's
      // points, the picked one bigger, and fainter "+"s between them
      const all = untrack(() => this.editor.shapeParamHandles);
      const picked = untrack(() => this.editor.selectedPathPoint);
      const of = (test: (id: string) => boolean) => all.filter((h) => test(h.id)).flatMap((h) => h.point);
      const params = of((id) => id.startsWith("param-"));
      const points = of((id) => id.startsWith("point-") && id !== `point-${picked}`);
      const inserts = of((id) => id.startsWith("insert-"));
      if (params.length) this.handleGroup.add(this.pivotPoints(params, HANDLE_SIZE * 0.85, 1, PARAM_COLOR));
      if (inserts.length) this.handleGroup.add(this.pivotPoints(inserts, HANDLE_SIZE * 0.6, 0.55));
      if (points.length) this.handleGroup.add(this.pivotPoints(points, HANDLE_SIZE, 1));
      const chosen = picked === null ? undefined : all.find((h) => h.id === `point-${picked}`);
      if (chosen) this.handleGroup.add(this.pivotPoints([...chosen.point], HANDLE_SIZE * 1.3, 1, PARAM_COLOR));
    } else if (depth) {
      this.handleGroup.add(this.pivotPoints([...depth], HANDLE_SIZE, 1));
    }
    this.requestRender();
  }

  /**
   * Markers, while the marker bar is open or View → Markers is on: points as small axes (up the
   * longest) with a dot, volumes as wireframes, each in its role's color. The marker being placed
   * is brighter; with the bar open, the origin shows too.
   */
  private rebuildMarkers() {
    clearGroup(this.rigGroup);
    const editor = this.editor;
    const editing = untrack(() => editor.markerEditing);
    if (!editing && !untrack(() => editor.markersShown)) return this.requestRender();
    const markers = untrack(() => editor.markers);
    const target = untrack(() => editor.markerTarget);
    const r = untrack(() => editor.resolution);
    const accent = this.theme.accent;
    for (const marker of markers) {
      const placement = untrack(() => editor.shownMarker(marker.id));
      if (!placement || placement.hidden) continue;
      const color = markerColor(marker.role, accent);
      const active = marker.id === target;
      const opacity = active || !editing ? 1 : 0.55;
      const { shape } = placement;
      if (shape.kind === "volume") {
        this.rigGroup.add(outlineBoxes([sourceOutline(shape.shape, r)], color, active ? 0.95 : 0.6));
        continue;
      }
      const at = shape.at.map((n) => n * r) as Vec3;
      const [x, y, z] = markerAxes(shape);
      const reach = active ? 1.4 : 1;
      const lines: number[] = [];
      for (const [axis, length] of [[x, 0.5], [y, 1], [z, 0.6]] as const) {
        lines.push(...at, ...at.map((n, a) => n + axis[a] * length * reach));
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new Float32BufferAttribute(lines, 3));
      const axes = new LineSegments(geometry, new LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false }));
      axes.renderOrder = 9;
      this.rigGroup.add(axes);
      this.rigGroup.add(this.pivotPoints([...at], HANDLE_SIZE * (active ? 1.2 : 0.8), opacity, color));
    }
    if (editing) {
      const origin = untrack(() => editor.shownOrigin).map((n) => n * r);
      this.rigGroup.add(this.pivotPoints(origin, HANDLE_SIZE * (target === ORIGIN ? 1.3 : 0.8), target === ORIGIN ? 1 : 0.5, "#ffffff"));
    }
    this.requestRender();
  }

  private pivotPoints(positions: number[], size: number, opacity: number, color?: string) {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    const points = new Points(
      geometry,
      new PointsMaterial({
        size,
        sizeAttenuation: false,
        map: this.handleMap(),
        transparent: true,
        opacity,
        depthTest: false,
        depthWrite: false,
        ...(color ? { color } : {}),
      }),
    );
    points.renderOrder = 10;
    return points;
  }

  private handleMap() {
    if (this.handleTexture) return this.handleTexture;
    const n = 64;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = n;
    const ctx = canvas.getContext("2d")!;
    ctx.beginPath();
    ctx.arc(n / 2, n / 2, n / 2 - 6, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 9;
    ctx.strokeStyle = this.theme.accent;
    ctx.stroke();
    this.handleTexture = new CanvasTexture(canvas);
    return this.handleTexture;
  }

  /** A handle on each face of the pending shape's box, and whether its face is turned toward the camera. */
  private faceHandles(shape: PendingShape) {
    // a path's box scales and moves its points like any shape's; the points themselves are edited in place
    const camera = this.orbit.camera;
    const ortho = camera instanceof OrthographicCamera;
    const forward = camera.getWorldDirection(new Vector3());
    return shapeHandles(shape).map((h) => {
      const { axis, sign } = h.normal;
      // an orthographic camera looks the same way everywhere; a perspective one from its position
      const toward = ortho ? -forward.getComponent(axis) : camera.position.getComponent(axis) - h.point[axis];
      return { ...h, front: toward * sign > 0 };
    });
  }

  /** The handle nearest a screen point, if one is within reach: a pending shape's or extrusion's, or the gizmo's. */
  private handleAt(e: PointerEvent): Handle | undefined {
    const editor = this.editor;
    const shape = editor.pendingShape;
    const depth = editor.extrusionHandle();
    const handles: { id: Handle; point: Vec3; front?: boolean }[] = shape
      ? shape.drawing
        ? []
        : shape.editing
          ? editor.shapeParamHandles
          : [...editor.shapeParamHandles, ...this.faceHandles(shape)]
      : depth
        ? [{ id: "depth", point: depth }]
        : [];
    // fingers get a full hit target around the drawn dot
    const reach = e.pointerType === "mouse" ? HANDLE_SIZE : TOUCH_REACH;
    let best: Handle | undefined;
    let bestDistance = reach;
    for (const handle of handles) {
      const p = this.toScreen(new Vector3(...handle.point));
      if (!p) continue;
      // where a handle in front and one behind overlap, the one in front wins
      const distance = Math.hypot(p.x - e.clientX, p.y - e.clientY) + (handle.front === false ? reach / 2 : 0);
      if (distance < bestDistance) {
        best = handle.id;
        bestDistance = distance;
      }
    }
    const reachLine = e.pointerType === "mouse" ? 10 : TOUCH_REACH;
    return best ?? this.gizmoAt(e.clientX, e.clientY, reachLine) ?? this.planeArrowAt(e.clientX, e.clientY, reachLine);
  }

  /** A point in grid units, in client pixels; null when it is behind the camera. */
  private toScreen(point: Vector3): Vector2 | null {
    const p = point.clone().project(this.orbit.camera);
    if (p.z > 1) return null;
    const rect = this.canvas.getBoundingClientRect();
    return new Vector2(rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height);
  }

  // #endregion

  // #region Gizmo

  /** Grid units per CSS pixel at a point, so the gizmo keeps its size on screen. */
  private pixelSize(at: Vector3): number {
    const camera = this.orbit.camera;
    const height = this.canvas.clientHeight || 1;
    if (camera instanceof OrthographicCamera) return (camera.top - camera.bottom) / camera.zoom / height;
    const forward = camera.getWorldDirection(new Vector3());
    const depth = Math.max(0.01, at.clone().sub(camera.position).dot(forward));
    return (2 * depth * Math.tan((camera.fov * Math.PI) / 360)) / height;
  }

  /** How squarely the camera looks along an axis: 1 head-on, 0 side-on. */
  private facing(axis: Axis) {
    const forward = this.orbit.camera.getWorldDirection(new Vector3());
    return Math.abs(forward.getComponent(axis));
  }

  /** Arrows that point (nearly) at the camera are too short to drag; rings seen edge-on are too thin. */
  private gizmoUsable(handle: GizmoHandle) {
    // a shape moves by its body and resizes by its face handles; the gizmo only turns it
    if (handle.startsWith("move") && untrack(() => this.editor.pendingShape)) return false;
    const axis = Number(handle.split("-")[1]) as Axis;
    const facing = this.facing(axis);
    return handle.startsWith("move") ? facing < 0.96 : facing > 0.12;
  }

  /** Build the gizmo's arrows and rings once per theme, in pixel units; `placeGizmo` scales them. */
  private buildGizmo() {
    clearGroup(this.gizmoGroup);
    this.gizmoParts.clear();
    const material = (color: string) =>
      new MeshBasicMaterial({ color, transparent: true, depthTest: false, depthWrite: false });
    for (const axis of [0, 1, 2] as Axis[]) {
      const color = AXIS_COLORS[axis];
      // arrows are built along +Y, rings around Z, then turned onto their axis
      const arrow = new Group();
      const length = GIZMO.arrowTo - GIZMO.arrowFrom;
      const shaft = new Mesh(new CylinderGeometry(GIZMO.shaft, GIZMO.shaft, length, 8), material(color));
      shaft.position.y = GIZMO.arrowFrom + length / 2;
      const head = new Mesh(new ConeGeometry(GIZMO.headRadius, GIZMO.head, 16), material(color));
      head.position.y = GIZMO.arrowTo + GIZMO.head / 2;
      arrow.add(shaft, head);
      if (axis === 0) arrow.rotation.z = -Math.PI / 2;
      if (axis === 2) arrow.rotation.x = Math.PI / 2;

      const ring = new Group();
      ring.add(new Mesh(new TorusGeometry(GIZMO.ring, GIZMO.tube, 6, 96), material(color)));
      if (axis === 0) ring.rotation.y = Math.PI / 2;
      if (axis === 1) ring.rotation.x = Math.PI / 2;

      for (const [id, part] of [
        [`move-${axis}`, arrow],
        [`rotate-${axis}`, ring],
      ] as const) {
        part.traverse((o) => (o.renderOrder = 12));
        this.gizmoParts.set(id, part);
        this.gizmoGroup.add(part);
      }
    }
    this.gizmoGroup.visible = false;
  }

  /** Put the gizmo on its content at a constant screen size, showing what can be grabbed. */
  private placeGizmo() {
    const gizmo = this.editor.playing ? null : this.gizmo;
    this.gizmoGroup.visible = !!gizmo && this.contentShown;
    if (!gizmo) return;
    this.gizmoGroup.position.copy(gizmo.center);
    this.gizmoGroup.scale.setScalar(this.pixelSize(gizmo.center));
    const active = this.gizmoDrag ?? this.gizmoHover;
    for (const [id, part] of this.gizmoParts) {
      // while dragging, only the handle in use shows
      part.visible = this.gizmoDrag ? id === this.gizmoDrag : this.gizmoUsable(id);
      const lit = id === active;
      part.traverse((o) => {
        const m = (o as Mesh).material as MeshBasicMaterial | undefined;
        if (!m) return;
        m.opacity = lit ? 1 : id.startsWith("rotate") ? 0.55 : 0.85;
        m.color.set(AXIS_COLORS[Number(id.split("-")[1])]);
        if (lit) m.color.lerp(new Color("#ffffff"), 0.35);
      });
    }
  }

  /** The gizmo handle within `reach` CSS pixels of a client point, nearest first. */
  private gizmoAt(x: number, y: number, reach: number): GizmoHandle | undefined {
    const gizmo = this.gizmo;
    if (!gizmo) return undefined;
    const c = gizmo.center;
    const px = this.pixelSize(c);
    const pointer = new Vector2(x, y);
    let best: GizmoHandle | undefined;
    let bestDistance = reach;
    const consider = (id: GizmoHandle, points: (Vector2 | null)[]) => {
      if (!this.gizmoUsable(id)) return;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        if (!a || !b) continue;
        const distance = segmentDistance(pointer, a, b);
        if (distance < bestDistance) {
          best = id;
          bestDistance = distance;
        }
      }
    };
    for (const axis of [0, 1, 2] as Axis[]) {
      const along = (n: number) => {
        const p = c.clone();
        p.setComponent(axis, p.getComponent(axis) + n * px);
        return this.toScreen(p);
      };
      consider(`move-${axis}`, [along(GIZMO.arrowFrom), along(GIZMO.arrowTo + GIZMO.head)]);
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;
      const ring: (Vector2 | null)[] = [];
      for (let i = 0; i <= 48; i++) {
        const t = (i / 48) * Math.PI * 2;
        const p = c.clone();
        p.setComponent(u, p.getComponent(u) + Math.cos(t) * GIZMO.ring * px);
        p.setComponent(v, p.getComponent(v) + Math.sin(t) * GIZMO.ring * px);
        ring.push(this.toScreen(p));
      }
      consider(`rotate-${axis}`, ring);
    }
    return best;
  }

  private setGizmoHover(handle: GizmoHandle | null) {
    if (handle === this.gizmoHover) return;
    this.gizmoHover = handle;
    this.requestRender();
  }

  /** Show or hide the workplane's arrow; the editor shows it while the workplane panel is open. */
  setWorkplaneHandle(shown: boolean) {
    this.planeArrowShown = shown;
    this.requestRender();
  }

  private buildPlaneArrow() {
    clearGroup(this.planeArrow);
    const material = () =>
      new MeshBasicMaterial({ color: this.theme.accent, transparent: true, depthTest: false, depthWrite: false });
    const shaftLength = 2 * (PLANE_ARROW.length - PLANE_ARROW.head);
    this.planeArrow.add(new Mesh(new CylinderGeometry(PLANE_ARROW.shaft, PLANE_ARROW.shaft, shaftLength, 8), material()));
    for (const sign of [1, -1]) {
      const head = new Mesh(new ConeGeometry(PLANE_ARROW.headRadius, PLANE_ARROW.head, 16), material());
      head.position.y = sign * (PLANE_ARROW.length - PLANE_ARROW.head / 2);
      if (sign < 0) head.rotation.z = Math.PI;
      this.planeArrow.add(head);
    }
    this.planeArrow.traverse((o) => (o.renderOrder = 12));
    this.planeArrow.visible = false;
  }

  /** Where the workplane's arrow is, when it can be grabbed: not head-on, and not while something else has the pointer. */
  private planeArrowPoint(): Vector3 | null {
    const editor = this.editor;
    if (!this.planeArrowShown || this.gizmo) return null;
    if (untrack(() => editor.markerEditing || editor.pendingShape || editor.pendingExtrusion)) return null;
    const axis = untrack(() => editor.workplane.axis);
    if (!this.planeArrowDrag && this.facing(axis) >= 0.96) return null;
    const eye = this.orbit.camera.position;
    return new Vector3(...untrack(() => editor.workplaneHandle([eye.x, eye.y, eye.z])));
  }

  private placePlaneArrow() {
    const point = this.planeArrowPoint();
    this.planeArrow.visible = !!point && this.contentShown;
    if (!point) return;
    const axis = untrack(() => this.editor.workplane.axis);
    this.planeArrow.position.copy(point);
    this.planeArrow.scale.setScalar(this.pixelSize(point));
    // built along +Y
    this.planeArrow.rotation.set(axis === 2 ? Math.PI / 2 : 0, 0, axis === 0 ? -Math.PI / 2 : 0);
    const lit = this.planeArrowHover || this.planeArrowDrag;
    this.planeArrow.traverse((o) => {
      const m = (o as Mesh).material as MeshBasicMaterial | undefined;
      if (m) m.opacity = lit ? 1 : 0.75;
    });
  }

  private planeArrowAt(x: number, y: number, reach: number): "workplane" | undefined {
    const point = this.planeArrowPoint();
    if (!point) return undefined;
    const axis = untrack(() => this.editor.workplane.axis);
    const px = this.pixelSize(point);
    const end = (sign: number) => {
      const p = point.clone();
      p.setComponent(axis, p.getComponent(axis) + sign * PLANE_ARROW.length * px);
      return this.toScreen(p);
    };
    const a = end(-1);
    const b = end(1);
    if (!a || !b) return undefined;
    return segmentDistance(new Vector2(x, y), a, b) < reach ? "workplane" : undefined;
  }

  /** Whether the pointer is over content a drag would move: floating content, or the move tool's target. */
  private movableAt(input: PointerInput) {
    const editor = this.editor;
    if (editor.floating) return !!editor.pickFloating(input.ray);
    if (editor.tool !== "move") return false;
    return !!(editor.hasSelection ? editor.pickSelection(input.ray) : editor.pickActive(input.ray));
  }

  // #endregion

  // #region Input

  private rayAt(clientX: number, clientY: number): PointerInput["ray"] {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const raycaster = new Raycaster();
    raycaster.setFromCamera(ndc, this.orbit.camera);
    const { origin, direction } = raycaster.ray;
    return { origin: [origin.x, origin.y, origin.z], dir: [direction.x, direction.y, direction.z] };
  }

  private input(e: PointerEvent | MouseEvent): PointerInput {
    const hover = !("pointerType" in e) || e.pointerType === "mouse";
    return { ray: this.rayAt(e.clientX, e.clientY), shift: e.shiftKey, alt: e.altKey, mod: e.ctrlKey || e.metaKey, hover };
  }

  private attachInput() {
    const canvas = this.canvas;
    const listen = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window,
      type: K,
      handler: (e: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, handler as EventListener, options);
      this.disposers.push(() => target.removeEventListener(type, handler as EventListener, options));
    };

    listen(canvas, "pointerdown", (e) => this.onPointerDown(e));
    listen(canvas, "pointermove", (e) => this.onPointerMove(e));
    listen(canvas, "pointerup", (e) => this.onPointerUp(e));
    listen(canvas, "pointercancel", (e) => this.onPointerUp(e, true));
    listen(canvas, "pointerleave", (e) => {
      if (e.pointerType !== "mouse" || this.gesture.kind !== "none") return;
      this.editor.pointerHover(null);
      this.pointerLayer?.hover?.(null, null);
      this.setGizmoHover(null);
    });

    listen(canvas, "contextmenu", (e) => e.preventDefault());
    listen(canvas, "wheel", (e) => this.onWheel(e), { passive: false });
    listen(window, "keydown", (e) => {
      if (e.code === "Space" && !isTyping(e)) this.spaceHeld = true;
    });
    listen(window, "keyup", (e) => {
      if (e.code === "Space") this.spaceHeld = false;
    });
    listen(window, "blur", () => {
      this.spaceHeld = false;
      this.cancelGesture();
    });
  }

  private onPointerDown(e: PointerEvent) {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

    if (this.pointers.size >= 2) {
      // a second finger turns any gesture into pinch/pan, undoing a started stroke
      if (this.gesture.kind === "tool") this.editor.cancelPointer();
      if (this.gesture.kind === "layer") this.pointerLayer?.cancel?.();
      this.gizmoDrag = null;
      this.planeArrowDrag = false;
      const [a, b] = [...this.pointers.values()];
      this.gesture = {
        kind: "pinch",
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        mid: new Vector2((a.x + b.x) / 2, (a.y + b.y) / 2),
      };
      this.editor.pointerHover(null);
      return;
    }

    const id = e.pointerId;
    if (e.button === 1 || (e.button === 2 && e.shiftKey) || (e.button === 0 && this.spaceHeld)) {
      this.gesture = { kind: "pan", pointerId: id };
    } else if (e.button === 2) {
      // a right drag orbits; a right click cancels what the tool is in the middle of
      this.gesture = { kind: "orbit", pointerId: id, tap: { x: e.clientX, y: e.clientY }, secondary: true };
    } else if (e.button === 0 && this.pointerLayer?.down(this.input(e), e)) {
      this.gesture = { kind: "layer", pointerId: id };
    } else if (e.button === 0 && !this.contentShown) {
      this.gesture = { kind: "orbit", pointerId: id, tap: { x: e.clientX, y: e.clientY } };
    } else if (e.button === 0) {
      const input = this.input(e);
      input.handle = this.handleAt(e);
      const handled = this.editor.pointerDown(input);
      this.gizmoDrag = handled && isGizmo(input.handle) && this.editor.floating ? input.handle : null;
      this.planeArrowDrag = handled && input.handle === "workplane";
      this.gesture = handled
        ? { kind: "tool", pointerId: id }
        : { kind: "orbit", pointerId: id, tap: { x: e.clientX, y: e.clientY } };
    }
    const grabbing =
      this.gesture.kind === "pan" ||
      (this.gesture.kind === "tool" &&
        (this.planeArrowDrag || this.editor.pendingShape || this.editor.floating || this.editor.pendingExtrusion));
    this.canvas.style.cursor = grabbing ? "grabbing" : "";
    this.requestRender();
  }

  private onPointerMove(e: PointerEvent) {
    const prev = this.pointers.get(e.pointerId);
    const g = this.gesture;

    if (!prev) {
      if (e.pointerType === "mouse" && g.kind === "none") {
        const input = this.input(e);
        if (this.pointerLayer?.hover?.(input, e)) {
          this.canvas.style.cursor = "grab";
          this.editor.pointerHover(null);
          return;
        }
        if (!this.contentShown) {
          this.canvas.style.cursor = "";
          return;
        }
        this.editor.pointerHover(input);
        const handle = this.handleAt(e);
        this.setGizmoHover(isGizmo(handle) ? handle : null);
        if (this.planeArrowHover !== (handle === "workplane")) {
          this.planeArrowHover = handle === "workplane";
          this.requestRender();
        }
        this.canvas.style.cursor = handle || this.movableAt(input) ? "grab" : "";
      }
      return;
    }

    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

    switch (g.kind) {
      case "tool":
        if (g.pointerId === e.pointerId) this.editor.pointerMove(this.input(e));
        break;
      case "layer":
        if (g.pointerId === e.pointerId) this.pointerLayer?.move?.(this.input(e), e);
        break;
      case "orbit":
        if (g.pointerId !== e.pointerId) break;
        if (g.tap && Math.hypot(e.clientX - g.tap.x, e.clientY - g.tap.y) <= TAP_SLOP) break;
        g.tap = undefined;
        // the 2D view doesn't turn: a drag off the model pans instead
        if (untrack(() => this.editor.mode2D)) this.orbit.pan(dx, dy, this.canvas.clientHeight);
        else this.orbit.orbit(-dx * 0.008, dy * 0.008);
        break;
      case "pan":
        if (g.pointerId === e.pointerId) this.orbit.pan(dx, dy, this.canvas.clientHeight);
        break;
      case "pinch": {
        const [a, b] = [...this.pointers.values()];
        if (!a || !b) break;
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = new Vector2((a.x + b.x) / 2, (a.y + b.y) / 2);
        if (g.distance > 0 && distance > 0) this.orbit.zoom(g.distance / distance);
        this.orbit.pan(mid.x - g.mid.x, mid.y - g.mid.y, this.canvas.clientHeight);
        g.distance = distance;
        g.mid = mid;
        break;
      }
    }
    this.requestRender();
  }

  private onPointerUp(e: PointerEvent, cancelled = false) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    const g = this.gesture;

    if (g.kind === "tool" && g.pointerId === e.pointerId) {
      if (cancelled) this.editor.cancelPointer();
      else this.editor.pointerUp();
    }
    if (g.kind === "layer" && g.pointerId === e.pointerId) {
      if (cancelled) this.pointerLayer?.cancel?.();
      else this.pointerLayer?.up?.(this.input(e), e);
    }
    // a tap (not a drag) on empty space
    if (g.kind === "orbit" && g.tap && g.pointerId === e.pointerId && !cancelled) {
      if (g.secondary) {
        this.editor.cancelPointer();
      } else {
        this.pointerLayer?.tap?.(this.input(e));
        if (this.contentShown) this.editor.pointerTap();
      }
    }

    if (this.pointers.size === 0) {
      this.gesture = { kind: "none" };
      this.gizmoDrag = null;
      this.planeArrowDrag = false;
      this.canvas.style.cursor = "";
      if (e.pointerType === "mouse" && this.contentShown) this.editor.pointerHover(this.input(e));
    } else if (g.kind === "pinch") {
      this.gesture = { kind: "idle" };
    }
    this.requestRender();
  }

  private cancelGesture() {
    if (this.gesture.kind === "tool") this.editor.cancelPointer();
    if (this.gesture.kind === "layer") this.pointerLayer?.cancel?.();
    this.gizmoDrag = null;
    this.planeArrowDrag = false;
    this.gesture = { kind: "none" };
    this.pointers.clear();
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    // trackpad pinch arrives as ctrl+wheel with small deltas
    const scale = e.ctrlKey ? 0.01 : 0.0015;
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.orbit.zoom(Math.exp(delta * scale));
    this.requestRender();
  }

  // #endregion

  private insets = { top: 0, bottom: 0 };

  /**
   * Keep the model clear of panels over the canvas's top and bottom edges (CSS pixels; a phone's
   * bottom sheet): the view's middle moves to the middle of the space between them, and Zoom to
   * fit fits into it.
   */
  setInsets(top: number, bottom: number) {
    if (top === this.insets.top && bottom === this.insets.bottom) return;
    this.insets = { top, bottom };
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (w && h) this.orbit.setInsets(top, bottom, w, h);
    this.requestRender();
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.orbit.setAspect(w / h);
    this.orbit.setInsets(this.insets.top, this.insets.bottom, w, h);
    this.requestRender();
  }

  private loop = () => {
    this.frame = requestAnimationFrame(this.loop);
    if (!this.needsRender) return;
    this.needsRender = false;
    // orbiting around the shape brings the handles of the faces now in view to the front
    if (this.handleFacing) {
      const shape = untrack(() => this.editor.pendingShape);
      const facing = shape && this.faceHandles(shape).map((h) => (h.front ? "1" : "0")).join("");
      if (shape && facing !== this.handleFacing) this.rebuildHandles(shape);
    }
    for (const fn of this.beforeRender) fn();
    this.placeGizmo();
    this.placePlaneArrow();
    // orbiting across the workplane shows what is clipped on the other side
    if (this.editor.workplane.clip !== "none" && this.viewSide() !== this.clippedSide) this.rebuildClipped();
    this.renderer.render(this.scene, this.orbit.camera);
    this.renderThumbnail();
  };
}

function isGizmo(handle: Handle | undefined): handle is GizmoHandle {
  return !!handle && (handle.startsWith("move-") || handle.startsWith("rotate-"));
}

/** Distance from a point to the segment ab, in the same units. */
function segmentDistance(p: Vector2, a: Vector2, b: Vector2) {
  const ab = b.clone().sub(a);
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / Math.max(1e-9, ab.lengthSq())));
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

/** Grid lines covering the face of the volume perpendicular to `axis`, at `layer`. */
function gridLines(axis: number, layer: number, size: Vec3, color: string, strong: string, opacity = 1, onTop = false) {
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  const minor: number[] = [];
  const major: number[] = [];
  const point = (pu: number, pv: number) => {
    const p = [0, 0, 0];
    p[axis] = layer;
    p[u] = pu;
    p[v] = pv;
    return p;
  };
  for (let i = 0; i <= size[u]; i++) {
    const target = i % 8 === 0 || i === size[u] ? major : minor;
    target.push(...point(i, 0), ...point(i, size[v]));
  }
  for (let j = 0; j <= size[v]; j++) {
    const target = j % 8 === 0 || j === size[v] ? major : minor;
    target.push(...point(0, j), ...point(size[u], j));
  }
  const group = new Group();
  for (const [positions, c] of [
    [minor, color],
    [major, strong],
  ] as const) {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    const lines = new LineSegments(
      geometry,
      new LineBasicMaterial({ color: c, transparent: opacity < 1, opacity, depthTest: !onTop, depthWrite: !onTop }),
    );
    if (onTop) lines.renderOrder = 11;
    group.add(lines);
  }
  return group;
}

function clearGroup(group: Group, keep?: Group) {
  for (const child of [...group.children]) {
    if (child === keep) continue;
    group.remove(child);
    disposeObject(child);
  }
}

/** What a marker is drawn in: its role's color. */
function markerColor(role: string | undefined, accent: string): string {
  switch (role) {
    case "mount":
      return accent;
    case "collision":
      return "#38bdf8";
    case "hitbox":
      return "#ef4444";
    case "hurtbox":
      return "#22c55e";
    default:
      return "#a78bfa";
  }
}

function outlineBoxes(boxes: Box[], color: string, opacity = 0.6) {
  const edges: number[] = [];
  for (const { min, max } of boxes) pushBox([], edges, min, [max[0] + 1, max[1] + 1, max[2] + 1]);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(edges, 3));
  // drawn through the model, so a shape's extent stays readable when it is partly buried
  const lines = new LineSegments(
    geometry,
    new LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false }),
  );
  lines.renderOrder = 5;
  return lines;
}

function pushBox(fill: number[], edges: number[], a: number[], b: number[]) {
  const c = (i: number) => [i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]];
  // faces as quads of corner ids (CCW from outside)
  const faces = [
    [0, 4, 6, 2],
    [1, 3, 7, 5],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 2, 3, 1],
    [4, 5, 7, 6],
  ];
  for (const [p, q, r, s] of faces) fill.push(...c(p), ...c(q), ...c(r), ...c(p), ...c(r), ...c(s));
  const lines = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  for (const [p, q] of lines) edges.push(...c(p), ...c(q));
}

function disposeObject(object: { traverse?: (fn: (o: unknown) => void) => void }) {
  object.traverse?.((o) => {
    const m = o as Mesh;
    m.geometry?.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}
