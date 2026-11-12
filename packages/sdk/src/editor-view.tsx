import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, untrack, type Component } from "solid-js";
import type { ToolId } from "@voxeltoy/core/types";
import { Dynamic } from "solid-js/web";
import { VECTOR_TOOLS, type Editor } from "@voxeltoy/core/editor";
import { Viewport, type ViewportTheme } from "@voxeltoy/three/viewport";
import { createActions, handleShortcut, nameActions, TOOLS, type Actions } from "./actions";
import { AppContext, type App, type Dialog, type EditorComponents, type EditorHost, type ThemePreference } from "./context";
import { Dialogs, Toast } from "./dialogs";
import { headsetMenus } from "./menus";
import { ExtrudeBar } from "./extrude-bar";
import { LayersPanel } from "./layers-panel";
import { MainBar } from "./main-menu";
import { MarkerBar } from "./marker-bar";
import { PropertiesPanel } from "./properties";
import { ShapeSelectionBar } from "./shape-selection-bar";
import { PointCard, PropertiesSheet } from "./properties-sheet";
import { SelectionBar } from "./selection-bar";
import { DrawLabel, ShapeBar, ShapeDrawBar } from "./shape-bar";
import { StyleButton, StylePanel } from "./style-panel";
import { Timeline } from "./timeline";
import { Toolbar } from "./toolbar";
import { ViewControls } from "./view-controls";

export interface EditorViewProps {
  editor: Editor;
  host?: EditorHost;
  /** The starting theme; the view does not store the choice. */
  theme?: ThemePreference;
  onThemeChange?: (theme: ThemePreference) => void;
  /** Called once the viewport exists, and with undefined when it goes away. */
  onViewport?: (viewport: Viewport | undefined) => void;
  /** Receives the view's state and commands, for hosts that drive it from outside. */
  ref?: (app: App) => void;
}

function mediaSignal(query: string) {
  const media = window.matchMedia(query);
  const [matches, setMatches] = createSignal(media.matches);
  const update = () => setMatches(media.matches);
  media.addEventListener("change", update);
  onCleanup(() => media.removeEventListener("change", update));
  return matches;
}

