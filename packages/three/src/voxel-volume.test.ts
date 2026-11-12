import { describe, expect, test } from "bun:test";
import { BackSide, Plane, Raycaster, ShaderLib, ShaderMaterial, Vector3 } from "three";
import { toVoxelAnimation } from "@voxeltoy/core/formats/volumes";
import { BOX_MARGIN, voxelHash, VoxelStandardMaterial, VoxelVolume, type VoxelIntersection } from "./voxel-volume";
import type { Vec3 } from "@voxeltoy/core/types";

function volume(size: Vec3, cells: [number, number, number, number][]) {
  const data = new Uint8Array(size[0] * size[1] * size[2]);
  for (const [x, y, z, v] of cells) data[x + size[0] * (y + size[1] * z)] = v;
  return data;
}

/** The drawn box is the volume grown by BOX_MARGIN on every side. */
function expectBox(v: VoxelVolume, min: Vec3, max: Vec3) {
  v.geometry.computeBoundingBox();
  v.geometry.boundingBox!.min.toArray().forEach((n, i) => expect(n).toBeCloseTo(min[i] - BOX_MARGIN));
  v.geometry.boundingBox!.max.toArray().forEach((n, i) => expect(n).toBeCloseTo(max[i] + BOX_MARGIN));
}

function cast(object: VoxelVolume, origin: Vector3, dir: Vector3) {
  object.updateMatrixWorld();
  return new Raycaster(origin, dir.normalize()).intersectObject(object) as VoxelIntersection[];
}

