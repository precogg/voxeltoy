import { Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { useApp } from "./context";
import { mainMenuItems } from "./menus";
import type { Action } from "./actions";
import { IconButton, Menu } from "./primitives";

export function MainBar() {
  const app = useApp();
  const { editor, actions, host } = app;
  const items = () => mainMenuItems(app);

  return (
    <div class="panel bar">
      <Menu icon="menu" label="Menu" items={items} />
      <IconButton
        icon="undo"
        label="Undo"
        kbd={actions.undo.kbd}
        disabled={!((actions.undo as Action).enabled?.() ?? editor.canUndo)}
        onClick={actions.undo.run}
      />
      <IconButton
        icon="redo"
        label="Redo"
        kbd={actions.redo.kbd}
        disabled={!((actions.redo as Action).enabled?.() ?? editor.canRedo)}
        onClick={actions.redo.run}
      />
      {/* only where the browser offers a headset view: on a headset */}
      <Show when={actions.enterHeadset.when()}>
        <IconButton icon="headset" label={actions.enterHeadset.label} onClick={actions.enterHeadset.run} />
      </Show>
      <Show when={host.components?.LayersPanel !== null}>
        <div class="bar-divider" />
        <IconButton
          icon="layers"
          label="Layers"
          active={app.layersOpen()}
          onClick={() => app.setLayersOpen(!app.layersOpen())}
        />
      </Show>
      <Show when={host.components?.Timeline !== null}>
        <IconButton
          icon="film"
          label={actions.toggleTimeline.label}
          kbd={actions.toggleTimeline.kbd}
          active={app.timelineOpen()}
          onClick={actions.toggleTimeline.run}
        />
      </Show>
      <Show when={host.mainBar}>{(component) => <Dynamic component={component()} />}</Show>
    </div>
  );
}
