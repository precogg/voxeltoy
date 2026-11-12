import { createEffect, createMemo, createSignal, For, on, Show, type Accessor } from "solid-js";
import { layerKind } from "@voxeltoy/core/editor";
import type { Effect } from "@voxeltoy/core/effects";
import { stageTree, type Blend, type StageNode } from "@voxeltoy/core/evaluate";
import type { Layer, LayerGroup } from "@voxeltoy/core/types";
import { useApp } from "./context";
import { Icon, type IconName } from "./icons";
import { blendTag, effectLabel, groupMenuItems, layerMenuItems, newLayerItems } from "./menus";
import { IconButton, Menu } from "./primitives";
import { ShapeRows } from "./shape-rows";
import { createLayerThumbnails } from "./thumbnails";
import { isFolded, openWhenShown, pickedGroup, RowEnd, setFolded, setPickedGroup, TreeRow } from "./tree-row";

/** What the tree's rows share: which row is selected, which rows hold it, and the layers' thumbnails. */
export interface TreeContext {
  /** The selected row: a group's or layer's id, or `step:` and a shape's id. */
  selected: Accessor<string | null>;
  /** Groups and layers that hold the selected row. */
  holds: Accessor<ReadonlySet<string>>;
  thumb: (layerId: string) => string | undefined;
}

/**
 * The open model's layers, topmost first, groups holding theirs and vector layers their shapes: what
 * the layers panel lists, and the scene tree under an entered model. One row is selected: a tapped
 * group, else the selected shape of the active layer, else the active layer.
 */
export function LayerRows(props: { indent?: number }) {
  const { editor, viewport } = useApp();
  const tree = createMemo(() => stageTree(editor.layers, editor.groups));
  const thumb = createLayerThumbnails(editor, viewport);
  const step = () => {
    const s = editor.selectedStep;
    return s && s.layerId === editor.activeLayerId ? s : null;
  };
  /** A group and the groups it is in, innermost first. */
  const groupChain = (id: string | undefined) => {
    const out: string[] = [];
    for (let at = id; at && out.length <= editor.groups.length; at = editor.groups.find((g) => g.id === at)?.group) out.push(at);
    return out;
  };
  const selected = () => {
    const g = pickedGroup();
    if (g && editor.groups.some((x) => x.id === g)) return g;
    const s = step();
    return s ? `step:${s.step.id}` : editor.activeLayerId;
  };
  const holds = createMemo<ReadonlySet<string>>(() => {
    const g = pickedGroup();
    if (g && editor.groups.some((x) => x.id === g)) return new Set(groupChain(editor.groups.find((x) => x.id === g)?.group));
    const layer = editor.layer(editor.activeLayerId);
    const ids = groupChain(layer?.group);
    if (step()) ids.push(editor.activeLayerId);
    return new Set(ids);
  });
  // a new selection opens whatever holds it, and a group tapped earlier lets go
  createEffect(
    on(
      () => [editor.activeLayerId, step()?.step.id] as const,
      () => {
        setPickedGroup(null);
        for (const id of holds()) setFolded(id, false);
      },
    ),
  );
  const ctx: TreeContext = { selected, holds, thumb };
  return <StageRows nodes={tree()} depth={props.indent ?? 0} guides={[]} ctx={ctx} />;
}

function StageRows(props: { nodes: readonly StageNode[]; depth: number; guides: readonly boolean[]; ctx: TreeContext }) {
  // topmost first, as stacks are read
  const ordered = () => [...props.nodes].reverse();
  return (
    <For each={ordered()}>
      {(node) => {
        const id = node.kind === "layer" ? (node.layer as Layer).id : (node.group as LayerGroup).id;
        const inner = () => [...props.guides, props.ctx.holds().has(id)];
        return node.kind === "layer" ? (
          <>
            <LayerRow layer={node.layer as Layer} depth={props.depth} guides={props.guides} ctx={props.ctx} />
            <Show when={(node.layer as Layer).shape && !isFolded(id)}>
              <ShapeRows layerId={id} depth={props.depth + 1} guides={inner()} selected={props.ctx.selected} />
            </Show>
          </>
        ) : (
          <>
            <GroupRow group={node.group as LayerGroup} depth={props.depth} guides={props.guides} ctx={props.ctx} hasChildren={node.children.length > 0} />
            <Show when={!isFolded(id)}>
              <StageRows nodes={node.children} depth={props.depth + 1} guides={inner()} ctx={props.ctx} />
            </Show>
          </>
        );
      }}
    </For>
  );
}

/** Tags a row shows after its name: its blend, effects and mask. */
function StageTags(props: { blend?: Blend; effects?: readonly Effect[]; masked?: boolean }) {
  return (
    <>
      <Show when={blendTag(props.blend)}>{(t) => <span class="layer-tag">{t()}</span>}</Show>
      <Show when={props.effects?.length}>
        <span class="layer-tag" title={props.effects!.map(effectLabel).join(", ")}>
          fx
        </span>
      </Show>
      <Show when={props.masked}>
        <span class="layer-tag">mask</span>
      </Show>
    </>
  );
}

