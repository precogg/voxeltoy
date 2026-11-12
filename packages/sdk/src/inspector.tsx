import { For, Show, createSignal, type JSX } from "solid-js";
import type { Field } from "@voxeltoy/core/scene-kinds";
import type { Json, Vec3 } from "@voxeltoy/core/types";
import { IconButton, Menu, Segmented, type MenuItem } from "./primitives";
import { useLibrary } from "./library-view";

const AXES = ["x", "y", "z"] as const;
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number");
const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/**
 * The selected instance's settings, from its kind's fields: a control each, inherited values
 * dimmed with a Reset for those it changes. A kind this app doesn't know shows its settings
 * read-only, as values. See docs/scenes.md ("Fields, inspector and handles").
 */
export function Inspector() {
  const { library: scene, layer } = useLibrary();
  const [open, setOpen] = createSignal(true);
  const id = () => (scene.selection.length === 1 ? scene.selection[0] : null);
  const inst = () => (id() ? scene.instance(id()!) : undefined);
  const kind = () => scene.kind(inst()?.kind);
  const info = () => (inst()?.kind ? scene.kindInfo(inst()!.kind!) : undefined);
  const settings = () => (id() ? scene.settings(id()!) : {});
  const fields = () => kind()?.fields ?? [];
  const unknownKeys = () => (kind() ? [] : Object.keys(settings()));

  return (
    <Show when={inst() && info() && (fields().length || unknownKeys().length)}>
      <section class="panel inspector" aria-label="Settings">
        <header class="panel-header">
          <span class="panel-title">{info()!.label}</span>
          <IconButton icon={open() ? "chevronDown" : "chevronUp"} label={open() ? "Hide settings" : "Show settings"} class="small" onClick={() => setOpen(!open())} />
        </header>
        <Show when={open()}>
          <div class="inspector-fields">
            <Show when={!kind()}>
              <p class="hint small">The app that made this object edits its settings.</p>
            </Show>
            <For each={fields()}>
              {(field) => (
                <FieldRow
                  field={field}
                  value={settings()[field.key]}
                  own={!!inst()!.data && field.key in inst()!.data!}
                  set={(v) => scene.setData(id()!, { [field.key]: v }, `Change ${field.label ?? field.key}`)}
                  reset={() => scene.unsetData(id()!, [field.key], `Reset ${field.label ?? field.key}`)}
                  addPoint={() => layer()?.fields.addVertex(id()!, field.key)}
                  deletePoint={() => layer()?.fields.deleteVertex(id()!, field.key)}
                  refItems={() => refItems(field, id()!, (v) => scene.setData(id()!, { [field.key]: v }, `Change ${field.label ?? field.key}`))}
                />
              )}
            </For>
            <For each={unknownKeys()}>
              {(key) => (
                <div class="field-row">
                  <span class="field-name">{key}</span>
                  <span class="field-value readonly">{JSON.stringify(settings()[key])}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </section>
    </Show>
  );

  /** Another instance to point at: of the field's kinds, or any. */
  function refItems(field: Field, self: string, set: (v: Json) => void): MenuItem[] {
    const kinds = field.type === "ref" ? field.kinds : undefined;
    const current = settings()[field.key];
    return [
      { label: "None", checked: current === null || current === undefined, onSelect: () => set(null) },
      ...scene.instances
        .filter((i) => i.id !== self && (!kinds || (i.kind && kinds.includes(i.kind))))
        .map((i) => ({ label: i.name, checked: current === i.id, onSelect: () => set(i.id) })),
    ];
  }
}

function NumberInput(props: { value: number; step?: number; min?: number; max?: number; label: string; onChange: (n: number) => void }) {
  return (
    <input
      class="field-number"
      type="number"
      inputmode="decimal"
      aria-label={props.label}
      value={fmt(props.value)}
      step={props.step ?? "any"}
      min={props.min}
      max={props.max}
      onChange={(e) => {
        const n = Number(e.currentTarget.value);
        if (!Number.isFinite(n)) return;
        const clamped = Math.max(props.min ?? -Infinity, Math.min(props.max ?? Infinity, n));
        props.onChange(clamped);
      }}
    />
  );
}

function FieldRow(props: {
  field: Field;
  value: Json | undefined;
  own: boolean;
  set: (v: Json) => void;
  reset: () => void;
  addPoint: () => void;
  deletePoint: () => void;
  refItems: () => MenuItem[];
}) {
  const f = () => props.field;
  const label = () => f().label ?? f().key;
  const control = (): JSX.Element => {
    const field = f();
    const v = props.value;
    switch (field.type) {
      case "number":
        return <NumberInput label={label()} value={typeof v === "number" ? v : 0} step={field.step} min={field.min} max={field.max} onChange={props.set} />;
      case "radius":
        return <NumberInput label={label()} value={typeof v === "number" ? v : 0} min={field.min ?? 0} max={field.max} onChange={props.set} />;
      case "bool":
        return (
          <button type="button" class="chip" data-active={v ? "" : undefined} aria-pressed={!!v} onClick={() => props.set(!v)}>
            {v ? "On" : "Off"}
          </button>
        );
      case "enum":
        return field.options.length <= 4 ? (
          <Segmented label={label()} value={String(v ?? "")} options={field.options.map((o) => ({ value: o, label: o }))} onChange={props.set} class="dense" />
        ) : (
          <Menu
            icon="chevronDown"
            label={label()}
            placement="top-end"
            trigger={() => <span class="field-menu">{String(v ?? "—")}</span>}
            items={() => field.options.map((o) => ({ label: o, checked: v === o, onSelect: () => props.set(o) }))}
          />
        );
      case "color":
        return (
          <input
            class="field-color"
            type="color"
            aria-label={label()}
            value={typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : "#ffffff"}
            onChange={(e) => props.set(e.currentTarget.value)}
          />
        );
      case "point":
      case "size": {
        const vec = isVec3(v) ? v : ([0, 0, 0] as Vec3);
        const axes = field.type === "size" ? field.axes.map((a) => AXES.indexOf(a)) : [0, 1, 2];
        return (
          <div class="field-vec">
            <For each={axes}>
              {(a) => (
                <label class="field-axis">
                  <span>{AXES[a]}</span>
                  <NumberInput
                    label={`${label()} ${AXES[a]}`}
                    value={vec[a]}
                    step={field.type === "size" ? field.step : undefined}
                    min={field.type === "size" ? field.min : undefined}
                    max={field.type === "size" ? field.max : undefined}
                    onChange={(n) => {
                      const next = [...vec] as Vec3;
                      next[a] = n;
                      props.set(next);
                    }}
                  />
                </label>
              )}
            </For>
          </div>
        );
      }
      case "points": {
        const count = Array.isArray(v) ? v.length : 0;
        return (
          <div class="field-points">
            <span class="field-value">{count} {count === 1 ? "point" : "points"}</span>
            <IconButton icon="plus" label="Add point" class="small" onClick={props.addPoint} />
            <IconButton icon="minus" label="Delete point" class="small" disabled={count < 2} onClick={props.deletePoint} />
          </div>
        );
      }
      case "ref":
        return (
          <Menu
            icon="link"
            label={label()}
            placement="top-end"
            trigger={() => <span class="field-menu">{refName(v)}</span>}
            items={props.refItems}
          />
        );
    }
  };
  const { library: scene } = useLibrary();
  const refName = (v: Json | undefined) => (typeof v === "string" ? (scene.instance(v)?.name ?? "Missing") : "None");

  return (
    <div class="field-row" data-inherited={props.own ? undefined : ""}>
      <span class="field-name">{label()}</span>
      <div class="field-control">{control()}</div>
      <Show when={props.own} fallback={<span class="field-reset-space" />}>
        <IconButton icon="rotate" label={`Reset ${label()} to its default`} class="small" onClick={props.reset} />
      </Show>
    </div>
  );
}
