import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Editor } from "@voxeltoy/core/editor";
import { parseLibrary, serializeLibrary } from "@voxeltoy/core/formats/library";
import { parseMoxel, serializeMoxel } from "@voxeltoy/core/formats/moxel";
import { LibraryEditor } from "@voxeltoy/core/library";
import type { DocumentData, Vec3 } from "@voxeltoy/core/types";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./server";
import { Session } from "./session";

let root: string;
let session: Session;
let client: Client;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "moxel-cli-"));
  session = new Session(root);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(session).connect(serverSide);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
});

afterEach(async () => {
  await client.close();
  await rm(root, { recursive: true, force: true });
});

/** Call a tool; its JSON result, or throws with its error text. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0].text;
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}

function model(name: string, size: Vec3): DocumentData {
  const e = new Editor();
  e.newDocument(size);
  e.setName(name);
  return e.getDocument();
}

/** A version 4 file: a knight (primary), a course, and a level that places the knight on the course. */
function knights(): string {
  const lib = new LibraryEditor();
  lib.setName("Knights");
  lib.addModel(model("Knight", [4, 6, 4]), { id: "model:knight" });
  lib.addModel(model("Course", [8, 2, 8]), { id: "model:course", voxelSize: 2 });
  const level = lib.newScene("Level 1", ["model:knight"])!;
  lib.openScene(level);
  lib.setStage("model:course");
  lib.setPrimary("model:knight");
  const doc = lib.getLibrary();
  doc.hostData = { game: { lives: 3 } };
  doc.extra = { future: { keep: true } };
  doc.scenes[0] = { ...doc.scenes[0], hostData: { game: { music: "march" } }, extra: { weather: "rain" } };
  doc.scenes[0].instances[0] = { ...doc.scenes[0].instances[0], extra: { glow: 1 } };
  return serializeLibrary(doc);
}

/** The first layer's voxel at a cell. */
const voxel = (doc: DocumentData, [x, y, z]: Vec3) => doc.layers[0].data[x + doc.size[0] * (y + doc.size[1] * z)];

