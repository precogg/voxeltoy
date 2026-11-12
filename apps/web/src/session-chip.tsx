import { For, Show } from "solid-js";
import { toHex } from "@voxeltoy/core/color";
import { IconButton, useApp } from "@voxeltoy/sdk";
import { useSession } from "./session-context";
import { statusLabel } from "./share-dialog";

/** The main bar's end: Share for the local draft, or where a shared document stands. */
export function SessionControls() {
  const app = useApp();
  const session = useSession();
  return (
    <>
      <Show when={session.mode === "local"}>
        <IconButton icon="share" label="Share" active={app.dialog() === "share"} onClick={() => app.setDialog("share")} />
      </Show>
      <Show when={session.mode !== "local"}>
        <SessionChip />
      </Show>
    </>
  );
}

/** Where a shared document stands: view only, or a live session's connection and people. Tap for details. */
function SessionChip() {
  const app = useApp();
  const session = useSession();
  const client = () => session.client;
  const others = () => (client()?.peers ?? []).filter((p) => p.actor !== client()?.actor);
  const label = () =>
    session.mode === "snapshot" ? "View only" : statusLabel(client()?.status, session.viewOnly);
  return (
    <button
      type="button"
      class="session-chip"
      data-status={session.mode === "snapshot" ? "view" : client()?.status}
      aria-label={`${session.mode === "snapshot" ? "Shared snapshot" : "Live session"}: ${label()}`}
      onClick={() => app.setDialog("share")}
    >
      <span class="status-dot" />
      <span class="session-label">{label()}</span>
      <Show when={others().length}>
        <span class="peer-stack" aria-hidden="true">
          <For each={others().slice(0, 3)}>
            {(peer) => (
              <span class="peer-dot" title={peer.name} style={{ background: toHex(peer.color) }}>
                {peer.name[0]}
              </span>
            )}
          </For>
          <Show when={others().length > 3}>
            <span class="peer-more">+{others().length - 3}</span>
          </Show>
        </span>
        <span class="peer-count">{others().length + 1}</span>
      </Show>
    </button>
  );
}
