// One open library and the folder it may read and write: what `voxeltoy mcp` (and `moxel mcp`) serves.
// Paths are relative to the root, and nothing outside it can be read or written.
//
// A .voxeltoy file is a library of models and scenes (docs/library.md). `.moxel` still opens.
// The whole library is open; one model of it is open for the model tools, and saving as
// .voxeltoy or .moxel writes all of it.

import { Editor } from "@voxeltoy/core/editor";
import { serializeLibrary } from "@voxeltoy/core/formats/library";
import { libraryOf, type LibraryDocument } from "@voxeltoy/core/library";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { documentBytes, fileKind, isLibraryExt, libraryBytes, paletteBytes, readLibrary, readPalette, saveFormat } from "./files";
import { libraryEditor, openDefaultModel } from "./library";

export interface FileEntry {
  name: string;
  type: "dir" | "model" | "palette";
}

const UNSAVED = "The open library has unsaved changes. Save it first with save_file, or pass discard: true to drop them";

/** A library of one empty model, as a new session starts with. */
export function emptyLibrary(): LibraryDocument {
  return libraryOf(new Editor().getDocument());
}

export class Session {
  readonly library = libraryEditor(emptyLibrary());
  /** The open library's file, relative to the root; null until it is opened from or saved to one. */
  path: string | null = null;
  /** The library as last opened or saved, to tell whether there are unsaved changes. */
  private saved: string;

  constructor(readonly root: string) {
    this.saved = this.snapshot();
  }

  /** The model the model tools act on, or null when none is (the library itself, or a scene without a stage, is open). */
  get openEditor(): Editor | null {
    return this.library.activeEditor;
  }

  /** The model the model tools act on, or a reason there is none and what to do. */
  get editor(): Editor {
    const editor = this.openEditor;
    if (editor) return editor;
    if (!this.library.models.length) throw new Error("The library has no models yet; add_model makes one (with open: true to edit it)");
    const where = this.library.scene ? `The open scene ${this.library.sceneName} has no stage, so no model is open` : "No model is open";
    throw new Error(`${where}. Open one with open (get_library lists them), or go into an instance's model with open_model`);
  }

  /** What is saved of the library, without revisions, which go up with every step, undo too. */
  private snapshot() {
    const lib = this.library.getLibrary();
    return serializeLibrary({ ...lib, revision: undefined, models: lib.models.map((m) => ({ ...m, doc: { ...m.doc, revision: undefined } })) });
  }

  get unsaved(): boolean {
    return this.snapshot() !== this.saved;
  }

  /** The open file, for tool results. */
  status() {
    return { path: this.path, unsaved: this.unsaved };
  }

  /** Throw, saying what to do, if replacing the library would lose unsaved changes. */
  checkUnsaved(discard = false) {
    if (this.unsaved && !discard) throw new Error(UNSAVED);
  }

  /** Replace the library with another (new_document), forgetting the file. Check `checkUnsaved` first. */
  replace(doc: LibraryDocument) {
    this.load(doc);
    this.path = null;
  }

  private load(doc: LibraryDocument) {
    this.library.loadLibrary(doc);
    openDefaultModel(this.library);
    this.saved = this.snapshot();
  }

  /** An absolute path for `path` that stays inside the root, following symlinks that exist. */
  async resolve(path: string): Promise<string> {
    if (typeof path !== "string" || !path.trim()) throw new Error("path is required, relative to the root folder");
    const root = await realpath(this.root);
    const target = resolve(root, path);
    // the nearest existing ancestor decides where a symlinked path really goes
    let real = target;
    let rest = "";
    for (;;) {
      try {
        real = join(await realpath(real), rest);
        break;
      } catch {
        const parent = dirname(real);
        if (parent === real) break;
        rest = join(basename(real), rest);
        real = parent;
      }
    }
    const rel = relative(root, real);
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
      throw new Error(`${path} is outside the root folder ${this.root}; use a path inside it`);
    }
    return real;
  }

  /** `path` as tool results name it: relative to the root, with forward slashes. */
  private async display(path: string) {
    return relative(await realpath(this.root), await this.resolve(path)).split(sep).join("/") || ".";
  }

  /** Open a .voxeltoy or legacy .moxel (a library) or .vox (a library of one model), or load a palette file into the open model. */
  async open(path: string, discard = false): Promise<"model" | "palette"> {
    const kind = fileKind(path);
    if (!kind) throw new Error(`Can't open ${extname(path) || "files without an extension"}; list_files shows what can be opened`);
    const bytes = new Uint8Array(await readFile(await this.resolve(path)));
    if (kind === "palette") {
      const palette = await readPalette(bytes, path);
      this.editor.loadPalette(palette.colors);
      return "palette";
    }
    this.checkUnsaved(discard);
    this.load(readLibrary(bytes, path));
    // saving to .vox would lose the other models, scenes, layer kinds and shapes, so a .vox isn't the file
    this.path = isLibraryExt(extname(path).slice(1).toLowerCase()) ? await this.display(path) : null;
    return "model";
  }

  /**
   * Write to `path` (default: the open library file) in the format its extension names. As .voxeltoy
   * or .moxel, the whole library, which becomes the open file; other formats export the open model
   * and leave the file as it was.
   */
  async save(path?: string): Promise<{ path: string; bytes: number }> {
    const target = path ?? this.path;
    if (!target) throw new Error("The library hasn't been saved yet; give a path ending in .voxeltoy");
    const format = saveFormat(target);
    const libraryFile = isLibraryExt(format);
    const data = libraryFile ? libraryBytes(this.library.getLibrary()) : await documentBytes(this.editor, format);
    await this.write(target, data);
    const shown = await this.display(target);
    if (libraryFile) {
      this.path = shown;
      this.saved = this.snapshot();
    }
    return { path: shown, bytes: data.length };
  }

  async exportPalette(path: string): Promise<{ path: string; bytes: number }> {
    const data = await paletteBytes(this.editor, path);
    await this.write(path, data);
    return { path: await this.display(path), bytes: data.length };
  }

  /** Write a rendered image; `path` must end in .png. */
  async writeImage(path: string, data: Uint8Array): Promise<string> {
    if (extname(path).toLowerCase() !== ".png") throw new Error("Renders are PNGs; give a path ending in .png");
    await this.write(path, data);
    return this.display(path);
  }

  private async write(path: string, data: Uint8Array) {
    const file = await this.resolve(path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  /** A folder's subfolders and the files that open here, skipping hidden ones and node_modules. */
  async list(dir = "."): Promise<FileEntry[]> {
    const entries = await readdir(await this.resolve(dir), { withFileTypes: true });
    const out: FileEntry[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      if (e.isDirectory()) out.push({ name: e.name, type: "dir" });
      else {
        const kind = fileKind(e.name);
        if (kind === "document") out.push({ name: e.name, type: "model" });
        else if (kind === "palette") out.push({ name: e.name, type: "palette" });
      }
    }
    return out.sort((a, b) => (a.type === "dir") !== (b.type === "dir") ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name));
  }
}
