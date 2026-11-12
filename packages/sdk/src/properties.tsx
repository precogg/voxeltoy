import { createSignal, For, Show, type JSX } from "solid-js";
import { toHex } from "@voxeltoy/core/color";
import { defaultForward, type Direction, limbEnds, shapeName, shapeOrientations } from "@voxeltoy/core/shapes";
import {
  cellsToSource,
  MAX_RESOLUTION,
  snapSource,
  sourceToCells,
  stepFill,
  type FillKind,
  type ShapeOptions,
  type Step,
  type StepMode,
} from "@voxeltoy/core/source";
import type { Axis, Vec3 } from "@voxeltoy/core/types";
import { useApp } from "./context";
import { Icon, type IconName } from "./icons";
import { Menu, NumberField, Segmented, type MenuItem } from "./primitives";
import { ShapeKindMenu, STEP_MODES as MODE_CHOICES } from "./shape-bar";

export const STEP_MODES: { id: StepMode; label: string; icon: IconName; title: string }[] = [
  { id: "add", label: "Add", icon: "cube", title: "Add: fill the shape" },
  { id: "cut", label: "Cut", icon: "cut", title: "Cut: empty the shape out of the shapes below" },
  { id: "intersect", label: "Intersect", icon: "selectIntersect", title: "Intersect: keep only what is inside the shape" },
  { id: "paint", label: "Paint", icon: "paint", title: "Paint: recolor what is inside the shape" },
];

const modeOf = (mode: StepMode) => STEP_MODES.find((m) => m.id === mode)!;

/** A step's name: its own, or "Sphere" for an added sphere and "Cut sphere", "Paint sphere" and so on for the rest. */
export const stepName = (step: Step) => {
  if (step.name) return step.name;
  const shape = shapeName(step.shape.kind, step.shape);
  if (step.mode === "add") return shape;
  return `${modeOf(step.mode).label} ${shape.toLowerCase()}`;
};

/** Whether a step's color choice means anything: cuts have no color, and paint always recolors. */
const keepApplies = (mode: StepMode) => mode === "add" || mode === "intersect";

const AXES = [0, 1, 2] as Axis[];
const directionLabel = (d: Direction) => `${d.sign > 0 ? "+" : "−"}${"XYZ"[d.axis]}`;
/** A limb's base corner, as the sides of the box it's on: "−X −Y −Z" is the min corner. */
const cornerLabel = (corner: number) => AXES.map((a) => `${(corner >> a) & 1 ? "+" : "−"}${"XYZ"[a]}`).join(" ");

/** The shape selected on the active vector layer, once it is made (not while it is being drawn). */
function useSelectedShape() {
  const { editor } = useApp();
  return () => {
    const s = editor.selectedStep;
    return s && s.layerId === editor.activeLayerId && !editor.pendingShape?.drawing ? s.step : null;
  };
}

/**
 * Properties: the selected shape's settings, in a card on the right under the color panel, shown
 * only while a shape is selected. The shapes themselves are listed in the Layers panel.
 */
export function PropertiesPanel() {
  const selected = useSelectedShape();
  return (
    <Show when={selected()}>
      {(s) => (
        <section class="panel properties-panel" aria-label="Properties">
          <StepInspector step={s()} />
        </section>
      )}
    </Show>
  );
}

/** What the selected shape's ⋯ menus offer (Properties' header and the bar over the toolbar). */
export function shapeMenuItems(app: ReturnType<typeof useApp>, withDuplicateAndDelete: boolean): MenuItem[] {
  const { actions } = app;
  const item = (a: { label: string; kbd?: string; enabled?: () => boolean; run: () => void }): Exclude<MenuItem, string> => ({
    label: a.label,
    kbd: a.kbd,
    disabled: a.enabled ? !a.enabled() : false,
    onSelect: a.run,
  });
  return [
    ...(withDuplicateAndDelete ? [item(actions.duplicateShape)] : []),
    item(actions.moveShapeUp),
    item(actions.moveShapeDown),
    "separator",
    item(actions.bakeShapeLayer),
    ...(withDuplicateAndDelete ? (["separator", { ...item(actions.deleteShape), danger: true }] as MenuItem[]) : []),
  ];
}

