import type { Editor } from "@voxeltoy/core/editor";
import { parseMoxel, serializeMoxel } from "@voxeltoy/core/formats/moxel";
import { readLocal } from "./storage";

const STORAGE_KEY = "voxeltoy:document";
const LEGACY_KEY = "moxel:document";

export function loadAutosave() {
  try {
    const text = readLocal(STORAGE_KEY, LEGACY_KEY);
    return text ? parseMoxel(text) : null;
  } catch {
    return null;
  }
}

/**
 * Save the document locally. Returns false if storage is full or unavailable: the document is
 * still in memory, and the last successful save is left as it was.
 */
export function writeAutosave(editor: Editor): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, serializeMoxel(editor.getDocument()));
    return true;
  } catch {
    return false;
  }
}
