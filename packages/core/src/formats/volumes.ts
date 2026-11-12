// Voxel volumes: an animation's raw voxels for engines that draw voxels directly (a ray-marched
// VoxelVolume in three.js, a Godot voxel runtime). Each distinct frame is cropped to its voxels
// and written once, as an 8-bit grayscale PNG whose values are palette indices (0 = empty). The
// palette is its own 256×1 PNG. volumes.json gives the grid, timing and where each volume sits.
// See docs/voxel-runtime.md.
//
// A volume image is its Z slices in a grid, left to right, then top to bottom, z = 0 first. Each
// slice is sx × sy pixels: column x, row y (so slices look upside down). Reading the slices in
// order gives Voxeltoy's x-major bytes, x + sx * (y + sy * z), which are also the slice order of a
// 3D texture sx wide, sy high and sz deep. Spare cells at the end are empty.

import { frameStart, isDuration, isFps, ticksToMs, totalTicks } from "../animation";
import type { Vec3 } from "../types";
import { decodePng, encodePng } from "./png";
import { crc32, readZip, type ZipEntry } from "./zip";

export const VOLUMES_MANIFEST = "volumes.json";
export const VOLUMES_PALETTE = "palette.png";

/** A block of voxels placed in the document grid. */
export interface PlacedVolume {
  size: Vec3;
  /** Where cell [0, 0, 0] of this volume is in the document grid. */
  offset: Vec3;
  /** x-major palette indices, size[0] * size[1] * size[2] bytes. */
  data: Uint8Array;
}

/** A whole animation as volumes: what `readVolumes` returns and a runtime plays. */
export interface VoxelAnimation {
  name: string;
  fps: number;
  /** The document grid every volume sits in. */
  size: Vec3;
  /** 256 colors as 0xRRGGBB; index 0 is empty. */
  palette: number[];
  /** The distinct poses. Frames that repeat a pose share one. */
  volumes: PlacedVolume[];
  frames: { id: string; duration: number; volume: number }[];
}

/** Format string new voxel-volume manifests are written with. */
export const VOLUMES_FORMAT = "voxeltoy-volumes";
/** Format string older voxel-volume manifests use. Still accepted on read. */
export const LEGACY_VOLUMES_FORMAT = "moxel-volumes";
/** Extension new voxel-volume archives are saved with. */
export const VOLUMES_EXTENSION = ".voxeltoyvol";
/** Extension older voxel-volume archives use. Still opened. */
export const LEGACY_VOLUMES_EXTENSION = ".moxelvol";

export function isVolumesFormat(format: unknown): format is typeof VOLUMES_FORMAT | typeof LEGACY_VOLUMES_FORMAT {
  return format === VOLUMES_FORMAT || format === LEGACY_VOLUMES_FORMAT;
}

export interface VolumesManifest {
  format: typeof VOLUMES_FORMAT | typeof LEGACY_VOLUMES_FORMAT;
  version: 1;
  name: string;
  fps: number;
  /** The whole loop. */
  durationMs: number;
  /** The document grid, in voxels. */
  size: Vec3;
  /** A 256×1 RGBA PNG: column i is palette index i. */
  palette: string;
  volumes: { file: string; size: Vec3; offset: Vec3; columns: number; rows: number }[];
  frames: { id: string; index: number; duration: number; startMs: number; durationMs: number; volume: number }[];
}

/** The smallest box around the solid voxels. An empty volume becomes one empty cell. */
export function cropVolume(voxels: Uint8Array, size: Vec3): PlacedVolume {
  const [sx, sy, sz] = size;
  const min: Vec3 = [sx, sy, sz];
  const max: Vec3 = [-1, -1, -1];
  for (let z = 0, i = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++, i++) {
        if (voxels[i] === 0) continue;
        if (x < min[0]) min[0] = x;
        if (x > max[0]) max[0] = x;
        if (y < min[1]) min[1] = y;
        if (y > max[1]) max[1] = y;
        if (z < min[2]) min[2] = z;
        if (z > max[2]) max[2] = z;
      }
    }
  }
  if (max[0] < 0) return { size: [1, 1, 1], offset: [0, 0, 0], data: new Uint8Array(1) };
  const crop: Vec3 = [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
  const data = new Uint8Array(crop[0] * crop[1] * crop[2]);
  for (let z = 0; z < crop[2]; z++) {
    for (let y = 0; y < crop[1]; y++) {
      const from = min[0] + sx * (min[1] + y + sy * (min[2] + z));
      data.set(voxels.subarray(from, from + crop[0]), crop[0] * (y + crop[1] * z));
    }
  }
  return { size: crop, offset: min, data };
}

