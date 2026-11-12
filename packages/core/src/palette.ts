// Palettes are lists of 0xRRGGBB colors. In a document, palette[0] is reserved
// for "empty", so a palette file's colors land at indices 1..255.

import { fromHex, MAX_COLORS, toHex } from "./color";
import { decodePng, encodePng } from "./formats/png";

export { fromHex, MAX_COLORS, toHex };

export interface NamedPalette {
  name: string;
  colors: number[];
}

const hexList = (s: string) => s.trim().split(/\s+/).map((h) => parseInt(h, 16));

export const BUILTIN_PALETTES: NamedPalette[] = [
  {
    name: "Endesga 32",
    colors: hexList(`
      be4a2f d77643 ead4aa e4a672 b86f50 733e39 3e2731 a22633
      e43b44 f77622 feae34 fee761 63c74d 3e8948 265c42 193c3e
      124e89 0099db 2ce8f5 ffffff c0cbdc 8b9bb4 5a6988 3a4466
      262b44 181425 ff0044 68386c b55088 f6757a e8b796 c28569`),
  },
  {
    name: "PICO-8",
    colors: hexList(`
      000000 1d2b53 7e2553 008751 ab5236 5f574f c2c3c7 fff1e8
      ff004d ffa300 ffec27 00e436 29adff 83769c ff77a8 ffccaa`),
  },
  {
    name: "Sweetie 16",
    colors: hexList(`
      1a1c2c 5d275d b13e53 ef7d57 ffcd75 a7f070 38b764 257179
      29366f 3b5dc9 41a6f6 73eff7 f4f4f4 94b0c2 566c86 333c57`),
  },
  {
    name: "Grayscale",
    colors: Array.from({ length: 16 }, (_, i) => {
      const v = Math.round((i / 15) * 255);
      return (v << 16) | (v << 8) | v;
    }),
  },
];

export const DEFAULT_PALETTE = BUILTIN_PALETTES[0];

/** The index of the palette color closest to `color`, skipping the reserved index 0. */
export function nearestColor(palette: readonly number[], color: number): number {
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  let best = 1;
  let bestDistance = Infinity;
  for (let i = 1; i < palette.length; i++) {
    const c = palette[i];
    const d = (((c >> 16) & 255) - r) ** 2 + (((c >> 8) & 255) - g) ** 2 + ((c & 255) - b) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

export const PALETTE_FILE_ACCEPT = ".gpl,.hex,.pal,.txt,.act,.ase,.png,.gif,.bmp,.webp";

// #region Parsing

export async function parsePaletteFile(file: File): Promise<NamedPalette> {
  const name = file.name.replace(/\.[^.]+$/, "");
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const bytes = new Uint8Array(await file.arrayBuffer());

  let colors: number[];
  if (file.type.startsWith("image/") || ["png", "gif", "bmp", "webp"].includes(ext)) {
    colors = await parseImage(file);
  } else if (ascii(bytes, 0, 4) === "ASEF") {
    colors = parseAse(bytes);
  } else if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "PAL ") {
    colors = parseRiffPal(bytes);
  } else if (ext === "act") {
    colors = parseAct(bytes);
  } else {
    colors = parseText(new TextDecoder().decode(bytes));
  }

  if (colors.length === 0) throw new Error("No colors found in palette file");
  return { name, colors: colors.slice(0, MAX_COLORS) };
}

/** Handles GIMP .gpl, JASC .pal, Paint.NET .txt and plain .hex lists. */
export function parseText(text: string): number[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const first = lines[0] ?? "";

  if (first.startsWith("GIMP Palette")) {
    const colors: number[] = [];
    for (const line of lines.slice(1)) {
      if (!line || line.startsWith("#") || /^(Name|Columns):/i.test(line)) continue;
      const m = line.match(/^(\d+)\s+(\d+)\s+(\d+)/);
      if (m) colors.push(rgb(+m[1], +m[2], +m[3]));
    }
    return colors;
  }

  if (first === "JASC-PAL") {
    const count = parseInt(lines[2], 10);
    const colors: number[] = [];
    for (const line of lines.slice(3, 3 + count)) {
      const m = line.match(/^(\d+)\s+(\d+)\s+(\d+)/);
      if (m) colors.push(rgb(+m[1], +m[2], +m[3]));
    }
    return colors;
  }

  // .hex (RRGGBB) and Paint.NET .txt (AARRGGBB, ';' comments)
  const colors: number[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(";") || line.startsWith("//")) continue;
    const m = line.match(/^#?([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3})\b/i);
    if (!m) continue;
    let h = m[1];
    if (h.length === 8) h = h.slice(2);
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    colors.push(parseInt(h, 16));
  }
  return colors;
}

function parseAct(bytes: Uint8Array): number[] {
  let count = 256;
  if (bytes.length >= 772) {
    count = (bytes[768] << 8) | bytes[769];
    if (count === 0 || count > 256) count = 256;
  }
  const colors: number[] = [];
  for (let i = 0; i < count && i * 3 + 2 < bytes.length; i++) {
    colors.push(rgb(bytes[i * 3], bytes[i * 3 + 1], bytes[i * 3 + 2]));
  }
  return colors;
}

function parseRiffPal(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (id === "data") {
      const count = view.getUint16(offset + 10, true);
      const colors: number[] = [];
      for (let i = 0; i < count; i++) {
        const p = offset + 12 + i * 4;
        colors.push(rgb(bytes[p], bytes[p + 1], bytes[p + 2]));
      }
      return colors;
    }
    offset += 8 + size + (size & 1);
  }
  return [];
}

