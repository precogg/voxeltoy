import { beforeAll, describe, expect, test } from "bun:test";
import { Scene, Vector3 } from "three";
import { XRHand } from "./input";
import { Router, TRACKING_GRACE } from "./interaction";
import { MenuView, type XRMenuItem } from "./menu";
import type { Control } from "./panel";
import { apparentScale, around, facing, FARTHEST, heldAt, NATURAL_DISTANCE, NEAREST, PUSH_GAIN, rayDistance, withinReach, XRWindows, type Viewer } from "./windows";

const near = (a: Vector3, b: Vector3, eps = 1e-6) => expect(a.distanceTo(b)).toBeLessThan(eps);
const EYES = new Vector3(0, 1.6, 0);
const AHEAD = new Vector3(0, 0, -1);
const VIEWER: Viewer = { eyes: EYES, forward: AHEAD };

beforeAll(() => {
  // panels draw to a canvas: enough of one to lay out and paint into nothing
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (t, k) => (k in t ? t[k] : k === "measureText" ? () => ({ width: 0 }) : () => {}),
    set: (t, k, v) => ((t[k] = v), true),
  });
  const g = globalThis as unknown as { document: unknown; Path2D: unknown };
  g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
  g.Path2D = class {};
});

describe("window placement", () => {
  test("a window faces the eyes, upright", () => {
    const center = new Vector3(0.5, 1.2, -0.7);
    const q = facing(center, EYES);
    near(new Vector3(0, 0, 1).applyQuaternion(q), EYES.clone().sub(center).normalize());
    // its sides stay level: no roll
    expect(Math.abs(new Vector3(1, 0, 0).applyQuaternion(q).y)).toBeLessThan(1e-6);
  });

  test("the point taken stays under the hand, wherever it goes, at any scale", () => {
    const local = new Vector3(0.12, -0.2, 0);
    for (const [target, scale] of [
      [new Vector3(0.3, 1.4, -0.6), 1],
      [new Vector3(-0.8, 1.0, -0.2), 1],
      [new Vector3(0, 2, -2.5), 2.5],
    ] as const) {
      const { position, quaternion } = heldAt(target, local, EYES, scale);
      near(local.clone().multiplyScalar(scale).applyQuaternion(quaternion).add(position), target);
    }
  });

  test("a window on a ray goes out as the hand pushes and comes in as it pulls, faster than the hand", () => {
    expect(rayDistance(1, 0.3, 0.3)).toBeCloseTo(1);
    expect(rayDistance(1, 0.3, 0.4)).toBeCloseTo(1 + 0.1 * PUSH_GAIN);
    expect(rayDistance(1, 0.3, 0.2)).toBeCloseTo(1 - 0.1 * PUSH_GAIN);
  });

  test("however it is moved, a window keeps between the nearest and farthest from the eyes", () => {
    expect(withinReach(new Vector3(0, 1.6, -0.05), EYES).distanceTo(EYES)).toBeCloseTo(NEAREST);
    expect(withinReach(new Vector3(0, 1.6, -9), EYES).distanceTo(EYES)).toBeCloseTo(FARTHEST);
    near(withinReach(new Vector3(0.2, 1.4, -0.7), EYES), new Vector3(0.2, 1.4, -0.7));
  });

  test("a window is its own size at arm's length, and grows past it to look the same", () => {
    expect(apparentScale(new Vector3(0, 1.6, -0.7), EYES)).toBe(1);
    expect(apparentScale(new Vector3(0, 1.6, -3 * NATURAL_DISTANCE), EYES)).toBeCloseTo(3);
  });

  test("spots about the viewer: turned right of where they look, out, below the eyes, facing them", () => {
    const right = around(VIEWER, { turn: 42, distance: 0.7, drop: 0.18 });
    expect(right.position.x).toBeGreaterThan(0.2);
    expect(right.position.y).toBeCloseTo(EYES.y - 0.18);
    const front = new Vector3(0, 0, 1).applyQuaternion(right.quaternion);
    expect(front.dot(EYES.clone().sub(right.position).normalize())).toBeGreaterThan(0.999);
    expect(around(VIEWER, { turn: -42, distance: 0.7, drop: 0 }).position.x).toBeLessThan(-0.2);
  });
});

