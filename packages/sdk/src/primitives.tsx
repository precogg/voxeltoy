import type { MenuNeed } from "@voxeltoy/xr/menu";
import { createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { formatKbd } from "./actions";
import { Icon, type IconSource } from "./icons";

export function IconButton(props: {
  icon: IconSource;
  label: string;
  kbd?: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: (e: MouseEvent) => void;
  class?: string;
  children?: JSX.Element;
}) {
  return (
    <button
      type="button"
      class={`icon-button ${props.class ?? ""}`}
      data-active={props.active ? "" : undefined}
      disabled={props.disabled}
      aria-label={props.label}
      aria-pressed={props.active === undefined ? undefined : props.active}
      title={props.kbd ? `${props.label} (${formatKbd(props.kbd)})` : props.label}
      onClick={(e) => props.onClick?.(e)}
    >
      <Icon name={props.icon} />
      {props.children}
    </button>
  );
}

export type MenuItem =
  | {
      label: string;
      kbd?: string;
      /** Muted text at the end of the row, such as a frame range. */
      detail?: string;
      /** A color dot before the label. */
      swatch?: string;
      /** An icon before the label. */
      icon?: IconSource;
      onSelect: () => void;
      checked?: boolean;
      danger?: boolean;
      disabled?: boolean;
      /** Stands for the command (an action's id). */
      id?: string;
      /** What it needs of the view offering it: a view that can't do it (the headset can't open a file picker) leaves it out. */
      needs?: readonly MenuNeed[];
    }
  | {
      /** A submenu: choosing it shows these items in the menu's place, with a way back. */
      label: string;
      items: () => MenuItem[];
      detail?: string;
      disabled?: boolean;
      id?: string;
      needs?: readonly MenuNeed[];
    }
  | { heading: string }
  | "separator";

export type Placement = "bottom-start" | "bottom-end" | "top-start" | "top-end";

/**
 * A button that opens a list of actions. Closes on selection, outside press or Escape. A submenu
 * opens in the menu's place, with a row back at its top, so it works by tap as well as by mouse.
 */
export function Menu(props: {
  icon: IconSource;
  label: string;
  items: () => MenuItem[];
  placement?: Placement;
  class?: string;
  buttonClass?: string;
  /** Content for a text button in place of the icon button. */
  trigger?: () => JSX.Element;
  /** Hands over a function that opens the menu, for another way in (a row's long-press). */
  control?: (open: () => void) => void;
}) {
  const [open, setOpenRaw] = createSignal(false);
  /** The submenus open, outermost first. */
  const [trail, setTrail] = createSignal<{ label: string; items: () => MenuItem[] }[]>([]);
  const setOpen = (value: boolean) => {
    setOpenRaw(value);
    if (!value) setTrail([]);
  };
  const shown = () => {
    const t = trail();
    return t.length ? t[t.length - 1].items() : props.items();
  };
  const [position, setPosition] = createSignal<JSX.CSSProperties>({});
  let root!: HTMLDivElement;
  let menu: HTMLDivElement | undefined;

  const onOutside = (e: PointerEvent) => {
    const target = e.target as Node;
    if (!root.contains(target) && !menu?.contains(target)) setOpen(false);
  };

  // Menus live in a portal (so scrolling panels can't clip them), positioned
  // next to their button and kept inside the viewport.
  const place = () => {
    const rect = root.getBoundingClientRect();
    let placement = props.placement ?? "bottom-start";
    const gap = 8;
    const margin = 8;
    // flip to the side with room: a row low in a bottom sheet opens upward
    const below = window.innerHeight - rect.bottom - gap - margin;
    const above = rect.top - gap - margin;
    if (placement.startsWith("bottom") && below < 240 && above > below) placement = placement.replace("bottom", "top") as Placement;
    else if (placement.startsWith("top") && above < 240 && below > above) placement = placement.replace("top", "bottom") as Placement;
    const width = Math.min(260, window.innerWidth - 2 * margin);
    const style: JSX.CSSProperties = { width: `${width}px` };
    let left = placement.endsWith("end") ? rect.right - width : rect.left;
    left = Math.max(margin, Math.min(window.innerWidth - width - margin, left));
    style.left = `${left}px`;
    if (placement.startsWith("top")) {
      style.bottom = `${window.innerHeight - rect.top + gap}px`;
      style["max-height"] = `${rect.top - gap - margin}px`;
    } else {
      style.top = `${rect.bottom + gap}px`;
      style["max-height"] = `${window.innerHeight - rect.bottom - gap - margin}px`;
    }
    setPosition(style);
  };

  const toggle = () => {
    if (!open()) place();
    setOpen(!open());
  };
  props.control?.(() => {
    place();
    setOpen(true);
  });
  const onResize = () => setOpen(false);
  window.addEventListener("resize", onResize);
  onCleanup(() => window.removeEventListener("resize", onResize));
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
  };
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey);
  onCleanup(() => {
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey);
  });

  return (
    <div class={`menu-root ${props.class ?? ""}`} ref={root}>
      <Show
        when={props.trigger}
        fallback={<IconButton icon={props.icon} label={props.label} active={open()} class={props.buttonClass} onClick={toggle} />}
      >
        <button
          type="button"
          class={`menu-trigger ${props.buttonClass ?? ""}`}
          data-active={open() ? "" : undefined}
          aria-label={props.label}
          aria-haspopup="menu"
          aria-expanded={open()}
          title={props.label}
          onClick={toggle}
        >
          {props.trigger!()}
        </button>
      </Show>
      <Show when={open()}>
        <Portal>
        <div class="menu panel" role="menu" ref={menu} style={position()}>
          <Show when={trail().length}>
            <button type="button" role="menuitem" class="menu-item menu-back" onClick={() => setTrail(trail().slice(0, -1))}>
              <span class="menu-check">
                <Icon name="chevronLeft" size={16} />
              </span>
              <span class="menu-label">{trail()[trail().length - 1].label}</span>
            </button>
            <div class="menu-separator" />
          </Show>
          <For each={shown()}>
            {(item) => {
              if (item === "separator") return <div class="menu-separator" />;
              if ("heading" in item) return <div class="menu-heading">{item.heading}</div>;
              if ("items" in item) {
                return (
                  <button
                    type="button"
                    role="menuitem"
                    aria-haspopup="menu"
                    class="menu-item"
                    disabled={item.disabled}
                    onClick={() => setTrail([...trail(), { label: item.label, items: item.items }])}
                  >
                    <span class="menu-check" />
                    <span class="menu-label">{item.label}</span>
                    <Show when={item.detail}>
                      <span class="menu-detail">{item.detail}</span>
                    </Show>
                    <span class="menu-more">
                      <Icon name="chevronRight" size={16} />
                    </span>
                  </button>
                );
              }
              return (
                <button
                  type="button"
                  role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                  aria-checked={item.checked}
                  class="menu-item"
                  data-danger={item.danger ? "" : undefined}
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  <span class="menu-check">
                    <Show when={item.checked}>
                      <Icon name="check" size={16} />
                    </Show>
                  </span>
                  <Show when={item.swatch}>
                    <span class="menu-swatch" style={{ background: item.swatch }} />
                  </Show>
                  <Show when={item.icon}>
                    <span class="menu-icon">
                      <Icon name={item.icon!} size={18} />
                    </span>
                  </Show>
                  <span class="menu-label">{item.label}</span>
                  <Show when={item.detail}>
                    <span class="menu-detail">{item.detail}</span>
                  </Show>
                  <Show when={item.kbd}>
                    <kbd>{formatKbd(item.kbd!)}</kbd>
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
        </Portal>
      </Show>
    </div>
  );
}

export function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
  class?: string;
}) {
  return (
    <div class={`segmented ${props.class ?? ""}`} role="radiogroup" aria-label={props.label}>
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.value === option.value}
            data-active={props.value === option.value ? "" : undefined}
            title={option.title ?? option.label}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        )}
      </For>
    </div>
  );
}

