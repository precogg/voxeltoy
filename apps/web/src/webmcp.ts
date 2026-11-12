import { createAgentTools, type AgentTool, type AgentView } from "@voxeltoy/core/agent-tools";
import type { Editor } from "@voxeltoy/core/editor";
import type { LibraryEditor } from "@voxeltoy/core/library";
import { createSceneAgentTools } from "@voxeltoy/core/scene-agent-tools";

interface ModelContext {
  registerTool(
    tool: Omit<AgentTool, "execute"> & { execute(input: Record<string, unknown>): Promise<string> },
    options?: { signal?: AbortSignal },
  ): Promise<void> | void;
  /** Early Chrome builds unregistered by name instead of with a signal. */
  unregisterTool?(name: string): void;
}

/**
 * Offer the editor's tools to browser agents through WebMCP, where the browser supports it.
 * Returns a function that withdraws them.
 */
export function registerWebMcp(editor: Editor, view: AgentView): () => void {
  return registerAgentTools(() => createAgentTools(editor, view));
}

/** Offer a scene's tools to browser agents (docs/scenes.md). Returns a function that withdraws them. */
export function registerSceneWebMcp(scene: LibraryEditor, view: AgentView): () => void {
  return registerAgentTools(() => createSceneAgentTools(scene, view));
}

function registerAgentTools(create: () => AgentTool[]): () => void {
  // document.modelContext is the standard name; Chrome shipped navigator.modelContext first
  const context = ((document as { modelContext?: ModelContext }).modelContext ??
    (navigator as { modelContext?: ModelContext }).modelContext) as ModelContext | undefined;
  if (!context?.registerTool) return () => {};

  const controller = new AbortController();
  const tools = create();
  for (const tool of tools) {
    const registered = { ...tool, execute: async (input: Record<string, unknown>) => tool.execute(input ?? {}) };
    Promise.resolve()
      .then(() => context.registerTool(registered, { signal: controller.signal }))
      .catch((err: Error) => console.warn(`WebMCP: couldn't register ${tool.name}:`, err.message));
  }

  return () => {
    controller.abort();
    for (const tool of tools) {
      try {
        context.unregisterTool?.(tool.name);
      } catch {
        // already gone with the signal
      }
    }
  };
}