/** Two windows about the viewer, each a big button over its content, and two hands to work them. */
function room() {
  let t = 1000;
  const now = () => t;
  const scene = new Scene();
  const hands = [new XRHand(0), new XRHand(1)];
  for (const h of hands) {
    h.source = { handedness: h.index ? "right" : "left", hand: {} } as unknown as XRInputSource;
    h.tracking = true;
    h.seenAt = t;
  }
  const router = new Router(hands, { now });
  const windows = new XRWindows({ scene, router, viewer: () => VIEWER });
  const pressed: string[] = [];
  const drags: string[] = [];
  const make = (id: string, turn: number) =>
    windows.add({
      id,
      width: 300,
      height: 400,
      open: true,
      place: (v) => around(v, { turn, distance: 0.7, drop: 0.1 }),
      layout: (): Control[] => [
        { id: "top", x: 0, y: 0, w: 300, h: 200, label: "Top", onPress: () => pressed.push(`${id}:top`) },
        {
          id: "lane", x: 0, y: 200, w: 300, h: 200, label: "Lane",
          onDrag: (fx) => drags.push(`${id}:drag ${fx.toFixed(1)}`),
          onRelease: () => drags.push(`${id}:release`),
          onCancel: () => drags.push(`${id}:cancel`),
        },
      ],
    });
  const a = make("a", 0);
  const b = make("b", 50);
  const frame = () => {
    scene.updateMatrixWorld();
    router.update(1 / 72);
  };
  /** A point on window `w` (metres from its center, in its plane), `out` in front of it. */
  const on = (w: typeof a, x: number, y: number, out = 0) => w.panel.mesh.localToWorld(new Vector3(x, y, out));
  /** The bottom bar of `w`'s frame. */
  const bar = (w: typeof a) => on(w, 0, -w.panel.height / 2000 + 0.016);
  const aim = (hand: XRHand, at: Vector3) => {
    hand.ray.origin.set(0.1 * (hand.index ? 1 : -1), 1.3, -0.2);
    hand.ray.direction.copy(at).sub(hand.ray.origin).normalize();
    // the hand itself, away from any window
    hand.handle.copy(hand.ray.origin);
    hand.finger = null;
  };
  const lose = (hand: XRHand, ms: number) => {
    hand.tracking = false;
    t += ms;
  };
  const regain = (hand: XRHand) => {
    hand.tracking = true;
    hand.seenAt = t;
  };
  return { router, windows, hands, a, b, frame, on, bar, aim, lose, regain, pressed, drags };
}

