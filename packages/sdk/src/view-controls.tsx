import { For, onCleanup, Show } from "solid-js";
import type { Axis } from "@voxeltoy/core/types";
import { formatKbd } from "./actions";
import { useApp } from "./context";
import { IconButton, Menu, type MenuItem } from "./primitives";

export function ViewControls() {
  const { editor, actions, viewport, workplaneOpen } = useApp();

  const views = (): MenuItem[] => [
    {
      label: actions.toggleProjection.label,
      kbd: actions.toggleProjection.kbd,
      checked: editor.projection === "orthographic",
      onSelect: actions.toggleProjection.run,
    },
    ...(editor.mode2D
      ? [{ label: actions.toggleDepthColors.label, checked: editor.depthColors, onSelect: actions.toggleDepthColors.run }]
      : []),
    ...(editor.workplane.clip !== "none"
      ? [{ label: actions.toggleShowClipped.label, checked: editor.showClipped, onSelect: actions.toggleShowClipped.run }]
      : []),
    "separator",
    ...(
      [
        ["iso", "Three-quarter"],
        ["front", "Front"],
        ["back", "Back"],
        ["left", "Left"],
        ["right", "Right"],
        ["top", "Top"],
        ["bottom", "Bottom"],
      ] as const
    ).map(([view, label]) => ({ label, onSelect: () => viewport()?.setView(view) })),
  ];

  const plane = () => editor.workplane;
  // across the middle while slicing; against the side otherwise, as the floor is
  const setAxis = (axis: Axis) =>
    editor.setWorkplane({ axis, level: plane().clip === "none" ? 0 : Math.floor(editor.size[axis] / 2) });

  return (
    <div class="view-controls">
      <Show when={workplaneOpen()}>
        <div class="panel workplane-panel" aria-label="Workplane">
          <div class="segmented" role="radiogroup" aria-label="Workplane axis">
            <For each={[0, 1, 2] as Axis[]}>
              {(axis) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={plane().axis === axis}
                  data-active={plane().axis === axis ? "" : undefined}
                  onClick={() => setAxis(axis)}
                >
                  {"XYZ"[axis]}
                </button>
              )}
            </For>
          </div>
          <div class="workplane-position">
            <IconButton
              icon="minus"
              label={actions.workplaneDown.label}
              kbd={actions.workplaneDown.kbd}
              onClick={actions.workplaneDown.run}
            />
            <input
              class="workplane-range"
              type="range"
              aria-label="Workplane level"
              min={0}
              max={editor.size[plane().axis] - 1}
              value={plane().level}
              onInput={(e) => editor.setWorkplane({ level: +e.currentTarget.value })}
            />
            <IconButton
              icon="plus"
              label={actions.workplaneUp.label}
              kbd={actions.workplaneUp.kbd}
              onClick={actions.workplaneUp.run}
            />
            <span class="workplane-level">{plane().level}</span>
            <IconButton
              icon="target"
              label={actions.pickWorkplane.label}
              active={editor.pickingWorkplane}
              onClick={actions.pickWorkplane.run}
            />
            <Menu
              icon="dots"
              label="More workplane options"
              placement="top-end"
              items={() => [
                { label: actions.faceWorkplane.label, onSelect: actions.faceWorkplane.run },
                { label: actions.resetWorkplane.label, onSelect: actions.resetWorkplane.run },
              ]}
            />
          </div>
          <div class="segmented workplane-clip" role="radiogroup" aria-label="Clip">
            <For each={[
              { mode: "none", symbol: "Off", action: actions.clipOff },
              { mode: "-", symbol: "−", action: actions.clipBelow },
              { mode: "+", symbol: "+", action: actions.clipAbove },
              { mode: "=", symbol: "=", action: actions.clipOnly },
            ] as const}>
              {({ mode, symbol, action }) => (
                <button
                  type="button"
                  role="radio"
                  aria-label={action.label}
                  title={action.label}
                  aria-checked={plane().clip === mode}
                  data-active={plane().clip === mode ? "" : undefined}
                  onClick={action.run}
                >
                  {symbol}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
      <Show when={editor.mode2D}>
        <Thumbnail />
      </Show>
      <div class="panel bar">
        <IconButton icon="fit" label="Zoom to fit" kbd={actions.fit.kbd} onClick={actions.fit.run} />
        <Menu icon="cube" label="Views" items={views} placement="top-start" />
        <IconButton
          icon="flat"
          label={actions.toggle2D.label}
          kbd={actions.toggle2D.kbd}
          active={!!editor.mode2D}
          onClick={actions.toggle2D.run}
        />
        <IconButton
          icon="slice"
          label={actions.toggleWorkplane.label}
          kbd={actions.toggleWorkplane.kbd}
          active={workplaneOpen()}
          onClick={actions.toggleWorkplane.run}
        />
      </div>
    </div>
  );
}

/** In 2D, a small 3D view of the model, drawn by the viewport behind this button. A tap goes back to 3D. */
function Thumbnail() {
  const { actions, viewport } = useApp();
  return (
    <button
      type="button"
      class="panel thumbnail"
      aria-label="Back to 3D"
      title={`Back to 3D (${formatKbd(actions.toggle2D.kbd!)})`}
      ref={(el) => {
        // the viewport may not exist yet on the first render
        queueMicrotask(() => viewport()?.setThumbnail(el));
        onCleanup(() => viewport()?.setThumbnail(null));
      }}
      onClick={actions.toggle2D.run}
    />
  );
}
