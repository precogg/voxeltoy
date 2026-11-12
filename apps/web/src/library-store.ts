// The library on this device (docs/library.md): one, kept in IndexedDB as a `.voxeltoy` (version 4)
// as it changes, and opened on start. A library embeds whole models, which can outgrow
// localStorage. Before libraries the device kept a model draft in localStorage; on first start it
// becomes the library's primary model. A database named "moxel" is copied to "voxeltoy" on open.

import { parseLibrary, serializeLibrary } from "@voxeltoy/core/formats/library";
import { libraryOf, type LibraryDocument, type LibraryEditor } from "@voxeltoy/core/library";
import { loadAutosave } from "./autosave";

const DB = "voxeltoy";
const LEGACY_DB = "moxel";
const STORE = "drafts";
const KEY = "library";

function openNamed(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function databaseNames(): Promise<Set<string> | null> {
  if (typeof indexedDB.databases !== "function") return null;
  const list = await indexedDB.databases();
  return new Set(list.map((db) => db.name).filter((name): name is string => !!name));
}

async function readRecord(name: string): Promise<string | undefined> {
  const db = await openNamed(name);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).get(KEY);
      tx.oncomplete = () => resolve(request.result as string | undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function writeRecord(name: string, text: string): Promise<void> {
  const db = await openNamed(name);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(text, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Drop a database. A missing or blocked database is not a failed load. */
function dropDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

/**
 * The library on this device: the one saved here, or on first start the model the device kept
 * before libraries, as a library of one. Null when there is neither (or it doesn't open).
 */
export async function loadLibraryDraft(): Promise<LibraryDocument | null> {
  try {
    const names = await databaseNames();
    const has = (name: string) => names === null || names.has(name);
    if (has(DB)) {
      const current = await readRecord(DB);
      if (current) {
        if (has(LEGACY_DB)) await dropDatabase(LEGACY_DB);
        return parseLibrary(current);
      }
    }
    if (has(LEGACY_DB)) {
      const legacy = await readRecord(LEGACY_DB);
      if (legacy) {
        await writeRecord(DB, legacy);
        const readBack = await readRecord(DB);
        if (readBack) {
          await dropDatabase(LEGACY_DB);
          return parseLibrary(readBack);
        }
        return parseLibrary(legacy);
      }
    }
  } catch {
    // unreadable: fall back to what the device kept before
  }
  const model = loadAutosave();
  return model ? libraryOf(model) : null;
}

/** Keep the library on this device. False if storage is full or unavailable. */
export async function saveLibraryDraft(library: LibraryEditor): Promise<boolean> {
  try {
    await writeRecord(DB, serializeLibrary(library.getLibrary()));
    return true;
  } catch {
    return false;
  }
}