describe("windows in the room", () => {
  test("a pinch at a window's frame carries it, the point taken staying under the hand", () => {
    const { router, hands, a, frame, bar } = room();
    const hand = hands[0];
    frame();
    const point = bar(a);
    hand.handle.copy(point);
    frame();
    expect(router.focusOf(hand)?.reach).toBe("grab");
    router.press(hand, "select");
    hand.handle.add(new Vector3(0.1, 0.05, 0));
    frame();
    expect(a.heldBy).toBe(hand);
    near(bar(a), hand.handle, 1e-3);
    router.release(hand, "select");
    expect(a.heldBy).toBeNull();
  });

  test("one hand holds a window at a time: another taking it lets the first go", () => {
    const { router, hands, a, frame, bar } = room();
    frame();
    hands[0].handle.copy(bar(a));
    hands[1].handle.copy(bar(a)).add(new Vector3(0.05, 0, 0));
    frame();
    router.press(hands[0], "select");
    frame();
    router.press(hands[1], "select");
    expect(a.heldBy).toBe(hands[1]);
    expect(router.captureOf(hands[0])).toBeNull();
    expect(router.captureOf(hands[1])?.target).toBe(a);
  });

  test("letting go of the trigger doesn't drop a window the grip holds", () => {
    const { router, hands, a, frame, bar } = room();
    const hand = hands[0];
    hand.source = { handedness: "left" } as unknown as XRInputSource;
    frame();
    hand.handle.copy(bar(a));
    frame();
    router.press(hand, "squeeze");
    router.press(hand, "select");
    router.release(hand, "select");
    frame();
    expect(a.heldBy).toBe(hand);
    router.release(hand, "squeeze");
    expect(a.heldBy).toBeNull();
  });

  test("touching one window while pointing at another: the touch has it", () => {
    const { router, hands, a, b, frame, on, aim, pressed } = room();
    const hand = hands[1];
    frame();
    aim(hand, on(b, 0, 0.1));
    hand.finger = on(a, 0, 0.1, 0.03);
    frame();
    expect(router.focusOf(hand)?.target).toBe(a);
    expect(router.focusOf(hand)?.reach).toBe("touch");
    // a pinch while touching presses nothing, here or there
    router.press(hand, "select");
    router.release(hand, "select");
    expect(pressed).toEqual([]);
    // pushing in presses what the finger is on
    hand.finger = on(a, 0, 0.1, 0.005);
    frame();
    expect(pressed).toEqual(["a:top"]);
  });

  test("pointing and pinching presses; a drag control follows the ray until let go", () => {
    const { router, hands, a, frame, on, aim, pressed, drags } = room();
    const hand = hands[1];
    frame();
    aim(hand, on(a, 0, 0.1));
    frame();
    router.press(hand, "select");
    router.release(hand, "select");
    expect(pressed).toEqual(["a:top"]);
    aim(hand, on(a, -0.1, -0.1));
    frame();
    router.press(hand, "select");
    aim(hand, on(a, 0.1, -0.1));
    frame();
    router.release(hand, "select");
    expect(drags[0]).toBe("a:drag 0.2");
    expect(drags.at(-2)).toBe("a:drag 0.8");
    expect(drags.at(-1)).toBe("a:release");
  });

  test("tracking lost too long while scrubbing takes the scrub back", () => {
    const { router, hands, a, frame, on, aim, lose, regain, drags } = room();
    const hand = hands[1];
    frame();
    aim(hand, on(a, 0, -0.1));
    frame();
    router.press(hand, "select");
    lose(hand, TRACKING_GRACE + 50);
    frame();
    expect(drags.at(-1)).toBe("a:cancel");
    regain(hand);
    frame();
    router.release(hand, "select");
    expect(drags.filter((d) => d.endsWith("release"))).toEqual([]);
  });

  test("a held window doesn't jump when tracking comes back after a gap", () => {
    const { router, hands, a, frame, bar, lose, regain } = room();
    const hand = hands[0];
    frame();
    hand.handle.copy(bar(a));
    frame();
    router.press(hand, "select");
    frame();
    const before = a.group.position.clone();
    lose(hand, TRACKING_GRACE / 2);
    frame();
    hand.handle.add(new Vector3(0.12, 0, 0));
    regain(hand);
    frame();
    near(a.group.position, before, 1e-6);
    // and from there it follows the hand again
    hand.handle.add(new Vector3(0.05, 0, 0));
    frame();
    expect(a.group.position.x).toBeGreaterThan(before.x + 0.04);
  });

  test("carried along a ray, a window keeps within reach and grows to look the same", () => {
    const { router, hands, a, frame, bar, aim } = room();
    const hand = hands[1];
    hand.source = { handedness: "right" } as unknown as XRInputSource;
    frame();
    aim(hand, bar(a));
    frame();
    router.press(hand, "select");
    // the hand goes far out from the eyes: the window goes three times as far, and no farther than allowed
    hand.ray.origin.add(new Vector3(0, 0, -1.5));
    frame();
    const d = a.group.position.distanceTo(EYES);
    expect(d).toBeLessThanOrEqual(FARTHEST + 0.3);
    expect(d).toBeGreaterThan(2);
    expect(a.group.scale.x).toBeGreaterThan(1.5);
    expect(router.captureOf(hand)?.interaction.pointer?.()).toBeGreaterThan(1);
  });

  test("hiding a window lets go of it", () => {
    const { router, windows, hands, a, frame, bar } = room();
    const hand = hands[0];
    frame();
    hand.handle.copy(bar(a));
    frame();
    router.press(hand, "select");
    windows.show("a", false);
    expect(router.captureOf(hand)).toBeNull();
    expect(a.heldBy).toBeNull();
    frame();
    expect(router.focusOf(hand)?.target).not.toBe(a);
  });

  test("a control can be pressed by its id, without a hand", () => {
    const { a, pressed, drags } = room();
    expect(a.panel.activate("top")).toBe(true);
    expect(a.panel.activate("lane")).toBe(true);
    expect(a.panel.activate("nothing")).toBe(false);
    expect(pressed).toEqual(["a:top"]);
    expect(drags).toEqual(["a:drag 0.5", "a:release"]);
  });
});

