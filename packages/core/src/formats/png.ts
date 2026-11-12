// A small PNG codec for exact data: 8-bit images whose bytes must survive a round trip, such as
// voxel volumes (palette indices as gray) and palettes. It writes no color chunks (gAMA, sRGB,
// iCCP, cICP), so loaders read the values as stored. Deflate comes from the web-standard
// CompressionStream, which browsers, Bun and Node all have. No DOM.
// See https://www.w3.org/TR/png-3/

import { crc32 } from "./zip";

/** Channels per pixel: gray, gray + alpha, RGB, RGBA. */
export type PngChannels = 1 | 2 | 3 | 4;

export interface PngImage {
  width: number;
  height: number;
  channels: PngChannels;
  /** Row-major, top row first, `channels` bytes per pixel. */
  pixels: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const COLOR_TYPE: Record<PngChannels, number> = { 1: 0, 2: 4, 3: 2, 4: 6 };
const CHANNELS: Record<number, PngChannels> = { 0: 1, 4: 2, 2: 3, 6: 4 };

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** zlib-wrapped deflate, as PNG's IDAT holds. */
export const deflate = (data: Uint8Array) => pipe(data, new CompressionStream("deflate"));
export const inflate = (data: Uint8Array) => pipe(data, new DecompressionStream("deflate"));

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export async function encodePng({ width, height, channels, pixels }: PngImage): Promise<Uint8Array> {
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) {
    throw new Error(`PNG size must be whole and positive, not ${width}×${height}`);
  }
  if (pixels.length !== width * height * channels) throw new Error("PNG pixels do not match its size");
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = COLOR_TYPE[channels];
  // compression, filter method and interlace stay 0
  // Each row starts with its filter type: 0, none. Deflate does well on sparse voxel data as it is.
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const parts = [
    new Uint8Array(SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", await deflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Reads 8-bit, non-interlaced gray, gray + alpha, RGB and RGBA PNGs, with any row filters. */
export async function decodePng(bytes: Uint8Array): Promise<PngImage> {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error("Not a PNG file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0, channels: PngChannels | undefined;
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (data.length !== length) throw new Error("PNG file is cut short");
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      const depth = data[8], color = data[9], interlace = data[12];
      channels = CHANNELS[color];
      if (depth !== 8 || !channels) {
        throw new Error(`Only 8-bit gray, gray + alpha, RGB or RGBA PNGs are supported (bit depth ${depth}, color type ${color})`);
      }
      if (interlace !== 0) throw new Error("Interlaced PNGs are not supported");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length;
  }
  if (!channels || !width || !height) throw new Error("PNG file has no header");
  const compressed = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  let offset = 0;
  for (const d of idat) {
    compressed.set(d, offset);
    offset += d.length;
  }
  const raw = await inflate(compressed);
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error("PNG image data is cut short");

  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[row + x - channels] : 0;
      const b = y > 0 ? pixels[row - stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[row - stride + x - channels] : 0;
      const v = raw[src + x];
      let out: number;
      if (filter === 0) out = v;
      else if (filter === 1) out = v + a;
      else if (filter === 2) out = v + b;
      else if (filter === 3) out = v + ((a + b) >> 1);
      else if (filter === 4) out = v + paeth(a, b, c);
      else throw new Error(`Unknown PNG row filter ${filter}`);
      pixels[row + x] = out & 255;
    }
  }
  return { width, height, channels, pixels };
}
