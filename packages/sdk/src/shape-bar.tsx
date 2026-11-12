import { createSignal, For, onCleanup, Show } from "solid-js";
import { baseAxes, boxExtent, isPathPreset, presetOf, shapeName, shapeOrientations, type ShapeKind, type ShapeParams, type ShapePreset } from "@voxeltoy/core/shapes";
import type { BrushOp, PendingShape } from "@voxeltoy/core/editor";
import type { Axis } from "@voxeltoy/core/types";
import { formatKbd, shapeIcon, SHAPES } from "./actions";
import { useApp } from "./context";
import { Icon } from "./icons";
import { IconButton, Menu, NumberField, Segmented, type Placement } from "./primitives";
import type { PenProfile } from "@voxeltoy/core/editor";
import type { StepMode } from "@voxeltoy/core/source";

/** What a new shape does to those below it, as the options bar and Properties offer it. */
export const STEP_MODES: { value: StepMode; label: string; title: string }[] = [
  { value: "add", label: "Add", title: "Add to what is below" },
  { value: "cut", label: "Cut", title: "Cut out of what is below" },
  { value: "intersect", label: "Intersect", title: "Keep only what is below inside it" },
  { value: "paint", label: "Paint", title: "Recolor what is below inside it" },
];

const PEN_PROFILES: { value: PenProfile; label: string; title: string }[] = [
  { value: "tube", label: "Tube", title: "A round tube through the points" },
  { value: "wall", label: "Wall", title: "An upright wall through the points" },
  { value: "slab", label: "Slab", title: "A flat slab inside the points" },
];

/** A shape layer step being placed: "Sphere", "Cut sphere", "Paint sphere". */
function operandLabel(op: BrushOp, name: string) {
  return op === "erase" ? `Cut ${name.toLowerCase()}` : op === "paint" ? `Paint ${name.toLowerCase()}` : name;
}

/**
 * A button naming a shape (its kind and settings: "Box", "6-sided pyramid") that opens the list
 * of shapes to pick from: what the tools draw, or what a shape is.
 */
export function ShapeKindMenu(props: {
  kind: ShapeKind;
  params?: ShapeParams;
  label: string;
  onPick: (preset: ShapePreset) => void;
  placement?: Placement;
  class?: string;
  /** Offer the paths (tube, wall, slab): only shape layers draw them. */
  paths?: boolean;
}) {
  const icon = () => shapeIcon(props.kind, props.params);
  return (
    <Menu
      icon={icon()}
      label={props.label}
      placement={props.placement ?? "top-start"}
      buttonClass={`kind-trigger ${props.class ?? ""}`}
      trigger={() => (
        <>
          <Icon name={icon()} size={18} />
          <span class="kind-name">{shapeName(props.kind, props.params)}</span>
          <Icon name="chevronDown" size={14} />
        </>
      )}
      items={() => {
        const current = presetOf(props.kind, props.params);
        return SHAPES.filter((s) => props.paths || !isPathPreset(s.id)).map((s) => ({
          label: s.label,
          icon: s.icon,
          checked: s.id === current,
          onSelect: () => props.onPick(s.id),
        }));
      }}
    />
  );
}

/** A toggle in a bar: on, it is filled. */
function BarToggle(props: { label: string; title: string; on: boolean; set: (on: boolean) => void }) {
  return (
    <button
      type="button"
      class="toggle-chip bar-toggle"
      aria-pressed={props.on}
      data-active={props.on ? "" : undefined}
      title={props.title}
      onClick={() => props.set(!props.on)}
    >
      {props.label}
    </button>
  );
}

/** Whether a raster layer's shape brush is out and nothing is being placed. */
function drawing(editor: ReturnType<typeof useApp>["editor"]) {
  const tool = editor.tool;
  if (editor.activeLayerKind === "shape") return false;
  if (tool === "select") {
    if (editor.selectBrush !== "shape") return false;
  } else if ((tool !== "add" && tool !== "erase" && tool !== "brush") || editor.brush !== "shape") {
    return false;
  }
  const pending = editor.pendingShape;
  return !pending || pending.operand === "edit";
}

