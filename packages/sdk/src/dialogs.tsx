import { createEffect, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { MAX_SIZE } from "@voxeltoy/core/editor";
import { BUILTIN_PALETTES } from "@voxeltoy/core/palette";
import type { Vec3 } from "@voxeltoy/core/types";
import { formatKbd } from "./actions";
import { type Anchor, AnchorPicker, anchorFractions, describeAnchor } from "./anchor-picker";
import { useApp } from "./context";
import { IconButton } from "./primitives";

export function Dialogs() {
  const app = useApp();
  return (
    <Show when={app.dialog()}>
      {(dialog) => (
        <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && app.setDialog(null)}>
          <Show when={app.host.dialogs?.[dialog()]} fallback={<BuiltInDialog name={dialog()} />}>
            {(component) => <Dynamic component={component()} />}
          </Show>
        </div>
      )}
    </Show>
  );
}

function BuiltInDialog(props: { name: string }) {
  return (
    <>
      <Show when={props.name === "new"}>
        <SizeDialog mode="new" />
      </Show>
      <Show when={props.name === "resize"}>
        <SizeDialog mode="resize" />
      </Show>
      <Show when={props.name === "shortcuts"}>
        <ShortcutsDialog />
      </Show>
    </>
  );
}

export function DialogFrame(props: { title: string; children: JSX.Element }) {
  const app = useApp();
  return (
    <div class="panel dialog" role="dialog" aria-modal="true" aria-label={props.title}>
      <header class="dialog-header">
        <h2>{props.title}</h2>
        <IconButton icon="close" label="Close" class="small" onClick={() => app.setDialog(null)} />
      </header>
      {props.children}
    </div>
  );
}

const PRESETS = [16, 32, 64, 128];

/** The resize anchor, remembered while the page is open: X and Z centered, on the floor. */
const [anchor, setAnchor] = createSignal<Anchor>([1, 0, 1]);