describe("VoxelVolume", () => {
  test("the box spans the grid in cell space, with a small margin", () => {
    const v = new VoxelVolume(new Uint8Array(4 * 3 * 2), [4, 3, 2], [0]);
    expectBox(v, [0, 0, 0], [4, 3, 2]);
  });

  test("raycasts hit the voxel, not the box", () => {
    const v = new VoxelVolume(volume([4, 4, 4], [[2, 1, 3, 7]]), [4, 4, 4], [0]);
    // Down the column x = 2, z = 3: passes empty cells at y = 3 and 2.
    const [hit] = cast(v, new Vector3(2.5, 10, 3.5), new Vector3(0, -1, 0));
    expect(hit.voxel).toEqual({ cell: [2, 1, 3], normal: [0, 1, 0], value: 7 });
    expect(hit.distance).toBeCloseTo(8);
    expect(hit.point.toArray()).toEqual([2.5, 2, 3.5]);
    // Through the box where it holds nothing.
    expect(cast(v, new Vector3(0.5, 10, 0.5), new Vector3(0, -1, 0))).toEqual([]);
  });

  test("raycasts follow the object's transform", () => {
    const v = new VoxelVolume(volume([2, 2, 2], [[0, 0, 0, 1]]), [2, 2, 2], [0]);
    v.position.set(10, 0, 0);
    v.scale.setScalar(0.5);
    const [hit] = cast(v, new Vector3(10.25, 5, 0.25), new Vector3(0, -1, 0));
    expect(hit.voxel.cell).toEqual([0, 0, 0]);
    expect(hit.point.y).toBeCloseTo(0.5);
    expect(hit.distance).toBeCloseTo(4.5);
  });

  test("setVoxel changes what is hit", () => {
    const v = new VoxelVolume(volume([1, 3, 1], [[0, 0, 0, 1]]), [1, 3, 1], [0]);
    v.setVoxel(0, 2, 0, 5);
    expect(v.getVoxel(0, 2, 0)).toBe(5);
    expect(cast(v, new Vector3(0.5, 9, 0.5), new Vector3(0, -1, 0))[0].voxel.cell).toEqual([0, 2, 0]);
    v.setVoxel(0, 2, 0, 0);
    expect(cast(v, new Vector3(0.5, 9, 0.5), new Vector3(0, -1, 0))[0].voxel.cell).toEqual([0, 0, 0]);
    // Outside the grid: ignored.
    v.setVoxel(0, 3, 0, 1);
    expect(v.getVoxel(0, 3, 0)).toBe(0);
  });

  test("setVolume copies, and resizes the box for a new size", () => {
    const source = volume([2, 1, 1], [[1, 0, 0, 3]]);
    const v = new VoxelVolume(source, [2, 1, 1], [0]);
    source[1] = 9;
    expect(v.getVoxel(1, 0, 0)).toBe(3);

    v.setVolume(volume([1, 2, 3], [[0, 1, 2, 4]]), [1, 2, 3]);
    expect(v.size).toEqual([1, 2, 3]);
    expect(v.getVoxel(0, 1, 2)).toBe(4);
    expectBox(v, [0, 0, 0], [1, 2, 3]);
    expect(() => v.setVolume(new Uint8Array(5), [1, 2, 3])).toThrow();
  });

  test("lit lighting swaps in a standard material that shares the voxel uniforms", () => {
    const v = new VoxelVolume(new Uint8Array(1), [1, 1, 1], [0], { lighting: "lit" });
    expect(v.material).toBeInstanceOf(VoxelStandardMaterial);
    expect(v.material.defines).toMatchObject({ STANDARD: "", VOXEL_LIT: "" });
    const flatUniforms = v.customDepthMaterial!.uniforms;

    // The material three.js compiles gets the same uniform objects, so new volumes reach it.
    const shader = { uniforms: {}, vertexShader: ShaderLib.standard.vertexShader, fragmentShader: ShaderLib.standard.fragmentShader };
    (v.material as VoxelStandardMaterial).onBeforeCompile(shader as never);
    expect((shader.uniforms as Record<string, unknown>).uVolume).toBe(flatUniforms.uVolume);
    expect(shader.fragmentShader).toContain("voxelMarch(false, voxelHit)");
    expect(shader.fragmentShader).not.toContain("#include <logdepthbuf_fragment>");
    expect(shader.fragmentShader).toContain("voxelDirectionalShadowCoord");

    v.lighting = "flat";
    expect(v.material).toBeInstanceOf(ShaderMaterial);
  });

  test("shadows are cast by the march, from the back faces", () => {
    const v = new VoxelVolume(new Uint8Array(1), [1, 1, 1], [0]);
    expect(v.customDepthMaterial).toBe(v.customDistanceMaterial!);
    expect(v.material.shadowSide).toBe(BackSide);
  });

  test("the palette texture holds the colors, one texel per index, and no glow", () => {
    const v = new VoxelVolume(new Uint8Array(1), [1, 1, 1], [0, 0x123456]);
    const bytes = v.material.uniforms.uPalette.value.image.data as Uint8Array;
    expect([...bytes.slice(4, 8)]).toEqual([0x12, 0x34, 0x56, 0]); // alpha is emission
  });
});

