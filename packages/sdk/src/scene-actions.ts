import { untrack, type Accessor, type Setter } from "solid-js";
import type { LibraryEditor } from "@voxeltoy/core/library";
import { eulerFromQuat } from "@voxeltoy/core/scene-math";
import type { Vec3 } from "@voxeltoy/core/types";
import type { SceneLayer } from "@voxeltoy/three/scene-layer";
import { nameActions, type Action } from "./actions";
import { exportSceneGlb } from "@voxeltoy/three/scene-export";
import { pickFile, saveFile } from "./files";
import { exportModel, IMPORT_ACCEPT, importFile, LIBRARY_ACCEPT, openLibraryFile, saveLibrary } from "./library-files";

/**
 * Where a new instance goes: on the ground under the middle of the view, snapped, and moved
 * along X past anything already standing there, so it doesn't land inside another instance.
 */
export function dropPoint(scene: LibraryEditor, layer: SceneLayer | undefined, width = 1): Vec3 {
  const target = layer?.viewport.orbit.target;
  const at = scene.snapPosition(target ? [target.x, 0, target.z] : [0, 0, 0]);
  const half = width / 2;
  const gap = untrack(() => scene.snapStep) ?? 1;
  for (let n = 0; n < 64; n++) {
    const blocking = untrack(() => scene.instances).map((i) => scene.worldBox(i.id)).find((b) =>
      b && at[0] + half > b.min[0] && at[0] - half < b.max[0] && at[2] + half > b.min[2] && at[2] - half < b.max[2]);
    if (!blocking) break;
    at[0] = scene.snapPosition([blocking.max[0] + half + gap, 0, 0])[0];
  }
  return at;
}

/** Whether replacing the library loses nothing, or the person says it may. */
export function mayReplaceLibrary(library: LibraryEditor, verb: string): boolean {
  const empty = !untrack(() => library.models.length) && !untrack(() => library.scenes.length);
  return empty || confirm(`${verb}? The library on this device will be replaced; save it first to keep it.`);
}

