import {
  BufferGeometry,
  Color,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  NoColorSpace,
  PerspectiveCamera,
  Quaternion,
  RingGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  LinearSRGBColorSpace,
  type ColorSpace,
  type Object3D,
} from "three";
import { bindHand, XRHand } from "./input";
import { Router, type RouterOptions } from "./interaction";
import { xrMode, type XRMode } from "./support";
import { TOUCH } from "./surface";
import { XRWindows, type Viewer } from "./windows";

export interface XRShellOptions {
  /** Defaults to what `xrMode` finds: passthrough if the browser has it, else a virtual room. */
  mode?: XRMode;
  /**
   * How colors go out. "srgb" (the default) for ordinary materials and textures; "baked" for
   * colors already in display space (vertex colors baked by a mesher), which go out as they are.
   * Panels follow.
   */
  colors?: "srgb" | "baked";
  /** The room's color where there is no passthrough. */
  background?: number;
  /** The router's rules (see `RouterOptions`). */
  routing?: RouterOptions;
  /** Where which windows are open is kept on this device. */
  windowsKey?: string;
  optionalFeatures?: string[];
}

export interface FrameInfo {
  /** Seconds since the last frame (at most 0.1). */
  dt: number;
  /** The session's time (ms). */
  time: number;
  frame: XRFrame | undefined;
  viewer: Viewer | null;
}

type FrameFn = (info: FrameInfo) => void;

/** Start a headset session and the shell around it. */
export async function startXR(options: XRShellOptions = {}): Promise<XRShell> {
  const mode = options.mode ?? (await xrMode());
  if (!mode) throw new Error("This browser can't show a headset view");
  const session = await navigator.xr!.requestSession(mode, {
    requiredFeatures: ["local-floor"],
    optionalFeatures: ["hand-tracking", ...(options.optionalFeatures ?? [])],
  });
  return new XRShell(session, mode, options);
}

/**
 * A WebXR session with what any headset UI on it needs: the renderer and frame loop, both hands
 * (`XRHand`), the router that decides what each hand works (`Router`), windows in the room
 * (`XRWindows`), and the feedback for them (a pointer ray, a fingertip cursor). An app adds its
 * own objects to `scene`, its own targets to `router` (its tool goes in at the lowest reach,
 * "free"), and runs per frame through `onFrame`. Everything that interrupts input (the session
 * hidden, an input gone, the session ended) takes back what hands were doing, in one place.
 */
export class XRShell {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(70, 1, 0.01, 200);
  readonly hands: XRHand[] = [new XRHand(0), new XRHand(1)];
  readonly router: Router;
  readonly windows: XRWindows;
  /** How panels' canvases are read, to match how the shell renders. */
  readonly panelColorSpace: ColorSpace;
  private canvas = document.createElement("canvas");
  private spaces: ReturnType<typeof bindHand>[] = [];
  private pointers: Line[] = [];
  private cursors: Mesh[] = [];
  private before = new Set<FrameFn>();
  private after = new Set<FrameFn>();
  private connects = new Set<(hand: XRHand) => void>();
  private ends = new Set<() => void>();
  private lastFrame = 0;
  private ended = false;
  private seen: Viewer | null = null;

