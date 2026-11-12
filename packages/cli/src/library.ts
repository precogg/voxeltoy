// A .moxel library in the CLI (docs/library.md): which of its models the commands and the MCP
// server's model tools work on, and a short account of what it holds.

import type { Editor } from "@voxeltoy/core/editor";
import { LibraryEditor, libraryOf, type LibraryDocument } from "@voxeltoy/core/library";

/** A library editor for a file's library. */
export function libraryEditor(doc?: LibraryDocument): LibraryEditor {
  return new LibraryEditor(doc);
}

/**
 * Make sure a model is open for the model tools after a library loads: the primary model if the
 * primary is a model, else the primary scene's stage (loading opens both), else the first model.
 */
export function openDefaultModel(library: LibraryEditor) {
  if (library.activeEditor) return;
  const first = library.models.find((m) => !m.built);
  if (first) library.openModelAlone(first.id);
}

/** A model of the library by id or name, or a reason naming the ones it has. */
export function findModel(library: LibraryEditor, ref: string): string {
  const models = library.models.filter((m) => !m.built);
  const found = models.find((m) => m.id === ref) ?? models.find((m) => library.modelName(m.id) === ref);
  if (found) return found.id;
  const names = models.map((m) => `${library.modelName(m.id)} (${m.id})`).join(", ");
  throw new Error(`No model ${JSON.stringify(ref)} in the library; it has ${names || "no models"}`);
}

/** Open a model on its own, by id or name, or with none the default one. Its editor, or null if the library has no models. */
export function openModel(library: LibraryEditor, ref?: string): Editor | null {
  if (ref !== undefined) return library.openModelAlone(findModel(library, ref));
  openDefaultModel(library);
  return library.activeEditor;
}

/** One model of the library as a library of its own, keeping its id and voxel size, so it opens anywhere. */
export function modelLibrary(library: LibraryEditor, id: string): LibraryDocument {
  const lib = libraryOf(library.document(id).toData(), id);
  const voxelSize = library.model(id)?.voxelSize;
  if (voxelSize) lib.models[0].record = { ...lib.models[0].record, voxelSize };
  return lib;
}

/** Whether a library is just one model, as files before libraries were: then commands show it as before. */
export function isSingleModel(library: LibraryEditor): boolean {
  return library.allModels.length === 1 && library.scenes.length === 0;
}