describe("menus in windows", () => {
  const box = { x: 0, y: 0, w: 300, h: 300 };
  const labels = (rows: Control[]) => rows.map((r) => r.label);

  test("items needing what the view can't do stay out, and so do the dividers and submenus they leave", () => {
    const view = new MenuView(() => {});
    const items: XRMenuItem[] = [
      { label: "Open…", needs: ["files"], onSelect: () => {} },
      "separator",
      { heading: "Export" },
      { label: "Image", needs: ["files"], onSelect: () => {} },
      "separator",
      { label: "Theme", items: () => [{ label: "Dark", needs: ["page"], onSelect: () => {} }] },
      { label: "Paste", onSelect: () => {} },
      "separator",
    ];
    expect(labels(view.rows(() => items, box))).toEqual(["Paste"]);
    // a view that can do it offers it
    const page = new MenuView(() => {}, new Set(["files"]));
    expect(labels(page.rows(() => items, box))).toEqual(["Open…", "Export", "Image", "Paste"]);
  });

  test("a submenu opens in place, with a row back", () => {
    let redraws = 0;
    const view = new MenuView(() => redraws++);
    let chose = "";
    const items: XRMenuItem[] = [{ label: "Model", items: () => [{ label: "Clear layer", checked: true, onSelect: () => (chose = "clear") }] }];
    view.rows(() => items, box)[0].onPress!();
    expect(redraws).toBe(1);
    const sub = view.rows(() => items, box);
    expect(labels(sub)).toEqual(["Model", "Clear layer"]);
    expect(sub[1].checked).toBe(true);
    // choosing runs it and goes back to the top
    sub[1].onPress!();
    expect(chose).toBe("clear");
    expect(labels(view.rows(() => items, box))).toEqual(["Model"]);
  });

  test("rows keep their ids across redraws: by the command's id, or its label", () => {
    const view = new MenuView(() => {});
    const items: XRMenuItem[] = [
      { id: "selectAll", label: "Select all", onSelect: () => {} },
      { label: "Clear layer", onSelect: () => {} },
    ];
    expect(view.rows(() => items, box).map((r) => r.id)).toEqual(["item:/selectAll", "item:/clear-layer"]);
  });

  test("a long menu comes in pages", () => {
    const view = new MenuView(() => {});
    const items: XRMenuItem[] = Array.from({ length: 20 }, (_, i) => ({ label: `Item ${i + 1}`, onSelect: () => {} }));
    const first = view.rows(() => items, box);
    expect(first.some((r) => r.label === "1 / 3")).toBe(true);
    first.find((r) => r.id === "menu-next")!.onPress!();
    const second = view.rows(() => items, box);
    expect(second[0].label).toBe("Item 8");
    // rows and the pager fit the box
    expect(Math.max(...second.map((r) => r.y + r.h))).toBeLessThanOrEqual(box.h);
  });
});
