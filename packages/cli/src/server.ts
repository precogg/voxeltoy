// `moxel mcp`: the browser's agent tools over stdio, on a headless library, plus file tools for a
// root folder. Each editing tool is one undo step, as in WebMCP.
//
// The open file is a library (docs/library.md). The model tools act on its open model, found
// afresh on every call, so they follow the library tools (open, open_model, add_model) when they
// open another one.

import { createAgentTools, type AgentTool } from "@voxeltoy/core/agent-tools";
import { Editor } from "@voxeltoy/core/editor";
import { libraryOf } from "@voxeltoy/core/library";
import { createSceneAgentTools } from "@voxeltoy/core/scene-agent-tools";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { errorMessage, OPEN_FORMATS, PALETTE_FORMATS, PALETTE_SAVE_FORMATS, SAVE_FORMATS } from "./files";
import { renderPng, renderSchema, type RenderInput } from "./render";
import type { Session } from "./session";
import pkg from "../package.json" with { type: "json" };

type Input = Record<string, unknown>;

/** A tool's result: JSON text, and images to show the agent. */
export interface ToolResult {
  text: string;
  images?: Uint8Array[];
}

export interface ServerTool extends Omit<AgentTool, "execute"> {
  execute(input: Input): string | ToolResult | Promise<string | ToolResult>;
}

const list = (formats: readonly string[]) => formats.map((f) => "." + f).join(", ");
const pathSchema = (description: string) => ({ type: "string", description });
const discardSchema = { type: "boolean", description: "Drop unsaved changes to the open library." };

const INSTRUCTIONS =
  "Voxeltoy edits voxel models. A .voxeltoy file is a library (a .moxel file still opens): it can hold several models, and scenes that place them. " +
  "One library is open at a time, and one model of it is open for the model tools (get_document, set_voxels, " +
  "place_shapes, ...); they change it in memory, and save_file writes the whole library to disk. Call get_library " +
  "to see the models and scenes and which model is open, and open (by id or name) to work on another one; " +
  "add_model makes a new model. Call get_document to see the open model. Paths are relative to the root folder, " +
  "and list_files shows what is there. Call render to see the open model as the user would, after building " +
  "something and whenever the shape is in doubt; pass a path to save a picture for the user.";

/** Scene tools the server leaves out: undo and redo already cover the whole library. */
const LEFT_OUT = new Set(["undo_scene", "redo_scene"]);

