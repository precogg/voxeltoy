#!/usr/bin/env bun
// The voxeltoy command: inspect and convert models, and serve them to agents over MCP.
// `moxel` is the same program for one step.

import { createAgentTools } from "@voxeltoy/core/agent-tools";
import { Editor } from "@voxeltoy/core/editor";
import type { LibraryEditor } from "@voxeltoy/core/library";
import { createSceneAgentTools } from "@voxeltoy/core/scene-agent-tools";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { documentBytes, errorMessage, fileKind, isLibraryExt, libraryBytes, OPEN_FORMATS, paletteBytes, PALETTE_SAVE_FORMATS, readLibrary, saveFormat, SAVE_FORMATS } from "./files";
import { isSingleModel, libraryEditor, modelLibrary, openModel } from "./library";
import { RENDER_VIEWS, renderPng } from "./render";
import { serveStdio } from "./server";
import { Session } from "./session";
import pkg from "../package.json" with { type: "json" };

/** `moxel` when this process was started under that name; otherwise `voxeltoy`. */
function commandName(): string {
  for (const arg of [process.argv[1], process.argv[0]]) {
    if (basename(arg ?? "") === "moxel") return "moxel";
  }
  return "voxeltoy";
}

const CMD = commandName();

const HELP = `${CMD} ${pkg.version}: voxel models from the command line

\`moxel\` is the same command as \`voxeltoy\`, for one step.

Usage:
  ${CMD} info <file> [--model <m>] [--json]   a library's models and scenes, and a model's size,
                                             palette, layers and frames
  ${CMD} convert <file> <out>... [--model <m>]  write as other formats, by extension
  ${CMD} new <out> [--size 32x32x32] [--palette <name>] [--name <name>]
  ${CMD} render <file> <out.png> [--model <m>] [--view iso] [--frames all] [--size 512]
               [--projection perspective|orthographic] [--background #rrggbb|transparent] [--layers a,b]
  ${CMD} mcp [--root <dir>]                   serve the editor to agents over stdio MCP

A .voxeltoy file is a library: it can hold several models and scenes. .moxel still opens, and
"format": "moxel" still reads. --model picks one by id or name; without it, commands use the
primary model (or the primary scene's stage, or else the first model).
convert writes the whole library to a .voxeltoy (or .moxel), or with --model just that model;
other formats take one model. New files say "format": "voxeltoy".

render draws the model as the editor shades it. --view takes a comma list of ${RENDER_VIEWS.join(", ")}
or yaw:pitch in degrees, and --frames a comma list of frame numbers from 0, or all; several of either
make a grid of tiles, --size pixels each.

Models open from ${list(OPEN_FORMATS)} and save to ${list(SAVE_FORMATS)};
palettes save to ${list(PALETTE_SAVE_FORMATS)}.

The MCP server can read and write files under --root only (default: the current folder).
Add it to an agent, e.g. Claude Code:  claude mcp add voxeltoy -- voxeltoy mcp --root ./models
\`moxel mcp\` still starts the same server.
`;

function list(formats: readonly string[]) {
  return formats.map((f) => "." + f).join(", ");
}

class UsageError extends Error {}

async function loadLibrary(path: string): Promise<LibraryEditor> {
  if (fileKind(path) !== "document") throw new Error(`${path}: models open from ${list(OPEN_FORMATS)}`);
  return libraryEditor(readLibrary(new Uint8Array(await readFile(path)), path));
}

/** A file's model: the one --model names, or the one the MCP server would open. */
function modelOf(library: LibraryEditor, path: string, ref?: string): Editor {
  return openModel(library, ref) ?? fail(`${path} has no models`);
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Write in the format `path`'s extension names: a model, or its palette. With a library, a .moxel
 * is the whole library, or with `model` that model alone.
 */
async function writeOut(editor: Editor, path: string, library?: { editor: LibraryEditor; model?: string }): Promise<number> {
  const e = extname(path).slice(1).toLowerCase();
  const isPalette = (PALETTE_SAVE_FORMATS as readonly string[]).includes(e);
  const data = isPalette
    ? await paletteBytes(editor, path)
    : library && isLibraryExt(saveFormat(path))
      ? libraryBytes(library.model ? modelLibrary(library.editor, library.model) : library.editor.getLibrary())
      : await documentBytes(editor, saveFormat(path));
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, data);
  return data.length;
}

