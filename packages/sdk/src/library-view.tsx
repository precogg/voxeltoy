import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
  useContext,
  type Accessor,
  type Component,
  type JSX,
  type Setter,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { Editor } from "@voxeltoy/core/editor";
import { frameStart } from "@voxeltoy/core/animation";
import type { LibraryEditor, SceneHostHooks } from "@voxeltoy/core/library";
import { stepName } from "./properties";
import type { InstanceKind } from "@voxeltoy/core/scene-kinds";
import { sceneReaches, type InstanceRecord } from "@voxeltoy/core/scene-ops";
import type { Vec3 } from "@voxeltoy/core/types";
import { SceneLayer } from "@voxeltoy/three/scene-layer";
import { Viewport, type ViewportTheme } from "@voxeltoy/three/viewport";
import { formatKbd, handleShortcut, type Actions } from "./actions";
import { AppContext, useApp, type App as EditorApp, type EditorHost, type ThemePreference } from "./context";
import { EditorView } from "./editor-view";
import { LayerRows } from "./layers-panel";
import { command, newLayerItems } from "./menus";
import { Icon } from "./icons";
import { IconButton, Menu, type MenuItem } from "./primitives";
import { openWhenShown, RowEnd, TreeRow } from "./tree-row";
import { createSceneActions, dropPoint, rotationOf, type SceneActions } from "./scene-actions";
import { exportModel } from "./library-files";
import { Inspector } from "./inspector";

/** What the application around a library view adds. Everything is optional. */
export interface LibraryHost {
  /** Rewrites the main menu of the library and of a scene, given the built-in entries. */
  menu?: (items: MenuItem[], app: LibraryApp) => MenuItem[];
  /** Shown at the end of the main bar. */
  mainBar?: Component;
  /** Two taps on an instance (or Edit model in its menu): open its model. */
  openInstance?: (instance: string) => void;
  /** The kinds of object the host offers: in the add menu, with an inspector and handles from their fields. */
  kinds?: InstanceKind[];
  /** Load and save models the host keeps under its own names (`ref`). */
  hooks?: SceneHostHooks;
  /** Rewrites an instance's menu, given the built-in entries. */
  instanceMenu?: (instance: string, items: MenuItem[]) => MenuItem[];
  /** Rewrites the add menu, given the built-in entries. */
  addMenu?: (items: MenuItem[]) => MenuItem[];
  /** A short note after an instance's name in the outliner, such as a count of problems. */
  outlinerBadge?: (instance: string) => string | null;
  /** Quiet text at the end of an instance's row in the outliner, such as where it stands. */
  outlinerDetail?: (instance: string) => string | null;
  /**
   * Orders the instances under each of the outliner's groups (by where they stand, say), in
   * place of the scene's own order; rows then drag only onto each other, not between.
   */
  outlinerSort?: (a: InstanceRecord, b: InstanceRecord) => number;
  /**
   * Draw into the scene: called with each scene layer as it appears; add objects to
   * `layer.overlay` (world units). Return a function that cleans up.
   */
  overlay?: (layer: SceneLayer) => (() => void) | void;
  /**
   * The app's own additions to a model's editor while that model is being edited (its sharing,
   * dialogs and menu, say), merged with the scene's: for a scratch scene's document, for one.
   */
  editorHost?: (editor: Editor) => EditorHost | undefined;
  /** Called with a model editor's app as it appears, for hosts that open its dialogs. */
  onEditorView?: (app: EditorApp, editor: Editor) => void;
  /**
   * Rewrites the scene's actions (menus, buttons and shortcuts use them): a scratch scene's Save
   * saves the model, and its New and Open open a scene of their own, for example.
   */
  actions?: (builtIn: SceneActions) => SceneActions;
}

export interface LibraryViewProps {
  library: LibraryEditor;
  host?: LibraryHost;
  theme?: ThemePreference;
  onThemeChange?: (theme: ThemePreference) => void;
  /**
   * Called when a viewport and its scene layer appear (and with undefined when they go). With a
   * model open in place or a stage, `editor` is that model's editor.
   */
  onViewport?: (viewport: Viewport | undefined, layer: SceneLayer | undefined, editor?: Editor) => void;
  ref?: (app: LibraryApp) => void;
}

export interface LibraryApp {
  library: LibraryEditor;
  host: LibraryHost;
  viewport: Accessor<Viewport | undefined>;
  layer: Accessor<SceneLayer | undefined>;
  actions: SceneActions;
  outlinerOpen: Accessor<boolean>;
  setOutlinerOpen: Setter<boolean>;
  dialog: Accessor<string | null>;
  setDialog: Setter<string | null>;
  theme: Accessor<ThemePreference>;
  setTheme: (t: ThemePreference) => void;
  compact: Accessor<boolean>;
  viewportTheme: Accessor<ViewportTheme>;
  /** Open an instance's model in place (or what the host does instead). */
  openInstance: (instance: string) => void;
  /** Called by whichever canvas is showing, when its viewport and layer appear or go. */
  attach: (viewport: Viewport | undefined, layer: SceneLayer | undefined, editor?: Editor) => void;
}

export const LibraryContext = createContext<LibraryApp>();

export function useLibrary(): LibraryApp {
  const app = useContext(LibraryContext);
  if (!app) throw new Error("useLibrary must be used inside a LibraryView");
  return app;
}

function mediaSignal(query: string) {
  const media = window.matchMedia(query);
  const [matches, setMatches] = createSignal(media.matches);
  const update = () => setMatches(media.matches);
  media.addEventListener("change", update);
  onCleanup(() => media.removeEventListener("change", update));
  return matches;
}

/**
 * A library (docs/library.md): what is open in it, one thing at a time. The library itself (its
 * models and scenes), a model on its own, a scene (its tree, canvas and instance bar), or a model
 * gone into from a scene.
 */
export function LibraryView(props: LibraryViewProps) {
  const scene = props.library;
  const host = props.host ?? {};
  const compact = mediaSignal("(max-width: 640px)");
  const prefersDark = mediaSignal("(prefers-color-scheme: dark)");
  const [viewport, setViewport] = createSignal<Viewport>();
  const [layer, setLayer] = createSignal<SceneLayer>();
  const [dialog, setDialog] = createSignal<string | null>(null);
  const [outlinerOpen, setOutlinerOpen] = createSignal(!compact());
  const [theme, setThemeRaw] = createSignal<ThemePreference>(props.theme ?? "system");
  const setTheme = (t: ThemePreference) => {
    setThemeRaw(t);
    props.onThemeChange?.(t);
  };
  createEffect(on(compact, (c) => setOutlinerOpen(!c), { defer: true }));

  const resolvedTheme = () => (theme() === "system" ? (prefersDark() ? "dark" : "light") : theme());
  const viewportTheme = createMemo<ViewportTheme>(() => {
    document.documentElement.dataset.theme = resolvedTheme();
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    return { background: v("--canvas"), grid: v("--grid"), gridStrong: v("--grid-strong"), accent: v("--accent"), danger: v("--danger") };
  });

  const app: LibraryApp = {
    library: scene,
    host,
    viewport,
    layer,
    actions: ((builtIn: SceneActions) => (host.actions ? host.actions(builtIn) : builtIn))(createSceneActions(scene, layer, setDialog) as SceneActions),
    outlinerOpen,
    setOutlinerOpen,
    dialog,
    setDialog,
    theme,
    setTheme,
    compact,
    viewportTheme,
    openInstance: (id) => {
      // a placed scene opens itself; a model opens in place
      const placed = scene.placedScene(id);
      if (placed) return void scene.openScene(placed);
      return host.openInstance ? host.openInstance(id) : void scene.openModel(id);
    },
    attach: (vp, sl, editor) => {
      stopOverlay?.();
      stopOverlay = sl && host.overlay ? (host.overlay(sl) ?? undefined) : undefined;
      setViewport(vp);
      setLayer(sl);
      props.onViewport?.(vp, sl, editor);
    },
  };
  let stopOverlay: (() => void) | undefined;
  onCleanup(() => stopOverlay?.());
  // the host's kinds and linked models; a scene that opens asks the host for its linked models again
  if (host.kinds) scene.registerKinds(host.kinds);
  if (host.hooks) {
    scene.setHost(host.hooks);
    const refresh = () => void scene.refreshLinked().catch((e: Error) => scene.notify(e.message));
    refresh();
    onCleanup(scene.onLoad(refresh));
  }
  props.ref?.(app);

  // what is open, as a key: a change of it puts up another canvas
  const open = createMemo(() => {
    const alone = scene.modelAlone;
    if (alone) return `alone|${alone}`;
    if (!scene.scene) return "library";
    const model = scene.activeModel;
    return model ? `in|${scene.open?.instance ?? "stage"}|${model}` : `scene|${scene.scene}`;
  });

  return (
    <LibraryContext.Provider value={app}>
      <Show when={open()} keyed>
        {(key) => {
          const [kind, a, b] = key.split("|");
          if (kind === "alone") return <ModelAlone model={a} />;
          if (kind === "in") return <ModelInScene model={b} editing={a !== "stage"} />;
          if (kind === "scene") return <SceneCanvas />;
          return <LibraryCanvas />;
        }}
      </Show>
    </LibraryContext.Provider>
  );
}

