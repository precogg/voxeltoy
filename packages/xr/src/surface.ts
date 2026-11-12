import { Object3D, Plane, Vector2, Vector3, type Ray } from "three";
import type { XRHand } from "./input";
import type { FocusedHit, Hit, Interaction, Reach, Target } from "./interaction";
import type { Panel, PanelRegion } from "./panel";

/** A fingertip this close in front of a surface (metres) is at it: the cursor shows, and the ray and the tool give way. Once at it, it stays until `TOUCH_LEAVE`. */
export const TOUCH = 0.06;
export const TOUCH_LEAVE = 0.08;
/** A fingertip this far through a surface has gone past it. */
const THROUGH = 0.05;

const inside = (uv: Vector2) => uv.x >= 0 && uv.x <= 1 && uv.y >= 0 && uv.y <= 1;

/** Whether `o` shows: it and everything it is in are visible, and it is in a scene. */
export function shows(o: Object3D) {
  for (let at: Object3D | null = o; at; at = at.parent) {
    if (!at.visible) return false;
    if (!at.parent) return at.type === "Scene";
  }
  return false;
}

/** Where `world` is over `panel`: its uv on the panel's plane, how far in front (metres, scale included) and the point on the face. */
export function overPanel(panel: Panel, world: Vector3) {
  const m = panel.mesh.matrixWorld;
  const center = new Vector3().setFromMatrixPosition(m);
  const normal = new Vector3(0, 0, 1).transformDirection(m);
  const depth = world.clone().sub(center).dot(normal);
  const local = panel.mesh.worldToLocal(world.clone());
  const { width, height } = panel.mesh.geometry.parameters;
  const uv = new Vector2(local.x / width + 0.5, local.y / height + 0.5);
  return { uv, depth, normal, point: world.clone().addScaledVector(normal, -depth) };
}

/** Where `ray` meets `panel`'s plane, however far off its edges, if ahead of it. */
export function rayOnPanel(panel: Panel, ray: Ray) {
  const m = panel.mesh.matrixWorld;
  const normal = new Vector3(0, 0, 1).transformDirection(m);
  const plane = new Plane().setFromNormalAndCoplanarPoint(normal, new Vector3().setFromMatrixPosition(m));
  const point = ray.intersectPlane(plane, new Vector3());
  if (!point) return null;
  const local = panel.mesh.worldToLocal(point.clone());
  const { width, height } = panel.mesh.geometry.parameters;
  return { uv: new Vector2(local.x / width + 0.5, local.y / height + 0.5), point, distance: ray.origin.distanceTo(point) };
}

/** A hit on a panel, with what is there. */
export type PanelHit = Hit & { uv: Vector2; region: PanelRegion };

/**
 * A panel hands can work: pushed with a fingertip, or pointed at and pinched (a trigger). A
 * control that drags (a scrub lane) holds the hand and follows it until let go. Squeezing a
 * panel passes through to what is behind it.
 */
export class PanelTarget implements Target {
  /** Controls held down, and by which hand. */
  private held = new Map<XRHand, string>();

  constructor(
    readonly panel: Panel,
    private options: { available?: (hand: XRHand) => boolean } = {},
  ) {}

  /** Whether `hand` can work it now. */
  open(hand: XRHand) {
    return hand.tracking && shows(this.panel.mesh) && (this.options.available?.(hand) ?? true);
  }

  hit(hand: XRHand, prev: Reach | null): Hit[] {
    if (!this.open(hand)) return [];
    const out: Hit[] = [];
    const touch = this.touchHit(hand, prev);
    if (touch) out.push(touch);
    const ray = this.rayHit(hand);
    if (ray) out.push(ray);
    return out;
  }

  /** A fingertip at the panel. */
  touchHit(hand: XRHand, prev: Reach | null): PanelHit | null {
    if (!hand.finger) return null;
    const o = overPanel(this.panel, hand.finger);
    if (!inside(o.uv) || o.depth > (prev === "touch" ? TOUCH_LEAVE : TOUCH) || o.depth < -THROUGH) return null;
    const region = this.panel.region(o.uv) ?? { kind: "content" as const };
    return {
      target: this,
      reach: "touch",
      distance: Math.abs(o.depth),
      depth: o.depth,
      point: o.point,
      normal: o.normal,
      uv: o.uv,
      region,
      // the fingertip presses by pushing; a pinch there is the panel's, and does nothing
      press: (h, trigger) => (trigger === "poke" ? this.pressAt(h, region, true) : trigger === "select"),
    };
  }

  /** The hand's ray on the panel. */
  rayHit(hand: XRHand): PanelHit | null {
    const r = rayOnPanel(this.panel, hand.ray);
    if (!r || !inside(r.uv)) return null;
    const region = this.panel.region(r.uv);
    if (!region) return null;
    return {
      target: this,
      reach: "ray",
      distance: r.distance,
      point: r.point,
      uv: r.uv,
      region,
      press: (h, trigger) => (trigger === "select" ? this.pressAt(h, region, false) : false),
    };
  }

  /** Press what is at `region`: a control runs, and one that drags holds the hand. The panel's bare face takes the press too, so it doesn't reach what is behind. */
  pressAt(hand: XRHand, region: PanelRegion, byFinger: boolean): Interaction | boolean {
    if (region.kind !== "control") return true;
    const c = region.control;
    this.panel.flash(c.id);
    c.onPress?.();
    if (!c.onDrag) return true;
    c.onDrag(region.fx, region.fy);
    this.held.set(hand, c.id);
    // the layout may have changed since: the control by its id now, or as it was
    const current = () => this.panel.control(c.id) ?? c;
    const done = () => {
      if (this.held.get(hand) === c.id) this.held.delete(hand);
    };
    return {
      update: (h) => {
        const uv = byFinger ? (h.finger ? overPanel(this.panel, h.finger).uv : null) : (rayOnPanel(this.panel, h.ray)?.uv ?? null);
        if (!uv) return;
        const { fx, fy } = this.panel.along(current(), uv);
        current().onDrag?.(fx, fy);
      },
      end: () => {
        done();
        current().onRelease?.();
      },
      cancel: () => {
        done();
        current().onCancel?.();
      },
    };
  }

  focus(hits: readonly FocusedHit[]) {
    this.panel.hover(this.hovered(hits));
  }

  /** The control a hand is at or holds. */
  hovered(hits: readonly FocusedHit[]): string | null {
    for (const id of this.held.values()) return id;
    for (const { hit } of hits) {
      const region = (hit as PanelHit).region;
      if (region?.kind === "control") return region.control.id;
    }
    return null;
  }
}

