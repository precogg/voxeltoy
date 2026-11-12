import type { Vector3 } from "three";
import type { XRHand } from "./input";

/**
 * Who a hand is working, and what owns it while it does.
 *
 * Every frame each hand resolves one focus: the best `Hit` any target offers it, ranked by reach
 * (grab, then touch, then ray, then free space) and distance. What lights up is what a press
 * starts. A press hands the hand to an `Interaction` (a capture) until the trigger that started it
 * lets go; while captured, the hand works nothing else. Everything that can interrupt a capture
 * (the session hidden, the input gone, tracking lost too long, its target hidden) comes through
 * `cancel`, which takes it back.
 */

/** What starts a press: a pinch or trigger, a grip, or a fingertip pushed into a surface. */
export type Trigger = "select" | "squeeze" | "poke";

/**
 * How a hand reaches a target, best first: holding it where the hand is (a window's frame at the
 * pinch), touching it with a fingertip, pointing at it, or free space (the app's own tool).
 */
export type Reach = "grab" | "touch" | "ray" | "free";
const RANK: Record<Reach, number> = { grab: 0, touch: 1, ray: 2, free: 3 };

export interface Hit {
  target: Target;
  reach: Reach;
  /** Metres: along the ray, or from the hand. Ranks hits of the same reach. */
  distance: number;
  /** A touch: how far the fingertip is in front of the surface (metres, negative once through). Pushing in presses (`POKE`). */
  depth?: number;
  /** Where the hit is, in the room: the end of the ray, or the fingertip on the surface. */
  point?: Vector3;
  /** A touch: which way the surface faces, for the cursor. */
  normal?: Vector3;
  /**
   * Press here. An interaction captures the hand until the trigger lets go; `true` handled it
   * without one (a tap); `false` passes it to the next hit down (a grip on a button falls through
   * to the tool behind it).
   */
  press(hand: XRHand, trigger: Trigger): Interaction | boolean | void;
}

/** What a captured hand is doing. */
export interface Interaction {
  /** Each frame while captured and tracking. */
  update?(hand: XRHand, dt: number): void;
  /** Let go: the trigger that started it was released, or the router ended it. */
  end?(): void;
  /** Taken back: the session was hidden, the input went, tracking was lost too long, its target went. */
  cancel?(): void;
  /** Tracking came back after a short gap: carry on from where the hand is now, not with a jump. */
  resume?(hand: XRHand): void;
  /** It reads the controller's thumbstick itself: the app's stick commands leave it alone. */
  axes?: boolean;
  /** How long a ray to draw from the hand while it lasts (metres); none by default. */
  pointer?(): number | null;
}

export interface Capture {
  interaction: Interaction;
  trigger: Trigger;
  target: Target | null;
  /** When it started (`now()`). */
  since: number;
}

export interface FocusedHit {
  hand: XRHand;
  hit: Hit;
}

/** Something hands can work: a panel, a window, a handle, the app's tool. */
export interface Target {
  /**
   * What `hand` reaches on this target now, if anything. `prev` is how it reached this target last
   * frame, if this was its focus (or holds it): hold on to that a little longer than it takes to
   * get it (hysteresis), so tracking noise doesn't flip between targets.
   */
  hit(hand: XRHand, prev: Reach | null): Hit | readonly Hit[] | null;
  /** Each frame: the hands that have it as their focus (none: empty), to light what they are at. */
  focus?(hits: readonly FocusedHit[]): void;
}

/**
 * Pushing a button: a fingertip that has been at least `release` in front of a surface (metres)
 * presses once it comes within `press` of it or goes through, however fast, and presses again only
 * after backing off past `release`.
 */
export const POKE = { press: 0.01, release: 0.02 };
/** Tracking lost this long (ms) takes a capture back; a shorter gap resumes it. */
export const TRACKING_GRACE = 300;

export interface RouterOptions {
  /** Whether `hand` may have `hit` (an app's rule: no rays at windows from a hand by the model). `focused`: it had it last frame. */
  allow?(hand: XRHand, hit: Hit, focused: boolean): boolean;
  now?: () => number;
}

interface HandState {
  focus: Hit | null;
  /** This frame's hits, best first: a press tries them in turn. */
  hits: Hit[];
  capture: Capture | null;
  /** Tracking was lost while captured. */
  lost: boolean;
  /** The fingertip has backed off `armedOn`, so pushing in presses. */
  armed: boolean;
  armedOn: Target | null;
}

const asList = (h: Hit | readonly Hit[] | null): readonly Hit[] => (!h ? [] : Array.isArray(h) ? h : [h as Hit]);

export class Router {
  private targets: Target[] = [];
  private state = new Map<XRHand, HandState>();
  private now: () => number;
  /** The app's rule for which hits a hand may have (see `RouterOptions.allow`). */
  allow: RouterOptions["allow"];

  constructor(
    readonly hands: readonly XRHand[],
    options: RouterOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.allow = options.allow;
    for (const hand of hands) this.state.set(hand, { focus: null, hits: [], capture: null, lost: false, armed: false, armedOn: null });
  }

  add(target: Target) {
    if (!this.targets.includes(target)) this.targets.push(target);
    return () => this.remove(target);
  }

  /** Stop routing to `target`, taking back what hands were doing with it. */
  remove(target: Target) {
    this.cancelTarget(target);
    this.targets = this.targets.filter((t) => t !== target);
    target.focus?.([]);
  }

  focusOf(hand: XRHand): Hit | null {
    return this.get(hand).focus;
  }

