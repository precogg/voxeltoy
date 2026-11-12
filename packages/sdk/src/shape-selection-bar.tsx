import { Show } from "solid-js";
import type { ShapeOptions } from "@voxeltoy/core/source";
import { formatKbd } from "./actions";
import { useApp } from "./context";
import { IconButton, Menu } from "./primitives";
import { shapeMenuItems, stepName } from "./properties";
import { shapeName } from "@voxeltoy/core/shapes";

/**
 * Over the toolbar while a shape is selected on a vector layer (and no shape tool is armed): the
 * shape's name and what can be done with it. Editing it in place, the bar says so, offers what
 * applies there (a path's Smooth and Closed, Delete point) and Done.
 */
export function ShapeSelectionBar() {
  const app = useApp();
  const { editor, actions, host, compact } = app;
  const selected = () => {
    if (host.viewOnly?.() || editor.activeLayerKind !== "shape") return null;
    if (editor.tool === "shape" || editor.tool === "pen" || editor.drawingPath || editor.pendingShape?.drawing) return null;
    const s = editor.selectedStep;
    return s && s.layerId === editor.activeLayerId ? s.step : null;
  };
  const title = (a: { label: string; kbd?: string }) => (a.kbd ? `${a.label} (${formatKbd(a.kbd)})` : a.label);
  return (
    <Show when={selected()}>
      {(step) => (
        <Show
          when={editor.editingShape}
          // on a phone, the Properties sheet's header has these
          fallback={!compact() &&
            <div class="panel bar shape-bar shape-selection-bar" role="toolbar" aria-label="Selected shape">
              <span class="bar-name" title={stepName(step())}>
                {stepName(step())}
              </span>
              <div class="bar-divider" />
              <button type="button" class="bar-chip" title={title(actions.editShape)} onClick={actions.editShape.run}>
                Edit
              </button>
              <button type="button" class="bar-chip" title={title(actions.duplicateShape)} onClick={actions.duplicateShape.run}>
                Duplicate
              </button>
              <button type="button" class="bar-chip" title={title(actions.deleteShape)} onClick={actions.deleteShape.run}>
                Delete
              </button>
              <Menu icon="dots" label="More for this shape" placement="top-end" items={() => shapeMenuItems(app, false)} />
            </div>
          }
        >
          <EditingBar />
        </Show>
      )}
    </Show>
  );
}

/** Editing a shape in place: "Editing Tube", a path's Smooth and Closed, Delete point, Done. */
function EditingBar() {
  const { editor, actions, compact } = useApp();
  const step = () => editor.selectedStep?.step ?? null;
  const path = () => step()?.shape.kind === "path";
  const set = (change: ShapeOptions) => {
    const s = editor.selectedStep;
    if (s) editor.setStepShape(s.layerId, s.step.id, change);
  };
  return (
    <Show when={step()}>
      {(s) => (
        <div class="panel bar shape-bar shape-selection-bar editing-bar" role="toolbar" aria-label="Editing a shape">
          <span class="bar-name">
            <span class="bar-muted">Editing </span>
            {shapeName(s().shape.kind, s().shape)}
          </span>
          <Show when={path()}>
            <div class="bar-divider" />
            <button
              type="button"
              class="toggle-chip bar-toggle"
              aria-pressed={!!s().shape.smooth}
              data-active={s().shape.smooth ? "" : undefined}
              title="A smooth curve through the points"
              onClick={() => set({ smooth: !s().shape.smooth })}
            >
              Smooth
            </button>
            <Show when={s().shape.profile !== "slab"}>
              <button
                type="button"
                class="toggle-chip bar-toggle"
                aria-pressed={!!s().shape.closed}
                data-active={s().shape.closed ? "" : undefined}
                title="Join the last point to the first"
                onClick={() => set({ closed: !s().shape.closed })}
              >
                Closed
              </button>
            </Show>
            <Show when={editor.selectedPathPoint !== null}>
              <Show
                when={!compact()}
                fallback={<IconButton icon="trash" label={actions.deletePoint.label} kbd={actions.deletePoint.kbd} onClick={actions.deletePoint.run} />}
              >
                <button type="button" class="bar-chip" title={`${actions.deletePoint.label} (${formatKbd(actions.deletePoint.kbd)})`} onClick={actions.deletePoint.run}>
                  Delete point
                </button>
              </Show>
            </Show>
          </Show>
          <div class="bar-divider" />
          <button type="button" class="bar-chip bar-done" title={`Done (${formatKbd(actions.doneEditing.kbd)})`} onClick={actions.doneEditing.run}>
            Done
          </button>
        </div>
      )}
    </Show>
  );
}
