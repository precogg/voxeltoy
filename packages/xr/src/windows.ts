import { Group, Matrix4, Quaternion, Vector3, type ColorSpace, type Object3D } from "three";
import type { XRHand } from "./input";
import type { FocusedHit, Hit, Interaction, Reach, Router, Target } from "./interaction";
import { Panel, type Control } from "./panel";
import { overPanel, PanelTarget, type PanelHit } from "./surface";

/** Window canvas pixels per millimetre: text reads well at arm's length, and close up. */
export const WINDOW_DENSITY = 2.5;
/** The frame around a window's content to take hold of it by, and the bar under it (millimetres). */
export const FRAME = { margin: 22, bar: 32 };
/** A pinch or grip this close to a window's plane (metres), on its frame, takes hold of it; once at it, until `FRAME_LEAVE`. */
const FRAME_REACH = 0.04;
const FRAME_LEAVE = 0.06;

/** A window held by a ray moves this many times as far as the hand toward or away from you: pushing and pulling it. */
export const PUSH_GAIN = 3;
/** How near and far a window can be (metres from the eyes), however it is moved. */
export const NEAREST = 0.25;
export const FARTHEST = 4;
/**
 * Out to this far (metres from the eyes) a window is its own size; beyond, it grows with distance
 * so it looks as big as it did here, and its controls stay as easy to point at.
 */
export const NATURAL_DISTANCE = 1;
/** A controller's thumbstick pushes or pulls a window held by its ray this fast (metres a second). */
const STICK_PUSH = 1.2;

const UP = new Vector3(0, 1, 0);

/** Where the viewer is and which way they look, in the room. */
export interface Viewer {
  eyes: Vector3;
  forward: Vector3;
}

export interface Pose {
  position: Vector3;
  quaternion: Quaternion;
}

/** The turn that faces a window at `center` toward `eyes`, upright: its face (+Z) toward them, its top up. */
export function facing(center: Vector3, eyes: Vector3): Quaternion {
  const toward = eyes.clone().sub(center);
  if (toward.lengthSq() < 1e-8) return new Quaternion();
  toward.normalize();
  // straight above or below: keep the turn about the vertical it had
  const up = Math.abs(toward.dot(UP)) > 0.999 ? new Vector3(0, 0, -1) : UP;
  return new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(toward, new Vector3(), up));
}

/** How big a window at `position` is drawn: its own size up close, growing past `NATURAL_DISTANCE` to look the same. */
export function apparentScale(position: Vector3, eyes: Vector3) {
  return Math.max(1, position.distanceTo(eyes) / NATURAL_DISTANCE);
}

/** `point` kept between `NEAREST` and `FARTHEST` from `eyes`. */
export function withinReach(point: Vector3, eyes: Vector3) {
  const to = point.clone().sub(eyes);
  const d = to.length();
  if (d < 1e-6) return eyes.clone().add(new Vector3(0, 0, -NEAREST));
  return eyes.clone().addScaledVector(to, Math.min(FARTHEST, Math.max(NEAREST, d)) / d);
}

/**
 * Where a window goes when the point `local` on it (its own space, before scaling) is held at
 * `target`: facing `eyes`, at its apparent scale.
 */
export function heldAt(target: Vector3, local: Vector3, eyes: Vector3, scale = 1) {
  const quaternion = facing(target, eyes);
  const position = target.clone().sub(local.clone().multiplyScalar(scale).applyQuaternion(quaternion));
  return { position, quaternion, scale };
}

/**
 * How far along its ray a window held by a ray is: as far as when it was taken, plus the hand's
 * move away from the eyes since (or less, toward them) times `PUSH_GAIN`.
 */
export function rayDistance(start: number, reachStart: number, reach: number) {
  return Math.max(0.1, start + (reach - reachStart) * PUSH_GAIN);
}

/**
 * A spot about the viewer: `turn` degrees to the right of where they look (level), `distance`
 * metres out, `drop` metres below the eyes, facing them.
 */
export function around(viewer: Viewer, spot: { turn: number; distance: number; drop: number }): Pose {
  const flat = new Vector3(viewer.forward.x, 0, viewer.forward.z);
  if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1);
  flat.normalize();
  // a turn to the right is clockwise from above
  const dir = flat.applyAxisAngle(UP, (-spot.turn * Math.PI) / 180);
  const center = viewer.eyes.clone().addScaledVector(dir, spot.distance);
  center.y = viewer.eyes.y - spot.drop;
  return { position: center, quaternion: facing(center, viewer.eyes) };
}

