import { describe, expect, test } from "bun:test";
import { Editor } from "../editor";
import type { Vec3 } from "../types";
import { decodePng, deflate, encodePng } from "./png";
import {
  cropVolume,
  imageToVolume,
  readVolumes,
  readVolumesZip,
  toVoxelAnimation,
  volumeToImage,
  writeVolumes,
  type VolumesManifest,
} from "./volumes";
import { crc32, readZip, writeZip } from "./zip";

function grid(size: Vec3, cells: [number, number, number, number][]) {
  const data = new Uint8Array(size[0] * size[1] * size[2]);
  for (const [x, y, z, v] of cells) data[x + size[0] * (y + size[1] * z)] = v;
  return data;
}

const roundTrip = (entries: { name: string; data: Uint8Array }[]) => readVolumesZip(writeZip(entries));

describe("png", () => {
  test("gray and RGBA images round-trip byte for byte", async () => {
    const gray = { width: 3, height: 2, channels: 1 as const, pixels: new Uint8Array([0, 1, 255, 7, 0, 128]) };
    expect(await decodePng(await encodePng(gray))).toEqual(gray);
    const rgba = { width: 2, height: 1, channels: 4 as const, pixels: new Uint8Array([1, 2, 3, 4, 250, 251, 252, 253]) };
    expect(await decodePng(await encodePng(rgba))).toEqual(rgba);
  });

  test("reads every row filter that other tools write", async () => {
    // 2 pixels wide, RGB, one row per filter: none, sub, up, average, paeth. Filter forward with
    // the spec's formulas, then check the decoder undoes them.
    const width = 2, channels = 3, stride = width * channels;
    const want = Uint8Array.from({ length: stride * 5 }, (_, i) => (i * 37 + 11) & 255);
    const at = (x: number, y: number) => (x < 0 || y < 0 ? 0 : want[y * stride + x]);
    const paeth = (a: number, b: number, c: number) => {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    const raw = new Uint8Array((stride + 1) * 5);
    for (let y = 0; y < 5; y++) {
      raw[y * (stride + 1)] = y;
      for (let x = 0; x < stride; x++) {
        const a = at(x - channels, y), b = at(x, y - 1), c = at(x - channels, y - 1);
        const predict = [0, a, b, (a + b) >> 1, paeth(a, b, c)][y];
        raw[y * (stride + 1) + 1 + x] = (at(x, y) - predict) & 255;
      }
    }
    const header = new Uint8Array(13);
    new DataView(header.buffer).setUint32(0, width);
    new DataView(header.buffer).setUint32(4, 5);
    header[8] = 8;
    header[9] = 2; // RGB
    const chunk = (type: string, data: Uint8Array) => {
      const out = new Uint8Array(12 + data.length);
      const view = new DataView(out.buffer);
      view.setUint32(0, data.length);
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
      out.set(data, 8);
      view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
      return out;
    };
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", await deflate(raw)), chunk("IEND", new Uint8Array())];
    const file = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((offset, p) => (file.set(p, offset), offset + p.length), 0);
    const image = await decodePng(file);
    expect(image.channels).toBe(3);
    expect(image.pixels).toEqual(want);
  });

  test("rejects what it can't read", async () => {
    await expect(decodePng(new Uint8Array([1, 2, 3]))).rejects.toThrow("Not a PNG");
  });
});

describe("zip", () => {
  test("reads back what it writes", async () => {
    const files = await readZip(writeZip([{ name: "a.txt", data: new Uint8Array([1, 2]) }, { name: "dir/b", data: new Uint8Array(0) }]));
    expect([...files.keys()]).toEqual(["a.txt", "dir/b"]);
    expect([...files.get("a.txt")!]).toEqual([1, 2]);
  });
});

describe("voxel volumes", () => {
  test("cropping keeps the voxels and says where they were", () => {
    const v = cropVolume(grid([4, 4, 4], [[1, 2, 3, 5], [2, 2, 3, 6]]), [4, 4, 4]);
    expect(v.size).toEqual([2, 1, 1]);
    expect(v.offset).toEqual([1, 2, 3]);
    expect([...v.data]).toEqual([5, 6]);
    expect(cropVolume(new Uint8Array(8), [2, 2, 2])).toEqual({ size: [1, 1, 1], offset: [0, 0, 0], data: new Uint8Array(1) });
  });

  test("slices are laid out in a grid, in Voxeltoy's byte order", () => {
    const size: Vec3 = [2, 1, 3];
    const data = new Uint8Array([1, 2, 3, 4, 5, 6]); // z = 0: 1 2, z = 1: 3 4, z = 2: 5 6
    const image = volumeToImage(data, size);
    expect([image.columns, image.rows, image.width, image.height]).toEqual([2, 2, 4, 2]);
    expect([...image.pixels]).toEqual([1, 2, 3, 4, 5, 6, 0, 0]);
    expect(imageToVolume(image.pixels, image.width, size, image.columns)).toEqual(data);
  });

  test("a single-column volume image is exactly the layer bytes", () => {
    const size: Vec3 = [3, 2, 1];
    const data = new Uint8Array([1, 2, 3, 4, 5, 6]);
    expect(volumeToImage(data, size).pixels).toEqual(data);
  });

  test("repeated poses are stored once", () => {
    const size: Vec3 = [3, 3, 3];
    const a = grid(size, [[0, 0, 0, 1]]);
    const b = grid(size, [[2, 2, 2, 1]]);
    const animation = toVoxelAnimation({
      name: "Bounce",
      fps: 12,
      size,
      palette: [0, 0xff0000],
      frames: [
        { id: "f1", duration: 2, voxels: a },
        { id: "f2", duration: 1, voxels: b },
        { id: "f3", duration: 1, voxels: a.slice() },
      ],
    });
    expect(animation.volumes.length).toBe(2);
    expect(animation.frames.map((f) => f.volume)).toEqual([0, 1, 0]);
    expect(animation.volumes[1].offset).toEqual([2, 2, 2]);
  });

  test("an export reads back exactly, through a zip", async () => {
    const size: Vec3 = [5, 4, 6];
    const frames = [0, 1, 2].map((i) => ({
      id: `f${i}`,
      duration: i + 1,
      voxels: grid(size, [[i, 0, 0, 1], [4, 3, 5 - i, 200], [2, 2, 2, 17]]),
    }));
    const palette = Array.from({ length: 256 }, (_, i) => (i * 0x010203) & 0xffffff);
    const animation = toVoxelAnimation({ name: "Test", fps: 10, size, palette, frames });
    const entries = await writeVolumes(animation);
    expect(entries.map((e) => e.name)).toEqual(["volumes.json", "palette.png", "volume-01.png", "volume-02.png", "volume-03.png"]);

    const manifest = JSON.parse(new TextDecoder().decode(entries[0].data)) as VolumesManifest;
    expect(manifest.format).toBe("voxeltoy-volumes");
    expect(manifest.durationMs).toBe(600);
    expect(manifest.frames.map((f) => f.startMs)).toEqual([0, 100, 300]);

    const read = await roundTrip(entries);
    expect(read).toEqual({ ...animation, palette: [0, ...palette.slice(1)] });
    // Each frame's volume, placed back in the grid, is the frame.
    for (const [i, f] of read.frames.entries()) {
      const v = read.volumes[f.volume];
      const full = new Uint8Array(size[0] * size[1] * size[2]);
      for (let z = 0; z < v.size[2]; z++)
        for (let y = 0; y < v.size[1]; y++)
          for (let x = 0; x < v.size[0]; x++)
            full[x + v.offset[0] + size[0] * (y + v.offset[1] + size[1] * (z + v.offset[2]))] = v.data[x + v.size[0] * (y + v.size[1] * z)];
      expect(full).toEqual(frames[i].voxels);
    }
  });

  test("volume PNGs are plain 8-bit gray, so engines read the indices as stored", async () => {
    const entries = await writeVolumes(toVoxelAnimation({ name: "", fps: 12, size: [1, 1, 1], palette: [], frames: [{ id: "a", duration: 1, voxels: new Uint8Array([9]) }] }));
    const png = entries[2].data;
    expect(png[25]).toBe(0); // color type 0: grayscale
    const types = new Set<string>();
    for (let at = 8; at < png.length; ) {
      const length = new DataView(png.buffer, png.byteOffset).getUint32(at);
      types.add(String.fromCharCode(...png.subarray(at + 4, at + 8)));
      at += 12 + length;
    }
    expect([...types]).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  test("bad files fail with a reason", async () => {
    const entries = await writeVolumes(toVoxelAnimation({ name: "", fps: 12, size: [2, 2, 2], palette: [], frames: [{ id: "a", duration: 1, voxels: new Uint8Array(8).fill(1) }] }));
    const manifest = JSON.parse(new TextDecoder().decode(entries[0].data));
    const files = new Map(entries.map((e) => [e.name, e.data]));
    const withManifest = (m: object) => readVolumes((name) => (name === "volumes.json" ? new TextEncoder().encode(JSON.stringify(m)) : files.get(name)!));
    await expect(withManifest({ ...manifest, format: "x" })).rejects.toThrow("not a voxel volumes manifest");
    await expect(withManifest({ ...manifest, volumes: [{ ...manifest.volumes[0], offset: [1, 0, 0] }] })).rejects.toThrow("does not fit");
    await expect(withManifest({ ...manifest, frames: [{ ...manifest.frames[0], volume: 3 }] })).rejects.toThrow("missing volume");
  });

  test("an animated document exports every frame, with its holds", async () => {
    const e = new Editor({ name: "Walk", size: [4, 4, 4], palette: [0, 0xff0000, 0x00ff00], layers: [{ name: "Body", visible: true, locked: false, data: new Uint8Array(64) }], activeLayer: 0 });
    e.setVoxel([0, 0, 0], 1);
    const first = e.activeFrameId;
    const second = e.insertFrame()!;
    e.setVoxel([1, 0, 0], 2);
    e.setFrameDuration(second, 3);
    e.insertFrame(); // a copy of the second pose
    // As the SDK's export does it.
    const animation = toVoxelAnimation({
      name: e.name,
      fps: e.fps,
      size: e.size,
      palette: e.palette,
      frames: e.frames.map((f) => ({ id: f.id, duration: f.duration, voxels: e.evaluateFrame(f.id) })),
    });
    const read = await roundTrip(await writeVolumes(animation));
    expect(read.frames.map((f) => [f.id, f.duration, f.volume])).toEqual([
      [first, 1, 0],
      [second, 3, 1],
      [e.frames[2].id, 3, 1],
    ]);
    expect([...read.volumes[1].data]).toEqual([1, 2]);
    expect(read.fps).toBe(12);
  });
});