/** The library tools' account of it, as get_library gives it. */
function libraryJson(library: LibraryEditor) {
  return JSON.parse(createSceneAgentTools(library).find((t) => t.name === "get_library")!.execute({}));
}

/** A library's models and scenes, as get_library gives them, as lines. `fallback` is the model commands use without --model. */
function describeLibrary(info: ReturnType<typeof libraryJson>, path: string, fallback: string | null): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const lines = [`${path}: library “${info.name}”, ${plural(info.models.length, "model")}, ${plural(info.scenes.length, "scene")}`];
  const table = (rows: string[][]) => {
    const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => r[c].length))) ?? [];
    for (const r of rows) lines.push(`    ${r.map((cell, c) => (c < r.length - 1 ? cell.padEnd(widths[c]) : cell)).join("  ")}`.trimEnd());
  };
  if (info.models.length) {
    lines.push("  models");
    table(
      info.models.map((m: { id: string; name: string; size: number[]; ref?: string; built?: boolean }) => {
        const flags = [m.id === info.primary && "primary", m.id === fallback && "default", m.ref !== undefined && `ref ${m.ref}`, m.built && "built"].filter(Boolean);
        return [m.id, m.name, m.size.join(" × "), flags.length ? `(${flags.join(", ")})` : ""];
      }),
    );
  }
  if (info.scenes.length) {
    lines.push("  scenes");
    table(
      info.scenes.map((s: { id: string; name: string; stage: string | null; instances: number }) => [
        s.id,
        s.name,
        plural(s.instances, "instance"),
        [s.id === info.primary && "primary", s.stage && `stage ${s.stage}`].filter(Boolean).join(", "),
      ]),
    );
  }
  return lines.join("\n");
}

function describe(editor: Editor, path: string): string {
  const doc = JSON.parse(createAgentTools(editor).find((t) => t.name === "get_document")!.execute({}));
  const lines = [
    `${path}: “${doc.name}”`,
    `  size        ${doc.size.join(" × ")}${doc.resolution > 1 ? ` (${doc.resolution}× resolution)` : ""}`,
    `  palette     ${doc.palette.length - 1} colors`,
    `  bounds      ${doc.bounds ? `${doc.bounds.min.join(",")} to ${doc.bounds.max.join(",")}` : "empty"}`,
    `  layers      ${doc.layers.length}`,
  ];
  const width = Math.max(...doc.layers.map((l: { name: string }) => l.name.length));
  for (const l of doc.layers) {
    const flags = [l.kind !== "raster" && l.kind, !l.visible && "hidden"].filter(Boolean);
    lines.push(`    ${l.name.padEnd(width)}  ${String(l.voxels).padStart(7)} voxels${flags.length ? `  (${flags.join(", ")})` : ""}`);
  }
  if (doc.markers.length) {
    lines.push(`  markers     ${doc.markers.length}`);
    for (const m of doc.markers) {
      const where = m.at ? `at ${m.at.join(",")}` : `${m.volume.kind} ${m.volume.min.join(",")} to ${m.volume.max.join(",")}`;
      lines.push(`    ${m.name}${m.role ? ` (${m.role})` : ""}  ${where}${m.keyed ? ", keyed per frame" : ""}`);
    }
  }
  const anim = doc.animation;
  if (anim.frames.length > 1) {
    lines.push(`  animation   ${anim.frames.length} frames, ${anim.fps} fps, ${anim.seconds}s`);
    const frame = (id: string) => anim.frames.findIndex((f: { id: string }) => f.id === id);
    for (const t of anim.tags ?? []) lines.push(`    ${t.name}  frames ${frame(t.from)}–${frame(t.to)}`);
  }
  return lines.join("\n");
}