  captureOf(hand: XRHand): Capture | null {
    return this.get(hand).capture;
  }

  /** Whether `hand` is free: tracked, and not captured. */
  idle(hand: XRHand) {
    return hand.tracking && !this.get(hand).capture;
  }

  /** Once a frame, after the hands' poses and the scene's matrices: captures follow, each free hand finds its focus, fingertips push. */
  update(dt: number) {
    const now = this.now();
    for (const hand of this.hands) {
      const s = this.get(hand);
      if (!hand.tracking) {
        s.focus = null;
        s.hits = [];
        s.armed = false;
        if (s.capture && (!hand.source || now - hand.seenAt > TRACKING_GRACE)) this.cancel(hand);
        else if (s.capture) s.lost = true;
        continue;
      }
      if (s.capture) {
        if (s.lost) {
          s.lost = false;
          s.capture.interaction.resume?.(hand);
        }
        if (s.capture.trigger === "poke") this.followPoke(hand, s);
        s.capture?.interaction.update?.(hand, dt);
        s.focus = null;
        s.hits = [];
        continue;
      }
      s.hits = this.resolve(hand, s.focus);
      s.focus = s.hits[0] ?? null;
      this.poke(hand, s);
    }
    const focused = new Map<Target, FocusedHit[]>();
    for (const hand of this.hands) {
      const hit = this.get(hand).focus;
      if (hit) focused.set(hit.target, [...(focused.get(hit.target) ?? []), { hand, hit }]);
    }
    for (const target of this.targets) target.focus?.(focused.get(target) ?? []);
  }

  /** A trigger went down: the hand's focus (or the next hit that takes it) gets the press. A captured hand ignores it. */
  press(hand: XRHand, trigger: Trigger): boolean {
    const s = this.get(hand);
    if (s.capture || !hand.tracking) return false;
    return this.begin(hand, trigger, s.hits);
  }

  /** A trigger let go: it ends the capture it started, and nothing else. */
  release(hand: XRHand, trigger: Trigger) {
    const s = this.get(hand);
    const capture = s.capture;
    if (!capture || capture.trigger !== trigger) return;
    s.capture = null;
    capture.interaction.end?.();
  }

  /**
   * Give `hand` to `interaction`, taking back whatever it was doing: an app moving a hand from one
   * thing to another (a stroke becomes a hold). It keeps the trigger it was pressed with.
   */
  take(hand: XRHand, interaction: Interaction, options: { trigger?: Trigger; target?: Target | null } = {}) {
    const s = this.get(hand);
    const trigger = options.trigger ?? s.capture?.trigger ?? "select";
    this.cancel(hand);
    s.capture = { interaction, trigger, target: options.target ?? null, since: this.now() };
  }

  /** Take back what `hand` is doing. */
  cancel(hand: XRHand) {
    const s = this.get(hand);
    const capture = s.capture;
    s.lost = false;
    if (!capture) return;
    s.capture = null;
    capture.interaction.cancel?.();
  }

  /** Take back what every hand is doing: the session was hidden, or the app changed under them. */
  cancelAll() {
    for (const hand of this.hands) this.cancel(hand);
  }

  /** Take back what hands are doing with `target`: it was hidden or went away. */
  cancelTarget(target: Target) {
    for (const hand of this.hands) {
      const s = this.get(hand);
      if (s.capture?.target === target) this.cancel(hand);
      if (s.focus?.target === target) s.focus = null;
      s.hits = s.hits.filter((h) => h.target !== target);
    }
  }

  private get(hand: XRHand): HandState {
    const s = this.state.get(hand);
    if (!s) throw new Error(`Hand ${hand.index} isn't one of this router's`);
    return s;
  }

  private resolve(hand: XRHand, prev: Hit | null): Hit[] {
    const out: Hit[] = [];
    for (const target of this.targets) {
      const was = prev?.target === target ? prev.reach : null;
      for (const hit of asList(target.hit(hand, was))) {
        const focused = was === hit.reach;
        if (this.allow && !this.allow(hand, hit, focused)) continue;
        out.push(hit);
      }
    }
    return out.sort((a, b) => RANK[a.reach] - RANK[b.reach] || a.distance - b.distance);
  }

  private begin(hand: XRHand, trigger: Trigger, hits: readonly Hit[]) {
    for (const hit of hits) {
      const result = hit.press(hand, trigger);
      if (!result) continue;
      if (result !== true) this.get(hand).capture = { interaction: result, trigger, target: hit.target, since: this.now() };
      return true;
    }
    return false;
  }

  /** A fingertip at a surface presses it on the way in (see `POKE`). */
  private poke(hand: XRHand, s: HandState) {
    const f = s.focus;
    const touch = f?.reach === "touch" && f.depth !== undefined ? f : null;
    if (!touch || touch.target !== s.armedOn) {
      s.armed = false;
      s.armedOn = touch?.target ?? null;
    }
    if (!touch) return;
    if (touch.depth! > POKE.release) {
      s.armed = true;
      return;
    }
    if (!s.armed || touch.depth! > POKE.press) return;
    s.armed = false;
    this.begin(hand, "poke", [touch]);
  }

  /** A press by a fingertip lets go once it backs off, or leaves the surface. */
  private followPoke(hand: XRHand, s: HandState) {
    const target = s.capture!.target;
    const touch = target ? asList(target.hit(hand, "touch")).find((h) => h.reach === "touch") : undefined;
    if (!touch || (touch.depth ?? 0) > POKE.release) this.release(hand, "poke");
  }
}
