import { describe, expect, test } from "bun:test";
import { Editor } from "./editor";
import { renderShot, renderVolume, volumeBounds } from "./render";
import type { Vec3 } from "./types";

const palette = [0, 0xff0000, 0x00ff00];
const pixel = (pixels: Uint8Array, width: number, x: number, y: number) => [...pixels.subarray((x + width * y) * 4, (x + width * y) * 4 + 4)];

describe("renderVolume", () => {
  const size: Vec3 = [3, 3, 3];
  const one = new Uint8Array(27);
  one[1 + 3 * (1 + 3 * 1)] = 1; // the middle cell

  test("frames the filled cells, shading faces like the mesher", () => {
    const front = renderVolume(one, size, palette, {
      width: 20, height: 20, background: 0xffffff, camera: { yaw: 0, pitch: 0, projection: "orthographic" },
    });
    // the +z face fills the middle, with the margin around it in the background
    expect(pixel(front, 20, 10, 10)).toEqual([Math.floor(255 * 0.92), 0, 0, 255]);
    expect(pixel(front, 20, 0, 0)).toEqual([255, 255, 255, 255]);
    const top = renderVolume(one, size, palette, {
      width: 20, height: 20, background: 0xffffff, camera: { yaw: 0, pitch: Math.PI / 2, projection: "perspective" },
    });
    expect(pixel(top, 20, 10, 10)).toEqual([255, 0, 0, 255]); // +y is unshaded
  });

  test("leaves the background transparent, and an empty volume blank", () => {
    const camera = { yaw: 0.7, pitch: 0.5, projection: "perspective" } as const;
    const shot = renderVolume(one, size, palette, { width: 16, height: 16, background: null, camera });
    expect(pixel(shot, 16, 0, 0)[3]).toBe(0);
    expect(pixel(shot, 16, 8, 8)[3]).toBe(255);
    const empty = renderVolume(new Uint8Array(27), size, palette, { width: 4, height: 4, background: 0x102030, camera });
    expect(pixel(empty, 4, 2, 2)).toEqual([16, 32, 48, 255]);
  });

  test("darkens corners that neighbors occlude", () => {
    // an L: the floor cell's top face is occluded where the wall stands next to it
    const l = new Uint8Array(27);
    l[0] = 2;
    l[1] = 2;
    l[1 + 3] = 2;
    const top = renderVolume(l, size, palette, {
      width: 40, height: 20, background: 0, camera: { yaw: 0, pitch: Math.PI / 2, projection: "orthographic" }, samples: 1,
    });
    const far = pixel(top, 40, 3, 10)[1];
    const near = pixel(top, 40, 18, 10)[1];
    expect(far).toBeGreaterThan(near);
    expect(volumeBounds(l, size)).toEqual({ min: [0, 0, 0], max: [1, 1, 0] });
  });
});

describe("renderShot", () => {
  test("tiles views and frames into one image", () => {
    const editor = new Editor();
    editor.setVoxel([4, 4, 4], 2);
    const shot = renderShot(editor, { views: ["iso", "front", "top"], width: 10, height: 10, background: 0xffffff });
    expect([shot.columns, shot.rows]).toEqual([2, 2]);
    expect(shot.tiles.map((t) => [t.view, t.x, t.y])).toEqual([["iso", 0, 0], ["front", 14, 0], ["top", 0, 14]]);
    expect([shot.width, shot.height]).toEqual([24, 24]);
  });
});
