import { describe, expect, test } from "bun:test";
import { Editor } from "../editor";
import { libraryOf } from "../library";
import { FORMAT, LEGACY_FORMAT, parseMoxel, serializeMoxel, VOXELTOY_EXTENSION } from "./moxel";
import { parseLibrary, serializeLibrary } from "./library";
import { LEGACY_SEQUENCE_FORMAT, parseSequenceManifest, SEQUENCE_FORMAT, sequenceManifest } from "./sequence";
import { LEGACY_VOLUMES_FORMAT, readVolumes, toVoxelAnimation, VOLUMES_FORMAT, writeVolumes } from "./volumes";

function painted() {
  const editor = new Editor();
  editor.newDocument([2, 2, 2]);
  editor.setName("Crate");
  editor.setVoxel([0, 0, 0], 1);
  return editor;
}

describe("native format name", () => {
  test("new files are written as voxeltoy and round-trip", () => {
    const editor = painted();
    const text = serializeMoxel(editor.getDocument());
    const written = JSON.parse(text);
    expect(written.format).toBe(FORMAT);
    expect(written.format).toBe("voxeltoy");
    expect(VOXELTOY_EXTENSION).toBe(".voxeltoy");
    const back = parseMoxel(text);
    expect(back.name).toBe("Crate");
    expect(back.layers[0].data[0]).toBe(1);
  });

  test("a legacy moxel file still opens", () => {
    const editor = painted();
    const written = JSON.parse(serializeMoxel(editor.getDocument()));
    written.format = LEGACY_FORMAT;
    const back = parseMoxel(JSON.stringify(written));
    expect(back.name).toBe("Crate");
    expect(back.layers[0].data[0]).toBe(1);
  });

  test("a library is written as voxeltoy, including each model", () => {
    const text = serializeLibrary(libraryOf(painted().getDocument()));
    const written = JSON.parse(text);
    expect(written.format).toBe("voxeltoy");
    expect(written.models[0].model.format).toBe("voxeltoy");
    const back = parseLibrary(text);
    expect(back.models[0].doc.layers[0].data[0]).toBe(1);
  });

  test("a legacy moxel library, and a legacy single-model file, still open", () => {
    const library = JSON.parse(serializeLibrary(libraryOf(painted().getDocument())));
    library.format = "moxel";
    library.models[0].model.format = "moxel";
    expect(parseLibrary(JSON.stringify(library)).models[0].doc.name).toBe("Crate");

    const single = JSON.parse(serializeMoxel(painted().getDocument()));
    single.format = "moxel";
    const opened = parseLibrary(JSON.stringify(single));
    expect(opened.models).toHaveLength(1);
    expect(opened.models[0].doc.layers[0].data[0]).toBe(1);
  });

  test("a sequence manifest is written as voxeltoy-sequence and a legacy one still reads", () => {
    const manifest = sequenceManifest("Walk", [{ id: "frame:a", duration: 1 }], 12, 8, 8);
    expect(manifest.format).toBe(SEQUENCE_FORMAT);
    expect(parseSequenceManifest(JSON.stringify(manifest)).name).toBe("Walk");
    const legacy = parseSequenceManifest(JSON.stringify({ ...manifest, format: LEGACY_SEQUENCE_FORMAT }));
    expect(legacy.format).toBe("moxel-sequence");
    expect(legacy.frames[0].file).toBe("frame-01.png");
    expect(() => parseSequenceManifest(JSON.stringify({ ...manifest, format: "nope" }))).toThrow(/Not a Voxeltoy sequence/);
  });

  test("voxel volumes are written as voxeltoy-volumes and a legacy manifest still reads", async () => {
    const animation = toVoxelAnimation({
      name: "Walk",
      fps: 12,
      size: [1, 1, 1],
      palette: [0, 0xff0000],
      frames: [{ id: "a", duration: 1, voxels: new Uint8Array([1]) }],
    });
    const entries = await writeVolumes(animation);
    const manifest = JSON.parse(new TextDecoder().decode(entries[0].data));
    expect(manifest.format).toBe(VOLUMES_FORMAT);
    const files = new Map(entries.map((entry) => [entry.name, entry.data]));
    const read = (body: object) =>
      readVolumes((name) => (name === "volumes.json" ? new TextEncoder().encode(JSON.stringify(body)) : files.get(name)!));
    expect((await read(manifest)).name).toBe("Walk");
    expect((await read({ ...manifest, format: LEGACY_VOLUMES_FORMAT })).frames[0].id).toBe("a");
    await expect(read({ ...manifest, format: "moxel" })).rejects.toThrow(/not a voxel volumes manifest/);
  });
});