/** From center and Uniform: how a drag draws a shape's base. */
function DrawToggles() {
  const { editor } = useApp();
  return (
    <>
      <BarToggle
        label="From center"
        title="Draw out from where you start, both ways"
        on={editor.shapeFromCenter}
        set={(on) => editor.setShapeFromCenter(on)}
      />
      <BarToggle
        label="Uniform"
        title="Keep the base as wide as it is deep (Shift)"
        on={editor.shapeUniform}
        set={(on) => editor.setShapeUniform(on)}
      />
    </>
  );
}

/**
 * Over the toolbar while a shape tool is out and nothing is being placed. On a vector layer, the
 * options bar: what the next shape does (Add, Cut, Intersect, Paint) and how it is drawn, or for
 * the Pen what it makes; the choices stick. On a raster layer, how the shape brush draws.
 */
export function ShapeDrawBar() {
  const { editor, host } = useApp();
  const vectorTool = () => editor.activeLayerKind === "shape" && (editor.tool === "shape" || editor.tool === "pen");
  return (
    <Show when={!host.viewOnly?.()}>
      <Show when={editor.drawingPath}>
        <PathBar />
      </Show>
      <Show
        when={!editor.drawingPath && vectorTool() && (!editor.pendingShape || editor.pendingShape.operand === "edit" || editor.pendingShape.drawing)}
      >
        <OptionsBar pen={editor.tool === "pen"} />
      </Show>
      <Show when={drawing(editor)}>
        <div class="panel bar shape-bar" role="toolbar" aria-label="Drawing shapes">
          <DrawToggles />
        </div>
      </Show>
    </Show>
  );
}

/** A vector layer's options bar: the Pen's Tube / Wall / Slab, then for both, the mode and how to draw. */
function OptionsBar(props: { pen: boolean }) {
  const { editor } = useApp();
  return (
    <div class="panel bar shape-bar options-bar" role="toolbar" aria-label={props.pen ? "Pen options" : "Shape tool options"}>
      <Show when={props.pen}>
        <Segmented label="What the Pen draws" value={editor.penProfile} options={PEN_PROFILES} onChange={(p) => editor.setPenProfile(p)} />
        <div class="bar-divider" />
      </Show>
      <Segmented label="What it does" value={editor.shapeMode} options={STEP_MODES} onChange={(m) => editor.setShapeMode(m)} />
      <div class="bar-divider" />
      <Show
        when={!props.pen}
        fallback={<BarToggle label="Smooth" title="A smooth curve through the points" on={editor.penSmooth} set={(on) => editor.setPenSmooth(on)} />}
      >
        <DrawToggles />
      </Show>
    </div>
  );
}

/**
 * While the Pen draws a path: what it makes (Tube, Wall, Slab), how many points it has, Smooth, and
 * Done. Each tap adds a point; undo takes the last one back; tapping the first point closes it.
 */
function PathBar() {
  const { editor, actions } = useApp();
  const step = () => {
    const d = editor.drawingPath;
    return d ? (editor.shapeStack(d.layerId)?.find((s) => s.id === d.stepId) ?? null) : null;
  };
  const set = (change: { smooth?: boolean; kind?: PenProfile }) => {
    const d = editor.drawingPath;
    if (!d) return;
    // what the Pen makes sticks for the next path too
    if (change.kind) editor.setPenProfile(change.kind);
    if (change.smooth !== undefined) editor.setPenSmooth(change.smooth);
    editor.setStepShape(d.layerId, d.stepId, change);
  };
  const count = () => step()?.shape.points?.length ?? 0;
  return (
    <Show when={step()}>
      {(s) => (
        <div class="panel bar shape-bar options-bar" role="toolbar" aria-label="Drawing a path">
          <Segmented label="What the Pen draws" value={s().shape.profile ?? "tube"} options={PEN_PROFILES} onChange={(p) => set({ kind: p })} />
          <span class="shape-size">
            {count()} {count() === 1 ? "point" : "points"}
          </span>
          <div class="bar-divider" />
          <BarToggle label="Smooth" title="A smooth curve through the points" on={!!s().shape.smooth} set={(on) => set({ smooth: on })} />
          <button type="button" class="bar-chip bar-done" title={`${actions.finishPath.label} (${formatKbd(actions.finishPath.kbd)})`} onClick={actions.finishPath.run}>
            Done
          </button>
        </div>
      )}
    </Show>
  );
}

