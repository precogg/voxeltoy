import { describe, expect, test } from "bun:test";
import { XRHand } from "./input";
import { POKE, Router, TRACKING_GRACE, type Hit, type Interaction, type Reach, type Target, type Trigger } from "./interaction";

/** A hand seen this frame, at `now`. */
function makeHand(index: number, now: () => number, isHand = true) {
  const hand = new XRHand(index);
  hand.source = { handedness: index ? "right" : "left", hand: isHand ? {} : undefined } as unknown as XRInputSource;
  hand.tracking = true;
  hand.seenAt = now();
  return hand;
}

/** A target that offers what `offer` says for a hand, and logs what is done with it. */
class Probe implements Target {
  log: string[] = [];
  focused = 0;
  offer: (hand: XRHand, prev: Reach | null) => Partial<Hit> | null = () => null;
  /** What a press returns: an interaction (logged), a tap, or a pass. */
  answer: "capture" | "tap" | "pass" = "capture";

  constructor(readonly name: string) {}

  hit(hand: XRHand, prev: Reach | null): Hit | null {
    const o = this.offer(hand, prev);
    if (!o) return null;
    return { target: this, reach: "ray", distance: 1, ...o, press: (h, t) => this.press(h, t) };
  }

  focus(hits: readonly unknown[]) {
    this.focused = hits.length;
  }

  private press(_hand: XRHand, trigger: Trigger): Interaction | boolean {
    this.log.push(`press ${trigger}`);
    if (this.answer === "pass") return false;
    if (this.answer === "tap") return true;
    return {
      update: () => this.log.push("update"),
      end: () => this.log.push("end"),
      cancel: () => this.log.push("cancel"),
      resume: () => this.log.push("resume"),
    };
  }
}

function setup() {
  let t = 1000;
  const now = () => t;
  const hands = [makeHand(0, now), makeHand(1, now)];
  const router = new Router(hands, { now });
  const advance = (ms: number) => {
    t += ms;
    for (const h of hands) if (h.tracking) h.seenAt = t;
  };
  return { router, hands, now, advance };
}