/** The whole editor: the canvas, its panels and toolbars, dialogs and keyboard shortcuts. */
export function EditorView(props: EditorViewProps) {
  const editor = props.editor;
  const host = props.host ?? {};

  const compact = mediaSignal("(max-width: 640px)");
  const prefersDark = mediaSignal("(prefers-color-scheme: dark)");

  const [viewport, setViewport] = createSignal<Viewport>();
  const [dialog, setDialog] = createSignal<Dialog>(null);
  const [layersOpen, setLayersOpenRaw] = createSignal(!compact());
  const [styleOpen, setStyleOpenRaw] = createSignal(!compact());
  const [theme, setThemeRaw] = createSignal<ThemePreference>(props.theme ?? "system");

  // On small screens the panels share the space, so only one is open at a time.
  const setLayersOpen = ((v: boolean | ((p: boolean) => boolean)) => {
    const next = typeof v === "function" ? v(layersOpen()) : v;
    if (next && compact()) setStyleOpenRaw(false);
    return setLayersOpenRaw(next);
  }) as App["setLayersOpen"];
  const setStyleOpen = ((v: boolean | ((p: boolean) => boolean)) => {
    const next = typeof v === "function" ? v(styleOpen()) : v;
    if (next && compact()) setLayersOpenRaw(false);
    return setStyleOpenRaw(next);
  }) as App["setStyleOpen"];

  const setTheme = (t: ThemePreference) => {
    setThemeRaw(t);
    props.onThemeChange?.(t);
  };

  const resolvedTheme = () => (theme() === "system" ? (prefersDark() ? "dark" : "light") : theme());
  const viewportTheme = createMemo<ViewportTheme>(() => {
    document.documentElement.dataset.theme = resolvedTheme();
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    return {
      background: v("--canvas"),
      grid: v("--grid"),
      gridStrong: v("--grid-strong"),
      accent: v("--accent"),
      danger: v("--danger"),
      onionBefore: v("--onion-before"),
      onionAfter: v("--onion-after"),
    };
  });

  createEffect(on(compact, (c) => {
    setLayersOpenRaw(!c);
    setStyleOpenRaw(!c);
  }, { defer: true }));

  const tools = host.tools ? host.tools(TOOLS) : TOOLS;
  const shapes = () => (host.shapes ?? true) || !editor.isFlat;
  // decals address whole cells, so their hosts keep 1× resolution
  if (host.decals) editor.lockResolution();
  const [workplaneOpen, setWorkplaneOpen] = createSignal(false);
  // an animation opens with its timeline showing
  const [timelineOpen, setTimelineOpen] = createSignal(untrack(() => editor.isAnimated || editor.tags.length > 0));
  onCleanup(editor.onLoad(() => untrack(() => editor.isAnimated || editor.tags.length > 0) && setTimelineOpen(true)));
  const app: App = {
    editor,
    host,
    viewport,
    tools,
    shapes,
    actions: createActions(editor, viewport, dialog, setDialog, tools, shapes, {
      open: workplaneOpen,
      setOpen: setWorkplaneOpen,
    }, {
      open: timelineOpen,
      setOpen: setTimelineOpen,
    }, () => ({ ...host.headset?.(app), menus: headsetMenus(app) })) as Actions,
    layersOpen,
    setLayersOpen,
    styleOpen,
    setStyleOpen,
    workplaneOpen,
    setWorkplaneOpen,
    timelineOpen,
    setTimelineOpen,
    dialog,
    setDialog,
    theme,
    setTheme,
    compact,
  };
  if (host.actions) app.actions = { ...app.actions, ...nameActions(host.actions(app)) };

  // the workplane's arrow shows while its panel is open
  createEffect(() => viewport()?.setWorkplaneHandle(workplaneOpen()));

  // vector and raster layers have their own tools; each kind keeps the tool it had last
  const lastTool: { vector: ToolId | null; raster: ToolId | null } = { vector: null, raster: null };
  const fits = (vector: boolean, tool: ToolId) => (vector ? VECTOR_TOOLS.includes(tool) : tool !== "shape" && tool !== "pen");
  createEffect(
    on(
      () => editor.activeLayerKind === "shape",
      (vector, was) => {
        const tool = untrack(() => editor.tool);
        if (was !== undefined) lastTool[was ? "vector" : "raster"] = tool;
        const next = lastTool[vector ? "vector" : "raster"];
        if (next && fits(vector, next)) editor.setTool(next);
        else if (!fits(vector, tool)) editor.setTool(vector ? "select" : "add");
      },
    ),
  );
  // playback: one pose per display frame at most, by elapsed time; a hidden page pauses, so it
  // doesn't leap through the time it was away
  createEffect(() => {
    if (!editor.playing) return;
    let frame = requestAnimationFrame(function tick(time) {
      editor.advance(time);
      frame = requestAnimationFrame(tick);
    });
    const onHidden = () => document.hidden && editor.pause();
    document.addEventListener("visibilitychange", onHidden);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onHidden);
    });
  });

  props.ref?.(app);

  const defaults: Required<EditorComponents> = {
    MainBar,
    LayersPanel,
    StylePanel,
    StyleButton,
    ViewControls,
    Toolbar,
    ContextBar: null,
    BottomRight: null,
    CanvasOverlay: null,
    Timeline,
    // Drawn inside the style panel, which falls back to its own swatches.
    Palette: null,
  };
  /** A layout part: the host's, or the default. Renders nothing if hidden. */
  const Part = (props: { name: keyof EditorComponents }) => {
    const parts = host.components ?? {};
    const component: Component | null = props.name in parts ? (parts[props.name] ?? null) : defaults[props.name];
    return <Show when={component}>{(c) => <Dynamic component={c()} />}</Show>;
  };

  let canvas!: HTMLCanvasElement;
  onMount(() => {
    const vp = new Viewport(canvas, editor, viewportTheme);
    setViewport(vp);
    props.onViewport?.(vp);
    if (host.decals) createEffect(() => vp.setDecals(host.decals!()));

    const onKey = (e: KeyboardEvent) => {
      if (dialog() && e.key !== "Escape") return;
      handleShortcut(app.actions, e);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      props.onViewport?.(undefined);
      setViewport(undefined);
      vp.dispose();
    });
  });

  return (
    <AppContext.Provider value={app}>
      <div class="app" data-tool={editor.tool}>
        <canvas class="canvas" ref={canvas} />
        <div class="canvas-overlay">
          <Part name="CanvasOverlay" />
        </div>
        <DrawLabel />
        <div class="ui" data-compact={compact() ? "" : undefined} data-editing={editor.editingShape ? "" : undefined}>
          <Show
            when={compact()}
            fallback={
              <>
                <div class="area top-left">
                  <Part name="MainBar" />
                  <Show when={layersOpen()}>
                    <Part name="LayersPanel" />
                  </Show>
                </div>
                <div class="area top-right">
                  <Part name="StylePanel" />
                  <PropertiesPanel />
                </div>
              </>
            }
          >
            {/* phones: one full-width sheet under the top bar */}
            <div class="area top-left">
              <Part name="MainBar" />
            </div>
            <div class="area top-right">
              <Part name="StyleButton" />
            </div>
            {/* Layers shares the bottom sheet with Properties (PropertiesSheet) */}
            <div class="area sheet">
              <Show when={styleOpen()}>
                <Part name="StylePanel" />
              </Show>
            </div>
          </Show>
          <div class="area bottom-left">
            <Part name="ViewControls" />
          </div>
          <div class="area bottom-center">
            <Show when={timelineOpen()}>
              <Part name="Timeline" />
            </Show>
            <ShapeBar />
            <ShapeDrawBar />
            <ExtrudeBar />
            <MarkerBar />
            <SelectionBar />
            <Show when={compact()}>
              <PointCard />
            </Show>
            <ShapeSelectionBar />
            <Show when={compact()}>
              <PropertiesSheet />
            </Show>
            <Part name="ContextBar" />
            {/* on a phone, editing a shape in place, its bar takes the toolbar's place */}
            <Show when={!(compact() && editor.editingShape)}>
              <Part name="Toolbar" />
            </Show>
          </div>
          <div class="area bottom-right">
            <Part name="BottomRight" />
          </div>
        </div>
        <Toast />
        <Dialogs />
      </div>
    </AppContext.Provider>
  );
}