/** How far a drag goes for one step of a number field. */
const SCRUB_PX = 8;

/**
 * A number you can drag sideways to scrub, or tap to type (Enter or leaving the field sets it,
 * Escape puts it back; ↑ and ↓ step it). `onScrubStart` and `onScrubEnd` bracket a drag, so a
 * host can make the whole drag one undo step. Shows `zeroLabel` in place of 0.
 */
export function NumberField(props: {
  /** A short label inside the field, such as "X". */
  label?: string;
  /** What it is, for screen readers and the tooltip. */
  title: string;
  value: number;
  onChange: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  /** Decimals to show; values are rounded to the step anyway. */
  digits?: number;
  /** Text after the number, such as "%". */
  unit?: string;
  zeroLabel?: string;
  disabled?: boolean;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
}) {
  const step = () => props.step ?? 1;
  const show = (n: number) => {
    if (n === 0 && props.zeroLabel) return "";
    return `${+n.toFixed(props.digits ?? 2)}${props.unit ?? ""}`;
  };
  const clamp = (n: number) => {
    const s = step();
    n = Math.round(n / s) * s;
    if (props.min !== undefined) n = Math.max(props.min, n);
    if (props.max !== undefined) n = Math.min(props.max, n);
    return +n.toFixed(6);
  };
  const [editing, setEditing] = createSignal(false);
  let input!: HTMLInputElement;
  /** The drag in progress: where it started, and whether it has become a scrub. */
  let drag: { id: number; x: number; from: number; scrubbing: boolean } | null = null;
  /** A scrub just ended, so the click that follows doesn't start typing. */
  let scrubbed = false;

  const commit = () => {
    const text = input.value.replace(props.unit ?? "", "").trim();
    setEditing(false);
    if (text === "" && props.zeroLabel) {
      if (props.value !== 0) props.onChange(clamp(0));
      return;
    }
    const n = Number(text.replace(",", "."));
    if (Number.isFinite(n) && clamp(n) !== props.value) props.onChange(clamp(n));
    else input.value = show(props.value);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (props.disabled || editing() || e.button !== 0) return;
    // keep focus off the input until it's clear this is a tap
    e.preventDefault();
    drag = { id: e.pointerId, x: e.clientX, from: props.value, scrubbing: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.scrubbing) {
      if (Math.abs(dx) < 4) return;
      drag.scrubbing = true;
      props.onScrubStart?.();
    }
    const next = clamp(drag.from + Math.trunc(dx / SCRUB_PX) * step());
    if (next !== props.value) props.onChange(next);
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    scrubbed = drag.scrubbing;
    drag = null;
    if (scrubbed) props.onScrubEnd?.();
  };
  const onClick = () => {
    if (props.disabled || scrubbed) {
      scrubbed = false;
      return;
    }
    if (!editing()) input.focus();
  };

  return (
    <div
      class="num-field"
      data-editing={editing() ? "" : undefined}
      data-disabled={props.disabled ? "" : undefined}
      title={`${props.title}: drag to change, tap to type`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={onClick}
    >
      <Show when={props.label}>
        <span class="num-label">{props.label}</span>
      </Show>
      <input
        ref={input}
        type="text"
        inputmode="decimal"
        enterkeyhint="done"
        aria-label={props.title}
        disabled={props.disabled}
        readOnly={!editing()}
        value={editing() ? input.value : show(props.value)}
        placeholder={props.zeroLabel}
        onFocus={() => {
          setEditing(true);
          input.select();
        }}
        onBlur={() => editing() && commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            input.blur();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            setEditing(false);
            input.value = show(props.value);
            input.blur();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const n = clamp(props.value + (e.key === "ArrowUp" ? step() : -step()));
            if (n !== props.value) props.onChange(n);
            input.value = show(n);
            input.select();
          }
        }}
      />
    </div>
  );
}