describe("router", () => {
  test("each hand has one focus, the nearest reach first: grab, touch, ray, free", () => {
    const { router, hands } = setup();
    const free = new Probe("free");
    const ray = new Probe("ray");
    const touch = new Probe("touch");
    free.offer = () => ({ reach: "free", distance: 0 });
    ray.offer = () => ({ reach: "ray", distance: 0.5 });
    touch.offer = () => ({ reach: "touch", distance: 0.05, depth: 0.05 });
    for (const t of [free, ray, touch]) router.add(t);
    router.update(0);
    expect(router.focusOf(hands[0])?.target).toBe(touch);
    expect(touch.focused).toBe(2);
    expect(ray.focused).toBe(0);
    // a press goes to what lights
    router.press(hands[0], "select");
    expect(touch.log).toEqual(["press select"]);
    expect(ray.log).toEqual([]);
  });

  test("a press that passes goes to the next hit down", () => {
    const { router, hands } = setup();
    const panel = new Probe("panel");
    const tool = new Probe("tool");
    panel.offer = () => ({ reach: "ray" });
    panel.answer = "pass";
    tool.offer = () => ({ reach: "free" });
    router.add(panel);
    router.add(tool);
    router.update(0);
    router.press(hands[0], "squeeze");
    expect(panel.log).toEqual(["press squeeze"]);
    expect(tool.log).toEqual(["press squeeze"]);
    expect(router.captureOf(hands[0])?.target).toBe(tool);
  });

  test("releasing a trigger ends only what that trigger started", () => {
    const { router, hands } = setup();
    const win = new Probe("window");
    win.offer = () => ({ reach: "grab" });
    router.add(win);
    router.update(0);
    router.press(hands[0], "squeeze");
    // the trigger, pressed and let go while the grip holds: the hold carries on
    router.press(hands[0], "select");
    router.release(hands[0], "select");
    expect(router.captureOf(hands[0])).not.toBeNull();
    router.update(0);
    router.release(hands[0], "squeeze");
    expect(router.captureOf(hands[0])).toBeNull();
    expect(win.log).toEqual(["press squeeze", "update", "end"]);
  });

  test("a captured hand works nothing else: no focus, presses ignored", () => {
    const { router, hands } = setup();
    const a = new Probe("a");
    const b = new Probe("b");
    a.offer = () => ({ reach: "ray", distance: 1 });
    b.offer = () => ({ reach: "ray", distance: 2 });
    router.add(a);
    router.add(b);
    router.update(0);
    router.press(hands[0], "select");
    // now b is nearer, but the hand is a's until it lets go
    b.offer = () => ({ reach: "grab", distance: 0 });
    router.update(0);
    expect(router.focusOf(hands[0])).toBeNull();
    router.press(hands[0], "squeeze");
    expect(b.log).toEqual([]);
    // the other hand is free
    expect(router.focusOf(hands[1])?.target).toBe(b);
  });

  test("a short gap in tracking resumes; a long one takes the capture back", () => {
    const { router, hands, advance } = setup();
    const p = new Probe("p");
    p.offer = () => ({ reach: "ray" });
    router.add(p);
    router.update(0);
    router.press(hands[0], "select");
    hands[0].tracking = false;
    advance(TRACKING_GRACE / 2);
    router.update(0);
    expect(router.captureOf(hands[0])).not.toBeNull();
    hands[0].tracking = true;
    advance(16);
    router.update(0);
    expect(p.log).toEqual(["press select", "resume", "update"]);

    hands[0].tracking = false;
    advance(TRACKING_GRACE + 1);
    router.update(0);
    expect(router.captureOf(hands[0])).toBeNull();
    expect(p.log.at(-1)).toBe("cancel");
    // coming back doesn't pick it up again, nor does letting go end it twice
    hands[0].tracking = true;
    router.update(0);
    router.release(hands[0], "select");
    expect(p.log.filter((l) => l === "cancel" || l === "end")).toEqual(["cancel"]);
  });

  test("an input going away, or the session hidden, takes back what hands were doing", () => {
    const { router, hands } = setup();
    const p = new Probe("p");
    p.offer = () => ({ reach: "ray" });
    router.add(p);
    router.update(0);
    router.press(hands[0], "select");
    router.press(hands[1], "select");
    router.cancelAll();
    expect(p.log.filter((l) => l === "cancel")).toHaveLength(2);
    expect(hands.every((h) => router.captureOf(h) === null)).toBe(true);
  });

  test("hiding a target takes back what hands were doing with it, and only that", () => {
    const { router, hands } = setup();
    const a = new Probe("a");
    const b = new Probe("b");
    a.offer = (h) => (h.index === 0 ? { reach: "ray" } : null);
    b.offer = (h) => (h.index === 1 ? { reach: "ray" } : null);
    router.add(a);
    router.add(b);
    router.update(0);
    router.press(hands[0], "select");
    router.press(hands[1], "select");
    router.cancelTarget(a);
    expect(router.captureOf(hands[0])).toBeNull();
    expect(router.captureOf(hands[1])?.target).toBe(b);
  });

  test("a fingertip presses once on the way in, and again only after backing off", () => {
    const { router, hands } = setup();
    const p = new Probe("p");
    p.answer = "tap";
    let depth = 0.05;
    p.offer = (h) => (h.index === 0 ? { reach: "touch", distance: Math.abs(depth), depth } : null);
    router.add(p);
    const at = (d: number) => {
      depth = d;
      router.update(0);
    };
    at(0.05);
    at(0.005);
    expect(p.log).toEqual(["press poke"]);
    // pushed through and wiggling: no more presses
    at(-0.01);
    at(0.015);
    at(0.005);
    expect(p.log).toEqual(["press poke"]);
    // back off past the release distance, then in again
    at(POKE.release + 0.005);
    at(0.002);
    expect(p.log).toEqual(["press poke", "press poke"]);
  });

  test("a fingertip that arrives already pushed in doesn't press", () => {
    const { router } = setup();
    const p = new Probe("p");
    p.answer = "tap";
    p.offer = () => ({ reach: "touch", distance: 0, depth: 0.004 });
    router.add(p);
    router.update(0);
    router.update(0);
    expect(p.log).toEqual([]);
  });

  test("a press held by a fingertip lets go when it backs off", () => {
    const { router, hands } = setup();
    const p = new Probe("p");
    let depth = 0.05;
    p.offer = () => ({ reach: "touch", distance: Math.abs(depth), depth });
    router.add(p);
    router.update(0);
    depth = 0;
    router.update(0);
    expect(router.captureOf(hands[0])?.trigger).toBe("poke");
    depth = 0.01;
    router.update(0);
    expect(router.captureOf(hands[0])).not.toBeNull();
    depth = POKE.release + 0.01;
    router.update(0);
    expect(router.captureOf(hands[0])).toBeNull();
    expect(p.log.at(-1)).toBe("end");
  });

  test("an app's rule keeps hits from a hand, and knows which it had", () => {
    const { router, hands } = setup();
    const win = new Probe("window");
    const tool = new Probe("tool");
    win.offer = () => ({ reach: "ray", distance: 1 });
    tool.offer = () => ({ reach: "free" });
    router.add(win);
    router.add(tool);
    let clear = 0.1;
    // rays reach the window from a hand clear of the model: 0.12 to start, 0.08 to keep it
    router.allow = (_hand, hit, focused) => hit.target !== win || clear > (focused ? 0.08 : 0.12);
    router.update(0);
    expect(router.focusOf(hands[0])?.target).toBe(tool);
    clear = 0.13;
    router.update(0);
    expect(router.focusOf(hands[0])?.target).toBe(win);
    clear = 0.1;
    router.update(0);
    expect(router.focusOf(hands[0])?.target).toBe(win);
    clear = 0.07;
    router.update(0);
    expect(router.focusOf(hands[0])?.target).toBe(tool);
  });

  test("an app can hand a hand from one thing to another, keeping its trigger", () => {
    const { router, hands } = setup();
    const p = new Probe("p");
    p.offer = () => ({ reach: "free" });
    router.add(p);
    router.update(0);
    router.press(hands[1], "select");
    const log: string[] = [];
    router.take(hands[1], { end: () => log.push("hold end") });
    expect(p.log).toEqual(["press select", "cancel"]);
    router.release(hands[1], "select");
    expect(log).toEqual(["hold end"]);
  });
});