/**
 * Inspector sections the user folded the other way, by id (UI state, kept from one selection to the
 * next). On a phone they start folded, so the sheet is a short list of what is set; on a desktop, open.
 */
const [flipped, setFlipped] = createSignal<ReadonlySet<string>>(new Set());

/**
 * A titled group of the inspector. With an `id` its title folds it shut, leaving the `summary`
 * (what it is set to) beside the title, so not everything has to show at once.
 */
function Section(props: { id?: string; title?: string; summary?: JSX.Element; children: any }) {
  const { compact } = useApp();
  const open = () => !props.id || compact() === flipped().has(props.id);
  const toggle = () => {
    const next = new Set(flipped());
    if (next.has(props.id!)) next.delete(props.id!);
    else next.add(props.id!);
    setFlipped(next);
  };
  return (
    <div class="inspector-section" data-shut={open() ? undefined : ""}>
      <Show when={props.title}>
        <Show when={props.id} fallback={<div class="inspector-title">{props.title}</div>}>
          <button type="button" class="inspector-toggle" aria-expanded={open()} onClick={toggle}>
            <Icon name="chevronRight" size={12} />
            <span class="inspector-title">{props.title}</span>
            <Show when={!open() && props.summary}>
              <span class="inspector-summary">{props.summary}</span>
            </Show>
          </button>
        </Show>
      </Show>
      <Show when={open()}>{props.children}</Show>
    </div>
  );
}

/** A labelled row of the inspector. */
function Field(props: { label: string; children: any }) {
  return (
    <div class="inspector-field">
      <span class="style-label">{props.label}</span>
      {props.children}
    </div>
  );
}

/**
 * The selected shape, in sections that fold: Combine (what it does to the shapes below), Transform
 * (where it is, how big, which way it turns and points), its kind's settings, and how it colors.
 * Numbers are in displayed voxels; drag one to scrub it (one undo step), or tap it to type. The
 * desktop card heads it with the kind ▾ and ⋯; the phone sheet has its own head (`head={false}`).
 */
