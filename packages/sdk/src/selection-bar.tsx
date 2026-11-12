import { Show } from "solid-js";
import { boxExtent } from "@voxeltoy/core/shapes";
import type { Action } from "./actions";
import { useApp } from "./context";
import { IconButton, Menu, type MenuItem } from "./primitives";

/**
 * Shown while something is selected: its size, and what can be done with it. While
 * content is floating, it offers apply and cancel instead.
 */
export function SelectionBar() {
  const { editor, actions } = useApp();

  const size = () => {
    const floating = editor.floating;
    if (floating) return floating.size;
    editor.selectionVersion;
    const bounds = editor.selectionBounds();
    return bounds ? boxExtent(bounds) : [0, 0, 0];
  };

  const item = (action: Action, disabled?: boolean): MenuItem => ({
    label: action.label,
    kbd: action.kbd,
    disabled,
    onSelect: action.run,
  });

  /** How far floating content has moved, e.g. "X +3  Z −2". */
  const moved = () =>
    (editor.floatingDelta ?? [0, 0, 0])
      .map((n, a) => (n ? `${"XYZ"[a]} ${n > 0 ? "+" : "−"}${Math.abs(n)}` : ""))
      .filter(Boolean)
      .join("  ");

  /** In 2D, turns, flips and moves in depth go by the screen; in 3D, by the axes. */
  const transformItems = (): MenuItem[] =>
    editor.mode2D
      ? [
          item(actions.rotateLeft),
          item(actions.rotateRight),
          "separator",
          item(actions.flipHorizontal),
          item(actions.flipVertical),
          "separator",
          item(actions.towardYou),
          item(actions.awayFromYou),
        ]
      : [
          item(actions.rotateSelectionY),
          item(actions.rotateSelectionYBack),
          item(actions.rotateSelectionX),
          item(actions.rotateSelectionZ),
          "separator",
          item(actions.flipSelectionX),
          item(actions.flipSelectionY),
          item(actions.flipSelectionZ),
        ];

  const moreItems = (): MenuItem[] => [
    item(actions.copy),
    item(actions.cut),
    item(actions.paste, !editor.canPaste),
    "separator",
    item(actions.fillSelection),
    item(actions.recolorSelection),
    ...(editor.activeLayerKind === "override" ? [item(actions.clearOverride)] : []),
    item(actions.copyToLayer),
    item(actions.moveToLayer),
    "separator",
    {
      label: "Select",
      items: () => [
        item(actions.selectAll),
        item(actions.invertSelection),
        item(actions.selectConnected),
        item(actions.growSelection),
        item(actions.shrinkSelection),
      ],
    },
  ];

  return (
    <Show
      when={!editor.pendingShape && !editor.operandEdit && !editor.pendingExtrusion && !editor.markerEditing && (editor.floating || editor.hasSelection)}
    >
      <div class="panel bar shape-bar" role="toolbar" aria-label="Selection">
        <span class="shape-size">{size().join(" × ")}</span>
        <Show when={moved()}>
          <span class="shape-size moved">{moved()}</span>
        </Show>
        <Menu icon="rotate" label="Rotate or flip" items={transformItems} placement="top-start" />
        <Show
          when={!editor.floating}
          fallback={
            <>
              <div class="bar-divider" />
              <IconButton icon="close" label={actions.cancelTransform.label} kbd="escape" onClick={actions.cancelTransform.run} />
              <IconButton
                icon="check"
                label={actions.applyTransform.label}
                kbd={actions.applyTransform.kbd}
                class="primary"
                onClick={actions.applyTransform.run}
              />
            </>
          }
        >
          <IconButton icon="copy" label={actions.duplicate.label} kbd={actions.duplicate.kbd} onClick={actions.duplicate.run} />
          <IconButton
            icon="trash"
            label={actions.deleteSelection.label}
            kbd={actions.deleteSelection.kbd}
            onClick={actions.deleteSelection.run}
          />
          <Menu icon="dots" label="Selection options" items={moreItems} placement="top-end" />
          <div class="bar-divider" />
          <IconButton icon="close" label={actions.deselect.label} kbd={actions.deselect.kbd} onClick={actions.deselect.run} />
        </Show>
      </div>
    </Show>
  );
}
