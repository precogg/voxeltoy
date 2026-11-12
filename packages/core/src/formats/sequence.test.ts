import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameFileName, sequenceManifest, sheetGrid } from "./sequence";
import { crc32, writeZip } from "./zip";

describe("zip", () => {
  test("crc32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  test("unzip reads what writeZip writes", () => {
    const dir = mkdtempSync(join(tmpdir(), "moxel-zip-"));
    const png = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 0xff);
    const zip = writeZip([
      { name: "frame-01.png", data: png },
      { name: "animation.json", data: new TextEncoder().encode('{"ok":true}') },
    ]);
    const path = join(dir, "out.zip");
    writeFileSync(path, zip);
    const test = spawnSync("unzip", ["-t", path]);
    if (test.error) return; // no unzip here
    expect(test.status).toBe(0);
    expect(spawnSync("unzip", ["-o", "-q", path, "-d", dir]).status).toBe(0);
    expect(new Uint8Array(readFileSync(join(dir, "frame-01.png")))).toEqual(png);
    expect(readFileSync(join(dir, "animation.json"), "utf8")).toBe('{"ok":true}');
  });
});

describe("sequence manifest", () => {
  const frames = [
    { id: "frame:a", duration: 1 },
    { id: "frame:b", duration: 3 },
    { id: "frame:c", duration: 2 },
  ];

  test("gives each frame its timing and file", () => {
    const m = sequenceManifest("Walk", frames, 12, 64, 48);
    expect(m.format).toBe("voxeltoy-sequence");
    expect(m.durationMs).toBe(500);
    expect(m.frames.map((f) => [f.startMs, f.durationMs, f.file])).toEqual([
      [0, 1000 / 12, "frame-01.png"],
      [1000 / 12, 250, "frame-02.png"],
      [(4 * 1000) / 12, 2000 / 12, "frame-03.png"],
    ]);
  });

  test("places frames on a sheet", () => {
    expect(sheetGrid(1)).toEqual({ columns: 1, rows: 1 });
    expect(sheetGrid(5)).toEqual({ columns: 3, rows: 2 });
    const m = sequenceManifest("Walk", frames, 12, 64, 48, "sheet.png");
    expect(m.image).toBe("sheet.png");
    expect(m.frames.map((f) => [f.x, f.y])).toEqual([
      [0, 0],
      [64, 0],
      [0, 48],
    ]);
  });

  test("pads file names so they sort", () => {
    expect(frameFileName(0, 5)).toBe("frame-01.png");
    expect(frameFileName(119, 120)).toBe("frame-120.png");
    expect(frameFileName(8, 120)).toBe("frame-009.png");
  });
});