/**
 * Where you are: crumbs that lead back up, then what is open, after a divider. Phones keep their top
 * bar small: the path is a line of small text under it (without the library, which every path
 * starts at), and a tap on it lists every crumb, the library first, to go back to. While a shape is
 * edited in place, the bar keeps its way one level up, which is the way out.
 */
function Crumbs(props: { trail: { label: string; onSelect: () => void }[]; current: string; note?: string }) {
  const app = useLibrary();
  const back = () => props.trail[props.trail.length - 1];
  const items = (): MenuItem[] => [
    ...props.trail.map((c) => ({ label: c.label, onSelect: c.onSelect })),
    { label: props.current, checked: true, onSelect: () => {} },
  ];
  return (
    <>
    <Show when={app.compact() && !props.note}>
      <Menu
        icon="chevronDown"
        label="Where you are"
        class="crumb-line"
        placement="bottom-start"
        items={items}
        trigger={() => (
          <span class="crumb-line-text">
            <For each={props.trail.slice(1)}>
              {(c) => (
                <>
                  <span class="crumb-line-part">{c.label}</span>
                  <span class="crumb-line-sep" aria-hidden="true">›</span>
                </>
              )}
            </For>
            <span class="crumb-line-part crumb-line-current">{props.current}</span>
          </span>
        )}
      />
    </Show>
    <Show when={!app.compact() || props.note}>
    <div class="bar-divider" />
    <nav class="crumbs" aria-label="Where you are">
      <Show
        when={!app.compact()}
        fallback={
          <button type="button" class="crumb" title={`Back to ${back().label}`} aria-label={`Back to ${back().label}`} onClick={() => back().onSelect()}>
            <Icon name="chevronLeft" size={18} />
          </button>
        }
      >
        <For each={props.trail}>
          {(crumb) => (
            <>
              <button type="button" class="crumb" title={`Back to ${crumb.label}`} onClick={() => crumb.onSelect()}>
                <span class="crumb-label">{crumb.label}</span>
              </button>
              <span class="crumb-separator" aria-hidden="true">
                <Icon name="chevronRight" size={14} />
              </span>
            </>
          )}
        </For>
      </Show>
      <span class="crumb-current" aria-current="page">
        {props.current}
      </span>
      <Show when={props.note && app.compact()}>
        <span class="crumb-note">{props.note}</span>
      </Show>
    </nav>
    </Show>
    </>
  );
}

/**
 * A model's crumbs: the model, and while a shape is edited in place, its layer and the shape
 * itself, the crumbs before it leading back out.
 */
function modelCrumbs(editor: Editor, trail: { label: string; onSelect: () => void }[]) {
  const editing = editor.editingShape;
  const step = editing && editor.selectedStep;
  if (!editing || !step) return { trail, current: editor.name, note: undefined };
  const out = () => editor.stopEditingShape();
  return {
    trail: [...trail, { label: editor.name, onSelect: out }, { label: editor.layer(editing.layerId)?.name ?? "Layer", onSelect: out }],
    current: stepName(step.step),
    note: "editing",
  };
}

/** A new scene with a new, empty model in it, opened on that model, as one undo step. */
function startScene(library: LibraryEditor) {
  const started = library.startScene();
  if (!started) return;
  library.openScene(started.scene);
  library.openModel(started.instance);
}

/** The first crumb: the library itself. */
const libraryCrumb = (library: LibraryEditor) => ({ label: "Library", onSelect: () => library.openLibrary() });

/** The library's own menu entries, at the top of every main menu: its file, and bringing files in. */
function libraryItems(actions: SceneActions): MenuItem[] {
  return [
    { label: actions.newLibrary.label, onSelect: actions.newLibrary.run },
    { label: actions.open.label, kbd: actions.open.kbd, onSelect: actions.open.run },
    { label: actions.save.label, kbd: actions.save.kbd, onSelect: actions.save.run },
    { label: actions.importFile.label, onSelect: actions.importFile.run },
  ];
}

function themeItem(app: LibraryApp): MenuItem {
  return {
    label: "Theme",
    detail: app.theme()[0].toUpperCase() + app.theme().slice(1),
    items: () =>
      (["system", "light", "dark"] as const).map((t) => ({
        label: t[0].toUpperCase() + t.slice(1),
        checked: app.theme() === t,
        onSelect: () => app.setTheme(t),
      })),
  };
}

/** The library itself: its models and scenes, to open, add and arrange. */
function LibraryCanvas() {
  const app = useLibrary();
  const { library, actions, host, dialog, setDialog } = app;
  onMount(() => {
    app.attach(undefined, undefined);
    const onKey = (e: KeyboardEvent) => {
      if (dialog()) {
        if (e.key === "Escape") setDialog(null);
        return;
      }
      handleShortcut(actions as unknown as Actions, e);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });
  const builtIn = (): MenuItem[] => [...libraryItems(actions), "separator", themeItem(app), { label: actions.shortcuts.label, kbd: actions.shortcuts.kbd, onSelect: actions.shortcuts.run }];
  const items = () => (host.menu ? host.menu(builtIn(), app) : builtIn());
  return (
    <div class="app library-app">
      <div class="ui" data-compact={app.compact() ? "" : undefined}>
        <div class="area top-left">
          <div class="panel bar">
            <Menu icon="menu" label="Menu" items={items} />
            <IconButton icon="undo" label="Undo" kbd={actions.undo.kbd} disabled={!library.canUndo} onClick={actions.undo.run} />
            <IconButton icon="redo" label="Redo" kbd={actions.redo.kbd} disabled={!library.canRedo} onClick={actions.redo.run} />
            <Show when={host.mainBar}>{(component) => <Dynamic component={component()} />}</Show>
          </div>
          <LibraryPanel />
        </div>
      </div>
      <SceneToast />
      <Show when={dialog() === "shortcuts"}>
        <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setDialog(null)}>
          <SceneShortcuts />
        </div>
      </Show>
    </div>
  );
}

