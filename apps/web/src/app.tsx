import { createEffect, createSignal, on, onCleanup, onMount, Show, type Component } from "solid-js";
import { VoxelClipboard } from "@voxeltoy/core/clipboard";
import { LibraryEditor } from "@voxeltoy/core/library";
import type { SceneLayer } from "@voxeltoy/three/scene-layer";
import {
  dropPoint,
  importFile,
  LibraryView,
  mayReplaceLibrary,
  openLibraryFile,
  type EditorHost,
  type LibraryHost,
  type ThemePreference,
} from "@voxeltoy/sdk";
import { InstallDialog } from "./install-dialog";
import { loadLibraryDraft, saveLibraryDraft } from "./library-store";
import { installApp, installed, refreshApp, updateAvailable } from "./pwa";
import { readLocal, writeLocal } from "./storage";
import { registerSceneWebMcp, registerWebMcp } from "./webmcp";

const THEME_KEY = "voxeltoy:theme";
const LEGACY_THEME_KEY = "moxel:theme";

/**
 * The Voxeltoy website: one library on this device (docs/library.md), opened on start and saved as
 * it changes. Sharing and live rooms are about one model and stay off while libraries land.
 */
const App: Component = () => {
  const library = new LibraryEditor(undefined, { editorOptions: { clipboard: new VoxelClipboard() } });
  // handy for poking at the API from devtools: library.newScene(), library.editor(id).setVoxel(...)
  (window as unknown as { library: LibraryEditor }).library = library;
  const [ready, setReady] = createSignal(false);
  const [sceneLayer, setSceneLayer] = createSignal<SceneLayer>();

  /** A new library with one empty model, open, as its primary. */
  const startFresh = () => library.newLibrary();
  // the library on this device, or a first model to start with
  void loadLibraryDraft().then((draft) => {
    try {
      if (draft) library.loadLibrary(draft);
      else startFresh();
    } catch (e) {
      startFresh();
      library.notify(`Couldn't open the library saved on this device: ${(e as Error).message}`);
    }
    setReady(true);
  });

  // saved on this device as it changes
  let saveTimer: number | undefined;
  createEffect(
    on(
      () => library.version,
      () => {
        if (!ready()) return;
        clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => {
          void saveLibraryDraft(library).then((ok) => ok || library.notify("Couldn't save the library on this device; save it as a file to keep it"));
        }, 600);
      },
      { defer: true },
    ),
  );

  /** What every model's editor gets from the app: installing the app. */
  const editorHost: EditorHost = {
    actions: (a) => ({
      install: {
        label: "Install app",
        run: () => {
          installApp(() => a.setDialog("install")).catch((e: Error) => library.notify(e.message));
        },
      },
    }),
    menu: (items, a) => (installed() ? items : [...items, { label: a.actions.install.label, needs: ["page"], onSelect: a.actions.install.run }]),
    dialogs: { install: InstallDialog },
  };

  const host: LibraryHost = {
    editorHost: () => editorHost,
  };

  onMount(() => {
    const onDragOver = (e: DragEvent) => e.preventDefault();
    // a file dropped in: into the open scene, placed; anywhere else, opened as the library
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      const done = library.scene
        ? importFile(library, file, { position: dropPoint(library, sceneLayer(), 8) })
        : mayReplaceLibrary(library, `Open ${file.name}`)
          ? openLibraryFile(library, file)
          : Promise.resolve();
      Promise.resolve(done).catch((err: Error) => library.notify(err.message));
    };
    const onUnload = () => void saveLibraryDraft(library);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    window.addEventListener("pagehide", onUnload);
    onCleanup(() => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("pagehide", onUnload);
    });
  });

  let unregisterTools = () => {};
  onCleanup(() => unregisterTools());
  const theme = (readLocal(THEME_KEY, LEGACY_THEME_KEY) as ThemePreference | null) ?? "system";

  return (
    <>
      <Show when={updateAvailable()}>
        <div class="update-notice" role="status">
          <span>New version available</span>
          <button
            type="button"
            onClick={() => {
              void saveLibraryDraft(library).then((ok) => {
                if (!ok) return library.notify("Save your library as a file before refreshing to keep your work");
                refreshApp().catch((error: Error) => library.notify(error.message));
              });
            }}
          >
            Refresh
          </button>
        </div>
      </Show>
      <Show when={ready()}>
        <LibraryView
          library={library}
          host={host}
          theme={theme}
          onThemeChange={(t) => writeLocal(THEME_KEY, t)}
          onViewport={(vp, layer, model) => {
            setSceneLayer(layer);
            // handy from devtools too, like window.library
            (window as unknown as { sceneLayer?: SceneLayer }).sceneLayer = layer;
            unregisterTools();
            // the library's tools always; the open model's when one is; a view to point when there is one
            const view = vp ? { fit: () => vp.fit(), setView: (v: Parameters<typeof vp.setView>[0]) => vp.setView(v) } : { fit: () => {}, setView: () => {} };
            const off = [registerSceneWebMcp(library, view), ...(model ? [registerWebMcp(model, view)] : [])];
            unregisterTools = () => off.forEach((f) => f());
          }}
        />
      </Show>
    </>
  );
};

export default App;