describe("VoxelVolume animation", () => {
  // A 4×4×4 grid: frame 0 has a voxel at the bottom corner, frame 1 at the top corner, frame 2
  // repeats frame 0. At 10 fps, durations 2, 1, 1 make a 400 ms loop.
  const size: Vec3 = [4, 4, 4];
  const animation = () =>
    toVoxelAnimation({
      name: "Blink",
      fps: 10,
      size,
      palette: [0, 0xff0000, 0x00ff00],
      frames: [
        { id: "a", duration: 2, voxels: volume(size, [[0, 0, 0, 1]]) },
        { id: "b", duration: 1, voxels: volume(size, [[3, 3, 3, 2]]) },
        { id: "c", duration: 1, voxels: volume(size, [[0, 0, 0, 1]]) },
      ],
    });

  test("frames show their cropped volume, placed in the grid", () => {
    const v = VoxelVolume.fromAnimation(animation());
    expect(v.size).toEqual([4, 4, 4]);
    expect(v.frames.map((f) => f.volume)).toEqual([0, 1, 0]);
    v.frame = 1;
    expect(v.volume.size).toEqual([1, 1, 1]);
    expect(v.volume.offset).toEqual([3, 3, 3]);
    expect(v.getVoxel(3, 3, 3)).toBe(2);
    expect(v.getVoxel(0, 0, 0)).toBe(0);
    expectBox(v, [3, 3, 3], [4, 4, 4]);
    expect(v.material.uniforms.uOffset.value.toArray()).toEqual([3, 3, 3]);
  });

  test("raycasts hit the frame on show, in grid coordinates", () => {
    const v = VoxelVolume.fromAnimation(animation());
    v.frame = 1;
    const [hit] = cast(v, new Vector3(3.5, 10, 3.5), new Vector3(0, -1, 0));
    expect(hit.voxel).toEqual({ cell: [3, 3, 3], normal: [0, 1, 0], value: 2 });
    expect(hit.point.y).toBeCloseTo(4);
    expect(cast(v, new Vector3(0.5, 10, 0.5), new Vector3(0, -1, 0))).toEqual([]);
  });

  test("update plays the frames with their holds, and loops", () => {
    const v = VoxelVolume.fromAnimation(animation());
    const shown: number[] = [];
    v.addEventListener("frame", (e) => shown.push(e.frame));
    v.update(1); // paused: nothing happens
    expect(v.frame).toBe(0);
    v.play();
    v.update(0.15); // 150 ms: still frame 0, which lasts 200 ms
    expect(v.frame).toBe(0);
    v.update(0.1); // 250 ms
    expect(v.frame).toBe(1);
    v.update(0.1); // 350 ms
    expect(v.frame).toBe(2);
    v.update(0.1); // 450 ms wraps to 50 ms
    expect(v.frame).toBe(0);
    expect(shown).toEqual([1, 2, 0]);
  });

  test("without loop, playback stops on the last frame and says so", () => {
    const v = VoxelVolume.fromAnimation(animation());
    v.loop = false;
    let finished = 0;
    v.addEventListener("finished", () => finished++);
    v.play();
    v.speed = 2;
    v.update(0.25); // 500 ms of animation
    expect(v.frame).toBe(2);
    expect(v.playing).toBe(false);
    expect(finished).toBe(1);
    v.play(); // starts over
    expect(v.time).toBe(0);
  });

  test("an edit changes every frame that shows the same pose", () => {
    const v = VoxelVolume.fromAnimation(animation());
    v.setVoxel(0, 0, 0, 2);
    v.frame = 2;
    expect(v.getVoxel(0, 0, 0)).toBe(2);
    v.setVoxel(1, 1, 1, 2); // outside frame 2's one-cell crop
    expect(v.getVoxel(1, 1, 1)).toBe(0);
  });

  test("setVolume turns an animation back into one still volume", () => {
    const v = VoxelVolume.fromAnimation(animation());
    v.setVolume(volume([2, 2, 2], [[1, 1, 1, 1]]), [2, 2, 2]);
    expect(v.frames.length).toBe(1);
    expect(v.size).toEqual([2, 2, 2]);
    expect(v.volume.offset).toEqual([0, 0, 0]);
    v.play();
    expect(v.playing).toBe(false);
  });
});