/** The library view's commands: the library's files, and the open scene's. Menus, buttons and shortcuts all use these. */
export function createSceneActions(
  scene: LibraryEditor,
  layer: Accessor<SceneLayer | undefined>,
  setDialog: Setter<string | null>,
) {
  const selection = () => untrack(() => scene.selection);
  const has = () => selection().length > 0;
  const guard = (fn: () => Promise<unknown>) => () => {
    fn().catch((e: Error) => scene.notify(e.message));
  };
  /** Turn the selection a step about the vertical axis. */
  const turn = (sign: 1 | -1) => () => {
    const angle = untrack(() => scene.snap.angle) ?? 90;
    scene.transact("Turn", () => {
      for (const id of selection()) {
        // a kind may not turn, or only a quarter at a time
        const rule = scene.rotateRule(id);
        const p = scene.placement(id);
        if (!p || rule === "none") continue;
        const step = rule === "quarter" ? Math.max(90, Math.round(angle / 90) * 90) : angle;
        const rotation = [...p.rotation] as Vec3;
        rotation[1] += sign * step;
        scene.setTransform(id, { rotation }, "Turn");
      }
    });
  };
  /** Move the selection a step along an axis. */
  const nudge = (axis: 0 | 1 | 2, sign: 1 | -1) => () => {
    const delta: Vec3 = [0, 0, 0];
    delta[axis] = sign * (untrack(() => scene.snapStep) ?? 1);
    scene.moveInstances(selection(), delta);
  };

  const actions = {
    undo: { label: "Undo", icon: "undo", kbd: "mod+z", enabled: () => scene.canUndo, run: () => scene.undo() },
    redo: { label: "Redo", icon: "redo", kbd: "mod+shift+z", enabled: () => scene.canRedo, run: () => scene.redo() },
    redoAlt: { label: "Redo", kbd: "mod+y", run: () => scene.redo() },
    newLibrary: {
      label: "New library",
      needs: ["dialog"],
      run: () => {
        if (mayReplaceLibrary(scene, "Start a new library")) scene.newLibrary();
      },
    },
    open: {
      label: "Open…",
      needs: ["files"],
      kbd: "mod+o",
      run: guard(async () => {
        const file = await pickFile(LIBRARY_ACCEPT);
        if (file && mayReplaceLibrary(scene, `Open ${file.name}`)) {
          await openLibraryFile(scene, file);
          layer()?.fit();
        }
      }),
    },
    save: { label: "Save", kbd: "mod+s", needs: ["files"], run: guard(() => saveLibrary(scene)) },
    importFile: {
      label: "Import…",
      needs: ["files"],
      run: guard(async () => {
        const file = await pickFile(IMPORT_ACCEPT);
        if (file) await importFile(scene, file);
      }),
    },
    addFromFile: {
      label: "Model from file…",
      needs: ["files"],
      run: guard(async () => {
        const file = await pickFile(IMPORT_ACCEPT);
        if (!file) return;
        await importFile(scene, file, { position: dropPoint(scene, layer(), 8) });
      }),
    },
    duplicate: {
      label: "Duplicate",
      icon: "copy",
      kbd: "mod+d",
      when: has,
      run: () => scene.duplicateInstances(selection(), [untrack(() => scene.snapStep) ?? 1, 0, 0]),
    },
    deleteSelection: { label: "Delete", icon: "trash", kbd: "delete", when: has, run: () => scene.deleteInstances(selection()) },
    deleteSelectionAlt: { label: "Delete", kbd: "backspace", when: has, run: () => scene.deleteInstances(selection()) },
    deselect: { label: "Deselect", kbd: "escape", when: has, run: () => scene.clearSelection() },
    selectAll: {
      label: "Select all",
      kbd: "mod+a",
      run: () => scene.select(untrack(() => scene.instances).filter((i) => !scene.isLocked(i.id) && scene.isShown(i.id)).map((i) => i.id)),
    },
    fit: { label: "Zoom to fit", icon: "fit", kbd: "f", run: () => layer()?.fit() },
    turnLeft: { label: "Turn left", kbd: "r", when: has, run: turn(1) },
    turnRight: { label: "Turn right", kbd: "shift+r", when: has, run: turn(-1) },
    nudgeLeft: { label: "Move −X", kbd: "arrowleft", when: has, run: nudge(0, -1) },
    nudgeRight: { label: "Move +X", kbd: "arrowright", when: has, run: nudge(0, 1) },
    nudgeBack: { label: "Move −Z", kbd: "arrowup", when: has, run: nudge(2, -1) },
    nudgeForward: { label: "Move +Z", kbd: "arrowdown", when: has, run: nudge(2, 1) },
    nudgeUp: { label: "Move up", kbd: "pageup", when: has, run: nudge(1, 1) },
    nudgeDown: { label: "Move down", kbd: "pagedown", when: has, run: nudge(1, -1) },
    exportModel: {
      label: "Export model…",
      needs: ["files"],
      when: () => {
        const id = selection()[0];
        return !!id && !!untrack(() => scene.instance(id))?.model;
      },
      run: guard(async () => {
        const model = untrack(() => scene.instance(selection()[0])?.model);
        if (model) await exportModel(scene, model);
      }),
    },
    exportGlb: {
      label: "glTF scene (.glb)",
      needs: ["files"],
      run: guard(async () => {
        const sl = layer();
        const blob = await exportSceneGlb(scene, { frameOf: (id) => sl?.frameShowing(id) ?? scene.frameOf(id) ?? "" });
        await saveFile(blob, `${fileName(untrack(() => scene.sceneName))}.glb`, "glTF scene");
      }),
    },
    exportPng: {
      label: "Image (.png)",
      needs: ["files"],
      run: guard(async () => {
        const sl = layer();
        if (sl) await saveFile(await sl.capture(), `${fileName(untrack(() => scene.sceneName))}.png`, "PNG image");
      }),
    },
    shortcuts: { label: "Keyboard shortcuts", kbd: "?", needs: ["dialog", "keyboard"], run: () => setDialog("shortcuts") },
  } satisfies Record<string, Action>;
  return nameActions(actions);
}

const fileName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "Untitled scene";

export type SceneActions = ReturnType<typeof createSceneActions> & Record<string, Action>;

/** An instance's rotation in degrees along one axis, as the instance bar shows it. */
export function rotationOf(scene: LibraryEditor, id: string, axis: 0 | 1 | 2): number {
  const inst = scene.instance(id);
  return inst ? eulerFromQuat(inst.rotation)[axis] : 0;
}
