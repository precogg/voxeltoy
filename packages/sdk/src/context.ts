import { createContext, useContext, type Accessor, type Component, type Setter } from "solid-js";
import type { Editor } from "@voxeltoy/core/editor";
import type { DecalSet } from "@voxeltoy/three/decals";
import type { Viewport } from "@voxeltoy/three/viewport";
import type { Action, Actions, ToolButton } from "./actions";
import type { MenuItem } from "./primitives";
import type { HeadsetOptions } from "./actions";

/** The built-in dialogs, or the name of one the host supplies in `EditorHost.dialogs`. */
export type Dialog = "new" | "resize" | "shortcuts" | (string & {}) | null;
export type ThemePreference = "system" | "light" | "dark";

/**
 * The parts of the editor's layout. A host replaces one with its own component, or hides it
 * with null; anything it leaves out keeps the default.
 */
export interface EditorComponents {
  /** Top left: the menu, undo and redo, and the host's `mainBar`. */
  MainBar?: Component | null;
  /**
   * In the style panel: the palette swatches. Replace it to offer the host's own materials
   * (picking one still goes through `editor.setColor`).
   */
  Palette?: Component | null;
  /** Under the main bar. Hiding it also hides the main bar's Layers button. */
  LayersPanel?: Component | null;
  /** Top right: palette, brush and mirror. On phones it opens from `StyleButton` into a sheet. */
  StylePanel?: Component | null;
  /** On phones, the top-right button that opens the style panel. */
  StyleButton?: Component | null;
  /** Bottom left: fit, views and workplane. */
  ViewControls?: Component | null;
  /** Bottom center: the tools. Contextual bars (shape, extrude, selection) sit above it. */
  Toolbar?: Component | null;
  /** Bottom center, just above the tools: a host's own contextual bar. Empty by default. */
  ContextBar?: Component | null;
  /** Bottom right. Empty by default. */
  BottomRight?: Component | null;
  /** Over the canvas, under the panels. Empty by default; it does not take pointer input. */
  CanvasOverlay?: Component | null;
  /** Bottom center, above the tools: the animation's frames, when open. Hiding it also hides the main bar's Timeline button. */
  Timeline?: Component | null;
}

/**
 * What the application around the editor adds: its own commands, menu entries, buttons and
 * dialogs, and the rules for replacing or editing the document. Everything is optional.
 */
export interface EditorHost {
  /** The toolbar's tools, given the built-in ones. Custom tools need a matching `CustomTool` in the Editor. */
  tools?: (builtIn: readonly ToolButton[]) => ToolButton[];
  /** Replace or hide parts of the layout. */
  components?: EditorComponents;
  /** True while the document can only be looked at: the toolbar keeps the tools that look. */
  viewOnly?: () => boolean;
  /**
   * Called before New replaces the document. Return false to keep it. Without this, the editor
   * asks for confirmation when the document has content.
   */
  beforeNewDocument?: () => boolean;
  /** More commands. Their shortcuts work like the built-in ones; a matching name replaces one. */
  actions?: (app: App) => Record<string, Action>;
  /** Rewrites the main menu, given the built-in entries. */
  menu?: (items: MenuItem[], app: App) => MenuItem[];
  /** Shown at the end of the main bar. */
  mainBar?: Component;
  /**
   * Pictures on voxel faces, recomputed whenever what it reads changes (it runs as a Solid
   * computation, so reading editor getters subscribes to them).
   */
  decals?: () => DecalSet | null;
  /** A name for a palette entry, shown in place of its hex code. */
  colorLabel?: (index: number) => string;
  /** Dialogs to open by name with `app.setDialog(name)`. */
  dialogs?: Record<string, Component>;
  /**
   * Offer the commands that add shape layers, override layers and resolutions. Defaults to true.
   * A model that already uses them gets its commands either way.
   */
  shapes?: boolean;
  /**
   * What the headset view takes from the app, beyond the editor and the page's menus: the library
   * whose scene this model is the stage of, the palette's colors and tools, life size, and its own
   * additions (see `XROptions` in `@voxeltoy/xr/editor/session`). Read when the headset opens.
   */
  headset?: (app: App) => HeadsetOptions;
}

export interface App {
  editor: Editor;
  host: EditorHost;
  viewport: Accessor<Viewport | undefined>;
  actions: Actions;
  /** The toolbar's tools. */
  tools: readonly ToolButton[];
  layersOpen: Accessor<boolean>;
  setLayersOpen: Setter<boolean>;
  styleOpen: Accessor<boolean>;
  setStyleOpen: Setter<boolean>;
  /** Whether the workplane panel is open. Closing it leaves the workplane where it is. */
  workplaneOpen: Accessor<boolean>;
  setWorkplaneOpen: Setter<boolean>;
  /** Whether the timeline (the animation's frames) is open. */
  timelineOpen: Accessor<boolean>;
  setTimelineOpen: Setter<boolean>;
  dialog: Accessor<Dialog>;
  setDialog: Setter<Dialog>;
  theme: Accessor<ThemePreference>;
  setTheme: (t: ThemePreference) => void;
  /** True on narrow screens; panels start collapsed and float over the canvas. */
  compact: Accessor<boolean>;
  /** Whether to offer shape layers, override layers and resolutions: see `EditorHost.shapes`. */
  shapes: Accessor<boolean>;
}

export const AppContext = createContext<App>();

export function useApp(): App {
  const app = useContext(AppContext);
  if (!app) throw new Error("useApp must be used inside an EditorView");
  return app;
}