describe("voxeltoy mcp", () => {
  test("lists the editing tools and the file tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of ["get_document", "set_voxels", "undo", "render", "list_files", "open_file", "save_file", "export_palette"]) {
      expect(names).toContain(name);
    }
    expect(names).not.toContain("set_view"); // no camera here
    expect(tools.find((t) => t.name === "get_document")!.annotations?.readOnlyHint).toBe(true);
  });

  test("edits, saves, reopens and exports", async () => {
    await call("new_document", { size: [4, 4, 4], name: "Cube" });
    await call("set_voxels", { voxels: [[0, 0, 0, 2], [1, 0, 0, 3]] });
    expect((await call("list_files")).open).toEqual({ path: null, unsaved: true });
    await expect(call("save_file")).rejects.toThrow(/hasn't been saved/);

    const saved = await call("save_file", { path: "models/cube.moxel" });
    expect(saved.path).toBe("models/cube.moxel");
    expect(saved.file).toEqual({ path: "models/cube.moxel", unsaved: false });

    // exports leave the open file alone
    expect((await call("save_file", { path: "out/cube.vox" })).file.path).toBe("models/cube.moxel");
    await call("save_file", { path: "out/cube.moxelvol" });
    await call("export_palette", { path: "out/cube.gpl" });
    expect((await readFile(join(root, "out/cube.gpl"), "utf8")).startsWith("GIMP Palette")).toBe(true);

    expect((await call("list_files")).entries).toEqual([
      { name: "models", type: "dir" },
      { name: "out", type: "dir" },
    ]);
    expect((await call("list_files", { dir: "out" })).entries.map((e: { name: string }) => e.name)).toEqual([
      "cube.gpl",
      "cube.vox",
    ]);

    await call("set_voxels", { voxels: [[2, 0, 0, 4]] });
    await expect(call("open_file", { path: "out/cube.vox" })).rejects.toThrow(/unsaved changes/);
    const opened = await call("open_file", { path: "out/cube.vox", discard: true });
    expect(opened.file).toEqual({ path: null, unsaved: false }); // a .vox isn't the file save_file writes
    expect((await call("get_voxels")).total).toBe(2);

    await call("open_file", { path: "models/cube.moxel" });
    const doc = await call("get_document");
    expect(doc.name).toBe("Cube");
    expect(doc.layers[0].voxels).toBe(2);
  });

  test("loads palette files into the open model, undoably", async () => {
    await writeFile(join(root, "two.hex"), "ff0000\n00ff00\n");
    const result = await call("open_file", { path: "two.hex" });
    expect(result.opened).toBe("palette");
    expect(result.colors).toBe(2);
    await call("undo");
    expect((await call("get_document")).palette.length).toBeGreaterThan(3);

    // and palette PNGs round trip without a canvas
    await call("export_palette", { path: "p.png" });
    await call("open_file", { path: "p.png" });
  });

  test("stays inside the root folder", async () => {
    await expect(call("save_file", { path: "../escape.moxel" })).rejects.toThrow(/outside the root/);
    await expect(call("open_file", { path: join(tmpdir(), "x.moxel") })).rejects.toThrow(/outside the root/);
    await expect(call("list_files", { dir: ".." })).rejects.toThrow(/outside the root/);
    await expect(call("open_file", { path: "missing.moxel" })).rejects.toThrow(/Nothing at missing.moxel/);
    await expect(call("save_file", { path: "a.txt" })).rejects.toThrow(/Can't save .txt/);
    await mkdir(join(root, "sub"));
    await expect(call("list_files", { dir: "sub/../.." })).rejects.toThrow(/outside the root/);
  });

  test("new_document guards unsaved work", async () => {
    await call("set_voxels", { voxels: [[0, 0, 0, 2]] });
    await expect(call("new_document")).rejects.toThrow(/unsaved changes/);
    await call("new_document", { discard: true });
    expect((await call("list_files")).open.unsaved).toBe(false);
  });

  test("renders the model as an image, and saves it for the user", async () => {
    await call("new_document", { size: [8, 8, 8] });
    await call("place_shapes", { shapes: [{ kind: "sphere", min: [0, 0, 0], max: [7, 7, 7], color: 2 }] });
    const result = await client.callTool({ name: "render", arguments: { views: ["iso", "front"], size: 64, path: "shots/ball.png" } });
    const [text, image] = result.content as [{ text: string }, { type: string; data: string; mimeType: string }];
    expect(image.type).toBe("image");
    expect(image.mimeType).toBe("image/png");
    const info = JSON.parse(text.text);
    expect(info).toMatchObject({ width: 132, height: 64, columns: 2, rows: 1, path: "shots/ball.png" });
    expect(info.tiles).toEqual([{ view: "iso", frame: 0 }, { view: "front", frame: 0 }]);
    const saved = await readFile(join(root, "shots/ball.png"));
    expect(saved.toString("base64")).toBe(image.data);

    await expect(call("render", { path: "ball.jpg" })).rejects.toThrow(/\.png/);
    await expect(call("render", { views: ["sideways"] })).rejects.toThrow(/view must be/);
    await expect(call("render", { frames: [3] })).rejects.toThrow(/1 frames/);
    await expect(call("render", { path: "../out.png" })).rejects.toThrow(/outside the root/);
  });

  test("editing errors come back as tool errors", async () => {
    await expect(call("edit_layer", { action: "rename", layer: "nope", name: "x" })).rejects.toThrow(/nope/);
    await expect(call("no_such_tool")).rejects.toThrow(/No tool named/);
  });

  test("opens a library, edits a model that isn't primary, and saves every model and scene", async () => {
    const original = knights();
    await writeFile(join(root, "knights.moxel"), original);
    const opened = await call("open_file", { path: "knights.moxel" });
    expect(opened).toMatchObject({ model: "model:knight", name: "Knight", library: { name: "Knights", models: 2, scenes: 1 } });

    const info = await call("get_library");
    expect(info.primary).toBe("model:knight");
    expect(info.openModel).toBe("model:knight");
    expect(info.models.map((m: { name: string }) => m.name)).toEqual(["Knight", "Course"]);
    expect(info.models[1]).toMatchObject({ id: "model:course", size: [8, 2, 8], voxelSize: 2 });
    expect(info.scenes).toEqual([{ id: expect.any(String), name: "Level 1", stage: "model:course", instances: 1 }]);

    // the model tools follow the open model
    expect((await call("open", { id: "Course" })).openModel).toBe("model:course");
    expect((await call("get_document")).name).toBe("Course");
    await call("set_voxels", { voxels: [[1, 0, 1, 3]] });
    expect((await call("list_files")).open).toEqual({ path: "knights.moxel", unsaved: true });
    await call("save_file");
    expect((await call("list_files")).open.unsaved).toBe(false);

    const text = await readFile(join(root, "knights.moxel"), "utf8");
    expect(JSON.parse(text).version).toBe(4);
    const before = parseLibrary(original);
    const after = parseLibrary(text);
    expect(after.models.map((m) => m.record)).toEqual(before.models.map((m) => m.record));
    expect(voxel(after.models[1].doc, [1, 0, 1])).toBe(3);
    expect(after.models[1].doc.layers[0].data.reduce((n, v) => n + (v ? 1 : 0), 0)).toBe(1);
    expect(after.models[0].doc.layers).toEqual(before.models[0].doc.layers);
    expect(after.scenes).toEqual(before.scenes);
    expect(after.primary).toBe("model:knight");
    expect(after.hostData).toEqual({ game: { lives: 3 } });
    expect(after.extra).toEqual({ future: { keep: true } });
    expect(after.scenes[0].hostData).toEqual({ game: { music: "march" } });
    expect(after.scenes[0].extra).toEqual({ weather: "rain" });
    expect((after.scenes[0].instances[0] as { extra?: object }).extra).toEqual({ glow: 1 });

    // exports take only the open model
    await call("save_file", { path: "course.vox" });
    expect((await call("open_file", { path: "course.vox" })).library).toMatchObject({ models: 1, scenes: 0 });
    expect((await call("get_document")).size).toEqual([8, 2, 8]);
  });

  test("a primary scene opens its stage; new models; nothing open", async () => {
    const doc = parseLibrary(knights());
    await writeFile(join(root, "level.moxel"), serializeLibrary({ ...doc, primary: doc.scenes[0].id }));
    expect((await call("open_file", { path: "level.moxel" })).model).toBe("model:course");
    expect((await call("get_scene")).instances.length).toBe(1);

    const { model: added } = await call("add_model", { name: "Torch", size: [2, 4, 2], open: true });
    expect((await call("get_document")).name).toBe("Torch");
    await call("set_voxels", { voxels: [[0, 0, 0, 2]] });
    // one history: the edit, then the new model
    await call("undo", { steps: 2 });
    expect((await call("get_library")).models.map((m: { id: string }) => m.id)).not.toContain(added);
    expect((await call("list_files")).open.unsaved).toBe(false);

    await call("open");
    await expect(call("get_document")).rejects.toThrow(/No model is open\. Open one with open/);
    await expect(call("render")).rejects.toThrow(/No model is open/);
    // undo and redo still work on the library
    await call("redo");
    expect((await call("get_library")).models.map((m: { id: string }) => m.id)).toContain(added);
    await expect(call("open", { id: "Nobody" })).rejects.toThrow(/get_library lists them/);
  });

  test("an older single-model file opens, edits and saves as version 4 with nothing lost", async () => {
    const old = { ...model("Crate", [4, 4, 4]), hostData: { game: { solid: true } } };
    const text = serializeMoxel(old);
    expect(JSON.parse(text).version).toBeLessThan(4);
    await writeFile(join(root, "crate.moxel"), text);
    expect(await call("open_file", { path: "crate.moxel" })).toMatchObject({ name: "Crate", library: { models: 1, scenes: 0 } });
    await call("set_voxels", { voxels: [[2, 0, 2, 5]] });
    await call("save_file");

    const saved = await readFile(join(root, "crate.moxel"), "utf8");
    expect(JSON.parse(saved).version).toBe(4);
    const lib = parseLibrary(saved);
    expect(lib.models.length).toBe(1);
    expect(lib.primary).toBe(lib.models[0].record.id);
    const before = parseMoxel(text);
    const after = lib.models[0].doc;
    expect(voxel(after, [2, 0, 2])).toBe(5);
    expect(after.hostData).toEqual({ game: { solid: true } });
    expect({ ...after, revision: undefined, layers: undefined }).toEqual({ ...before, revision: undefined, layers: undefined });
    expect(after.layers.map((l) => ({ ...l, data: undefined }))).toEqual(before.layers.map((l) => ({ ...l, data: undefined })));
  });

  test("new_document replaces the library with one model", async () => {
    await writeFile(join(root, "knights.moxel"), knights());
    await call("open_file", { path: "knights.moxel" });
    await call("open", { id: "Course" });
    await call("set_voxels", { voxels: [[0, 0, 0, 2]] });
    await expect(call("new_document", { name: "Fresh" })).rejects.toThrow(/open library has unsaved changes/);
    expect((await call("get_library")).models.length).toBe(2);
    await call("new_document", { name: "Fresh", size: [4, 4, 4], discard: true });
    const info = await call("get_library");
    expect(info.models.map((m: { name: string }) => m.name)).toEqual(["Fresh"]);
    expect(info.scenes).toEqual([]);
    expect((await call("list_files")).open).toEqual({ path: null, unsaved: false });
    expect((await call("get_document")).size).toEqual([4, 4, 4]);
  });
});