/**
 * While a vector layer's shape is being drawn, its size by the pointer: the footprint's "W × D",
 * then its height. Beside a mouse, above a finger.
 */
export function DrawLabel() {
  const { editor } = useApp();
  const [at, setAt] = createSignal<{ x: number; y: number; touch: boolean } | null>(null);
  const track = (e: PointerEvent) => setAt({ x: e.clientX, y: e.clientY, touch: e.pointerType !== "mouse" });
  window.addEventListener("pointermove", track, true);
  window.addEventListener("pointerdown", track, true);
  onCleanup(() => {
    window.removeEventListener("pointermove", track, true);
    window.removeEventListener("pointerdown", track, true);
  });
  const text = () => {
    const shape = editor.pendingShape;
    if (!shape?.drawing) return null;
    const [u, v] = baseAxes(shape).sort((a, b) => a - b);
    const size = boxExtent(shape.box);
    return shape.drawing === "footprint" ? `${size[u]} × ${size[v]}` : `height ${size[shape.grow.axis]}`;
  };
  return (
    <Show when={text() ? at() : null}>
      {(p) => (
        <span class="draw-label" style={{ left: `${p().x + 16}px`, top: `${p().touch ? p().y - 64 : p().y + 18}px` }}>
          {text()}
        </span>
      )}
    </Show>
  );
}

/**
 * Shown while a shape is being placed: its kind, its size on each axis (drag or type each one; the
 * handles on the canvas do the same), and rotate / cancel / apply.
 */
export function ShapeBar() {
  const { editor, actions } = useApp();
  /** Make the shape `n` cells along `axis`, from its min face, inside the grid. */
  const resize = (shape: PendingShape, axis: Axis, n: number) => {
    const max = [...shape.box.max] as typeof shape.box.max;
    max[axis] = Math.min(editor.size[axis] - 1, shape.box.min[axis] + n - 1);
    const { box: _, kind: __, hollow: ___, op: ____, operand: _____, params: ______, ...draft } = shape;
    editor.setPendingShape({ ...draft, box: { min: [...shape.box.min], max } });
  };
  return (
    <Show when={editor.pendingShape?.operand !== "edit" && !editor.pendingShape?.drawing && editor.pendingShape}>
      {(shape) => (
        <div class="panel bar shape-bar" role="toolbar" aria-label="Shape">
          <ShapeKindMenu kind={shape().kind} params={shape().params} label="Shape" onPick={(k) => editor.setShapeKind(k)} />
          <Show when={shape().operand && shape().op !== "add"}>
            <span class="shape-size">{operandLabel(shape().op, shapeName(shape().kind, shape().params))}</span>
          </Show>
          <div class="bar-sizes">
            <For each={[0, 1, 2] as Axis[]}>
              {(a) => (
                <NumberField
                  label={"XYZ"[a]}
                  title={`${"XYZ"[a]} size`}
                  value={boxExtent(shape().box)[a]}
                  min={1}
                  max={editor.size[a]}
                  onChange={(n) => resize(shape(), a, n)}
                />
              )}
            </For>
          </div>
          <Show when={shapeOrientations(shape().kind).length > 0}>
            <IconButton
              icon="rotate"
              label={actions.rotateShape.label}
              kbd={actions.rotateShape.kbd}
              onClick={actions.rotateShape.run}
            />
          </Show>
          <div class="bar-divider" />
          <IconButton icon="close" label={actions.cancelShape.label} kbd="escape" onClick={actions.cancelShape.run} />
          <IconButton
            icon="check"
            label={actions.applyShape.label}
            kbd={actions.applyShape.kbd}
            class="primary"
            onClick={actions.applyShape.run}
          />
        </div>
      )}
    </Show>
  );
}