describe("VoxelVolume effects and edits", () => {
  const column = () => new VoxelVolume(new Uint8Array(8).fill(1), [1, 8, 1], [0, 0xff0000]);
  const down = (v: VoxelVolume) => cast(v, new Vector3(0.5, 20, 0.5), new Vector3(0, -1, 0))[0]?.voxel.cell[1];

  test("the hash is stable, spread out, and in 1/65536 steps", () => {
    expect(voxelHash(1, 2, 3)).toBe(voxelHash(1, 2, 3));
    const values = Array.from({ length: 4096 }, (_, i) => voxelHash(i % 16, (i >> 4) % 16, i >> 8));
    for (const h of values) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
      expect(Number.isInteger(h * 65536)).toBe(true);
    }
    const below = values.filter((h) => h < 0.25).length / values.length;
    expect(below).toBeGreaterThan(0.2);
    expect(below).toBeLessThan(0.3);
  });

  test("dissolved cells can't be hit, and the same ones go first", () => {
    const v = column();
    v.dissolve = 0.5;
    const hidden = [0, 1, 2, 3, 4, 5, 6, 7].filter((y) => v.isHidden(0, y, 0));
    const top = [7, 6, 5, 4, 3, 2, 1, 0].find((y) => !v.isHidden(0, y, 0));
    expect(down(v)).toBe(top);
    v.dissolve = 0.25;
    for (let y = 0; y < 8; y++) if (v.isHidden(0, y, 0)) expect(hidden).toContain(y);
    v.dissolve = 1;
    expect(down(v)).toBeUndefined();
  });

  test("a cutaway plane hides the cells on its positive side", () => {
    const v = column();
    v.clipPlane = new Plane(new Vector3(0, 1, 0), -5); // y > 5
    expect(v.isHidden(0, 5, 0)).toBe(true); // center 5.5
    expect(v.isHidden(0, 4, 0)).toBe(false);
    expect(down(v)).toBe(4);
    v.clipPlane = null;
    expect(down(v)).toBe(7);
  });

  test("fillBox and fillSphere change the cells inside, in grid coordinates", () => {
    const v = new VoxelVolume(new Uint8Array(27).fill(1), [3, 3, 3], [0]);
    expect(v.fillBox([0, 0, 0], [1, 1, 1], 0)).toBe(8);
    expect(v.getVoxel(1, 1, 1)).toBe(0);
    expect(v.getVoxel(2, 2, 2)).toBe(1);
    expect(v.fillBox([0, 0, 0], [1, 1, 1], 0)).toBe(0); // nothing left to change
    expect(v.fillSphere([2.5, 2.5, 2.5], 0.6, 3)).toBe(1);
    expect(v.getVoxel(2, 2, 2)).toBe(3);
  });

  test("fills reach every pose with allFrames", () => {
    const size: Vec3 = [2, 1, 1];
    const v = VoxelVolume.fromAnimation(
      toVoxelAnimation({
        name: "",
        fps: 12,
        size,
        palette: [0, 1, 2],
        frames: [
          { id: "a", duration: 1, voxels: new Uint8Array([1, 1]) },
          { id: "b", duration: 1, voxels: new Uint8Array([2, 2]) },
        ],
      }),
    );
    v.fillBox([0, 0, 0], [0, 0, 0], 0);
    v.frame = 1;
    expect(v.getVoxel(0, 0, 0)).toBe(2);
    expect(v.fillBox([0, 0, 0], [0, 0, 0], 0, { allFrames: true })).toBe(1);
    v.frame = 0;
    expect(v.getVoxel(0, 0, 0)).toBe(0);
  });

  test("a flash fades out as update runs, even while paused", () => {
    const v = column();
    v.flash([0, 4, 0], { duration: 0.5, color: 0x00ff00, radius: 2 });
    const amount = () => v.material.uniforms.uFlashAmount.value;
    expect(amount()).toBe(1);
    v.update(0.25);
    expect(amount()).toBeCloseTo(0.5);
    v.update(1);
    expect(amount()).toBe(0);
  });

  test("emission lives in the palette's alpha, and survives a new palette", () => {
    const v = column();
    const alpha = (i: number) => (v.material.uniforms.uPalette.value.image.data as Uint8Array)[i * 4 + 3];
    expect(alpha(1)).toBe(0);
    v.setEmission(1, 1);
    expect(alpha(1)).toBe(255);
    v.setPalette([0, 0x00ff00]);
    expect(alpha(1)).toBe(255);
    expect(v.getEmission(1)).toBe(1);
  });
});