async function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      size: { type: "string" },
      palette: { type: "string" },
      name: { type: "string" },
      view: { type: "string" },
      frames: { type: "string" },
      projection: { type: "string" },
      background: { type: "string" },
      layers: { type: "string" },
      root: { type: "string" },
      model: { type: "string", short: "m" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command, ...args] = positionals;
  if (values.version) return console.log(pkg.version);
  if (values.help || !command || command === "help") return console.log(HELP);

  switch (command) {
    case "info": {
      if (args.length !== 1) throw new UsageError(`${CMD} info <file> [--model <m>] [--json]`);
      const library = await loadLibrary(args[0]);
      const getDocument = (editor: Editor) => createAgentTools(editor).find((t) => t.name === "get_document")!.execute({});
      // a file of one model reads as it did before libraries
      if (isSingleModel(library)) {
        const editor = modelOf(library, args[0], values.model);
        return console.log(values.json ? getDocument(editor) : describe(editor, args[0]));
      }
      const fallback = openModel(library) && library.activeModel;
      const editor = values.model !== undefined ? modelOf(library, args[0], values.model) : library.activeEditor;
      const json = libraryJson(library);
      if (values.json) return console.log(JSON.stringify({ library: json, document: editor && JSON.parse(getDocument(editor)) }));
      const details = editor ? `

${describe(editor, library.activeModel!)}` : "";
      return console.log(describeLibrary(json, args[0], fallback || null) + details);
    }
    case "convert": {
      if (args.length < 2) throw new UsageError(`${CMD} convert <file> <out>... [--model <m>]`);
      const library = await loadLibrary(args[0]);
      const editor = modelOf(library, args[0], values.model);
      const model = values.model === undefined ? undefined : library.activeModel!;
      for (const out of args.slice(1)) console.log(`${out}  ${await writeOut(editor, out, { editor: library, model })} bytes`);
      return;
    }
    case "new": {
      if (args.length !== 1) throw new UsageError(`${CMD} new <out> [--size 32x32x32] [--palette <name>] [--name <name>]`);
      const editor = new Editor();
      const size = values.size?.split(/[x×,]/).map(Number);
      const input = { size, palette: values.palette, name: values.name };
      createAgentTools(editor).find((t) => t.name === "new_document")!.execute(input);
      console.log(`${args[0]}  ${await writeOut(editor, args[0])} bytes`);
      return;
    }
    case "render": {
      if (args.length !== 2) throw new UsageError(`${CMD} render <file> <out.png> [--model <m>] [--view iso,front] [--frames all] [--size 512]`);
      if (extname(args[1]).toLowerCase() !== ".png") throw new UsageError(`${CMD} render <file> <out.png>: renders are PNGs`);
      const editor = modelOf(await loadLibrary(args[0]), args[0], values.model);
      const split = (value?: string) => value?.split(",").map((s) => s.trim());
      const size = values.size === undefined ? undefined : Number(values.size);
      const result = await renderPng(editor, {
        views: split(values.view)?.map((v) => {
          if ((RENDER_VIEWS as readonly string[]).includes(v)) return v;
          const angles = v.split(":");
          const [yaw, pitch] = angles.map(Number);
          if (angles.length !== 2 || angles.some((a) => !a.trim()) || !Number.isFinite(yaw) || !Number.isFinite(pitch) || Math.abs(pitch) > 90) {
            throw new UsageError(`--view must be one of ${RENDER_VIEWS.join(", ")}, or yaw:pitch in degrees, with pitch from -90 to 90`);
          }
          return { yaw, pitch };
        }),
        frames: values.frames === "all" ? "all" : split(values.frames)?.map((f) => (/^\d+$/.test(f) ? Number(f) : f)),
        size,
        projection: values.projection,
        background: values.background,
        layers: split(values.layers),
      });
      await mkdir(dirname(resolve(args[1])), { recursive: true });
      await writeFile(args[1], result.png);
      console.log(`${args[1]}  ${result.width}×${result.height}, ${result.png.length} bytes`);
      return;
    }
    case "mcp": {
      const root = resolve(values.root ?? ".");
      if (!(await stat(root).catch(() => null))?.isDirectory()) throw new UsageError(`--root ${root} isn't a folder`);
      // stdout carries the protocol, so the greeting goes to stderr
      console.error(`${CMD} mcp: serving ${root}`);
      return serveStdio(new Session(root));
    }
    default:
      throw new UsageError(`Unknown command “${command}”. Run ${CMD} help`);
  }
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(err instanceof UsageError ? `Usage: ${err.message}` : `${CMD}: ${errorMessage(err)}`);
  process.exit(1);
});
