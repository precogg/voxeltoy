import { createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { Icon } from "./icons";
import { Menu, type MenuItem } from "./primitives";

/** Groups and vector layers folded shut in the Layers panel, by id (UI state; open by default). */
const [folded, setFoldedSet] = createSignal<ReadonlySet<string>>(new Set());

export function isFolded(id: string) {
  return folded().has(id);
}

export function setFolded(id: string, fold: boolean) {
  if (folded().has(id) === fold) return;
  const next = new Set(folded());
  if (fold) next.add(id);
  else next.delete(id);
  setFoldedSet(next);
}

/** A group tapped in the Layers panel: the selected row while nothing else is picked (UI state; groups aren't selected in the editor). */
export const [pickedGroup, setPickedGroup] = createSignal<string | null>(null);

/**
 * One row of the Layers tree: guides for the levels above it, its indent, a chevron gutter (empty on
 * rows with nothing under them, so siblings line up), then the row's own content (its main button
 * and trailing slot). One row is selected; the rows holding it are marked with a bolder name.
 */
export function TreeRow(props: {
  depth: number;
  /** One per level above: whether that ancestor holds the selection (its guide is lit). */
  guides: readonly boolean[];
  selected?: boolean;
  holds?: boolean;
  hidden?: boolean;
  fold?: { open: boolean; toggle: () => void; label: string };
  class?: string;
  ref?: (el: HTMLLIElement) => void;
  attrs?: Record<string, string | undefined>;
  /** A held finger or a right-click: select the row and open its menu (a shortcut for its ⋯). */
  onMenu?: () => void;
  /** The row's own handlers, beside the long-press (a scene row's drag, select and enter). */
  onPointerDown?: (e: PointerEvent) => void;
  onClick?: (e: MouseEvent) => void;
  onDblClick?: (e: MouseEvent) => void;
  /** False when a held finger already means something else on this row (dragging it); right-click still opens the menu. */
  holdForMenu?: boolean;
  children: JSX.Element;
}) {
  /** Just held: its ⋯ shows for the menu to open by, selected or not. */
  const [held, setHeld] = createSignal(false);
  const press = longPress(() => {
    setHeld(true);
    props.onMenu?.();
    setTimeout(() => setHeld(false), 300);
  });
  return (
    <li
      onPointerDown={(e) => {
        if (props.onMenu && props.holdForMenu !== false) press.down(e);
        props.onPointerDown?.(e);
      }}
      onClick={(e) => props.onClick?.(e)}
      onDblClick={(e) => props.onDblClick?.(e)}
      data-held={held() ? "" : undefined}
      onPointerMove={press.move}
      onPointerUp={press.cancel}
      onPointerCancel={press.cancel}
      onContextMenu={press.contextMenu}
      class={`tree-row ${props.class ?? ""}`}
      ref={(el) => {
        el.addEventListener("click", press.swallow, true);
        props.ref?.(el);
      }}
      data-selected={props.selected ? "" : undefined}
      data-holds={props.holds ? "" : undefined}
      data-hidden={props.hidden ? "" : undefined}
      style={{ "--depth": props.depth } as JSX.CSSProperties}
      {...props.attrs}
    >
      <For each={props.guides}>
        {(lit, d) => <span class="tree-guide" data-lit={lit ? "" : undefined} style={{ "--d": d() } as JSX.CSSProperties} />}
      </For>
      <span class="tree-indent" />
      <Show when={props.fold} fallback={<span class="tree-chev" aria-hidden="true" />}>
        {(f) => (
          <button
            type="button"
            class="tree-chev"
            data-open={f().open ? "" : undefined}
            aria-expanded={f().open}
            aria-label={f().label}
            title={f().label}
            onClick={(e) => {
              e.stopPropagation();
              f().toggle();
            }}
          >
            <Icon name="chevronRight" size={12} />
          </button>
        )}
      </Show>
      {props.children}
    </li>
  );
}

/** How long a finger rests on a row before its menu opens, and how far it may drift. */
const HOLD_MS = 500;
const HOLD_SLOP = 8;

/**
 * A row's long-press (touch) and right-click (mouse): both open its menu. The click that ends a
 * long-press is swallowed, so it doesn't also act on the row; the browser's own contextmenu after
 * a hold is ignored when the hold already opened it.
 */
function longPress(fire: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start: { x: number; y: number; id: number } | null = null;
  let fired = -Infinity;
  const cancel = () => {
    clearTimeout(timer);
    start = null;
  };
  onCleanup(cancel);
  return {
    down: (e: PointerEvent) => {
      cancel();
      if (e.pointerType === "mouse") return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      timer = setTimeout(() => {
        start = null;
        fired = performance.now();
        fire();
      }, HOLD_MS);
    },
    move: (e: PointerEvent) => {
      if (start && e.pointerId === start.id && Math.hypot(e.clientX - start.x, e.clientY - start.y) > HOLD_SLOP) cancel();
    },
    cancel,
    swallow: (e: MouseEvent) => {
      if (performance.now() - fired < 700) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    contextMenu: (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest("input")) return;
      e.preventDefault();
      cancel();
      if (performance.now() - fired < 1000) return;
      fired = performance.now();
      fire();
    },
  };
}

/**
 * A row's trailing slot. At rest it shows only state worth knowing (hidden, locked), each a tap to
 * undo; the selected row adds ⋯ (a long-press or right-click on the row opens it too). With a mouse, hovering a row shows Hide, Lock and ⋯ too.
 * Everything here is also in ⋯, so touch never needs hover.
 */
export function RowEnd(props: {
  visible?: boolean;
  setVisible?: (v: boolean) => void;
  locked?: boolean;
  setLocked?: (v: boolean) => void;
  menu: () => MenuItem[];
  menuLabel: string;
  control?: (open: () => void) => void;
}) {
  return (
    <span class="tree-end" onClick={(e) => e.stopPropagation()}>
      <Show when={props.setVisible}>
        <button
          type="button"
          class="tree-inline"
          data-state={props.visible ? undefined : ""}
          aria-label={props.visible ? "Hide" : "Show"}
          title={props.visible ? "Hide" : "Show"}
          onClick={() => props.setVisible!(!props.visible)}
        >
          <Icon name={props.visible ? "eye" : "eyeOff"} size={16} />
        </button>
      </Show>
      <Show when={props.setLocked}>
        <button
          type="button"
          class="tree-inline"
          data-state={props.locked ? "" : undefined}
          aria-label={props.locked ? "Unlock" : "Lock"}
          title={props.locked ? "Unlock" : "Lock"}
          onClick={() => props.setLocked!(!props.locked)}
        >
          <Icon name={props.locked ? "lock" : "unlock"} size={16} />
        </button>
      </Show>
      <Menu
        icon="dots"
        label={props.menuLabel}
        items={props.menu}
        placement="bottom-end"
        class="tree-more"
        buttonClass="tree-inline"
        control={props.control}
      />
    </span>
  );
}

/** Open a row's menu once it is the selected row (its ⋯ shows only then, and the menu sits by it). */
export function openWhenShown(open: (() => void) | undefined) {
  requestAnimationFrame(() => open?.());
}
