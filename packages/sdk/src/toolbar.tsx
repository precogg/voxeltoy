import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { ShapePreset } from "@voxeltoy/core/shapes";
import { MORE_SHAPES, TOOLBAR_SHAPES, VECTOR_TOOLS, VIEW_TOOLS, type ShapeButton, type ToolButton } from "./actions";
import { useApp } from "./context";
import { Icon } from "./icons";
import { IconButton } from "./primitives";

/**
 * The tools for the active layer, which a label at the start names: a raster layer's voxel tools,
 * or a vector layer's Orbit, Select | shapes, More ▾ | Pen, Fill.
 */
export function Toolbar() {
  const { editor } = useApp();
  const vector = () => editor.activeLayerKind === "shape";
  return (
    <nav class="panel toolbar" aria-label={vector() ? "Vector tools" : "Voxel tools"}>
      <span class="toolbar-kind" data-kind={vector() ? "vector" : "voxels"}>
        {vector() ? "Vector" : "Voxels"}
      </span>
      <Show when={vector()} fallback={<RasterTools />}>
        <VectorTools />
      </Show>
    </nav>
  );
}

function ToolIcon(props: { tool: ToolButton }) {
  const { editor } = useApp();
  return (
    <IconButton
      icon={props.tool.icon}
      label={props.tool.label}
      kbd={props.tool.kbd}
      active={editor.tool === props.tool.id}
      class="tool"
      onClick={() => editor.setTool(props.tool.id)}
    />
  );
}

function RasterTools() {
  const { host, tools: all } = useApp();
  const tools = () => (host.viewOnly?.() ? all.filter((t) => VIEW_TOOLS.includes(t.id)) : all);
  // the tools that only look, then those that edit
  const looking = () => tools().filter((t) => t.id === "orbit" || t.id === "select");
  const editing = () => tools().filter((t) => t.id !== "orbit" && t.id !== "select");
  return (
    <>
      <For each={looking()}>{(tool) => <ToolIcon tool={tool} />}</For>
      <Show when={looking().length && editing().length}>
        <div class="bar-divider" />
      </Show>
      <For each={editing()}>{(tool) => <ToolIcon tool={tool} />}</For>
    </>
  );
}

function VectorTools() {
  const { editor, host, compact } = useApp();
  const [orbit, select, pen, fill] = VECTOR_TOOLS;
  // phones keep three shapes on the bar; Cone and Torus go in More
  const onBar = () => (compact() ? TOOLBAR_SHAPES.slice(0, 3) : TOOLBAR_SHAPES);
  const inMore = () => (compact() ? [...TOOLBAR_SHAPES.slice(3), ...MORE_SHAPES] : MORE_SHAPES);
  const armed = (id: ShapePreset) => editor.tool === "shape" && editor.shapePreset === id;
  return (
    <Show when={!host.viewOnly?.()} fallback={<ToolIcon tool={orbit} />}>
      <ToolIcon tool={orbit} />
      <ToolIcon tool={select} />
      <div class="bar-divider" />
      <For each={onBar()}>
        {(shape) => (
          <IconButton
            icon={shape.icon}
            label={shape.label}
            kbd={shape.kbd}
            active={armed(shape.id)}
            class="tool"
            onClick={() => editor.setShapeTool(shape.id)}
          />
        )}
      </For>
      <MoreShapes shapes={inMore()} armed={armed} />
      <div class="bar-divider" />
      <ToolIcon tool={pen} />
      <ToolIcon tool={fill} />
    </Show>
  );
}

/**
 * More ▾: a small grid of the other shapes over the toolbar. Picking one arms it, and the button
 * then shows that shape until another is picked from the grid.
 */
function MoreShapes(props: { shapes: ShapeButton[]; armed: (id: ShapePreset) => boolean }) {
  const { editor } = useApp();
  const [open, setOpen] = createSignal(false);
  const [last, setLast] = createSignal<ShapeButton | null>(null);
  // the last one picked, while it is still in the grid (a phone's grid holds more)
  const shown = () => {
    const l = last();
    return l && props.shapes.some((s) => s.id === l.id) ? l : null;
  };
  let root!: HTMLDivElement;
  createEffect(() => {
    if (!open()) return;
    const away = (e: PointerEvent) => !root.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    onCleanup(() => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
    });
  });
  const pick = (shape: ShapeButton) => {
    setLast(shape);
    setOpen(false);
    editor.setShapeTool(shape.id);
  };
  return (
    <div class="more-shapes" ref={root}>
      <button
        type="button"
        class="icon-button tool more-button"
        aria-label="More shapes"
        aria-haspopup="true"
        aria-expanded={open()}
        title={shown() ? `${shown()!.label} (more shapes)` : "More shapes"}
        data-active={shown() && props.armed(shown()!.id) ? "" : undefined}
        data-open={open() ? "" : undefined}
        onClick={() => setOpen(!open())}
      >
        <Show when={shown()} fallback={<Icon name="chevronDown" />}>
          {(s) => (
            <>
              <Icon name={s().icon} />
              <span class="more-caret" aria-hidden="true">
                <Icon name="chevronDown" size={10} />
              </span>
            </>
          )}
        </Show>
      </button>
      <Show when={open()}>
        <div class="panel more-grid" role="menu" aria-label="More shapes">
          <For each={props.shapes}>
            {(shape) => (
              <button
                type="button"
                class="more-item"
                role="menuitemradio"
                aria-checked={props.armed(shape.id)}
                data-active={props.armed(shape.id) ? "" : undefined}
                onClick={() => pick(shape)}
              >
                <Icon name={shape.icon} />
                <span>{shape.label}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
