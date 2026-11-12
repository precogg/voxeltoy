import { describe, expect, test } from "bun:test";
import { Mesher, MESH_NO_AO, MESH_NO_SHADE } from "./mesher";

describe("greedy mesher integration", () => {
  test("viewport and export share six-quad solid geometry with their own shading", () => {
    const mesher = new Mesher();
    const volume = new Uint8Array(8 * 6 * 4).fill(1);
    const viewport = mesher.build(volume, [8, 6, 4], [0, 0xc86432]);
    const exported = mesher.build(volume, [8, 6, 4], [0, 0xc86432], MESH_NO_AO | MESH_NO_SHADE);
    expect(viewport.getAttribute("position").count).toBe(24);
    expect(exported.getIndex()!.count).toBe(36);
    expect(exported.getAttribute("position").array).toEqual(viewport.getAttribute("position").array);
    expect(exported.boundingSphere!.center.toArray()).toEqual([4, 3, 2]);
    expect(Array.from(exported.getAttribute("color").array).slice(0, 3)).toEqual([200, 100, 50]);
    expect(viewport.getAttribute("color").array).not.toEqual(exported.getAttribute("color").array);
    viewport.dispose();
    exported.dispose();
  });

  test("buffer growth, reuse, palette updates, and empty geometry stay independent", () => {
    const mesher = new Mesher();
    const small = mesher.build(new Uint8Array([1]), [1, 1, 1], [0, 0xff0000]);
    const original = small.getAttribute("position").array.slice();
    const size = 20;
    const checker = Uint8Array.from({ length: size ** 3 }, (_, i) => {
      const x = i % size, y = Math.floor(i / size) % size, z = Math.floor(i / (size * size));
      return (x + y + z) % 2 ? 1 : 0;
    });
    const large = mesher.build(checker, [size, size, size], [0, 0x00ff00], MESH_NO_AO);
    expect(large.getAttribute("position").count).toBe(size ** 3 / 2 * 6 * 4);
    expect(large.getIndex()!.count).toBe(size ** 3 / 2 * 6 * 6);
    const indices = large.getIndex()!.array;
    expect(indices[indices.length - 1]).toBe(large.getAttribute("position").count - 1);
    expect(small.getAttribute("position").array).toEqual(original);
    expect(Array.from(small.getAttribute("color").array).slice(0, 3)).toEqual([198, 0, 0]);
    const empty = mesher.build(new Uint8Array(8), [2, 2, 2], [0, 0]);
    expect(empty.getAttribute("position").count).toBe(0);
    expect(empty.getIndex()!.count).toBe(0);
    const recolored = mesher.build(new Uint8Array([1]), [1, 1, 1], [0, 0x0000ff], MESH_NO_SHADE | MESH_NO_AO);
    expect(Array.from(recolored.getAttribute("color").array).slice(0, 3)).toEqual([0, 0, 255]);
    for (const geometry of [small, large, empty, recolored]) geometry.dispose();
  });
});
