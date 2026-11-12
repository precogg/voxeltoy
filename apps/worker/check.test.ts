import { describe, expect, test } from "bun:test";
import { Editor } from "@voxeltoy/core/editor";
import { serializeMoxel } from "@voxeltoy/core/formats/moxel";
import { check } from "./check";

function model(frames: number) {
  const e = new Editor();
  e.newDocument([4, 4, 4]);
  e.setName("Walk");
  e.setVoxel([0, 0, 0], 2);
  for (let i = 1; i < frames; i++) e.insertFrame();
  return JSON.parse(serializeMoxel(e.getDocument()));
}

describe("snapshot check", () => {
  test("takes still models and animations", () => {
    expect(check(JSON.stringify(model(1)))).toEqual({ name: "Walk" });
    const animated = model(3);
    expect(animated.version).toBe(3);
    expect(check(JSON.stringify(animated))).toEqual({ name: "Walk" });
  });

  test("turns down what it can't keep", () => {
    const animated = model(2);
    expect(check(JSON.stringify({ ...animated, format: "moxel" }))).toEqual({ name: "Walk" });
    expect(check(JSON.stringify({ ...animated, version: 2 }))).toEqual({ error: "Not a Voxeltoy file" });
    expect(check(JSON.stringify({ ...animated, layers: [{ ...animated.layers[0], kind: "shape" }] }))).toHaveProperty("error");
    expect(check(JSON.stringify({ ...animated, frames: [] }))).toEqual({ error: "Bad frames" });
    expect(check(JSON.stringify({ ...animated, frames: [{ ...animated.frames[0], duration: 0 }] }))).toHaveProperty("error");
  });

  test("counts every frame toward the size limit", () => {
    const animated = model(2);
    const big = { ...animated, size: [256, 256, 256], frames: Array.from({ length: 5 }, () => animated.frames[0]) };
    expect(check(JSON.stringify(big))).toEqual({ error: "The model is too big to share" });
  });
});