export function StepInspector(props: { step: Step; head?: boolean }) {
  const app = useApp();
  const { editor } = app;
  const layerId = () => editor.activeLayerId;
  const step = () => props.step;
  const shape = () => props.step.shape;
  const res = () => editor.resolution;
  const cells = () => sourceToCells(shape(), res());
  /** A whole drag is one undo step. */
  const scrub = { onScrubStart: () => editor.beginStroke("Change shape"), onScrubEnd: () => editor.endStroke() };

  /** Set the cells the box covers along one axis; the other axes keep their exact source coordinates. */
  const setSpan = (a: Axis, lo: number, hi: number) => {
    const box = cells();
    const next = { min: [...box.min], max: [...box.max] } as typeof box;
    next.min[a] = lo;
    next.max[a] = hi;
    const src = cellsToSource(next, res());
    const min = [...shape().min] as Vec3;
    const max = [...shape().max] as Vec3;
    if (lo !== box.min[a]) min[a] = src.min[a];
    max[a] = src.max[a];
    editor.setStepBox(layerId(), step().id, { min, max });
  };
  const size = (a: Axis) => cells().max[a] - cells().min[a] + 1;

  const setOption = (change: ShapeOptions) => editor.setStepShape(layerId(), step().id, change);
  /** A length in source units as displayed voxels, and back. */
  const voxels = (n: number | undefined) => (n ?? 0) * res();
  const source = (v: number) => Math.max(0, v / res());
  const roundTop = () => shape().roundTop ?? shape().round ?? 0;
  const roundBottom = () => shape().roundBottom ?? shape().round ?? 0;
  /**
   * A limb radius on the source lattice and within half the box's smallest side (the most it shows):
   * past the most a change would do nothing.
   */
  const limbRadius = (n: number, least: number) => {
    const { min, max } = shape();
    const most = Math.floor((Math.min(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2) * MAX_RESOLUTION) / MAX_RESOLUTION;
    return Math.min(most, Math.max(least, snapSource(n)));
  };
  const orientations = () => shapeOrientations(shape().kind);
  const up = () => shape().up ?? { axis: 1, sign: 1 };
  const forward = () => {
    const f = shape().forward;
    return f && f.axis !== up().axis ? f : defaultForward(up());
  };
  /** What `forward` means for this shape, when it means something: a wedge's slope, where a sweep starts, a polygon's flat side. */
  const facing = () => {
    const sh = shape();
    if (sh.kind === "wedge") return "Slope";
    if (sh.sweep) return "From";
    if (sh.kind === "prism" && sh.sides && sh.sides !== 4) return "Faces";
    return null;
  };
  /** A row of the palette's first colors, the shape's own among them. */
  const fillColors = () => {
    const n = Math.min(editor.palette.length - 1, 6);
    const list = Array.from({ length: n }, (_, i) => i + 1);
    if (!list.includes(step().material) && n > 0) list[n - 1] = step().material;
    return list;
  };
  /** What the kind's settings come to, for its folded section: a wall, a taper, a sweep, a path's points. */
  const shapeSummary = () => {
    const sh = shape();
    const parts: string[] = [];
    if (sh.kind === "path") parts.push(`${sh.points?.length ?? 0} points`);
    if (sh.kind === "prism" && sh.sides) parts.push(`${sh.sides} sides`);
    if (sh.taper) parts.push(`taper ${Math.round(sh.taper * 100)}%`);
    if (sh.sweep) parts.push(`${sh.sweep}°`);
    if (sh.shell) parts.push(`wall ${voxels(sh.shell)}`);
    return parts.join(", ") || "Solid";
  };
  /** Sides from a field: 1 and 2 aren't polygons, so stepping past them goes to round or a triangle. */
  const sidesFrom = (v: number) => (v >= 3 ? v : v === 0 ? 0 : (shape().sides ?? 0) >= 3 ? 0 : 3);

  return (
    <div class="step-inspector">
      <Show when={props.head !== false}>
      <div class="inspector-head">
        <ShapeKindMenu
          kind={shape().kind}
          params={shape()}
          paths
          label="Change the shape"
          placement="bottom-start"
          onPick={(kind) => editor.setStepShape(layerId(), step().id, { kind })}
        />
        <Menu icon="dots" label="Shape options" placement="bottom-end" items={() => shapeMenuItems(app, true)} />
      </div>

      <PickedPoint step={step()} />
      </Show>

      <Section id="combine" title="Combine" summary={modeOf(step().mode).label + (keepApplies(step().mode) && step().keep ? ", keep colors" : "")}>
        <Segmented
          label="What it does to the shapes below"
          value={step().mode}
          options={MODE_CHOICES}
          onChange={(m) => editor.setStepMode(layerId(), step().id, m)}
        />
        <Show when={keepApplies(step().mode)}>
          <Field label="Overlap">
            <Segmented
              label="Where it overlaps"
              value={step().keep ? "keep" : "over"}
              options={[
                { value: "over", label: "Paint over", title: "Overlapping voxels take this shape's color" },
                { value: "keep", label: "Keep colors", title: "Overlapping voxels keep the colors below" },
              ]}
              onChange={(v) => editor.setStepKeep(layerId(), step().id, v === "keep")}
            />
          </Field>
        </Show>
      </Section>

      <Section id="transform" title="Transform" summary={`${size(0)} × ${size(1)} × ${size(2)}`}>
        <div class="inspector-grid">
          <span class="style-label">Position</span>
          <For each={AXES}>
            {(a) => (
              <NumberField
                label={"XYZ"[a]}
                title={`${"XYZ"[a]} position`}
                value={cells().min[a]}
                onChange={(v) => setSpan(a, v, v + size(a) - 1)}
                {...scrub}
              />
            )}
          </For>
          <span class="style-label">Size</span>
          <For each={AXES}>
            {(a) => (
              <NumberField
                label={"XYZ"[a]}
                title={`${"XYZ"[a]} size`}
                value={size(a)}
                min={1}
                onChange={(v) => setSpan(a, cells().min[a], cells().min[a] + v - 1)}
                {...scrub}
              />
            )}
          </For>
          <span class="style-label">Turn</span>
          <For each={AXES}>
            {(a) => (
              <button
                type="button"
                class="turn-button"
                title={`Turn a quarter turn about ${"XYZ"[a]}`}
                aria-label={`Turn about ${"XYZ"[a]}`}
                onClick={() => editor.rotateStepAbout(layerId(), step().id, a)}
              >
                <Icon name="rotate" size={14} />
                <span>{"XYZ"[a]}</span>
              </button>
            )}
          </For>
        </div>
        <Show when={orientations().length > 0}>
          <Field label="Points">
            <Menu
              icon="rotate"
              label="Which way it points"
              placement="bottom-start"
              buttonClass="select-trigger"
              trigger={() => (
                <>
                  <span>{directionLabel(shape().up ?? { axis: 1, sign: 1 })}</span>
                  <Icon name="chevronDown" size={14} />
                </>
              )}
              items={() =>
                orientations().map((d) => ({
                  label: directionLabel(d),
                  checked: shape().up?.axis === d.axis && (shape().up?.sign ?? 1) === d.sign,
                  onSelect: () => editor.pointStep(layerId(), step().id, d),
                }))
              }
            />
          </Field>
        </Show>
        <Show when={facing()}>
          {(what) => (
            <Field label={what()}>
              <Menu
                icon="rotate"
                label={what() === "Slope" ? "Which way the slope faces" : what() === "From" ? "Where it starts going round" : "Which way a flat side faces"}
                placement="bottom-start"
                buttonClass="select-trigger"
                trigger={() => (
                  <>
                    <span>{directionLabel(forward())}</span>
                    <Icon name="chevronDown" size={14} />
                  </>
                )}
                items={() =>
                  AXES.filter((a) => a !== up().axis)
                    .flatMap((axis) => [1, -1].map((sign) => ({ axis, sign }) as Direction))
                    .map((d) => ({
                      label: directionLabel(d),
                      checked: forward().axis === d.axis && forward().sign === d.sign,
                      onSelect: () => setOption({ forward: d }),
                    }))
                }
              />
            </Field>
          )}
        </Show>
      </Section>

      <Section id="shape" title={shapeName(shape().kind, shape())} summary={shapeSummary()}>
        <Show when={props.head === false}>
          <Field label="Kind">
            <ShapeKindMenu
              kind={shape().kind}
              params={shape()}
              paths
              label="Change the shape"
              placement="top-start"
              onPick={(kind) => editor.setStepShape(layerId(), step().id, { kind })}
            />
          </Field>
        </Show>
        <Show when={shape().kind === "prism"}>
          <Field label="Sides">
            <NumberField
              title="Sides, 3 to 12"
              value={shape().sides ?? 0}
              min={0}
              max={12}
              zeroLabel="Round"
              onChange={(v) => setOption({ sides: sidesFrom(v) })}
              {...scrub}
            />
          </Field>
          <Field label="Taper">
            <NumberField
              title="How much the top shrinks: 100% is a point"
              value={(shape().taper ?? 0) * 100}
              min={0}
              max={100}
              step={12.5}
              digits={1}
              unit="%"
              zeroLabel="Straight"
              onChange={(v) => setOption({ taper: v / 100 })}
              {...scrub}
            />
          </Field>
        </Show>
        <Show when={shape().kind === "prism" && !shape().taper && (shape().sides ?? 0) % 4 === 0 && (shape().sides ?? 0) <= 4}>
          <Show when={shape().sides === 4}>
            <Field label="Corners">
              <NumberField title="Edge radius" value={voxels(shape().round)} min={0} zeroLabel="Sharp" onChange={(v) => setOption({ round: source(v) })} {...scrub} />
            </Field>
          </Show>
          <Field label="Top">
            <NumberField title="Top edge radius" value={voxels(roundTop())} min={0} zeroLabel="Sharp" onChange={(v) => setOption({ roundTop: source(v) })} {...scrub} />
          </Field>
          <Field label="Bottom">
            <NumberField
              title="Bottom edge radius"
              value={voxels(roundBottom())}
              min={0}
              zeroLabel="Sharp"
              onChange={(v) => setOption({ roundBottom: source(v) })}
              {...scrub}
            />
          </Field>
        </Show>
        <Show when={shape().kind === "torus"}>
          <Field label="Tube">
            <NumberField
              title="The tube's radius across the ring: thicker leaves a smaller hole"
              value={voxels(shape().tube)}
              min={0}
              zeroLabel="Auto"
              onChange={(v) => setOption({ tube: source(v) })}
              {...scrub}
            />
          </Field>
        </Show>
        <Show when={shape().kind === "prism" || shape().kind === "sphere" || shape().kind === "torus"}>
          <Field label="Sweep">
            <NumberField
              title="How far round it goes"
              value={shape().sweep ?? 360}
              min={15}
              max={360}
              step={15}
              digits={0}
              unit="°"
              onChange={(v) => setOption({ sweep: v >= 360 ? 0 : v })}
              {...scrub}
            />
          </Field>
        </Show>
        <Show when={shape().kind === "path"}>
          <PathSettings step={step()} />
        </Show>
        <Show when={shape().kind !== "path"}>
          <Field label="Wall">
            <NumberField title="Wall thickness" value={voxels(shape().shell)} min={0} zeroLabel="Solid" onChange={(v) => setOption({ shell: source(v) })} {...scrub} />
          </Field>
        </Show>
        <Show when={shape().shell && shape().kind !== "limb" && shape().kind !== "diamond" && shape().kind !== "path"}>
          <Field label="Open">
            <div class="segmented" role="group" aria-label="Open ends">
              <For each={[["openTop", "Top"], ["openBottom", "Bottom"]] as const}>
                {([key, label]) => (
                  <button
                    type="button"
                    aria-pressed={!!shape()[key]}
                    data-active={shape()[key] ? "" : undefined}
                    title={`No wall at the ${label.toLowerCase()}`}
                    onClick={() => setOption({ [key]: !shape()[key] })}
                  >
                    {label}
                  </button>
                )}
              </For>
            </div>
          </Field>
        </Show>
        <Show when={shape().kind === "limb"}>
          <Field label="From">
            <Menu
              icon="rotate"
              label="The corner it grows from"
              placement="bottom-start"
              buttonClass="select-trigger"
              trigger={() => (
                <>
                  <span>{cornerLabel(shape().corner ?? 0)}</span>
                  <Icon name="chevronDown" size={14} />
                </>
              )}
              items={() =>
                [0, 1, 2, 3, 4, 5, 6, 7].map((c) => ({
                  label: cornerLabel(c),
                  checked: (shape().corner ?? 0) === c,
                  onSelect: () => setOption({ corner: c }),
                }))
              }
            />
          </Field>
          <Field label="Base">
            <NumberField
              title="Radius at the base"
              value={voxels(limbEnds(shape()).radius)}
              min={0}
              onChange={(v) => setOption({ radius: limbRadius(source(v), 1 / 8) })}
              {...scrub}
            />
          </Field>
          <Field label="Tip">
            <NumberField
              title="Radius at the tip"
              value={voxels(limbEnds(shape()).tip)}
              min={0}
              zeroLabel="Point"
              onChange={(v) => setOption({ tip: limbRadius(source(v), 0) })}
              {...scrub}
            />
          </Field>
        </Show>
      </Section>

      <Show when={step().mode === "cut"}>
        <p class="stack-hint">A cut has no color.</p>
      </Show>
      <Show when={step().mode !== "cut"}>
        <Section
          id="fill"
          title="Fill"
          summary={<span class="fill-dot" style={{ "background-color": toHex(editor.palette[step().material] ?? 0) }} />}
        >
          <div class="fill-row" role="radiogroup" aria-label="Color">
            <For each={fillColors()}>
              {(c) => (
                <button
                  type="button"
                  class="fill-swatch"
                  role="radio"
                  aria-checked={c === step().material}
                  aria-label={`Color ${c}`}
                  data-active={c === step().material ? "" : undefined}
                  style={{ "background-color": toHex(editor.palette[c] ?? 0) }}
                  onClick={() => editor.setStepMaterial(layerId(), step().id, c)}
                />
              )}
            </For>
            <button type="button" class="fill-all" title="All the palette's colors" onClick={() => app.setStyleOpen(true)}>
              All…
            </button>
          </div>
          <StepFillEditor step={step()} />
        </Section>
      </Show>
    </div>
  );
}

/**
 * A path's settings: straight or smooth, open or closed, its tube's radius or its wall's or
 * slab's size, and the point tapped on the canvas: where it is (in cells), its own radius, Delete.
 */
/** The point picked on a path being edited in place: where it is (in cells) and its own radius (tubes). */
function PickedPoint(props: { step: Step }) {
  const { editor } = useApp();
  const layerId = () => editor.activeLayerId;
  const shape = () => props.step.shape;
  const res = () => editor.resolution;
  const scrub = { onScrubStart: () => editor.beginStroke("Change shape"), onScrubEnd: () => editor.endStroke() };
  const source = (v: number) => Math.max(0, v / res());
  const voxels = (n: number | undefined) => (n ?? 0) * res();
  const point = () => {
    const i = editor.selectedPathPoint;
    const p = i === null ? undefined : shape().points?.[i];
    return p && i !== null ? { index: i, ...p } : null;
  };
  const cell = (n: number) => Math.floor(n * res());
  return (
    <Show when={editor.editingShape && point()}>
      {(p) => (
        <Section title={`Point ${p().index + 1} of ${shape().points?.length}`}>
          <div class="xyz">
            <For each={AXES}>
              {(a) => (
                <NumberField
                  label={"XYZ"[a]}
                  title={`Point ${"XYZ"[a]}`}
                  value={cell(p().at[a])}
                  onChange={(v) => {
                    const at = [...p().at] as Vec3;
                    at[a] = (v + 0.5) / res();
                    editor.movePathPoint(layerId(), props.step.id, p().index, at);
                  }}
                  {...scrub}
                />
              )}
            </For>
          </div>
          <Show when={(shape().profile ?? "tube") === "tube"}>
            <Field label="Radius">
              <NumberField
                title="This point's own radius"
                value={voxels(p().radius)}
                min={0}
                step={0.5}
                zeroLabel="Path's"
                onChange={(v) => editor.setPathPointRadius(layerId(), props.step.id, p().index, v ? source(v) : null)}
                {...scrub}
              />
            </Field>
          </Show>
        </Section>
      )}
    </Show>
  );
}

function PathSettings(props: { step: Step }) {
  const { editor } = useApp();
  const layerId = () => editor.activeLayerId;
  const shape = () => props.step.shape;
  const res = () => editor.resolution;
  const scrub = { onScrubStart: () => editor.beginStroke("Change shape"), onScrubEnd: () => editor.endStroke() };
  const set = (change: ShapeOptions) => editor.setStepShape(layerId(), props.step.id, change);
  const voxels = (n: number | undefined) => (n ?? 0) * res();
  const source = (v: number) => Math.max(0, v / res());
  const profile = () => shape().profile ?? "tube";
  const point = () => {
    const i = editor.selectedPathPoint;
    const p = i === null ? undefined : shape().points?.[i];
    return p && i !== null ? { index: i, ...p } : null;
  };

  return (
    <>
      <Field label="Line">
        <div class="segmented" role="group" aria-label="Line">
          <button
            type="button"
            aria-pressed={!!shape().smooth}
            data-active={shape().smooth ? "" : undefined}
            title="A smooth curve through the points"
            onClick={() => set({ smooth: !shape().smooth })}
          >
            Smooth
          </button>
          <Show when={profile() !== "slab"}>
            <button
              type="button"
              aria-pressed={!!shape().closed}
              data-active={shape().closed ? "" : undefined}
              title="Join the last point to the first"
              onClick={() => set({ closed: !shape().closed })}
            >
              Closed
            </button>
          </Show>
        </div>
      </Field>
      <Show when={profile() === "tube"}>
        <Field label="Radius">
          <NumberField title="The tube's radius" value={voxels(shape().radius ?? 1)} min={0.5} step={0.5} onChange={(v) => set({ radius: source(v) })} {...scrub} />
        </Field>
      </Show>
      <Show when={profile() === "wall"}>
        <Field label="Width">
          <NumberField title="How thick the wall is" value={voxels(shape().width ?? 1)} min={1} onChange={(v) => set({ width: source(v) })} {...scrub} />
        </Field>
      </Show>
      <Show when={profile() !== "tube"}>
        <Field label="Height">
          <NumberField title="How tall, up from the path" value={voxels(shape().height ?? 4)} min={1} onChange={(v) => set({ height: source(v) })} {...scrub} />
        </Field>
      </Show>
      <Show when={editor.editingShape && !point()}>
        <p class="stack-hint">{shape().points?.length ?? 0} points. Tap one to pick it, drag it to move it; tap a + to add one.</p>
      </Show>
      <Show when={!editor.editingShape}>
        <p class="stack-hint">{shape().points?.length ?? 0} points. Edit the path to move them.</p>
      </Show>
    </>
  );
}

const FILLS: { value: "solid" | FillKind; label: string; title: string }[] = [
  { value: "solid", label: "Solid", title: "One color" },
  { value: "gradient", label: "Ramp", title: "A gradient through the palette, from this color to the second" },
  { value: "checker", label: "Check", title: "A 3D checkerboard of the two colors" },
  { value: "stripes", label: "Stripe", title: "Stripes of the two colors" },
];

/** How the selected step colors its voxels: one color, or a ramp, checks or stripes of two. */
function StepFillEditor(props: { step: Step }) {
  const { editor } = useApp();
  const fill = () => props.step.fill;
  const set = (change: { kind?: FillKind; to?: number; axis?: Axis; size?: number }) => {
    const f = fill();
    const kind = change.kind ?? f!.kind;
    const to = change.to ?? f?.to ?? secondColor();
    editor.setStepFill(editor.activeLayerId, props.step.id, stepFill(kind, to, { axis: change.axis ?? f?.axis, size: change.size ?? f?.size }));
  };
  /** A second color to start from: the current one, unless it is the step's own. */
  const secondColor = () =>
    editor.color !== props.step.material ? editor.color : Math.min(editor.palette.length - 1, props.step.material + 1);
  const size = () => fill()?.size ?? 1;

  return (
    <>
      <Field label="Pattern">
        <Segmented
          label="Fill"
          value={fill()?.kind ?? "solid"}
          options={FILLS}
          class="dense"
          onChange={(v) => (v === "solid" ? editor.setStepFill(editor.activeLayerId, props.step.id, null) : set({ kind: v }))}
        />
      </Field>
      <Show when={fill()}>
        {(f) => (
          <>
            <Field label="To">
              <button
                type="button"
                class="step-color"
                title="Use the current color"
                aria-label="Second color: use the current color"
                onClick={() => set({ to: editor.color })}
              >
                <span class="step-swatch" style={{ "background-color": toHex(editor.palette[f().to] ?? 0) }} />
              </button>
              <Show when={f().axis !== undefined}>
                <Segmented
                  label="Fill axis"
                  value={String(f().axis)}
                  options={AXES.map((a) => ({ value: String(a), label: "XYZ"[a] }))}
                  onChange={(v) => set({ axis: Number(v) as Axis })}
                />
              </Show>
            </Field>
            <Show when={f().size !== undefined}>
              <Field label="Every">
                <NumberField
                  title="Pattern size"
                  value={size() * editor.resolution}
                  min={1}
                  onChange={(v) => set({ size: v / editor.resolution })}
                  onScrubStart={() => editor.beginStroke("Change fill")}
                  onScrubEnd={() => editor.endStroke()}
                />
              </Field>
            </Show>
          </>
        )}
      </Show>
    </>
  );
}