/** Columns and rows of slices for a volume `depth` slices deep: as square as it gets. */
export function sliceGrid(depth: number): { columns: number; rows: number } {
  const columns = Math.max(1, Math.ceil(Math.sqrt(depth)));
  return { columns, rows: Math.max(1, Math.ceil(depth / columns)) };
}

/** A volume's Z slices laid out as one grayscale image. */
export function volumeToImage(data: Uint8Array, [sx, sy, sz]: Vec3) {
  const { columns, rows } = sliceGrid(sz);
  const width = sx * columns;
  const height = sy * rows;
  const pixels = new Uint8Array(width * height);
  for (let z = 0; z < sz; z++) {
    const left = (z % columns) * sx;
    const top = Math.floor(z / columns) * sy;
    for (let y = 0; y < sy; y++) {
      const from = sx * (y + sy * z);
      pixels.set(data.subarray(from, from + sx), left + (top + y) * width);
    }
  }
  return { width, height, columns, rows, pixels };
}

/** The volume back from its slice image (`width` pixels wide, `channels` bytes per pixel, first channel used). */
export function imageToVolume(pixels: Uint8Array, width: number, [sx, sy, sz]: Vec3, columns: number, channels = 1) {
  const data = new Uint8Array(sx * sy * sz);
  for (let z = 0; z < sz; z++) {
    const left = (z % columns) * sx;
    const top = Math.floor(z / columns) * sy;
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++) data[x + sx * (y + sy * z)] = pixels[(left + x + (top + y) * width) * channels];
    }
  }
  return data;
}

