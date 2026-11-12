import { Show } from "solid-js";
import { useApp } from "./context";
import { IconButton } from "./primitives";

/** Shown while an extrusion is pending: its depth, with steps for when a drag can't reach, and cancel / apply. */
export function ExtrudeBar() {
  const { editor, actions } = useApp();
  const depth = () => editor.pendingExtrusion?.depth ?? 0;
  return (
    <Show when={editor.pendingExtrusion}>
      <div class="panel bar shape-bar" role="toolbar" aria-label="Extrusion">
        <IconButton icon="minus" label={actions.extrudeLess.label} kbd={actions.extrudeLess.kbd} onClick={actions.extrudeLess.run} />
        <span class="extrude-depth" data-carve={depth() < 0 ? "" : undefined} title={depth() < 0 ? "Carving in" : "Pulling out"}>
          {depth() > 0 ? `+${depth()}` : depth() < 0 ? `−${-depth()}` : "0"}
        </span>
        <IconButton icon="plus" label={actions.extrudeMore.label} kbd={actions.extrudeMore.kbd} onClick={actions.extrudeMore.run} />
        <div class="bar-divider" />
        <IconButton icon="close" label={actions.cancelExtrusion.label} kbd="escape" onClick={actions.cancelExtrusion.run} />
        <IconButton
          icon="check"
          label={actions.applyExtrusion.label}
          kbd={actions.applyExtrusion.kbd}
          class="primary"
          onClick={actions.applyExtrusion.run}
        />
      </div>
    </Show>
  );
}