/** The model tools on whichever model is open, the library and scene tools, and the file tools. */
export function serverTools(session: Session): ServerTool[] {
  const { library } = session;
  // each model's tools, made when first used; their schemas don't depend on the model
  const toolsOf = new WeakMap<Editor, Map<string, AgentTool>>();
  const onOpenModel = (name: string): AgentTool => {
    const editor = session.editor;
    let tools = toolsOf.get(editor);
    if (!tools) toolsOf.set(editor, (tools = new Map(createAgentTools(editor).map((t) => [t.name, t]))));
    return tools.get(name)!;
  };

  /** Undo or redo on the library when no model is open, answering as the model tools do. */
  const libraryStep = (name: string, input: Input): string => {
    const undo = name === "undo";
    const steps = input.steps ?? 1;
    if (!Number.isInteger(steps) || (steps as number) < 1 || (steps as number) > 200) throw new Error("steps must be a whole number from 1 to 200");
    const done: string[] = [];
    while (done.length < (steps as number)) {
      const label = undo ? library.undoLabel : library.redoLabel;
      if (!label || !(undo ? library.undo() : library.redo())) break;
      done.push(label);
    }
    return JSON.stringify({ [undo ? "undone" : "redone"]: done, undo: library.undoLabel, redo: library.redoLabel });
  };

  const editing: ServerTool[] = createAgentTools(new Editor()).map((tool): ServerTool => {
    switch (tool.name) {
      case "new_document":
        return {
          ...tool,
          description:
            "Replace the open library with a new one holding one empty model, and open that model. This discards the " +
            "library (every model and scene in it) and its undo history, so only use it when the user asks for a new " +
            "file; add_model adds a model to the open library instead.",
          inputSchema: {
            ...tool.inputSchema,
            properties: { ...(tool.inputSchema.properties as object), discard: discardSchema },
          },
          execute: (input) => {
            session.checkUnsaved(input.discard === true);
            // made on an editor of its own, then opened as a library of one
            const scratch = new Editor();
            const result = createAgentTools(scratch).find((t) => t.name === "new_document")!.execute(input);
            session.replace(libraryOf(scratch.getDocument()));
            return result;
          },
        };
      case "undo":
      case "redo":
        return {
          ...tool,
          description: `${tool.description} One history covers the whole library: model edits, scene edits and library changes, in the order they were made.`,
          execute: (input) => (session.openEditor ? onOpenModel(tool.name).execute(input) : libraryStep(tool.name, input)),
        };
      default:
        return { ...tool, execute: (input) => onOpenModel(tool.name).execute(input) };
    }
  });

  const scenes: ServerTool[] = createSceneAgentTools(library).filter((t) => !LEFT_OUT.has(t.name));

  const files: ServerTool[] = [
    {
      name: "list_files",
      title: "List files",
      description:
        `List a folder under the root: subfolders, models and libraries (${list(OPEN_FORMATS)}) and palettes ` +
        `(${list(PALETTE_FORMATS)}). Also says which file is open and whether it has unsaved changes.`,
      inputSchema: {
        type: "object",
        properties: { dir: pathSchema("A folder relative to the root. Defaults to the root.") },
      },
      annotations: { readOnlyHint: true },
      execute: async (input) =>
        JSON.stringify({ open: session.status(), entries: await session.list((input.dir as string | undefined) ?? ".") }),
    },
    {
      name: "open_file",
      title: "Open file",
      description:
        `Open a file (${list(OPEN_FORMATS)}) as the library, replacing the open one and its undo history, or load a palette ` +
        `file (${list(PALETTE_FORMATS)}) into the open model as one undo step; voxels whose color is gone take the nearest one. ` +
        "A .voxeltoy (or a legacy .moxel) can hold several models and scenes; all of them open, and its primary model (or its primary scene's " +
        "stage, or else its first model) is open for the model tools. get_library lists the rest, and open switches. " +
        "A .vox opens as a library of one model. Opening a .voxeltoy or .moxel makes it the file save_file writes to.",
      inputSchema: {
        type: "object",
        properties: { path: pathSchema("Relative to the root."), discard: discardSchema },
        required: ["path"],
      },
      annotations: { consequentialHint: true },
      execute: async (input) => {
        const kind = await session.open(input.path as string, input.discard === true);
        const editor = session.openEditor;
        return JSON.stringify({
          opened: kind,
          file: session.status(),
          library: { name: library.name, models: library.models.length, scenes: library.scenes.length },
          model: library.activeModel,
          ...(editor
            ? { name: editor.name, size: editor.size, layers: editor.layers.length, colors: editor.palette.length - 1, frames: editor.frames.length }
            : {}),
        });
      },
    },
    {
      name: "save_file",
      title: "Save file",
      description:
        `Write in the format the path's extension names: ${list(SAVE_FORMATS)}. ` +
        ".voxeltoy and .moxel write the whole library (every model and scene) and become the open file. " +
        ".vox (MagicaVoxel), .voxeltoyvol and .moxelvol export only the open model: .vox is flattened to what shape and override layers " +
        "evaluate to, and .voxeltoyvol (or .moxelvol) is every frame's voxels for game engines. Without a path, saves the open library file. " +
        "Folders are created as needed and existing files are replaced.",
      inputSchema: {
        type: "object",
        properties: { path: pathSchema("Relative to the root. Defaults to the open library file.") },
      },
      execute: async (input) => JSON.stringify({ ...(await session.save(input.path as string | undefined)), file: session.status() }),
    },
    {
      name: "export_palette",
      title: "Export palette",
      description: `Write the open model's palette (without the reserved empty color) as ${list(PALETTE_SAVE_FORMATS)}, by the path's extension.`,
      inputSchema: {
        type: "object",
        properties: { path: pathSchema("Relative to the root.") },
        required: ["path"],
      },
      execute: async (input) => JSON.stringify(await session.exportPalette(input.path as string)),
    },
  ];
  const render: ServerTool = {
    name: "render",
    title: "Render",
    description:
      "See the open model: a shaded picture of it, as the editor draws it, returned as an image. Several views or frames " +
      "come back as tiles of one image: with several of each, each row is a frame and each column a view; " +
      "otherwise the tiles wrap left to right, top to bottom. `tiles` says what each shows. Every tile frames the " +
      "same box, so frames line up. Shows the committed model of visible layers, ignoring the workplane's clip. " +
      "Pass a path to also save the PNG under the root, e.g. to show the user.",
    inputSchema: {
      type: "object",
      properties: { ...renderSchema, path: pathSchema("Also save the image here, relative to the root; ends in .png.") },
    },
    execute: async (input) => {
      const { png, ...info } = await renderPng(session.editor, input as RenderInput);
      const path = input.path === undefined ? undefined : await session.writeImage(input.path as string, png);
      return { text: JSON.stringify({ ...info, path }), images: [png] };
    },
  };
  return [...editing, ...scenes, render, ...files];
}

export function createServer(session: Session): Server {
  const tools = serverTools(session);
  const server = new Server({ name: "voxeltoy", version: pkg.version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema as { type: "object" },
      annotations: {
        title: t.title,
        readOnlyHint: !!t.annotations?.readOnlyHint,
        destructiveHint: !!t.annotations?.consequentialHint,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) return { content: [{ type: "text", text: `No tool named ${request.params.name}` }], isError: true };
    try {
      const result = await tool.execute((request.params.arguments ?? {}) as Input);
      const { text, images = [] } = typeof result === "string" ? { text: result } : result;
      return {
        content: [
          { type: "text" as const, text },
          ...images.map((png) => ({ type: "image" as const, data: Buffer.from(png).toString("base64"), mimeType: "image/png" })),
        ],
      };
    } catch (err) {
      // tools throw with a reason the agent can act on
      return { content: [{ type: "text", text: errorMessage(err, session.root) }], isError: true };
    }
  });

  return server;
}

/** Serve on stdin/stdout until the client goes away. Nothing else may write to stdout. */
export async function serveStdio(session: Session) {
  await createServer(session).connect(new StdioServerTransport());
}
