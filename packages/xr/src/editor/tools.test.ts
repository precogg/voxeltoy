import { describe, expect, test } from "bun:test";
import { Group } from "three";
import { Editor } from "@voxeltoy/core/editor";
import { XRHand } from "../input";
import { Router } from "../interaction";
import type { CellOp, XRReach } from "./reach";
import { BoxDraw, ModelHandles, RayStroke, VoxelTool } from "./tools";

/** A controller, tracked. */
function controller(index: number) {
  const hand = new XRHand(index);
  hand.source = { handedness: index ? "right" : "left" } as unknown as XRInputSource;
  hand.tracking = true;
  hand.seenAt = performance.now();
  return hand;
}

/** The tool on a fresh model, with voxel space at the room's origin (a cell a metre), the palette on the left. */
function setup(reach: XRReach, op: CellOp = "add") {
  const editor = new Editor();
  const hands = [controller(0), controller(1)];
  const router = new Router(hands);
  const workspace = new Group();
  const voxels = new Group();
  workspace.add(voxels);
  workspace.updateMatrixWorld(true);
  const handles = new ModelHandles(workspace, router);
  const tool = new VoxelTool(editor, router, handles, voxels, { op: () => op, reach: () => reach, isPaletteHand: (h) => h === hands[0] });
  router.add(tool);
  const filled = () => {
    const out: string[] = [];
    const [sx, sy, sz] = editor.size;
    const v = editor.evaluate();
    for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) if (v[x + sx * (y + sy * z)]) out.push(`${x},${y},${z}`);
    return out;
  };
  return { editor, hands, router, tool, filled, draw: hands[1] };
}

describe("drawing along the ray", () => {
  test("with nothing there, Add lands on the floor and a drag keeps to that layer", () => {
    const { router, draw, filled } = setup("ray");
    draw.ray.origin.set(2.5, 10, 2.5);
    draw.ray.direction.set(0, -1, 0);
    router.update(0);
    expect(router.focusOf(draw)?.reach).toBe("ray");
    expect(router.press(draw, "select")).toBe(true);
    expect(router.captureOf(draw)?.interaction).toBeInstanceOf(RayStroke);
    draw.ray.origin.set(5.5, 10, 2.5);
    router.update(0);
    router.release(draw, "select");
    expect(filled()).toEqual(["2,0,2", "3,0,2", "4,0,2", "5,0,2"]);
  });

  test("pointing at a block, Add puts one on the face it points at", () => {
    const { router, draw, filled } = setup("ray");
    draw.ray.origin.set(2.5, 10, 2.5);
    draw.ray.direction.set(0, -1, 0);
    for (let i = 0; i < 2; i++) {
      router.update(0);
      router.press(draw, "select");
      router.release(draw, "select");
    }
    expect(filled()).toEqual(["2,0,2", "2,1,2"]);
  });

  test("held still at a slant on a block's side, it adds the one cell it points at", () => {
    const { editor, router, draw, filled } = setup("ray");
    editor.applyCells([[2, 0, 2]], "add");
    // meets the side at y 0.95, but crosses the next layer's middle at y 1.025
    draw.ray.origin.set(6, 1.4, 2.5);
    draw.ray.direction.set(-1, -0.15, 0).normalize();
    router.update(0);
    router.press(draw, "select");
    router.update(0);
    router.update(0);
    router.release(draw, "select");
    expect(filled()).toEqual(["2,0,2", "3,0,2"]);
  });

  test("the palette hand holds the model rather than drawing", () => {
    const { router, hands, filled } = setup("ray");
    hands[0].ray.origin.set(2.5, 10, 2.5);
    hands[0].ray.direction.set(0, -1, 0);
    router.update(0);
    expect(router.focusOf(hands[0])?.reach).toBe("free");
    router.press(hands[0], "select");
    router.release(hands[0], "select");
    expect(filled()).toEqual([]);
  });
});

describe("boxes", () => {
  test("a box from where the tip went down to where it let go, as one undo step", () => {
    const { editor, router, draw, filled } = setup("box");
    draw.tip.set(1.5, 0.5, 1.5);
    router.update(0);
    router.press(draw, "select");
    expect(router.captureOf(draw)?.interaction).toBeInstanceOf(BoxDraw);
    draw.tip.set(3.2, 1.9, 2.1);
    router.update(0);
    // nothing until it lets go
    expect(filled()).toEqual([]);
    router.release(draw, "select");
    expect(filled()).toHaveLength(3 * 2 * 2);
    editor.undo();
    expect(filled()).toEqual([]);
  });

  test("a tip outside the grid takes the nearest cell in it", () => {
    const { router, draw, filled } = setup("box");
    draw.tip.set(-5, 0.5, 0.5);
    router.update(0);
    router.press(draw, "select");
    draw.tip.set(1.5, 0.5, 0.5);
    router.update(0);
    router.release(draw, "select");
    expect(filled()).toEqual(["0,0,0", "1,0,0"]);
  });

  test("Erase takes a box out", () => {
    const { editor, router, draw, filled } = setup("box", "erase");
    editor.applyCells([[0, 0, 0], [1, 0, 0], [2, 0, 0]], "add");
    draw.tip.set(0.5, 0.5, 0.5);
    router.update(0);
    router.press(draw, "select");
    draw.tip.set(1.5, 0.5, 0.5);
    router.update(0);
    router.release(draw, "select");
    expect(filled()).toEqual(["2,0,0"]);
  });
});
