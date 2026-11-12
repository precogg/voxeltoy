import { createEffect, createSignal, For, on, Show, type Accessor, type JSX } from "solid-js";
import { toHex } from "@voxeltoy/core/color";
import type { Step, StepMode } from "@voxeltoy/core/source";
import { shapeIcon } from "./actions";
import { useApp } from "./context";
import { Icon, type IconName } from "./icons";
import { Menu, type MenuItem } from "./primitives";
import { stepName } from "./properties";
import { openWhenShown, TreeRow } from "./tree-row";

/** The badge on a shape's glyph for a mode other than Add. */
const MODE_BADGES: Record<Exclude<StepMode, "add">, { icon: IconName; label: string }> = {
  cut: { icon: "minus", label: "Cut" },
  intersect: { icon: "selectIntersect", label: "Intersect" },
  paint: { icon: "paint", label: "Paint" },
};

/**
 * A vector layer's shapes in the Layers panel, top first, a level under its row. Each shows its
 * kind's glyph in its own color (a cut's is plain), with a badge for Cut, Intersect or Paint. Tap
 * one to select it (its layer becomes active); drag its glyph to reorder it in the layer;
 * double-tap the glyph to edit it in place, the name (or ⋯ › Rename) to rename it.
 */
export function ShapeRows(props: { layerId: string; depth: number; guides: readonly boolean[]; selected: Accessor<string | null> }) {
  const { editor } = useApp();
  const steps = () => editor.shapeStack(props.layerId) ?? [];
  const shown = () => [...steps()].reverse();
  const selectedId = () => {
    const s = props.selected();
    return s?.startsWith("step:") && editor.selectedStep?.layerId === props.layerId ? s.slice(5) : null;
  };
  const hidden = () => !editor.layer(props.layerId)?.visible;
  const [renaming, setRenaming] = createSignal<string | null>(null);
  /** A row being dragged to a new place: which, and the gap it would land in (0 = above the top row). */
  const [dragging, setDragging] = createSignal<{ id: string; gap: number } | null>(null);
  const empty = () => ({ "--depth": props.depth }) as JSX.CSSProperties;

  /** The gap among this layer's shape rows nearest a pointer's height. */
  const gapAt = (y: number) => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(`.shape-row[data-layer="${CSS.escape(props.layerId)}"]`));
    let gap = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) {
        gap = i;
        break;
      }
    }
    return gap;
  };

  const select = (step: Step) => editor.selectStep(step.id, props.layerId);

  /** Drag a row by its icon to reorder; a tap selects it. */
  const grip = (step: Step) => {
    let start: { id: number; y: number } | null = null;
    return {
      onPointerDown: (e: PointerEvent) => {
        if (e.button !== 0) return;
        start = { id: e.pointerId, y: e.clientY };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      },
      onPointerMove: (e: PointerEvent) => {
        if (!start || e.pointerId !== start.id) return;
        if (!dragging() && Math.abs(e.clientY - start.y) < 6) return;
        setDragging({ id: step.id, gap: gapAt(e.clientY) });
      },
      onPointerUp: (e: PointerEvent) => {
        if (!start || e.pointerId !== start.id) return;
        start = null;
        const drag = dragging();
        setDragging(null);
        if (!drag) {
          select(step);
          return;
        }
        const from = shown().findIndex((s) => s.id === step.id);
        // the gap counts the row itself, which leaves its place
        const to = drag.gap > from ? drag.gap - 1 : drag.gap;
        if (to !== from) editor.moveStep(props.layerId, step.id, steps().length - 1 - to);
      },
      onPointerCancel: () => {
        start = null;
        setDragging(null);
      },
    };
  };

  const items = (step: Step): MenuItem[] => {
    const id = props.layerId;
    const index = steps().findIndex((s) => s.id === step.id);
    const count = steps().length;
    return [
      { label: step.shape.kind === "path" ? "Edit points" : "Edit shape", onSelect: () => editor.editShape(step.id, id) },
      "separator",
      { label: "Rename", onSelect: () => setRenaming(step.id) },
      { label: "Duplicate", onSelect: () => editor.duplicateStep(id, step.id) },
      "separator",
      { label: "Move up", disabled: index >= count - 1, onSelect: () => editor.moveStep(id, step.id, index + 1) },
      { label: "Move down", disabled: index <= 0, onSelect: () => editor.moveStep(id, step.id, index - 1) },
      "separator",
      { label: "Delete", danger: true, onSelect: () => editor.removeStep(id, step.id) },
    ];
  };

  return (
    <Show
      when={shown().length}
      fallback={
        <li class="shape-empty" style={empty()}>
          No shapes yet. Draw one with the tools below.
        </li>
      }
    >
      <For each={shown()}>
        {(step, i) => {
          const active = () => selectedId() === step.id;
          const drop = () => {
            const d = dragging();
            if (!d || d.id === step.id) return undefined;
            return d.gap === i() ? "before" : d.gap === i() + 1 && i() === shown().length - 1 ? "after" : undefined;
          };
          let row: HTMLLIElement | undefined;
          // selecting on the canvas brings the row into view
          createEffect(on(active, (a) => a && queueMicrotask(() => row?.scrollIntoView?.({ block: "nearest" }))));
          let openMenu: (() => void) | undefined;
          const color = () => (step.mode === "cut" ? undefined : toHex(editor.palette[step.material] ?? 0));
          const badge = () => (step.mode === "add" ? null : MODE_BADGES[step.mode as Exclude<StepMode, "add">]);
          const tile = (
            <span
              class="tree-tile shape-glyph"
              title="Drag to reorder; double-tap to edit"
              style={{ color: color() }}
              onDblClick={() => editor.editShape(step.id, props.layerId)}
              {...grip(step)}
            >
              <Icon name={shapeIcon(step.shape.kind, step.shape)} size={16} />
              <Show when={badge()}>
                {(b) => (
                  <span class="tree-badge" title={b().label}>
                    <Icon name={b().icon} size={10} />
                  </span>
                )}
              </Show>
            </span>
          );
          return (
            <TreeRow
              class="shape-row"
              depth={props.depth}
              guides={props.guides}
              selected={active()}
              hidden={hidden()}
              ref={(el) => (row = el)}
              onMenu={() => {
                select(step);
                openWhenShown(openMenu);
              }}
              attrs={{
                "data-layer": props.layerId,
                "data-mode": step.mode,
                "data-editing": active() && editor.editingShape ? "" : undefined,
                "data-drop": drop(),
                "data-lifted": dragging()?.id === step.id ? "" : undefined,
              }}
            >
              <Show
                when={renaming() === step.id}
                fallback={
                  <span class="tree-main">
                    {tile}
                    <button
                      type="button"
                      class="tree-name shape-select"
                      aria-current={active() ? "true" : undefined}
                      onClick={() => select(step)}
                      onDblClick={() => setRenaming(step.id)}
                    >
                      {stepName(step)}
                    </button>
                  </span>
                }
              >
                <span class="tree-main">
                  {tile}
                  <RenameInput step={step} done={() => setRenaming(null)} />
                </span>
              </Show>
              <span class="tree-end">
                <Menu icon="dots" label="Shape options" placement="bottom-end" class="tree-more" buttonClass="tree-inline" items={() => items(step)} control={(f) => (openMenu = f)} />
              </span>
            </TreeRow>
          );
        }}
      </For>
    </Show>
  );

  function RenameInput(props2: { step: Step; done: () => void }) {
    let cancelled = false;
    return (
      <input
        class="tree-rename"
        aria-label="Shape name"
        value={props2.step.name ?? ""}
        placeholder={stepName({ ...props2.step, name: undefined })}
        maxLength={64}
        ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            e.stopPropagation();
            cancelled = true;
            e.currentTarget.blur();
          }
        }}
        onBlur={(e) => {
          if (!cancelled) editor.setStepName(props.layerId, props2.step.id, e.currentTarget.value);
          props2.done();
        }}
      />
    );
  }
}