/** The library's models and scenes. A tap opens one; each row's menu does the rest. */
function LibraryPanel() {
  const { library, actions } = useLibrary();
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const addItems = (): MenuItem[] => [
    { label: "New model", onSelect: () => { const id = library.newModel(); if (id) library.openModelAlone(id); } },
    { label: "New scene", onSelect: () => startScene(library) },
    { label: actions.importFile.label, onSelect: actions.importFile.run },
  ];
  const primaryItem = (id: string): MenuItem =>
    library.primary === id
      ? { label: "Primary", checked: true, onSelect: () => library.setPrimary(null) }
      : { label: "Make primary", onSelect: () => library.setPrimary(id) };
  const modelItems = (id: string): MenuItem[] => {
    const uses = library.scenesUsing(id);
    return [
      { label: "Open", onSelect: () => library.openModelAlone(id) },
      { label: "New scene with this model", onSelect: () => { const s = library.newScene(`${library.modelName(id)} scene`, [id]); if (s) library.openScene(s); } },
      "separator",
      { label: "Rename", onSelect: () => setRenaming(id) },
      { label: "Duplicate", onSelect: () => library.duplicateModel(id) },
      primaryItem(id),
      { label: "Export as .moxel…", onSelect: () => void exportModel(library, id).catch((e: Error) => library.notify(e.message)) },
      "separator",
      {
        label: "Delete",
        danger: true,
        detail: uses.length ? `in ${uses.length} scene${uses.length > 1 ? "s" : ""}` : undefined,
        onSelect: () => {
          if (uses.length && !confirm(`${library.modelName(id)} is placed in ${uses.map((s) => s.name).join(", ")}. Delete it there too?`)) return;
          library.deleteModel(id);
        },
      },
    ];
  };
  const sceneItems = (id: string): MenuItem[] => [
    { label: "Open", onSelect: () => library.openScene(id) },
    "separator",
    { label: "Rename", onSelect: () => setRenaming(id) },
    { label: "Duplicate", onSelect: () => library.duplicateScene(id) },
    primaryItem(id),
    "separator",
    { label: "Delete", danger: true, onSelect: () => library.deleteScene(id) },
  ];
  /**
   * The scene a model belongs to: the one scene that uses it, unless it is the primary. Such a
   * model (a rig's part) is listed under its scene rather than with the library's models.
   */
  const owners = createMemo(() => {
    library.version;
    const out = new Map<string, string>();
    for (const m of library.models) {
      if (library.primary === m.id) continue;
      const uses = library.scenesUsing(m.id);
      if (uses.length === 1) out.set(m.id, uses[0].id);
    }
    return out;
  });
  const modelRow = (id: string, child = false) => (
    <Row
      id={id}
      name={library.modelName(id)}
      child={child}
      items={() => modelItems(id)}
      open={() => library.openModelAlone(id)}
      rename={(name) => library.renameModel(id, name)}
    />
  );
  const Row = (props: { id: string; name: string; scene?: boolean; child?: boolean; items: () => MenuItem[]; open: () => void; rename: (name: string) => void }) => {
    let openMenu: (() => void) | undefined;
    return (
      <TreeRow
        class="library-row"
        depth={props.child ? 1 : 0}
        guides={props.child ? [false] : []}
        attrs={{ "data-child": props.child ? "" : undefined }}
        onMenu={() => openWhenShown(openMenu)}
      >
        <Show
          when={renaming() === props.id}
          fallback={
            <button type="button" class="tree-main" onClick={() => props.open()} onDblClick={() => setRenaming(props.id)}>
              <span class="tree-tile">
                <Icon name={props.scene ? "parent" : "cube"} size={16} />
              </span>
              <span class="tree-name">{props.name}</span>
              <Show when={library.primary === props.id}>
                <span class="layer-tag">primary</span>
              </Show>
            </button>
          }
        >
          <span class="tree-main">
            <span class="tree-tile">
              <Icon name={props.scene ? "parent" : "cube"} size={16} />
            </span>
            <input
              class="tree-rename"
              value={props.name}
              ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setRenaming(null);
              }}
              onBlur={(e) => {
                const name = e.currentTarget.value.trim();
                setRenaming(null);
                if (name && name !== props.name) props.rename(name);
              }}
            />
          </span>
        </Show>
        <RowEnd menu={props.items} menuLabel={`${props.name} menu`} control={(f) => (openMenu = f)} />
      </TreeRow>
    );
  };
  return (
    <section class="panel layers-panel library-panel" aria-label="Library">
      <header class="panel-header">
        <span class="panel-title">{library.name}</span>
        <Menu icon="plus" label="Add" placement="bottom-end" items={addItems} />
      </header>
      <Show when={library.models.length || library.scenes.length} fallback={<p class="hint small outliner-empty">Start a model or a scene with +, or import a file.</p>}>
        <ul class="layer-list">
          <Show when={library.models.some((m) => !owners().has(m.id))}>
            <li class="library-heading">Models</li>
          </Show>
          <For each={library.models.filter((m) => !owners().has(m.id))}>{(m) => modelRow(m.id)}</For>
          <Show when={library.scenes.length}>
            <li class="library-heading">Scenes</li>
          </Show>
          <For each={library.scenes}>
            {(sc) => (
              <>
                <Row id={sc.id} name={sc.name} scene items={() => sceneItems(sc.id)} open={() => library.openScene(sc.id)} rename={(name) => library.renameScene(sc.id, name)} />
                <For each={library.models.filter((m) => owners().get(m.id) === sc.id)}>{(m) => modelRow(m.id, true)}</For>
              </>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

/**
 * A model of the library on its own: the model editor, with the breadcrumb back to the library
 * and the library's file entries at the top of its menu.
 */
function ModelAlone(props: { model: string }) {
  const app = useLibrary();
  const { library } = app;
  const editor = library.editor(props.model);
  const outer = app.host.editorHost?.(editor);
  const OuterBar = outer?.mainBar;
  const host: EditorHost = {
    ...outer,
    mainBar: () => (
      <>
        <Show when={OuterBar}>{(bar) => <Dynamic component={bar()} />}</Show>
        <Crumbs
          trail={modelCrumbs(editor, [libraryCrumb(library)]).trail}
          current={modelCrumbs(editor, [libraryCrumb(library)]).current}
          note={modelCrumbs(editor, []).note}
        />
      </>
    ),
    // the library's file, not the model's: New, Open and Save are the library's
    actions: (editorApp) => ({
      ...outer?.actions?.(editorApp),
      newDocument: { ...app.actions.newLibrary },
      open: { ...app.actions.open },
      save: { ...app.actions.save },
    }),
    menu: (items, editorApp) => {
      const mine: MenuItem[] = [
        // the headset edits this model: going elsewhere is the page's
        { label: "Back to library", needs: ["navigation"], onSelect: () => library.openLibrary() },
        "separator",
        ...items.slice(0, 3),
        command(app.actions.importFile),
        ...items.slice(3),
        "separator",
        { label: "New scene with this model", needs: ["navigation"], onSelect: () => { const s = library.newScene(`${editor.name} scene`, [props.model]); if (s) library.openScene(s); } },
        { label: "Export as .moxel…", needs: ["files"], onSelect: () => void exportModel(library, props.model).catch((e: Error) => library.notify(e.message)) },
      ];
      return outer?.menu ? outer.menu(mine, editorApp) : mine;
    },
  };
  return (
    <>
      <EditorView
        editor={editor}
        host={host}
        theme={app.theme()}
        onThemeChange={app.setTheme}
        ref={(editorApp) => app.host.onEditorView?.(editorApp, editor)}
        onViewport={(vp) => app.attach(vp, undefined, editor)}
      />
      <SceneToast />
    </>
  );
}

/** The scene on its own: instances on the ground, the outliner and the instance bar. */
function SceneCanvas() {
  const app = useLibrary();
  const { library: scene, compact, outlinerOpen, dialog, setDialog } = app;
  let canvas!: HTMLCanvasElement;
  onMount(() => {
    // the viewport draws an editor's model; with no model open it hides it and draws instances
    const placeholder = new Editor();
    placeholder.newDocument([1, 1, 1]);
    const vp = new Viewport(canvas, placeholder, app.viewportTheme);
    vp.setContentShown(false);
    const sl = new SceneLayer(vp, scene, app.viewportTheme, { onOpen: app.openInstance });
    app.attach(vp, sl);
    sl.fit();
    const stopLoad = scene.onLoad(() => sl.fit());

    const onKey = (e: KeyboardEvent) => {
      if (dialog()) {
        if (e.key === "Escape") setDialog(null);
        return;
      }
      handleShortcut(app.actions as unknown as Actions, e);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      stopLoad();
      app.attach(undefined, undefined);
      sl.dispose();
      vp.dispose();
    });
  });

  return (
    <div class="app scene-app">
      <canvas class="canvas" ref={canvas} />
      <div class="ui" data-compact={compact() ? "" : undefined}>
        <Show
          when={compact()}
          fallback={
            <div class="area top-left">
              <SceneMainBar />
              <Show when={outlinerOpen()}>
                <SceneTree />
              </Show>
            </div>
          }
        >
          <div class="area top-left">
            <SceneMainBar />
          </div>
          <div class="area sheet">
            <Show when={outlinerOpen()}>
              <SceneTree />
            </Show>
          </div>
        </Show>
        <div class="area bottom-left">
          <div class="panel bar">
            <IconButton icon="fit" label={app.actions.fit.label} kbd={app.actions.fit.kbd} onClick={app.actions.fit.run} />
          </div>
        </div>
        <div class="area bottom-center">
          <Show when={scene.selection.length > 0} fallback={<AddBar />}>
            <Inspector />
            <InstanceBar />
          </Show>
        </div>
      </div>
      <SceneToast />
      <Show when={dialog() === "shortcuts"}>
        <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setDialog(null)}>
          <SceneShortcuts />
        </div>
      </Show>
    </div>
  );
}

/**
 * A model's own editor, inside the scene (docs/workspace.md): the model being edited, entered
 * from the tree or with two taps, or a host's stage. The scene around it stays live, and the
 * Objects tool picks and moves its instances; the breadcrumb leads back out.
 */
function ModelInScene(props: { model: string; editing: boolean }) {
  const app = useLibrary();
  const { library: scene } = app;
  const editor = scene.editor(props.model);
  const [contextShown, setContextShown] = createSignal(true);
  let layer: SceneLayer | undefined;
  createEffect(() => {
    // read the signal first: with no layer yet, `layer?.setShown(...)` would skip it and never track it
    const shown = contextShown();
    layer?.setShown(shown);
  });

  /** Where you are, the scene then the model, and showing the scene around it (on phones, in the menu). */
  const ModelBar = () => {
    const { compact } = useApp();
    return (
      <>
        <Crumbs
          trail={props.editing ? modelCrumbs(editor, [libraryCrumb(scene), { label: scene.sceneName, onSelect: () => scene.closeModel() }]).trail : [libraryCrumb(scene)]}
          current={props.editing ? modelCrumbs(editor, []).current : scene.sceneName}
          note={props.editing ? modelCrumbs(editor, []).note : undefined}
        />
        <Show when={!compact()}>
          <IconButton
            icon={contextShown() ? "eye" : "eyeOff"}
            label={contextShown() ? "Hide the scene" : "Show the scene"}
            active={!contextShown()}
            onClick={() => setContextShown(!contextShown())}
          />
        </Show>
      </>
    );
  };
  /** The selection's instance bar, or with the Objects tool, the add bar. */
  const ObjectsBar = () => (
    <Show when={scene.selection.length > 0}>
      <Inspector />
      <InstanceBar />
    </Show>
  );

  // the app's additions for this model, merged under the scene's
  const outer = app.host.editorHost?.(editor);
  const OuterBar = outer?.mainBar;
  const host: EditorHost = {
    ...outer,
    mainBar: () => (
      <>
        <Show when={OuterBar}>{(bar) => <Dynamic component={bar()} />}</Show>
        <ModelBar />
      </>
    ),
    menu: (items, editorApp) => {
      const mine: MenuItem[] = [
        props.editing
          ? { label: `Back to ${scene.sceneName}`, needs: ["navigation"], onSelect: () => scene.closeModel() }
          : { label: "Back to library", needs: ["navigation"], onSelect: () => scene.openLibrary() },
        // the scene around the model shows in the page's viewport only
        { label: "Show the scene", needs: ["page"], checked: contextShown(), onSelect: () => setContextShown(!contextShown()) },
        "separator",
        ...items.slice(0, 3),
        command(app.actions.importFile),
        ...items.slice(3),
      ];
      return outer?.menu ? outer.menu(mine, editorApp) : mine;
    },
    components: { ...outer?.components, LayersPanel: SceneTree, ContextBar: ObjectsBar },
    // on the stage, the headset shows the scene's objects about it, and Move works them
    headset: (editorApp) => ({ ...outer?.headset?.(editorApp), ...(props.editing ? {} : { library: scene }) }),
    // the library's file, not the model's: New, Open and Save are the library's
    actions: (editorApp) => ({
      ...outer?.actions?.(editorApp),
      newDocument: { ...app.actions.newLibrary },
      open: { ...app.actions.open },
      save: { ...app.actions.save },
    }),
  };

  return (
    <>
      <EditorView
        editor={editor}
        host={host}
        theme={app.theme()}
        onThemeChange={app.setTheme}
        ref={(editorApp) => app.host.onEditorView?.(editorApp, editor)}
        onViewport={(vp) => {
          layer?.dispose();
          layer = undefined;
          if (vp) {
            layer = new SceneLayer(vp, scene, app.viewportTheme, {
              handlesOnly: true,
              // the view tool picks and drags instances; the model's tools go through them
              pickWhen: () => untrack(() => editor.tool) === "orbit",
              onOpen: app.openInstance,
            });
            layer.setShown(untrack(contextShown));
          }
          app.attach(vp, layer, editor);
        }}
      />
      <SceneToast />
    </>
  );
}

function SceneMainBar() {
  const app = useLibrary();
  const { library: scene, actions, host } = app;
  // the top level holds what is used often; the rest is a level down (submenus open in place)
  const builtIn = (): MenuItem[] => [
    { label: "Back to library", onSelect: () => scene.openLibrary() },
    "separator",
    ...libraryItems(actions),
    {
      label: "Export",
      items: () => [
        { label: actions.exportGlb.label, onSelect: actions.exportGlb.run },
        { label: actions.exportPng.label, onSelect: actions.exportPng.run },
      ],
    },
    "separator",
    { label: "Add", items: () => addItems(scene, actions, app.layer, host) },
    { label: actions.selectAll.label, kbd: actions.selectAll.kbd, onSelect: actions.selectAll.run },
    { label: "Show ground", checked: scene.ground.visible, onSelect: () => scene.setGround({ visible: !scene.ground.visible }) },
    "separator",
    themeItem(app),
    { label: actions.shortcuts.label, kbd: actions.shortcuts.kbd, onSelect: actions.shortcuts.run },
  ];
  const items = () => (host.menu ? host.menu(builtIn(), app) : builtIn());
  return (
    <div class="panel bar">
      <Menu icon="menu" label="Menu" items={items} />
      <IconButton icon="undo" label="Undo" kbd={actions.undo.kbd} disabled={!scene.canUndo} onClick={actions.undo.run} />
      <IconButton icon="redo" label="Redo" kbd={actions.redo.kbd} disabled={!scene.canRedo} onClick={actions.redo.run} />
      <div class="bar-divider" />
      <IconButton icon="layers" label="Scene tree" active={app.outlinerOpen()} onClick={() => app.setOutlinerOpen(!app.outlinerOpen())} />
      <Show when={host.mainBar}>{(component) => <Dynamic component={component()} />}</Show>
      <Crumbs trail={[libraryCrumb(scene)]} current={scene.sceneName} />
    </div>
  );
}

/** Where an instance is listed in the scene tree: under its kind's group, its kind, its model, or what it is. */
interface ObjectGroup {
  key: string;
  label: string;
  /** Kinds first, in the order the host gave them; then models, scenes and groups. */
  rank: number;
  roots: InstanceRecord[];
}

function groupFor(scene: LibraryEditor, inst: InstanceRecord): Omit<ObjectGroup, "roots"> {
  if (inst.kind) {
    const kinds = scene.kinds;
    const kind = scene.kind(inst.kind);
    if (kind?.group) return { key: `group:${kind.group}`, label: kind.group, rank: kinds.findIndex((k) => k.group === kind.group) };
    const at = kind ? kinds.indexOf(kind) : -1;
    return { key: `kind:${inst.kind}`, label: scene.kindInfo(inst.kind)?.label ?? inst.kind, rank: at >= 0 ? at : 999 };
  }
  if (inst.model) return { key: `model:${inst.model}`, label: scene.modelName(inst.model), rank: 1000 };
  if (inst.scene) return { key: "scenes", label: "Scenes", rank: 2000 };
  return { key: "groups", label: "Groups", rank: 3000 };
}

/** A group with this many or fewer is open until it is closed; larger ones start closed. */
const OPEN_GROUP_MAX = 3;
/** With more objects than this, the tree offers a filter. */
const FILTER_MIN = 8;

/**
 * The scene tree (docs/workspace.md), in two parts. Layers: the model being edited (or the
 * stage), when there is one. Objects: the scene's instances, filed by kind group, kind or model
 * under headers that open and close, each instance with what hangs from it nested beneath. Inside
 * a model's editor it takes the layers panel's place.
 */
function SceneTree() {
  const { library: scene, actions, layer, host } = useLibrary();
  // set when a model is being edited: the tree is inside its editor
  const editorApp = useContext(AppContext);
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => {
    const next = new Set(collapsed());
    if (!next.delete(id)) next.add(id);
    setCollapsed(next);
  };
  const [layersOpen, setLayersOpen] = createSignal(true);
  const [query, setQuery] = createSignal("");
  /** Groups opened or closed by hand; the rest follow OPEN_GROUP_MAX. */
  const [opened, setOpened] = createSignal<ReadonlyMap<string, boolean>>(new Map());
  const filtering = () => query().trim().length > 0;
  const groupOpen = (g: ObjectGroup) => filtering() || (opened().get(g.key) ?? g.roots.length <= OPEN_GROUP_MAX);
  const setGroupOpen = (key: string, open: boolean) => setOpened(new Map(opened()).set(key, open));

  const children = createMemo(() => {
    const list = scene.instances;
    const ids = new Set(list.map((i) => i.id));
    const map = new Map<string | null, InstanceRecord[]>();
    for (const inst of list) {
      const key = inst.parent && ids.has(inst.parent.instance) ? inst.parent.instance : null;
      map.set(key, [...(map.get(key) ?? []), inst]);
    }
    return map;
  });
  const groups = createMemo(() => {
    const map = children();
    const q = query().trim().toLowerCase();
    const matches = (inst: InstanceRecord, n = 0): boolean =>
      inst.name.toLowerCase().includes(q) || (n < 64 && (map.get(inst.id) ?? []).some((c) => matches(c, n + 1)));
    const out = new Map<string, ObjectGroup>();
    for (const inst of map.get(null) ?? []) {
      const g = groupFor(scene, inst);
      if (q && !g.label.toLowerCase().includes(q) && !matches(inst)) continue;
      const found = out.get(g.key);
      if (found) found.roots.push(inst);
      else out.set(g.key, { ...g, roots: [inst] });
    }
    const list = [...out.values()].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
    if (host.outlinerSort) for (const g of list) g.roots.sort(host.outlinerSort);
    return list;
  });
  type Row = { group: ObjectGroup; open: boolean } | { inst: InstanceRecord; depth: number };
  const rows = createMemo(() => {
    const map = children();
    const out: Row[] = [];
    const walk = (key: string, depth: number) => {
      for (const inst of map.get(key) ?? []) {
        out.push({ inst, depth });
        if (!collapsed().has(inst.id)) walk(inst.id, depth + 1);
      }
    };
    for (const group of groups()) {
      const open = groupOpen(group);
      out.push({ group, open });
      if (!open) continue;
      for (const inst of group.roots) {
        out.push({ inst, depth: 1 });
        if (!collapsed().has(inst.id)) walk(inst.id, 2);
      }
    }
    return out;
  });
  const entered = () => scene.open?.instance ?? null;
  const atScene = () => !scene.open && !scene.selection.length;

  // What is chosen in the scene shows in the tree: its group opens, what it hangs from expands,
  // and its row scrolls into view.
  let list: HTMLUListElement | undefined;
  createEffect(
    on(
      () => scene.selection,
      (selection) => {
        const id = selection[selection.length - 1];
        if (!id || !scene.instance(id)) return;
        let root = scene.instance(id)!;
        const holders: string[] = [];
        for (let n = 0; root.parent && scene.instance(root.parent.instance) && n < 10000; n++) {
          root = scene.instance(root.parent.instance)!;
          holders.push(root.id);
        }
        const shut = untrack(collapsed);
        if (holders.some((h) => shut.has(h))) setCollapsed(new Set([...shut].filter((h) => !holders.includes(h))));
        const key = groupFor(scene, root).key;
        const group = untrack(groups).find((g) => g.key === key);
        if (group && !untrack(() => groupOpen(group))) setGroupOpen(key, true);
        requestAnimationFrame(() => list?.querySelector(`[data-row="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" }));
      },
    ),
  );

  // Dragging a row: onto another to hang from it, near its top or bottom edge to go before or
  // after it (unless the host sorts the list), or onto the Objects header to hang from nothing. A
  // finger holds the row first, so a quick swipe still scrolls; the row menu's Hangs from is the
  // same without dragging.
  type Drop = { over: string | null; where: "into" | "before" | "after" };
  const [drag, setDrag] = createSignal<{ id: string; target: Drop | null } | null>(null);
  let press: { id: string; pointerId: number; x: number; y: number; touch: boolean; timer?: number } | null = null;
  let justDragged = false;
  const targetAt = (x: number, y: number): Drop | null => {
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-row]");
    if (!row) return null;
    if (row.dataset.row === "root") return { over: null, where: "into" };
    if (host.outlinerSort) return { over: row.dataset.row!, where: "into" };
    const rect = row.getBoundingClientRect();
    const f = (y - rect.top) / rect.height;
    return { over: row.dataset.row!, where: f < 0.25 ? "before" : f > 0.75 ? "after" : "into" };
  };
  const finish = () => {
    if (press?.timer) clearTimeout(press.timer);
    press = null;
    setDrag(null);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", finish);
  };
  const onMove = (e: PointerEvent) => {
    if (!press || e.pointerId !== press.pointerId) return;
    if (!drag()) {
      const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
      // a finger that moves before the hold is scrolling the list
      if (press.touch) return void (moved > 10 && finish());
      if (moved < 5) return;
      setDrag({ id: press.id, target: null });
    }
    setDrag({ id: press.id, target: targetAt(e.clientX, e.clientY) });
  };
  const onUp = (e: PointerEvent) => {
    if (!press || e.pointerId !== press.pointerId) return;
    const d = drag();
    if (d) {
      justDragged = true;
      setTimeout(() => (justDragged = false));
      if (d.target) drop(d.id, d.target);
    }
    finish();
  };
  const onPress = (e: PointerEvent, id: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, input")) return;
    finish();
    const touch = e.pointerType !== "mouse";
    press = { id, pointerId: e.pointerId, x: e.clientX, y: e.clientY, touch };
    if (touch) press.timer = window.setTimeout(() => press && setDrag({ id: press.id, target: null }), 350);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", finish);
  };
  onCleanup(finish);
  const drop = (id: string, target: Drop) => {
    if (target.over === id) return;
    if (target.over === null) return void scene.placeInTree(id, null);
    if (target.where === "into") return void scene.placeInTree(id, target.over);
    const over = scene.instance(target.over);
    const parent = over?.parent && scene.instance(over.parent.instance) ? over.parent.instance : null;
    if (target.where === "before") return void scene.placeInTree(id, parent, target.over);
    // after it: before whatever comes next beside it
    const siblings = scene.instances.filter((i) => (i.parent?.instance ?? null) === parent && i.id !== id);
    const next = siblings[siblings.findIndex((i) => i.id === target.over) + 1];
    scene.placeInTree(id, parent, next?.id ?? null);
  };
  const dropOn = (id: string | null) => {
    const t = drag()?.target;
    return t && t.over === id ? t.where : undefined;
  };
  // while a finger drags a row, the list mustn't scroll under it (touchmove must be cancellable)
  const holdScroll = (el: HTMLElement) => {
    const onTouch = (e: TouchEvent) => drag() && e.preventDefault();
    el.addEventListener("touchmove", onTouch, { passive: false });
    onCleanup(() => el.removeEventListener("touchmove", onTouch));
  };

  return (
    <section class="panel layers-panel scene-tree" aria-label="Scene" ref={holdScroll} data-dragging={drag() ? "" : undefined}>
      <header class="panel-header">
        <button
          type="button"
          class="scene-tree-root"
          data-active={atScene() ? "" : undefined}
          title={scene.open ? `Back to ${scene.sceneName}` : scene.sceneName}
          onClick={() => {
            scene.closeModel();
            scene.select([]);
          }}
        >
          <span class="panel-title">{scene.sceneName}</span>
        </button>
      </header>
      <Show when={editorApp}>
        {(app) => (
          <div class="tree-section tree-layers">
            <div class="tree-section-header">
              <SectionToggle open={layersOpen()} onToggle={() => setLayersOpen(!layersOpen())} label="Layers">
                <span class="layer-tag">{scene.open ? app().editor.name : "stage"}</span>
              </SectionToggle>
              <Menu icon="plus" label="New layer" placement="bottom-end" buttonClass="small" items={() => newLayerItems(app())} />
            </div>
            <Show when={layersOpen()}>
              <ul class="layer-list">
                <LayerRows />
              </ul>
            </Show>
          </div>
        )}
      </Show>
      <div class="tree-section tree-objects">
        <div class="tree-section-header" data-row="root" data-drop={dropOn(null)}>
          <span class="tree-section-title">
            Objects
            <Show when={scene.instances.length}>
              <span class="tree-count">{scene.instances.length}</span>
            </Show>
          </span>
          <Menu icon="plus" label="Add" placement="bottom-end" buttonClass="small" items={() => addItems(scene, actions, layer, host)} />
        </div>
        <Show when={scene.instances.length > FILTER_MIN || filtering()}>
          <div class="tree-filter">
            <input
              type="search"
              placeholder="Filter"
              aria-label="Filter objects"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Escape" && (setQuery(""), e.currentTarget.blur())}
            />
          </div>
        </Show>
        <ul class="layer-list" ref={list}>
          <For each={rows()}>
            {(row) =>
              "group" in row ? (
                <ObjectGroupRow group={row.group} open={row.open} onToggle={() => setGroupOpen(row.group.key, !row.open)} />
              ) : (
                <ObjectRow
                  inst={row.inst}
                  depth={row.depth}
                  drop={dropOn(row.inst.id)}
                  dragged={drag()?.id === row.inst.id}
                  onPress={(e) => onPress(e, row.inst.id)}
                  justDragged={() => justDragged}
                  hasChildren={!!children().get(row.inst.id)?.length}
                  collapsed={collapsed().has(row.inst.id)}
                  onToggle={() => toggle(row.inst.id)}
                />
              )
            }
          </For>
        </ul>
        <Show when={!rows().length}>
          <p class="hint small outliner-empty">
            {filtering() ? "Nothing matches." : entered() || scene.stage ? "No objects yet. Add one with +." : "Add a model to start the scene."}
          </p>
        </Show>
      </div>
    </section>
  );
}

/** A section's or group's title that opens and closes it. */
function SectionToggle(props: { open: boolean; onToggle: () => void; label: string; children?: JSX.Element }) {
  return (
    <button type="button" class="tree-section-title" aria-expanded={props.open} onClick={() => props.onToggle()}>
      <Icon name={props.open ? "chevronDown" : "chevronRight"} size={14} />
      {props.label}
      {props.children}
    </button>
  );
}

/** A group's header in Objects: open or close it, and show, hide or lock all it holds. */
function ObjectGroupRow(props: { group: ObjectGroup; open: boolean; onToggle: () => void }) {
  const { library: scene } = useLibrary();
  const roots = () => props.group.roots;
  const allShown = () => roots().every((i) => i.visible);
  const noneShown = () => roots().every((i) => !i.visible);
  const allLocked = () => roots().every((i) => i.locked);
  const anyLocked = () => roots().some((i) => i.locked);
  let openMenu: (() => void) | undefined;
  const showAll = (show: boolean) => {
    for (const i of roots()) if (i.visible !== show) scene.setVisible(i.id, show);
  };
  const lockAll = (lock: boolean) => {
    for (const i of roots()) if (i.locked !== lock) scene.setLocked(i.id, lock);
  };
  const items = (): MenuItem[] => [
    {
      label: `Select all ${props.group.label}`,
      onSelect: () => scene.select(roots().filter((i) => !scene.isLocked(i.id) && scene.isShown(i.id)).map((i) => i.id)),
    },
    "separator",
    { label: allShown() ? "Hide all" : "Show all", onSelect: () => showAll(!allShown()) },
    { label: allLocked() ? "Unlock all" : "Lock all", onSelect: () => lockAll(!allLocked()) },
  ];
  return (
    <TreeRow
      class="object-group-row"
      depth={0}
      guides={[]}
      hidden={noneShown()}
      fold={{ open: props.open, toggle: props.onToggle, label: props.open ? `Close ${props.group.label}` : `Open ${props.group.label}` }}
      onMenu={() => openWhenShown(openMenu)}
    >
      <button type="button" class="tree-main" aria-expanded={props.open} onClick={() => props.onToggle()}>
        <span class="tree-name">
          {props.group.label}
          <span class="tree-count">{roots().length}</span>
        </span>
      </button>
      <RowEnd
        visible={!noneShown()}
        setVisible={showAll}
        locked={anyLocked()}
        setLocked={lockAll}
        menu={items}
        menuLabel={`${props.group.label} menu`}
        control={(f) => (openMenu = f)}
      />
    </TreeRow>
  );
}

function ObjectRow(props: {
  inst: InstanceRecord;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  onToggle: () => void;
  /** Where a dragged row would land on this one. */
  drop?: "into" | "before" | "after";
  dragged: boolean;
  onPress: (e: PointerEvent) => void;
  /** Whether a drag just ended, so the click that follows it doesn't select. */
  justDragged: () => boolean;
}) {
  const app = useLibrary();
  const { library: scene, actions, host } = app;
  const [renaming, setRenaming] = createSignal(false);
  const selected = () => scene.selection.includes(props.inst.id);
  const entered = () => scene.open?.instance === props.inst.id;
  const group = () => scene.isGroup(props.inst.id);
  let openMenu: (() => void) | undefined;
  /** The marker of its parent's model it hangs from, if any. */
  const part = () => {
    const parent = props.inst.parent;
    const model = parent?.marker ? scene.modelFor(parent.instance) : null;
    return model ? scene.document(model).marker(parent!.marker!)?.name : undefined;
  };
  const select = (e: MouseEvent) => {
    if (props.justDragged() || scene.isLocked(props.inst.id) || !scene.isShown(props.inst.id)) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) scene.toggleSelected(props.inst.id);
    else scene.select([props.inst.id]);
  };
  const commit = (input: HTMLInputElement) => {
    const name = input.value.trim();
    setRenaming(false);
    if (name && name !== props.inst.name) scene.renameInstance(props.inst.id, name);
  };
  const items = (): MenuItem[] => instanceMenu(scene, actions, host, props.inst.id, () => setRenaming(true));
  return (
    <TreeRow
      class="object-row"
      depth={props.depth}
      guides={Array.from({ length: props.depth }, () => false)}
      selected={selected()}
      hidden={!scene.isShown(props.inst.id)}
      fold={
        props.hasChildren
          ? { open: !props.collapsed, toggle: props.onToggle, label: props.collapsed ? "Expand" : "Collapse" }
          : undefined
      }
      attrs={{
        "data-entered": entered() ? "" : undefined,
        "data-row": props.inst.id,
        "data-drop": props.drop,
        "data-dragged": props.dragged ? "" : undefined,
      }}
      holdForMenu={false}
      onMenu={() => openWhenShown(openMenu)}
      onPointerDown={(e) => props.onPress(e)}
      onClick={select}
      onDblClick={() => (editable(scene, props.inst.id) && !entered() ? app.openInstance(props.inst.id) : setRenaming(true))}
    >
      <Show
        when={renaming()}
        fallback={
          <span class="tree-main">
            <span class="tree-name">
              {props.inst.name}
              <Show when={part()}>{(p) => <span class="layer-parent">{p()}</span>}</Show>
            </span>
            <Show when={group()}>
              <span class="layer-tag">group</span>
            </Show>
            <Show when={entered()}>
              <span class="layer-tag">editing</span>
            </Show>
            <Show when={host.outlinerBadge?.(props.inst.id)}>{(badge) => <span class="outliner-badge">{badge()}</span>}</Show>
            <Show when={host.outlinerDetail?.(props.inst.id)}>{(detail) => <span class="outliner-detail">{detail()}</span>}</Show>
          </span>
        }
      >
        <span class="tree-main">
          <input
            class="tree-rename"
            value={props.inst.name}
            ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit(e.currentTarget);
              if (e.key === "Escape") setRenaming(false);
            }}
            onBlur={(e) => commit(e.currentTarget)}
          />
        </span>
      </Show>
      <RowEnd
        visible={props.inst.visible}
        setVisible={(v) => scene.setVisible(props.inst.id, v)}
        locked={!!props.inst.locked}
        setLocked={(v) => scene.setLocked(props.inst.id, v)}
        menu={items}
        menuLabel={`${props.inst.name} menu`}
        control={(f) => (openMenu = f)}
      />
    </TreeRow>
  );
}

/** What can be added: a model from a file, more of the models already in the scene, and the host's kinds. */
function addItems(scene: LibraryEditor, actions: SceneActions, layer: () => SceneLayer | undefined, host: LibraryHost): MenuItem[] {
  const items = builtInAddItems(scene, actions, layer);
  return host.addMenu ? host.addMenu(items) : items;
}

function builtInAddItems(scene: LibraryEditor, actions: SceneActions, layer: () => SceneLayer | undefined): MenuItem[] {
  const at = (width = 1) => ({ position: dropPoint(scene, layer(), width), align: true });
  // the library's models; those kinds build or link are theirs to place, not the add menu's
  const models = scene.models.filter((m) => !m.built);
  const kinds = scene.kinds;
  return [
    {
      label: "New model",
      onSelect: () => {
        const id = scene.newModel({ ...at(16) });
        if (id) scene.openModel(id);
      },
    },
    { label: actions.addFromFile.label, onSelect: actions.addFromFile.run },
    { label: "New group", onSelect: () => scene.addInstance(null, { ...at(), name: "Group" }) },
    ...(models.length
      ? ([{ heading: "From the library" }, ...models.map((m) => ({ label: scene.modelName(m.id), detail: scene.usage(m.id) ? `${scene.usage(m.id)}× here` : undefined, onSelect: () => scene.addInstance(m.id, at(scene.modelFootprint(m.id))) }))] as MenuItem[])
      : []),
    ...placeableScenes(scene).length
      ? ([
          { heading: "Scenes" },
          ...placeableScenes(scene).map((s) => ({ label: s.name, onSelect: () => scene.addInstance(null, { ...at(), scene: s.id }) })),
        ] as MenuItem[])
      : [],
    ...kindItems(kinds, (k) => scene.addInstance(null, { ...at(), kind: k.id })),
  ];
}

/** The library's scenes the open one can place whole: not itself, nor one that places it. */
function placeableScenes(scene: LibraryEditor): { id: string; name: string }[] {
  const open = scene.scene;
  if (!open) return [];
  return scene.scenes.filter((s) => !sceneReaches({ scenePlaces: (id) => scene.scenePlaces(id) }, s.id, open));
}

/** A host's kinds for the add menu: those without a group under Objects, and each group as a submenu. */
function kindItems(kinds: readonly InstanceKind[], add: (kind: InstanceKind) => void): MenuItem[] {
  if (!kinds.length) return [];
  const item = (k: InstanceKind): MenuItem => ({ label: k.label, onSelect: () => add(k) });
  const groups = new Map<string, InstanceKind[]>();
  for (const k of kinds) if (k.group) groups.set(k.group, [...(groups.get(k.group) ?? []), k]);
  return [
    { heading: "Objects" },
    ...[...groups].map(([label, list]): MenuItem => ({ label, detail: String(list.length), items: () => list.map(item) })),
    ...kinds.filter((k) => !k.group).map(item),
  ];
}

/** An instance's menu, in the outliner and the instance bar. */
function instanceMenu(scene: LibraryEditor, actions: SceneActions, host: LibraryHost, id: string, rename?: () => void): MenuItem[] {
  const items = builtInInstanceMenu(scene, actions, host, id, rename);
  return host.instanceMenu ? host.instanceMenu(id, items) : items;
}

function builtInInstanceMenu(scene: LibraryEditor, actions: SceneActions, host: LibraryHost, id: string, rename?: () => void): MenuItem[] {
  const inst = scene.instance(id);
  if (!inst) return [];
  const playback = playbackItems(scene, id);
  const parent = inst.parent ? scene.instance(inst.parent.instance) : undefined;
  return [
    ...(rename ? ([{ label: "Rename", onSelect: rename }] as MenuItem[]) : []),
    { label: "Duplicate", kbd: actions.duplicate.kbd, onSelect: () => scene.duplicateInstances([id], [scene.snapStep ?? 1, 0, 0]) },
    ...(editable(scene, id) ? ([{ label: "Edit model", onSelect: () => (host.openInstance ? host.openInstance(id) : void scene.openModel(id)) }] as MenuItem[]) : []),
    ...(inst.scene !== undefined ? ([{ label: "Open scene", onSelect: () => scene.openScene(inst.scene!) }] as MenuItem[]) : []),
    "separator",
    {
      label: "Group",
      onSelect: () => scene.groupInstances(scene.selection.includes(id) ? scene.selection : [id], "Group"),
    },
    ...(scene.isGroup(id) ? ([{ label: "Ungroup", onSelect: () => scene.ungroup(id) }] as MenuItem[]) : []),
    // what it hangs from: its parent in the tree (dragging its row there does the same)
    { label: "Hangs from", detail: parent?.name ?? "Nothing", items: () => attachItems(scene, id) },
    ...(playback.length ? ([{ label: "Playback", items: () => playbackItems(scene, id) }] as MenuItem[]) : []),
    ...(inst.model
      ? ([
          {
            label: "Model",
            detail: scene.modelName(inst.model),
            items: () => [
              { label: "Select all of this model", onSelect: () => scene.select(scene.instances.filter((i) => i.model === inst.model && !scene.isLocked(i.id) && scene.isShown(i.id)).map((i) => i.id)) },
              { label: actions.exportModel.label, onSelect: () => (scene.select([id]), actions.exportModel.run()) },
            ],
          },
        ] as MenuItem[])
      : []),
    "separator",
    { label: "Delete", danger: true, onSelect: () => scene.deleteInstances([id]) },
  ];
}

/**
 * Where an instance can hang from: nothing, or another instance (not one hanging from it). A
 * model's markers are attach points too: its row opens them, mounts first.
 */
function attachItems(scene: LibraryEditor, id: string): MenuItem[] {
  const inst = scene.instance(id);
  if (!inst) return [];
  const others = scene.instances.filter((i) => i.id !== id && !isDescendant(scene, i.id, id));
  return [
    { label: "Nothing", checked: !inst.parent, onSelect: () => scene.attach(id, null) },
    ...others.map((other): MenuItem => {
      const model = scene.modelFor(other.id);
      const markers = model ? [...scene.document(model).markers].sort((a, b) => Number(b.role === "mount") - Number(a.role === "mount")) : [];
      const here = inst.parent?.instance === other.id;
      const whole = { label: other.name, checked: here && !inst.parent?.marker, onSelect: () => scene.attach(id, { instance: other.id, marker: null }) };
      if (!markers.length) return whole;
      const at = here && inst.parent?.marker ? markers.find((m) => m.id === inst.parent!.marker)?.name : undefined;
      return {
        label: other.name,
        detail: here ? (at ?? "origin") : undefined,
        items: () => [
          { ...whole, label: "Its origin" },
          { heading: "A marker" },
          ...markers.map((m) => ({
            label: m.name,
            detail: m.role,
            checked: here && inst.parent?.marker === m.id,
            onSelect: () => scene.attach(id, { instance: other.id, marker: m.id }),
          })),
        ],
      };
    }),
  ];
}

/** How an instance of an animated model plays: loop (at a speed, from a frame), or hold one frame. */
function playbackItems(scene: LibraryEditor, id: string): MenuItem[] {
  const inst = scene.instance(id);
  const model = scene.modelFor(id);
  if (!inst || !model) return [];
  const doc = scene.document(model);
  const frames = doc.frames;
  if (frames.length < 2) return [];
  const p = inst.playback;
  const loop = p?.kind === "loop" ? p : null;
  const durations = frames.map((f) => f.duration);
  const msPerTick = 1000 / doc.fps;
  const frameMs = (i: number) => frameStart(durations, i) * msPerTick;
  const total = frameMs(frames.length);
  /** Which frame a loop starts on: its offset, in frames. */
  const startFrame = loop ? frames.findIndex((_, i) => (((loop.offset % total) + total) % total) < frameMs(i + 1)) : 0;
  const setLoop = (speed: number, start = startFrame) => scene.setPlayback(id, { kind: "loop", speed, offset: frameMs(start) });
  return [
    { label: "Show the frame being edited", checked: !p, onSelect: () => scene.setPlayback(id, null) },
    ...([[1, "Loop"], [0.5, "Loop at half speed"], [2, "Loop at double speed"], [-1, "Loop backwards"]] as const).map(([speed, label]) => ({
      label,
      checked: loop?.speed === speed,
      onSelect: () => setLoop(speed),
    })),
    ...(loop
      ? ([
          { label: "Start a frame later", detail: `from ${startFrame + 1}`, onSelect: () => setLoop(loop.speed, (startFrame + 1) % frames.length) },
          { label: "Start a frame earlier", onSelect: () => setLoop(loop.speed, (startFrame + frames.length - 1) % frames.length) },
        ] as MenuItem[])
      : []),
    ...frames.slice(0, 16).map((f, i) => ({
      label: `Hold frame ${i + 1}`,
      checked: p?.kind === "frame" && p.frame === f.id,
      onSelect: () => scene.setPlayback(id, { kind: "frame", frame: f.id }),
    })),
  ];
}

/** Whether an instance's model can be opened in place: it has one, and it isn't built from settings. */
function editable(scene: LibraryEditor, id: string) {
  const model = scene.modelFor(id);
  return !!model && !scene.model(model)?.built;
}

function isDescendant(scene: LibraryEditor, id: string, ancestor: string): boolean {
  for (let at = scene.instance(id)?.parent?.instance, n = 0; at && n < 10000; n++) {
    if (at === ancestor) return true;
    at = scene.instance(at)?.parent?.instance;
  }
  return false;
}

/** With nothing selected: add instances, and how placement snaps. */
function AddBar() {
  const { library: scene, actions, layer, host } = useLibrary();
  return (
    <div class="panel bar scene-add-bar" role="toolbar" aria-label="Scene">
      <Menu
        icon="plus"
        label="Add"
        placement="top-start"
        items={() => addItems(scene, actions, layer, host)}
        trigger={() => (
          <span class="scene-add-label">
            <Icon name="plus" /> Add
          </span>
        )}
      />
      <div class="bar-divider" />
      <SnapMenu />
    </div>
  );
}

function SnapMenu() {
  const { library: scene } = useLibrary();
  const steps: [number | null, string][] = [[1, "1"], [0.5, "½"], [0.25, "¼"], [0.125, "⅛"], [0.0625, "1⁄16"], [null, "Off"]];
  const angles: [number | null, string][] = [[90, "90°"], [45, "45°"], [15, "15°"], [null, "Free"]];
  const label = () => (scene.snap.step === null ? "Free" : `${steps.find(([s]) => s === scene.snap.step)?.[1] ?? scene.snap.step}`);
  return (
    <Menu
      icon="target"
      label="Snap"
      placement="top-end"
      trigger={() => <span class="scene-snap-label">Snap {label()}</span>}
      items={() => [
        { heading: scene.stage ? "Grid (stage voxels)" : "Grid (voxels)" },
        ...steps.map(([step, text]) => ({ label: text, checked: scene.snap.step === step, onSelect: () => scene.setSnap({ step }) })),
        { heading: "Rotation" },
        ...angles.map(([angle, text]) => ({ label: text, checked: scene.snap.angle === angle, onSelect: () => scene.setSnap({ angle }) })),
      ]}
    />
  );
}

type Mode = "move" | "turn" | "size";

/** The selection's placement: one axis at a time, in snap steps; and its menu. */
function InstanceBar() {
  const app = useLibrary();
  const { library: scene, actions } = app;
  const [mode, setMode] = createSignal<Mode>("move");
  const [axis, setAxis] = createSignal<0 | 1 | 2>(0);
  const first = () => scene.selection[0];
  const inst = () => (first() ? scene.instance(first()) : undefined);
  const count = () => scene.selection.length;
  /** Whether anything selected may turn: kinds can say they don't. */
  const turns = () => scene.selection.some((id) => scene.rotateRule(id) !== "none");
  createEffect(() => {
    if (mode() === "turn" && !turns()) setMode("move");
  });

  const value = () => {
    const i = inst();
    if (!i) return "";
    if (mode() === "size") return fmt(i.scale ?? 1);
    if (mode() === "turn") return `${fmt(rotationOf(scene, i.id, axis()))}°`;
    return fmt(i.position[axis()]);
  };
  const step = (sign: 1 | -1) => {
    const ids = untrack(() => scene.selection);
    if (mode() === "move") {
      const delta: Vec3 = [0, 0, 0];
      delta[axis()] = sign * (scene.snapStep ?? 1);
      scene.moveInstances(ids, delta);
    } else if (mode() === "turn") {
      const angle = scene.snap.angle ?? 15;
      scene.transact("Turn", () => {
        for (const id of ids) {
          // a kind may not turn, or only a quarter at a time
          const rule = scene.rotateRule(id);
          const p = scene.placement(id);
          if (!p || rule === "none") continue;
          const by = rule === "quarter" ? Math.max(90, Math.round(angle / 90) * 90) : angle;
          const rotation = [...p.rotation] as Vec3;
          rotation[axis()] += sign * by;
          scene.setTransform(id, { rotation }, "Turn");
        }
      });
    } else {
      scene.transact("Scale", () => {
        for (const id of ids) {
          const s = scene.instance(id)?.scale ?? 1;
          const next = Math.max(0.25, Math.round((s + sign * 0.25) * 100) / 100);
          scene.setTransform(id, { scale: next }, "Scale");
        }
      });
    }
  };

  return (
    <Show when={inst()}>
      {(i) => (
        <div class="panel bar instance-bar" role="toolbar" aria-label="Instance">
          <div class="instance-row">
          <span class="part-name">{count() > 1 ? `${count()} selected` : i().name}</span>
          <div class="segmented" role="radiogroup" aria-label="Change">
            <For each={([["move", "Move"], ["turn", "Turn"], ["size", "Size"]] as [Mode, string][]).filter(([m]) => m !== "turn" || turns())}>
              {([m, label]) => (
                <button type="button" role="radio" aria-checked={mode() === m} data-active={mode() === m ? "" : undefined} onClick={() => setMode(m)}>
                  {label}
                </button>
              )}
            </For>
          </div>
          <Show when={mode() !== "size"}>
            <div class="segmented" role="radiogroup" aria-label="Axis">
              <For each={[0, 1, 2] as const}>
                {(a) => (
                  <button type="button" role="radio" aria-checked={axis() === a} data-active={axis() === a ? "" : undefined} onClick={() => setAxis(a)}>
                    {"XYZ"[a]}
                  </button>
                )}
              </For>
            </div>
          </Show>
          </div>
          <div class="instance-row">
          <IconButton icon="minus" label="Less" onClick={() => step(-1)} />
          <span class="part-pivot instance-value">{value()}</span>
          <IconButton icon="plus" label="More" onClick={() => step(1)} />
          <div class="bar-divider" />
          <Menu icon="dots" label="Instance menu" placement="top-end" items={() => instanceMenu(scene, actions, app.host, i().id)} />
          <IconButton icon="check" label="Done" kbd={actions.deselect.kbd} class="primary" onClick={actions.deselect.run} />
          </div>
        </div>
      )}
    </Show>
  );
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

function SceneToast() {
  const { library: scene } = useLibrary();
  const [message, setMessage] = createSignal<string | null>(null);
  let timer: number | undefined;
  createEffect(
    on(
      () => scene.toast,
      (toast) => {
        if (!toast) return;
        setMessage(toast.message);
        clearTimeout(timer);
        timer = window.setTimeout(() => setMessage(null), 2400);
      },
      { defer: true },
    ),
  );
  onCleanup(() => clearTimeout(timer));
  return (
    <Show when={message()}>
      <div class="toast panel" role="status">
        {message()}
      </div>
    </Show>
  );
}

function SceneShortcuts() {
  const { actions, setDialog } = useLibrary();
  const k = (a: { kbd?: string }) => formatKbd(a.kbd!);
  const rows: [string, string][] = [
    ["Select / add to selection", "Click / Shift + click"],
    ["Go into an instance's model", "Double tap"],
    ["Select all / deselect", `${k(actions.selectAll)} / Esc`],
    ["Move selection", "Arrows · PgUp / PgDn"],
    ["Turn left / right", `${k(actions.turnLeft)} / ${k(actions.turnRight)}`],
    ["Duplicate", k(actions.duplicate)],
    ["Delete", `${k(actions.deleteSelection)} / ${k(actions.deleteSelectionAlt)}`],
    ["Zoom to fit", k(actions.fit)],
    ["Undo / redo", `${k(actions.undo)} / ${k(actions.redo)}`],
    ["Open / save", `${k(actions.open)} / ${k(actions.save)}`],
    ["Cancel a drag", "Second finger"],
    ["Orbit", "Right drag · drag empty space"],
    ["Pan", "Middle drag · Space + drag · two fingers"],
    ["Zoom", "Scroll · pinch"],
  ];
  return (
    <div class="panel dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <header class="dialog-header">
        <h2>Keyboard shortcuts</h2>
        <IconButton icon="close" label="Close" class="small" onClick={() => setDialog(null)} />
      </header>
      <div class="dialog-body">
        <table class="shortcuts">
          <tbody>
            <For each={rows}>
              {([label, keys]) => (
                <tr>
                  <td>{label}</td>
                  <td>
                    <kbd>{keys}</kbd>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </div>
  );
}