function GroupRow(props: { group: LayerGroup; depth: number; guides: readonly boolean[]; ctx: TreeContext; hasChildren: boolean }) {
  const app = useApp();
  const { editor } = app;
  const [editing, setEditing] = createSignal(false);
  const id = () => props.group.id;
  const setVisible = (v: boolean) => editor.setGroupVisible(id(), v);
  let openMenu: (() => void) | undefined;
  const items = () => groupMenuItems(app, id(), () => setEditing(true));
  const tile = (
    <span class="tree-tile">
      <Icon name="folder" size={16} />
    </span>
  );
  return (
    <TreeRow
      class="group-row"
      depth={props.depth}
      guides={props.guides}
      selected={props.ctx.selected() === id()}
      holds={props.ctx.holds().has(id())}
      hidden={!props.group.visible}
      onMenu={() => {
        setPickedGroup(id());
        openWhenShown(openMenu);
      }}
      fold={
        props.hasChildren
          ? { open: !isFolded(id()), toggle: () => setFolded(id(), !isFolded(id())), label: isFolded(id()) ? "Open group" : "Close group" }
          : undefined
      }
    >
      <Show
        when={editing()}
        fallback={
          <button
            type="button"
            class="tree-main"
            aria-current={props.ctx.selected() === id() ? "true" : undefined}
            onClick={() => setPickedGroup(id())}
            onDblClick={() => setEditing(true)}
          >
            {tile}
            <span class="tree-name">{props.group.name}</span>
            <StageTags blend={props.group.blend} effects={props.group.effects} />
          </button>
        }
      >
        <span class="tree-main">
          {tile}
          <input
            class="tree-rename"
            value={props.group.name}
            ref={(el) => queueMicrotask(() => el.select())}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                e.currentTarget.value = props.group.name;
                e.currentTarget.blur();
              }
            }}
            onBlur={(e) => {
              const name = e.currentTarget.value.trim();
              if (name && name !== props.group.name) editor.renameGroup(id(), name);
              setEditing(false);
            }}
          />
        </span>
      </Show>
      <RowEnd visible={props.group.visible} setVisible={setVisible} menu={items} menuLabel="Group options" control={(f) => (openMenu = f)} />
    </TreeRow>
  );
}

/** The + that makes a layer: a button, or with vector layers on, a menu of the kinds. */
export function NewLayerButton() {
  const app = useApp();
  const { actions, shapes } = app;
  return (
    <Show
      when={shapes()}
      fallback={<IconButton icon="plus" label="New layer" kbd={actions.newLayer.kbd} class="small" onClick={actions.newLayer.run} />}
    >
      <Menu icon="plus" label="New layer" placement="bottom-end" buttonClass="small" items={() => newLayerItems(app)} />
    </Show>
  );
}

export function LayersPanel() {
  return (
    <section class="panel layers-panel" aria-label="Layers">
      <header class="panel-header">
        <span class="panel-title">Layers</span>
        <NewLayerButton />
      </header>
      <ul class="layer-list">
        <LayerRows />
      </ul>
    </section>
  );
}

function LayerRow(props: { layer: Layer; depth: number; guides: readonly boolean[]; ctx: TreeContext }) {
  const app = useApp();
  const { editor } = app;
  const [editing, setEditing] = createSignal(false);

  const kind = () => layerKind(props.layer);
  const setVisible = (v: boolean) => editor.setLayerVisible(props.layer.id, v);
  const setLocked = (v: boolean) => editor.setLayerLocked(props.layer.id, v);
  let openMenu: (() => void) | undefined;
  const select = () => {
    setPickedGroup(null);
    editor.selectLayer(props.layer.id);
    // the layer itself, not a shape in it
    if (editor.selectedStep) editor.selectStep(null, props.layer.id);
  };

  const items = () => layerMenuItems(app, props.layer.id, () => setEditing(true));

  const id = () => props.layer.id;
  const badge = (): IconName => (kind() === "shape" ? "pen" : kind() === "override" ? "erase" : "voxels");
  const kindName = () => (kind() === "shape" ? "Vector layer" : kind() === "override" ? "Override layer" : "Voxel layer");
  const tile = () => (
    <span class="tree-tile" title={kindName()}>
      <Show when={props.ctx.thumb(id())} fallback={<span class="tree-thumb" />}>
        {(src) => <img class="tree-thumb" src={src()} alt="" draggable={false} />}
      </Show>
      <span class="tree-badge" data-kind={kind()}>
        <Icon name={badge()} size={10} />
      </span>
    </span>
  );
  return (
    <TreeRow
      class="layer-tree-row"
      depth={props.depth}
      guides={props.guides}
      selected={props.ctx.selected() === id()}
      holds={props.ctx.holds().has(id())}
      hidden={!props.layer.visible}
      attrs={{ "data-kind": kind() }}
      onMenu={() => {
        select();
        openWhenShown(openMenu);
      }}
      fold={
        kind() === "shape"
          ? { open: !isFolded(id()), toggle: () => setFolded(id(), !isFolded(id())), label: isFolded(id()) ? "Show shapes" : "Hide shapes" }
          : undefined
      }
    >
      <Show
        when={editing()}
        fallback={
          <button
            type="button"
            class="tree-main"
            aria-current={props.ctx.selected() === id() ? "true" : undefined}
            aria-label={`${props.layer.name}, ${kindName().toLowerCase()}`}
            onClick={select}
            onDblClick={() => setEditing(true)}
          >
            {tile()}
            <span class="tree-name">{props.layer.name}</span>
            <StageTags blend={props.layer.blend} effects={props.layer.effects} masked={!!props.layer.mask} />
          </button>
        }
      >
        <span class="tree-main">
          {tile()}
          <input
            class="tree-rename"
            value={props.layer.name}
            ref={(el) => queueMicrotask(() => el.select())}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                e.currentTarget.value = props.layer.name;
                e.currentTarget.blur();
              }
            }}
            onBlur={(e) => {
              editor.renameLayer(props.layer.id, e.currentTarget.value);
              setEditing(false);
            }}
          />
        </span>
      </Show>
      <RowEnd
        visible={props.layer.visible}
        setVisible={setVisible}
        locked={!!props.layer.locked}
        setLocked={setLocked}
        menu={items}
        menuLabel="Layer options"
        control={(f) => (openMenu = f)}
      />
    </TreeRow>
  );
}