function SizeDialog(props: { mode: "new" | "resize" }) {
  const app = useApp();
  const { editor } = app;
  const [size, setSize] = createSignal<Vec3>([...editor.size]);
  const [palette, setPalette] = createSignal(0);
  let first!: HTMLInputElement;
  onMount(() => first?.focus());

  const setAxis = (axis: number, value: number) => {
    const next = [...size()] as Vec3;
    next[axis] = Math.max(1, Math.min(MAX_SIZE, Math.round(value) || 1));
    setSize(next);
  };

  const submit = (e: Event) => {
    e.preventDefault();
    if (props.mode === "new") {
      const proceed = app.host.beforeNewDocument
        ? app.host.beforeNewDocument()
        : (!editor.contentBounds() && !editor.isAnimated) || confirm("Start a new model? The current one will be replaced.");
      if (!proceed) return;
      editor.newDocument(size(), BUILTIN_PALETTES[palette()].colors);
    } else {
      editor.resize(size(), { anchor: anchorFractions(anchor()) });
    }
    app.setDialog(null);
    app.viewport()?.fit();
  };

  return (
    <DialogFrame title={props.mode === "new" ? "New model" : "Resize volume"}>
      <form class="dialog-body" onSubmit={submit}>
        <div class="field">
          <span class="field-label">Size</span>
          <div class="size-inputs">
            <For each={["X", "Y", "Z"]}>
              {(name, i) => (
                <label class="size-input">
                  <span data-axis={i()}>{name}</span>
                  <input
                    ref={i() === 0 ? first : undefined}
                    type="number"
                    inputmode="numeric"
                    min={1}
                    max={MAX_SIZE}
                    value={size()[i()]}
                    onChange={(e) => setAxis(i(), +e.currentTarget.value)}
                  />
                </label>
              )}
            </For>
          </div>
          <div class="chips">
            <For each={PRESETS}>
              {(n) => (
                <button
                  type="button"
                  class="chip"
                  data-active={size().every((s) => s === n) ? "" : undefined}
                  onClick={() => setSize([n, n, n])}
                >
                  {n}³
                </button>
              )}
            </For>
          </div>
        </div>
        <Show when={props.mode === "new"}>
          <div class="field">
            <span class="field-label">Palette</span>
            <div class="chips">
              <For each={BUILTIN_PALETTES}>
                {(p, i) => (
                  <button
                    type="button"
                    class="chip"
                    data-active={palette() === i() ? "" : undefined}
                    onClick={() => setPalette(i())}
                  >
                    {p.name}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>
        <Show when={props.mode === "resize"}>
          <div class="field">
            <span class="field-label">Anchor</span>
            <AnchorPicker value={anchor()} onChange={setAnchor} yaw={app.viewport()?.orbit.yaw ?? Math.PI / 4} />
            <p class="hint small">
              {describeAnchor(anchor())} Voxels outside the new size are removed.
            </p>
          </div>
        </Show>
        <footer class="dialog-footer">
          <button type="button" class="button" onClick={() => app.setDialog(null)}>
            Cancel
          </button>
          <button type="submit" class="button primary">
            {props.mode === "new" ? "Create" : "Resize"}
          </button>
        </footer>
      </form>
    </DialogFrame>
  );
}

function ShortcutsDialog() {
  const { actions, tools, shapes } = useApp();
  const rows: [string, string][] = [
    ...tools.filter((t) => t.kbd).map((t) => [t.label, formatKbd(t.kbd!)] as [string, string]),
    ["Voxel / Box / Face / Shape brush", "1 / 2 / 3 / 4"],
    ["Square shape base (flips Uniform)", "Shift + drag"],
    ["Apply / cancel shape", "Enter / Esc"],
    ["Finish a path", "Enter"],
    ["Rotate shape", formatKbd(actions.rotateShape.kbd)],
    ["Extrude deeper / shallower", "↑ / ↓"],
    ["Apply / cancel extrusion", "Enter / Esc"],
    ["Add to / subtract from selection", "Shift / Ctrl + select"],
    ["Select all / deselect", `${formatKbd(actions.selectAll.kbd)} / Esc`],
    ["Invert selection", formatKbd(actions.invertSelection.kbd)],
    ["Copy / cut / paste", [actions.copy, actions.cut, actions.paste].map((a) => formatKbd(a.kbd)).join(" / ")],
    ["Duplicate selection", formatKbd(actions.duplicate.kbd)],
    ["Delete selection", `${formatKbd(actions.deleteSelection.kbd)} / ${formatKbd(actions.deleteSelectionAlt.kbd)}`],
    ["Move selection", "Arrows · PgUp / PgDn"],
    ["Lock a move to one axis", "Shift + drag"],
    ["Rotate selection", `${formatKbd(actions.rotateSelectionY.kbd!)} / ${formatKbd(actions.rotateSelectionYBack.kbd!)}`],
    ["Apply / cancel move", "Enter / Esc"],
    ["Markers and origin", "Shift+M"],
    ["Put the layer in a new group", formatKbd(actions.groupLayer.kbd!)],
    ["Finish placing markers", "Enter / Esc"],
    ["Mirror X / Y / Z", "X / Y / Z"],
    ["Workplane", formatKbd(actions.toggleWorkplane.kbd)],
    ["2D view", formatKbd(actions.toggle2D.kbd)],
    ["Workplane down / up", "[ / ]"],
    ["Zoom to fit", formatKbd(actions.fit.kbd)],
    ["Toggle orthographic view", formatKbd(actions.toggleProjection.kbd)],
    ["Undo", formatKbd(actions.undo.kbd)],
    ["Redo", formatKbd(actions.redo.kbd)],
    ["Save", formatKbd(actions.save.kbd)],
    ["Open", formatKbd(actions.open.kbd)],
    ["New layer", formatKbd(actions.newLayer.kbd)],
    ["Timeline", formatKbd(actions.toggleTimeline.kbd)],
    ["Play / pause", formatKbd(actions.playPause.kbd)],
    ["Previous / next frame", `${formatKbd(actions.previousFrame.kbd)} / ${formatKbd(actions.nextFrame.kbd)}`],
    ["Duplicate frame", formatKbd(actions.duplicateFrame.kbd)],
    ["Onion skin", formatKbd(actions.toggleOnion.kbd)],
    ...(shapes()
      ? ([
          ["New vector layer", formatKbd(actions.newShapeLayer.kbd)],
          ["Vector layer: orbit / select", "H / M"],
          ["Vector layer: box / cylinder / sphere / cone / torus", "1 / 2 / 3 / 4 / 5"],
          ["Vector layer: pen / fill", "P / G"],
          ["Make the shape being drawn / cancel it", "Enter / Esc"],
        ] as [string, string][])
      : []),
    ["Pick color with any tool", "Alt + click"],
    ["Brush: add / erase", "Shift / Ctrl + drag"],
    ["Fill every voxel of a color", "Shift + click"],
    ["Orbit", "Right drag · drag empty space"],
    ["Pan", "Middle drag · Space + drag · two fingers"],
    ["Zoom", "Scroll · pinch"],
  ];
  return (
    <DialogFrame title="Keyboard shortcuts">
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
    </DialogFrame>
  );
}

export function Toast() {
  const { editor } = useApp();
  const [message, setMessage] = createSignal<string | null>(null);
  let timer: number | undefined;

  createEffect(
    on(
      () => editor.toast,
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