function parseAse(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blocks = view.getUint32(8);
  let offset = 12;
  const colors: number[] = [];
  for (let b = 0; b < blocks && offset + 6 <= bytes.length; b++) {
    const type = view.getUint16(offset);
    const length = view.getUint32(offset + 2);
    const body = offset + 6;
    if (type === 0x0001) {
      const nameLength = view.getUint16(body);
      let p = body + 2 + nameLength * 2;
      const model = ascii(bytes, p, 4);
      p += 4;
      const f = (i: number) => view.getFloat32(p + i * 4);
      const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
      if (model === "RGB ") colors.push(rgb(c(f(0)), c(f(1)), c(f(2))));
      else if (model === "Gray") colors.push(rgb(c(f(0)), c(f(0)), c(f(0))));
      else if (model === "CMYK") {
        const k = 1 - f(3);
        colors.push(rgb(c((1 - f(0)) * k), c((1 - f(1)) * k), c((1 - f(2)) * k)));
      }
    }
    offset = body + length;
  }
  return colors;
}

async function parseImage(file: File): Promise<number[]> {
  const png = await decodePng(new Uint8Array(await file.arrayBuffer())).catch(() => null);
  if (png) {
    // 8-bit PNGs decode without a canvas, so they also load where there's no DOM (the CLI)
    const rgba = new Uint8Array(png.width * png.height * 4);
    for (let i = 0, j = 0; i < png.pixels.length; i += png.channels, j += 4) {
      const gray = png.channels < 3;
      rgba[j] = png.pixels[i];
      rgba[j + 1] = png.pixels[i + (gray ? 0 : 1)];
      rgba[j + 2] = png.pixels[i + (gray ? 0 : 2)];
      rgba[j + 3] = png.channels === 2 || png.channels === 4 ? png.pixels[i + png.channels - 1] : 255;
    }
    return imageColors(rgba);
  }
  if (typeof document === "undefined") throw new Error("Only 8-bit PNG palette images can be read here");
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  return imageColors(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data);
}

/** The distinct opaque colors of RGBA pixels, in reading order. */
function imageColors(data: Uint8Array | Uint8ClampedArray): number[] {
  const seen = new Set<number>();
  const colors: number[] = [];
  for (let i = 0; i < data.length && colors.length < MAX_COLORS; i += 4) {
    if (data[i + 3] < 128) continue;
    const color = rgb(data[i], data[i + 1], data[i + 2]);
    if (!seen.has(color)) {
      seen.add(color);
      colors.push(color);
    }
  }
  return colors;
}

// #endregion

// #region Writing

export type PaletteExportFormat = "gpl" | "hex" | "pal" | "png";

export async function writePalette(palette: NamedPalette, format: PaletteExportFormat): Promise<Blob> {
  const { name, colors } = palette;
  const channels = (c: number) => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

  switch (format) {
    case "gpl": {
      const lines = ["GIMP Palette", `Name: ${name}`, "Columns: 8", "#"];
      for (const c of colors) {
        const [r, g, b] = channels(c);
        lines.push(`${String(r).padStart(3)} ${String(g).padStart(3)} ${String(b).padStart(3)}\t${toHex(c)}`);
      }
      return new Blob([lines.join("\n") + "\n"], { type: "text/plain" });
    }
    case "hex":
      return new Blob([colors.map((c) => toHex(c).slice(1)).join("\n") + "\n"], { type: "text/plain" });
    case "pal": {
      const lines = ["JASC-PAL", "0100", String(colors.length), ...colors.map((c) => channels(c).join(" "))];
      return new Blob([lines.join("\r\n") + "\r\n"], { type: "text/plain" });
    }
    case "png": {
      const pixels = new Uint8Array(colors.flatMap(channels));
      const png = await encodePng({ width: colors.length, height: 1, channels: 3, pixels });
      return new Blob([png as Uint8Array<ArrayBuffer>], { type: "image/png" });
    }
  }
}

// #endregion

function rgb(r: number, g: number, b: number) {
  return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}