  constructor(
    readonly session: XRSession,
    readonly mode: XRMode,
    options: XRShellOptions = {},
  ) {
    // a headset shows the session itself; an emulator (IWER) draws it here, over the page
    const background = options.background ?? 0x1b1c20;
    Object.assign(this.canvas.style, { position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: "1000", background: `#${background.toString(16).padStart(6, "0")}` });
    document.body.append(this.canvas);
    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    const baked = options.colors === "baked";
    this.renderer.outputColorSpace = baked ? LinearSRGBColorSpace : SRGBColorSpace;
    this.panelColorSpace = baked ? NoColorSpace : SRGBColorSpace;
    this.renderer.setClearColor(new Color(background), mode === "immersive-ar" ? 0 : 1);
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType("local-floor");
    this.scene.add(this.camera);

    this.router = new Router(this.hands, options.routing);
    this.windows = new XRWindows(
      { scene: this.scene, router: this.router, viewer: () => this.seen, colorSpace: this.panelColorSpace },
      options.windowsKey,
    );

    for (const hand of this.hands) {
      const space = bindHand(this.renderer, hand, this.scene, {
        connect: (h) => this.connects.forEach((fn) => fn(h)),
        // an input going away takes back what it was doing
        disconnect: (h) => this.router.cancel(h),
        down: (h, trigger) => this.router.press(h, trigger),
        up: (h, trigger) => this.router.release(h, trigger),
      });
      this.spaces.push(space);
      const pointer = new Line(
        new BufferGeometry().setFromPoints([new Vector3(0, 0, 0), new Vector3(0, 0, -1)]),
        new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }),
      );
      pointer.visible = false;
      space.raySpace.add(pointer);
      this.pointers.push(pointer);
      const cursor = new Mesh(
        new RingGeometry(0.004, 0.0055, 32),
        new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }),
      );
      cursor.visible = false;
      cursor.renderOrder = 11;
      cursor.matrixAutoUpdate = false;
      this.scene.add(cursor);
      this.cursors.push(cursor);
    }

    session.addEventListener("end", () => this.cleanup());
    session.addEventListener("visibilitychange", () => {
      // the system menu, or the headset taken off: whatever the hands were doing is taken back
      if (session.visibilityState !== "visible") this.router.cancelAll();
    });
    void this.renderer.xr.setSession(session).then(() => this.renderer.setAnimationLoop((t, f) => this.frame(t, f)));
  }

  /** Where the viewer is and looks, once the session knows. */
  viewer(): Viewer | null {
    return this.seen;
  }

  /**
   * Run `fn` every frame: after the router (captures followed, focus found) by default; with
   * `beforeInput`, after the hands' poses but before the router, to move what they work.
   */
  onFrame(fn: FrameFn, options: { beforeInput?: boolean } = {}) {
    const set = options.beforeInput ? this.before : this.after;
    set.add(fn);
    return () => set.delete(fn);
  }

  /** When a controller or hand connects (they come and go as Quest switches between them). */
  onConnect(fn: (hand: XRHand) => void) {
    this.connects.add(fn);
    return () => this.connects.delete(fn);
  }

  /** Once the session is over, however it ended. */
  onEnd(fn: () => void) {
    this.ends.add(fn);
    return () => this.ends.delete(fn);
  }

  end() {
    if (!this.ended) void this.session.end().catch(() => this.cleanup());
  }

  private frame(time: number, xrFrame: XRFrame | undefined) {
    const now = performance.now();
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    this.seen = this.readViewer(xrFrame) ?? this.seen;
    for (const space of this.spaces) space.update(time);
    const info: FrameInfo = { dt, time, frame: xrFrame, viewer: this.seen };
    for (const fn of this.before) fn(info);
    this.scene.updateMatrixWorld();
    this.windows.frame();
    this.router.update(dt);
    for (const fn of this.after) fn(info);
    this.feedback();
    this.renderer.render(this.scene, this.camera);
  }

  /** A ray to what each hand points at (or carries along its ray), a ring under a fingertip at a surface, smaller as it closes in. */
  private feedback() {
    this.hands.forEach((hand, i) => {
      const pointer = this.pointers[i];
      const cursor = this.cursors[i];
      const capture = this.router.captureOf(hand);
      const focus = this.router.focusOf(hand);
      const length = capture ? (capture.interaction.pointer?.() ?? null) : focus?.reach === "ray" ? focus.distance : null;
      pointer.visible = hand.tracking && length !== null;
      if (length !== null) pointer.scale.z = length;
      const touch = !capture && focus?.reach === "touch" && focus.point && focus.normal && (focus.depth ?? 1) < TOUCH ? focus : null;
      cursor.visible = !!touch;
      if (!touch) return;
      const s = 1 + Math.max(0, touch.depth!) * 40;
      const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), touch.normal!);
      cursor.matrix.compose(touch.point!.clone().addScaledVector(touch.normal!, 0.001), q, new Vector3(s, s, s));
      cursor.matrixWorldNeedsUpdate = true;
    });
  }

  private readViewer(frame: XRFrame | undefined): Viewer | null {
    const space = this.renderer.xr.getReferenceSpace();
    const pose = frame && space ? frame.getViewerPose(space) : null;
    if (!pose) return null;
    const { position: p, orientation: o } = pose.transform;
    return {
      eyes: new Vector3(p.x, p.y, p.z),
      forward: new Vector3(0, 0, -1).applyQuaternion(new Quaternion(o.x, o.y, o.z, o.w)),
    };
  }

  private cleanup() {
    if (this.ended) return;
    this.ended = true;
    this.router.cancelAll();
    this.renderer.setAnimationLoop(null);
    for (const fn of this.ends) fn();
    this.windows.dispose();
    this.scene.traverse((o: Object3D) => {
      const mesh = o as Partial<Mesh>;
      if (o.userData.shared) return;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (material) for (const m of Array.isArray(material) ? material : [material]) m.dispose();
    });
    this.renderer.dispose();
    this.canvas.remove();
  }
}