export interface WindowOptions {
  /** Stands for it: unique among the windows, kept with which are open. */
  id: string;
  /** Its content's size, in millimetres (the frame goes around it). */
  width: number;
  height: number;
  /** Its controls, from the current state (see `Panel`). */
  layout(width: number, height: number): Control[];
  /** Where it starts, and comes back to when gathered. */
  place(viewer: Viewer): Pose;
  /** Open at first, before the device remembers. */
  open?: boolean;
  /** Each time it is shown: back to the top of its menus, say. */
  onShow?(): void;
}

/**
 * A window floating in the room: a panel with a frame to take hold of it by, like a headset's own
 * windows. Push or point at its controls; pinch or grip its frame to carry it, the point taken
 * staying under the hand (or along the ray, pushed and pulled). It turns to face you as it goes,
 * keeps between `NEAREST` and `FARTHEST`, and grows past arm's length so it reads the same. One
 * hand holds it at a time: another taking it lets the first go. Where it is is the view's.
 */
export class XRWindow implements Target {
  readonly group = new Group();
  readonly panel: Panel;
  readonly surface: PanelTarget;
  /** Placed somewhere in the room yet. */
  placed = false;
  private holder: XRHand | null = null;

  constructor(
    readonly options: WindowOptions,
    private host: { router: Router; viewer(): Viewer; colorSpace?: ColorSpace },
  ) {
    this.panel = new Panel({
      width: options.width + FRAME.margin * 2,
      height: options.height + FRAME.margin + FRAME.bar,
      layout: options.layout,
      density: WINDOW_DENSITY,
      frame: FRAME,
      colorSpace: host.colorSpace,
    });
    this.surface = new PanelTarget(this.panel);
    this.group.add(this.panel.mesh);
    this.group.visible = false;
  }

  get id() {
    return this.options.id;
  }

  get shown() {
    return this.group.visible;
  }

  /** Who holds it by its frame, if anyone. */
  get heldBy() {
    return this.holder;
  }

  /** Put it at `position`, turned by `quaternion`, at the scale that distance gives. */
  place(position: Vector3, quaternion: Quaternion, scale = apparentScale(position, this.host.viewer().eyes)) {
    this.group.position.copy(position);
    this.group.quaternion.copy(quaternion);
    this.group.scale.setScalar(scale);
    this.group.updateMatrixWorld(true);
    this.placed = true;
  }

  /** Whether it is out of the way of the viewer: behind them, or across the room. */
  lost(viewer: Viewer) {
    const to = this.group.position.clone().sub(viewer.eyes);
    return !this.placed || to.length() > FARTHEST + 0.5 || to.normalize().dot(viewer.forward) < 0;
  }

  hit(hand: XRHand, prev: Reach | null): Hit[] {
    if (!this.surface.open(hand)) return [];
    const out: Hit[] = [];
    // its frame at the pinch or grip
    const at = overPanel(this.panel, hand.handle);
    const reach = prev === "grab" ? FRAME_LEAVE : FRAME_REACH;
    if (Math.abs(at.depth) < reach && this.panel.region(at.uv)?.kind === "frame") {
      const point = hand.handle.clone();
      out.push({ target: this, reach: "grab", distance: Math.abs(at.depth), press: (h, t) => t !== "poke" && this.carry(h, point, false) });
    }
    const touch = this.surface.touchHit(hand, prev);
    if (touch) out.push({ ...touch, target: this });
    const ray = this.surface.rayHit(hand);
    if (ray) {
      // pointing at the frame and pinching (or gripping) carries it along the ray
      const onFrame = ray.region.kind === "frame";
      out.push({ ...ray, target: this, press: onFrame ? (h, t) => t !== "poke" && this.carry(h, ray.point!, true) : ray.press });
    }
    return out;
  }

  focus(hits: readonly FocusedHit[]) {
    this.panel.hover(this.surface.hovered(hits));
    const hot = hits.some(({ hit }) => hit.reach === "grab" || (hit as PanelHit).region?.kind === "frame");
    this.panel.setFrame(this.holder ? "held" : hot ? "hot" : "rest");
  }