function sameVolume(a: PlacedVolume, b: PlacedVolume) {
  if (a.size.some((n, i) => n !== b.size[i]) || a.offset.some((n, i) => n !== b.offset[i])) return false;
  if (a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

/** Crop every frame and keep each distinct pose once. */
export function toVoxelAnimation(input: {
  name: string;
  fps: number;
  size: Vec3;
  palette: readonly number[];
  frames: readonly { id: string; duration: number; voxels: Uint8Array }[];
}): VoxelAnimation {
  const volumes: PlacedVolume[] = [];
  const byKey = new Map<string, number[]>();
  const frames = input.frames.map((f) => {
    const volume = cropVolume(f.voxels, input.size);
    const key = `${crc32(volume.data)} ${volume.size} ${volume.offset}`;
    const candidates = byKey.get(key) ?? [];
    let index = candidates.find((i) => sameVolume(volumes[i], volume));
    if (index === undefined) {
      index = volumes.push(volume) - 1;
      byKey.set(key, [...candidates, index]);
    }
    return { id: f.id, duration: f.duration, volume: index };
  });
  return {
    name: input.name,
    fps: input.fps,
    size: [...input.size],
    palette: Array.from({ length: 256 }, (_, i) => input.palette[i] ?? 0),
    volumes,
    frames,
  };
}

const volumeFileName = (index: number, count: number) =>
  `volume-${String(index + 1).padStart(Math.max(2, String(count).length), "0")}.png`;

/** The files of a voxel volumes export: volumes.json, palette.png and one PNG per volume. */
export async function writeVolumes(animation: VoxelAnimation): Promise<ZipEntry[]> {
  const { volumes, frames, fps } = animation;
  const durations = frames.map((f) => f.duration);
  const palette = new Uint8Array(256 * 4);
  for (let i = 1; i < 256; i++) {
    const c = animation.palette[i] ?? 0;
    palette.set([(c >> 16) & 255, (c >> 8) & 255, c & 255, 255], i * 4);
  }
  const entries: ZipEntry[] = [];
  const manifest: VolumesManifest = {
    format: VOLUMES_FORMAT,
    version: 1,
    name: animation.name,
    fps,
    durationMs: ticksToMs(totalTicks(durations), fps),
    size: [...animation.size],
    palette: VOLUMES_PALETTE,
    volumes: [],
    frames: frames.map((f, index) => ({
      id: f.id,
      index,
      duration: f.duration,
      startMs: ticksToMs(frameStart(durations, index), fps),
      durationMs: ticksToMs(f.duration, fps),
      volume: f.volume,
    })),
  };
  for (const [i, v] of volumes.entries()) {
    const file = volumeFileName(i, volumes.length);
    const image = volumeToImage(v.data, v.size);
    manifest.volumes.push({ file, size: [...v.size], offset: [...v.offset], columns: image.columns, rows: image.rows });
    entries.push({ name: file, data: await encodePng({ width: image.width, height: image.height, channels: 1, pixels: image.pixels }) });
  }
  entries.unshift(
    { name: VOLUMES_MANIFEST, data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) },
    { name: VOLUMES_PALETTE, data: await encodePng({ width: 256, height: 1, channels: 4, pixels: palette }) },
  );
  return entries;
}

const isVec3 = (v: unknown, min: number): v is Vec3 =>
  Array.isArray(v) && v.length === 3 && v.every((n) => Number.isInteger(n) && n >= min);

/**
 * Read a voxel volumes export. `read` returns a file's bytes by its name in the manifest: from an
 * unpacked zip, or fetched next to the manifest.
 */
export async function readVolumes(
  read: (name: string) => Promise<Uint8Array> | Uint8Array,
  manifestName = VOLUMES_MANIFEST,
): Promise<VoxelAnimation> {
  let manifest: VolumesManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(await read(manifestName)));
  } catch (error) {
    throw new Error(`Couldn't read ${manifestName}: ${error instanceof Error ? error.message : error}`);
  }
  if (!isVolumesFormat(manifest?.format)) throw new Error(`${manifestName} is not a voxel volumes manifest`);
  if (manifest.version !== 1) throw new Error(`Voxel volumes version ${manifest.version} is newer than this reader`);
  if (!isFps(manifest.fps)) throw new Error(`Bad fps: ${manifest.fps}`);
  if (!isVec3(manifest.size, 1)) throw new Error("Bad grid size");
  if (!Array.isArray(manifest.volumes) || !manifest.volumes.length) throw new Error("No volumes");
  if (!Array.isArray(manifest.frames) || !manifest.frames.length) throw new Error("No frames");

  const paletteImage = await decodePng(await read(manifest.palette));
  if (paletteImage.width < 256 || paletteImage.channels < 3) throw new Error("The palette must be a 256×1 RGB or RGBA image");
  const palette = Array.from({ length: 256 }, (_, i) => {
    const p = i * paletteImage.channels;
    return i === 0 ? 0 : (paletteImage.pixels[p] << 16) | (paletteImage.pixels[p + 1] << 8) | paletteImage.pixels[p + 2];
  });

  const volumes: PlacedVolume[] = [];
  for (const v of manifest.volumes) {
    if (!isVec3(v.size, 1) || !isVec3(v.offset, 0) || v.size.some((n, i) => n + v.offset[i] > manifest.size[i])) {
      throw new Error(`Volume ${v.file} does not fit in the ${manifest.size.join("×")} grid`);
    }
    const columns = Number.isInteger(v.columns) && v.columns > 0 ? v.columns : sliceGrid(v.size[2]).columns;
    const image = await decodePng(await read(v.file));
    const rows = Math.ceil(v.size[2] / columns);
    if (image.width < v.size[0] * columns || image.height < v.size[1] * rows) {
      throw new Error(`${v.file} is ${image.width}×${image.height}, too small for its ${v.size.join("×")} voxels`);
    }
    volumes.push({ size: [...v.size], offset: [...v.offset], data: imageToVolume(image.pixels, image.width, v.size, columns, image.channels) });
  }

  const frames = manifest.frames.map((f, i) => {
    if (!isDuration(f.duration)) throw new Error(`Frame ${i + 1} has a bad duration: ${f.duration}`);
    if (!Number.isInteger(f.volume) || f.volume < 0 || f.volume >= volumes.length) {
      throw new Error(`Frame ${i + 1} refers to a missing volume`);
    }
    return { id: typeof f.id === "string" ? f.id : `frame:${i}`, duration: f.duration, volume: f.volume };
  });
  return { name: String(manifest.name ?? ""), fps: manifest.fps, size: [...manifest.size], palette, volumes, frames };
}

/** Read a voxel volumes export from its zip archive. */
export async function readVolumesZip(bytes: Uint8Array): Promise<VoxelAnimation> {
  const files = await readZip(bytes);
  return readVolumes((name) => {
    const file = files.get(name);
    if (!file) throw new Error(`The archive has no ${name}`);
    return file;
  });
}
