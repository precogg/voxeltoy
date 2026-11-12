// A library's files (docs/library.md): open and save the library, bring other files into it, and
// export one model on its own.

import { parseLibrary, serializeLibrary } from "@voxeltoy/core/formats/library";
import { isNativeExtension, LEGACY_EXTENSION, VOXELTOY_EXTENSION } from "@voxeltoy/core/formats/moxel";
import { parseVox, VOX_EXTENSION } from "@voxeltoy/core/formats/vox";
import { libraryOf, type LibraryDocument, type LibraryEditor, type Placement } from "@voxeltoy/core/library";
import type { DocumentData } from "@voxeltoy/core/types";
import { saveFile } from "./files";

/** Files that open as a library: a `.voxeltoy` or legacy `.moxel` (any version), or a MagicaVoxel model. */
export const LIBRARY_ACCEPT = `${VOXELTOY_EXTENSION},${LEGACY_EXTENSION},${VOX_EXTENSION}`;
/** Files whose models (and scenes) can be brought into a library. */
export const IMPORT_ACCEPT = `${VOXELTOY_EXTENSION},${LEGACY_EXTENSION},${VOX_EXTENSION}`;

const baseName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "Untitled";
const extension = (name: string) => name.slice(name.lastIndexOf(".")).toLowerCase();

/** A file as a library: a `.voxeltoy` or `.moxel` as it is (an older one as a library of its model), a `.vox` as a library of one. */
export async function readLibraryFile(file: File): Promise<LibraryDocument> {
  const ext = extension(file.name);
  if (isNativeExtension(ext)) return parseLibrary(await file.text());
  if (ext === VOX_EXTENSION) return libraryOf(parseVox(await file.arrayBuffer(), file.name.replace(/\.[^.]+$/, "")));
  throw new Error(`Can't open ${ext || "this"} files`);
}

/** A file as one model: a library's primary (or first) model, or a `.vox`. */
export async function readModelFile(file: File): Promise<DocumentData> {
  const lib = await readLibraryFile(file);
  const main = lib.models.find((m) => m.record.id === lib.primary) ?? lib.models[0];
  if (!main) throw new Error(`${file.name} has no model`);
  return main.doc;
}

/** Save the whole library as a `.voxeltoy` file. */
export async function saveLibrary(library: LibraryEditor) {
  const blob = new Blob([serializeLibrary(library.getLibrary())], { type: "application/json" });
  return saveFile(blob, baseName(library.name) + VOXELTOY_EXTENSION, "Voxeltoy library");
}

/** Replace the library with a file's. */
export async function openLibraryFile(library: LibraryEditor, file: File) {
  const doc = await readLibraryFile(file);
  library.loadLibrary({ ...doc, name: doc.name === "Untitled" ? file.name.replace(/\.[^.]+$/, "") : doc.name });
  library.notify(`Opened ${file.name}`);
}

/**
 * Bring a file's models and scenes into the library. With a scene open and a `placement`, its
 * primary (or first) model is placed there too. Returns the ids it added.
 */
export async function importFile(library: LibraryEditor, file: File, placement?: Placement) {
  const doc = await readLibraryFile(file);
  return library.transact(`Import ${file.name}`, () => {
    const added = library.importLibrary(doc);
    const main = added.primary && added.models.includes(added.primary) ? added.primary : added.models[0];
    if (placement && main && library.scene) library.addInstance(main, placement);
    library.notify(`Imported ${file.name}`);
    return added;
  });
}

/** Save one model as a `.voxeltoy` of its own (a library holding just it), so it opens anywhere. */
export async function exportModel(library: LibraryEditor, model: string) {
  const doc = library.document(model).toData();
  const record = library.model(model);
  const lib = libraryOf(doc, model);
  if (record?.voxelSize) lib.models[0].record = { ...lib.models[0].record, voxelSize: record.voxelSize };
  const blob = new Blob([serializeLibrary(lib)], { type: "application/json" });
  return saveFile(blob, baseName(doc.name) + VOXELTOY_EXTENSION, "Voxeltoy model");
}