  /** Take hold of it by the point `world` on it: in the hand, or along its ray. */
  private carry(hand: XRHand, world: Vector3, byRay: boolean): Interaction {
    if (this.holder && this.holder !== hand) this.host.router.cancel(this.holder);
    this.holder = hand;
    this.panel.setFrame("held");
    // the point taken, in the window's own space (at its natural size)
    let local = this.group.worldToLocal(world.clone());
    let distance = hand.ray.origin.distanceTo(world);
    let reach = hand.ray.origin.distanceTo(this.host.viewer().eyes);
    let along = distance;
    const letGo = () => {
      if (this.holder !== hand) return;
      this.holder = null;
      this.panel.setFrame("rest");
    };
    return {
      axes: byRay && !hand.isHand,
      update: (h, dt) => {
        const { eyes } = this.host.viewer();
        let target: Vector3;
        if (byRay) {
          // a controller's thumbstick pushes and pulls it too
          const y = h.gamepad?.axes[3] ?? 0;
          if (Math.abs(y) > 0.2) distance = Math.max(0.1, distance - y * STICK_PUSH * dt);
          along = rayDistance(distance, reach, h.ray.origin.distanceTo(eyes));
          target = h.ray.at(along, new Vector3());
        } else {
          target = h.handle.clone();
        }
        target = withinReach(target, eyes);
        const at = heldAt(target, local, eyes, apparentScale(target, eyes));
        this.place(at.position, at.quaternion, at.scale);
      },
      // after a gap in tracking, take it again where the hand is now: the window stays put
      resume: (h) => {
        const { eyes } = this.host.viewer();
        const point = withinReach(byRay ? h.ray.at(along, new Vector3()) : h.handle.clone(), eyes);
        // the point on it that, held there, leaves it where it is (turned to face you from there)
        const q = facing(point, eyes);
        const scale = apparentScale(point, eyes);
        local = point.sub(this.group.position).applyQuaternion(q.invert()).divideScalar(scale);
        distance = along;
        reach = h.ray.origin.distanceTo(this.host.viewer().eyes);
      },
      pointer: () => (byRay ? along : null),
      end: letGo,
      cancel: letGo,
    };
  }

  dispose() {
    this.panel.dispose();
  }
}

/**
 * The windows in a session: shown or hidden (which are open is kept on the device under
 * `storageKey`), placed about the viewer when first shown, and gathered back on request.
 */
export class XRWindows {
  private list: XRWindow[] = [];
  private gathering = false;
  private listeners = new Set<() => void>();

  constructor(
    private host: { scene: Object3D; router: Router; viewer(): Viewer | null; colorSpace?: ColorSpace },
    private storageKey?: string,
  ) {}

  get all(): readonly XRWindow[] {
    return this.list;
  }

  add(options: WindowOptions): XRWindow {
    const win = new XRWindow(options, {
      router: this.host.router,
      viewer: () => this.host.viewer() ?? { eyes: new Vector3(0, 1.6, 0), forward: new Vector3(0, 0, -1) },
      colorSpace: this.host.colorSpace,
    });
    this.list.push(win);
    this.host.scene.add(win.group);
    this.host.router.add(win);
    const saved = this.saved();
    win.group.visible = saved ? saved.includes(win.id) : !!options.open;
    if (win.shown) {
      options.onShow?.();
      this.placeLost(win);
    }
    return win;
  }

  get(id: string) {
    return this.list.find((w) => w.id === id);
  }

  shown(id: string) {
    return !!this.get(id)?.shown;
  }

  /** Show or hide a window (toggle without `shown`). One shown out of the way (behind you, across the room) comes back to its place. */
  show(id: string, shown = !this.shown(id)) {
    const win = this.get(id);
    if (!win || win.shown === shown) return;
    win.group.visible = shown;
    if (!shown) this.host.router.cancelTarget(win);
    else {
      win.options.onShow?.();
      win.panel.redraw();
      this.placeLost(win);
    }
    this.save();
    this.changed();
  }

  /** Put the open windows back in their places about the viewer (on the next frame, if the viewer isn't known yet). */
  gather() {
    const viewer = this.host.viewer();
    if (!viewer) {
      this.gathering = true;
      return;
    }
    this.gathering = false;
    for (const win of this.list) {
      // a window being carried stays in the hand
      if (win.heldBy) continue;
      const at = win.options.place(viewer);
      win.place(at.position, at.quaternion, apparentScale(at.position, viewer.eyes));
    }
  }

  /** Once a frame, with the viewer known: a gather asked for before it was. */
  frame() {
    if (this.gathering) this.gather();
  }

  /** Called when windows are shown or hidden. */
  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  redraw() {
    for (const win of this.list) win.panel.redraw();
  }

  dispose() {
    for (const win of this.list) {
      this.host.router.remove(win);
      win.group.removeFromParent();
      win.dispose();
    }
    this.list = [];
  }

  private placeLost(win: XRWindow) {
    const viewer = this.host.viewer();
    if (!viewer) {
      this.gathering = true;
      return;
    }
    if (!win.lost(viewer)) return;
    const at = win.options.place(viewer);
    win.place(at.position, at.quaternion, apparentScale(at.position, viewer.eyes));
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  private saved(): string[] | null {
    if (!this.storageKey) return null;
    try {
      const saved = JSON.parse(localStorage.getItem(this.storageKey) ?? "null");
      return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : null;
    } catch {
      return null;
    }
  }

  private save() {
    if (!this.storageKey) return;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.list.filter((w) => w.shown).map((w) => w.id)));
    } catch {
      // private browsing: they open as at first next time
    }
  }
}
