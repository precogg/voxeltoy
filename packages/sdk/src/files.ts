import type { Editor } from "@voxeltoy/core/editor";
import { isNativeExtension, parseMoxel, serializeMoxel, VOXELTOY_EXTENSION, LEGACY_EXTENSION } from "@voxeltoy/core/formats/moxel";
import { parseVox, VOX_EXTENSION, writeVox } from "@voxeltoy/core/formats/vox";
import { PALETTE_FILE_ACCEPT, parsePaletteFile, writePalette, type PaletteExportFormat } from "@voxeltoy/core/palette";

export const DOCUMENT_ACCEPT = `${VOXELTOY_EXTENSION},${LEGACY_EXTENSION},${VOX_EXTENSION}`;

/** Ask the user for a file. Resolves null if they cancel. */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    input.addEventListener("change", () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    input.addEventListener("cancel", () => {
      resolve(null);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

interface SavePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{ createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }>;
}

/**
 * Save a blob, using the native save dialog where available (desktop Chromium)
 * and a download everywhere else (Safari, Firefox, mobile).
 */
export async function saveFile(blob: Blob, filename: string, description = "File"): Promise<boolean> {
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  const ext = filename.slice(filename.lastIndexOf("."));
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: filename,
        types: [{ description, accept: { [blob.type || "application/octet-stream"]: [ext] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (e) {
      if ((e as Error).name === "AbortError") return false;
      // fall through to a download (e.g. picker blocked in an iframe)
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

const baseName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "Untitled";

/** Load a .voxeltoy, legacy .moxel, or .vox file (or a palette file) into the editor. */
export async function openFile(editor: Editor, file: File) {
  const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  const name = file.name.replace(/\.[^.]+$/, "");
  if (isNativeExtension(ext)) {
    editor.loadDocument(parseMoxel(await file.text()));
  } else if (ext === VOX_EXTENSION) {
    editor.loadDocument(parseVox(await file.arrayBuffer(), name));
  } else if (PALETTE_FILE_ACCEPT.split(",").includes(ext)) {
    const palette = await parsePaletteFile(file);
    editor.loadPalette(palette.colors);
    editor.notify(`Loaded palette “${palette.name}” (${palette.colors.length} colors)`);
    return;
  } else {
    throw new Error(`Can't open ${ext || "this"} files`);
  }
  editor.notify(`Opened ${file.name}`);
}

export async function saveDocument(editor: Editor) {
  const blob = new Blob([serializeMoxel(editor.getDocument())], { type: "application/json" });
  return saveFile(blob, baseName(editor.name) + VOXELTOY_EXTENSION, "Voxeltoy document");
}

/** Layers as .vox models; a model with shape or override layers as one flat model of what it evaluates to. */
export async function exportVox(editor: Editor) {
  const doc = editor.isFlat ? editor.getDocument() : editor.flatDocument();
  return saveFile(writeVox(doc), baseName(editor.name) + VOX_EXTENSION, "MagicaVoxel model");
}

export async function exportPalette(editor: Editor, format: PaletteExportFormat) {
  const colors = editor.palette.slice(1);
  const blob = await writePalette({ name: editor.name, colors }, format);
  return saveFile(blob, `${baseName(editor.name)}-palette.${format}`, "Palette");
}
