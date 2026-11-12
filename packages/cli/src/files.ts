// Files on disk <-> the editor: which formats a path means, and their bytes. Shared by the commands
// and the MCP server's file tools.

import type { Editor } from "@voxeltoy/core/editor";
import { parseLibrary, serializeLibrary } from "@voxeltoy/core/formats/library";
import { toVoxelAnimation, writeVolumes } from "@voxeltoy/core/formats/volumes";
import { parseVox, writeVox } from "@voxeltoy/core/formats/vox";
import { writeZip } from "@voxeltoy/core/formats/zip";
import { parsePaletteFile, writePalette, type NamedPalette, type PaletteExportFormat } from "@voxeltoy/core/palette";
import { libraryOf, type LibraryDocument } from "@voxeltoy/core/library";
import { basename, extname, relative, sep } from "node:path";

/** Formats a document opens from. `.moxel` is the legacy extension. */
export const OPEN_FORMATS = ["voxeltoy", "moxel", "vox"] as const;
/** Formats a document saves or exports to. `.voxeltoyvol` is every frame's voxels for engines (docs/voxel-runtime.md); `.moxel` and `.moxelvol` still write the same bytes. */
export const SAVE_FORMATS = ["voxeltoy", "moxel", "vox", "voxeltoyvol", "moxelvol"] as const;
/** Palette files that load into the open document. Images must be 8-bit PNGs here. */
export const PALETTE_FORMATS = ["gpl", "hex", "pal", "txt", "act", "ase", "png"] as const;
export const PALETTE_SAVE_FORMATS = ["gpl", "hex", "pal", "png"] as const satisfies readonly PaletteExportFormat[];

export type SaveFormat = (typeof SAVE_FORMATS)[number];

const ext = (path: string) => extname(path).slice(1).toLowerCase();
const stem = (path: string) => basename(path, extname(path));
const has = <T extends string>(list: readonly T[], value: string): value is T => (list as readonly string[]).includes(value);

/** What a path holds, by its extension; .png is a palette, since documents don't open from images. */
export function fileKind(path: string): "document" | "palette" | null {
  const e = ext(path);
  if (has(OPEN_FORMATS, e)) return "document";
  if (has(PALETTE_FORMATS, e)) return "palette";
  return null;
}

const LIBRARY_EXTS = new Set(["voxeltoy", "moxel"]);

export function isLibraryExt(extension: string): boolean {
  return LIBRARY_EXTS.has(extension);
}

/**
 * A .voxeltoy, legacy .moxel, or .vox file as a library: a native file as it is (versions 1 to 3
 * as a library of their one model), a .vox as a library of one.
 */
export function readLibrary(bytes: Uint8Array, path: string): LibraryDocument {
  const e = ext(path);
  if (isLibraryExt(e)) return parseLibrary(new TextDecoder().decode(bytes));
  if (e === "vox") return libraryOf(parseVox(bytes.slice().buffer, stem(path)));
  throw new Error(`Can't open .${e || "?"} files as a model; use ${OPEN_FORMATS.map((f) => "." + f).join(" or ")}`);
}

/** A library as a native file (always version 4, `"format": "voxeltoy"`). */
export function libraryBytes(doc: LibraryDocument): Uint8Array {
  return new TextEncoder().encode(serializeLibrary(doc));
}

export function readPalette(bytes: Uint8Array, path: string): Promise<NamedPalette> {
  return parsePaletteFile(new File([bytes as Uint8Array<ArrayBuffer>], basename(path)));
}

/** The save format a path asks for, or the reason it can't be saved there. */
export function saveFormat(path: string): SaveFormat {
  const e = ext(path);
  if (has(SAVE_FORMATS, e)) return e;
  if (has(PALETTE_SAVE_FORMATS, e)) {
    throw new Error(`.${e} is a palette format; save the palette with export_palette (or --palette on the command line)`);
  }
  throw new Error(`Can't save .${e || "?"} files; use ${SAVE_FORMATS.map((f) => "." + f).join(", ")}`);
}

/** One model in a format, as the web app writes it; as .voxeltoy or .moxel, a library holding just it. */
export async function documentBytes(editor: Editor, format: SaveFormat): Promise<Uint8Array> {
  switch (format) {
    case "voxeltoy":
    case "moxel":
      return libraryBytes(libraryOf(editor.getDocument()));
    case "vox":
      // .vox has no shapes or overrides, so a model with them is written as what it evaluates to
      return new Uint8Array(await writeVox(editor.isFlat ? editor.getDocument() : editor.flatDocument()).arrayBuffer());
    case "voxeltoyvol":
    case "moxelvol": {
      const animation = toVoxelAnimation({
        name: editor.name,
        fps: editor.fps,
        size: editor.size,
        palette: editor.palette,
        frames: editor.frames.map((f) => ({ id: f.id, duration: f.duration, voxels: editor.evaluateFrame(f.id) })),
      });
      return writeZip(await writeVolumes(animation));
    }
  }
}

export async function paletteBytes(editor: Editor, path: string): Promise<Uint8Array> {
  const e = ext(path);
  if (!has(PALETTE_SAVE_FORMATS, e)) {
    throw new Error(`Can't write .${e || "?"} palettes; use ${PALETTE_SAVE_FORMATS.map((f) => "." + f).join(", ")}`);
  }
  const blob = await writePalette({ name: editor.name, colors: editor.palette.slice(1) }, e);
  return new Uint8Array(await blob.arrayBuffer());
}

/** An error's message, with Node's file errors put plainly. */
export function errorMessage(err: unknown, root = ""): string {
  const e = err as NodeJS.ErrnoException;
  const path = e.path ? relative(root, e.path).split(sep).join("/") || "." : "";
  if (e.code === "ENOENT") return `Nothing at ${path}`;
  if (e.code === "EISDIR") return `${path} is a folder`;
  if (e.code === "ENOTDIR") return `${path} isn't a folder`;
  if (e.code === "EACCES" || e.code === "EPERM") return `Not allowed to access ${path}`;
  return e.message ?? String(err);
}
