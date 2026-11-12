import { createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import type { SyncStatus } from "@voxeltoy/sync/client";
import { toHex } from "@voxeltoy/core/color";
import { linkUrl, ownerKey, type ShareRecord } from "./session";
import { DialogFrame, Icon, IconButton, Menu, useApp, type MenuItem } from "@voxeltoy/sdk";
import { useSession } from "./session-context";

/** Run an async action, showing its error as a notice. */
function useRun() {
  const { editor } = useApp();
  return (fn: () => Promise<unknown>) => fn().catch((e: Error) => editor.notify(e.message || "Something went wrong"));
}

function copyText(text: string, done: string) {
  const { editor } = useApp();
  return () =>
    navigator.clipboard
      .writeText(text)
      .then(() => editor.notify(done))
      .catch(() => editor.notify("Couldn't copy; select the text and copy it"));
}

export function ShareDialog() {
  const session = useSession();
  const title = () => (session.mode === "room" ? "Live session" : session.mode === "snapshot" ? "Shared snapshot" : "Share");
  return (
    <DialogFrame title={title()}>
      <div class="dialog-body share">
        <Switch>
          <Match when={session.mode === "local"}>
            <ShareLocal />
          </Match>
          <Match when={session.mode === "snapshot"}>
            <ShareSnapshot />
          </Match>
          <Match when={session.mode === "room"}>
            <ShareRoom />
          </Match>
        </Switch>
      </div>
    </DialogFrame>
  );
}

// #region Local

function ShareLocal() {
  const session = useSession();
  const run = useRun();
  const [created, setCreated] = createSignal<ShareRecord | null>(null);
  const share = () => {
    const c = created();
    return c && session.shares.find((s) => s.id === c.id);
  };
  onMount(() => {
    if (session.liveEnabled) void session.checkStatus();
  });

  return (
    <>
      <p class="hint">{session.shareBlocker ?? "Sharing uploads a copy of this model. It stays on this device too."}</p>
      <Show
        when={share()}
        fallback={
          <button
            type="button"
            class="button primary"
            disabled={!!session.busy || !!session.shareBlocker}
            onClick={() => run(async () => setCreated(await session.createSnapshot()))}
          >
            {session.busy === "Creating link…" ? session.busy : "Create view link"}
          </button>
        }
      >
        {(s) => (
          <>
            <LinkField
              label="View link"
              url={linkUrl({ kind: "snapshot", id: s().id, token: s().viewToken! })}
              hint="Anyone with this link can look at this version and make their own copy. Later changes aren't included: share again for a new version."
            />
            <OwnerKey share={s()} />
          </>
        )}
      </Show>
      <Show when={session.liveEnabled}>
        <div class="field">
          <span class="field-label">Work together</span>
          <p class="hint">
            {!session.roomsOn
              ? "Live sessions are turned off for now. Try again later."
              : session.liveBlocker && !session.shareBlocker
                ? session.liveBlocker
                : "A live session starts from a copy of this model. Everyone with the edit link can change it with you; the model on this device stays as it is."}
          </p>
          <button
            type="button"
            class="button"
            disabled={!!session.busy || !session.roomsOn || !!session.liveBlocker}
            onClick={() => run(() => session.startLive())}
          >
            {session.busy === "Starting live session…" ? session.busy : "Start live session"}
          </button>
        </div>
      </Show>
      <SharedList />
      <AddOwnerKey />
    </>
  );
}

/** The links this device created (or has owner keys for), to copy, renew or stop. */
function SharedList() {
  const app = useApp();
  const session = useSession();
  const run = useRun();
  const date = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  const items = (s: ShareRecord): MenuItem[] => {
    const view = s.viewToken && linkUrl({ kind: s.kind, id: s.id, token: s.viewToken });
    const edit = s.editToken && linkUrl({ kind: s.kind, id: s.id, token: s.editToken });
    return [
      ...(s.kind === "room" && s.editToken
        ? [{ label: "Join", onSelect: () => run(() => session.open({ kind: "room", id: s.id, token: s.editToken! }).then(() => app.setDialog(null))) }]
        : []),
      ...(view ? [{ label: "Copy view link", onSelect: copyLink(view) }] : []),
      ...(edit ? [{ label: "Copy edit link", onSelect: copyLink(edit) }] : []),
      { label: "New view link", onSelect: () => run(() => session.rotate(s, "view")) },
      ...(s.kind === "room" ? [{ label: "New edit link", onSelect: () => run(() => session.rotate(s, "edit")) }] : []),
      { label: "Copy owner key", onSelect: copyKey(s) },
      "separator",
      {
        label: s.kind === "room" ? "End session" : "Stop sharing",
        danger: true,
        onSelect: () => {
          const what = s.kind === "room" ? "End this live session for everyone? Its links stop working." : "Stop sharing? The link stops working.";
          if (confirm(what)) run(() => session.stop(s));
        },
      },
      { label: "Forget on this device", onSelect: () => confirm("Forget this link? Without its owner key you can't manage it anymore.") && session.forget(s) },
    ];
  };

  const copyLink = (url: string) => () => {
    navigator.clipboard.writeText(url).then(
      () => app.editor.notify("Link copied"),
      () => app.editor.notify("Couldn't copy the link"),
    );
  };
  const copyKey = (s: ShareRecord) => () => {
    navigator.clipboard.writeText(ownerKey(s)).then(
      () => app.editor.notify("Owner key copied"),
      () => app.editor.notify("Couldn't copy the key"),
    );
  };

  return (
    <Show when={session.shares.length}>
      <div class="field">
        <span class="field-label">Shared from this device</span>
        <ul class="share-list">
          <For each={session.shares}>
            {(s) => (
              <li class="share-row">
                <Icon name={s.kind === "room" ? "share" : "link"} size={18} />
                <span class="share-name">{s.name}</span>
                <span class="share-meta">
                  {s.kind === "room" ? "Live" : "Snapshot"} · {date(s.created)}
                </span>
                <Menu icon="dots" label={`Manage ${s.name}`} items={() => items(s)} placement="bottom-end" />
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
}

function AddOwnerKey() {
  const { editor } = useApp();
  const session = useSession();
  const run = useRun();
  const [open, setOpen] = createSignal(false);
  const [key, setKey] = createSignal("");
  return (
    <Show
      when={open()}
      fallback={
        <button type="button" class="text-button" onClick={() => setOpen(true)}>
          Manage a link with an owner key…
        </button>
      }
    >
      <form
        class="field"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const share = await session.importOwnerKey(key());
            editor.notify(`Added “${share.name}”`);
            setKey("");
            setOpen(false);
          });
        }}
      >
        <span class="field-label">Owner key</span>
        <div class="link-field">
          <input
            class="text-input"
            placeholder="voxeltoy-owner:…"
            value={key()}
            onInput={(e) => setKey(e.currentTarget.value)}
            autocomplete="off"
            spellcheck={false}
          />
          <button type="submit" class="button" disabled={!key().trim()}>
            Add
          </button>
        </div>
      </form>
    </Show>
  );
}

// #endregion

// #region Snapshot

function ShareSnapshot() {
  const { actions } = useApp();
  const session = useSession();
  return (
    <>
      <p class="hint">A copy someone shared. You can look around, select and download it; make a copy to edit it on this device.</p>
      <button type="button" class="button primary" onClick={actions.makeCopy.run}>
        Make a copy
      </button>
      <div class="button-row">
        <button type="button" class="button" onClick={actions.save.run}>
          <Icon name="download" size={18} />
          Download
        </button>
        <button type="button" class="button" onClick={actions.leaveSession.run}>
          Back to my model
        </button>
      </div>
      <Show when={session.link}>{(link) => <LinkField label="This link" url={linkUrl(link())} />}</Show>
      <Show when={session.ownShare}>{(share) => <OwnerControls share={share()} />}</Show>
    </>
  );
}

// #endregion

// #region Live

const STATUS_TEXT: Record<SyncStatus, string> = {
  connecting: "Connecting…",
  saving: "Saving…",
  saved: "Saved",
  reconnecting: "Reconnecting…",
  closed: "Ended",
};

/** A live session's state in a word, as people see it. */
export function statusLabel(status: SyncStatus | undefined, viewOnly: boolean) {
  if (!status) return "";
  if (viewOnly && (status === "saved" || status === "saving")) return "View only";
  return STATUS_TEXT[status];
}

const STATUS_HINT: Record<SyncStatus, string> = {
  connecting: "Getting the latest version.",
  saving: "Your latest changes are on their way to the server.",
  saved: "Everything you changed is stored on the server.",
  reconnecting: "The connection dropped. Editing pauses until it's back; nothing you did is lost.",
  closed: "",
};

function ShareRoom() {
  const app = useApp();
  const { actions } = app;
  const session = useSession();
  const client = () => session.client;
  const status = () => client()?.status ?? "connecting";
  const editLink = () => {
    const link = session.link;
    if (!link) return null;
    if (client()?.role === "edit") return linkUrl(link);
    const own = session.ownShare;
    return own?.editToken ? linkUrl({ kind: "room", id: own.id, token: own.editToken }) : null;
  };
  const viewLink = () => {
    const link = session.link;
    if (!link) return null;
    if (client()?.role === "view") return linkUrl(link);
    const own = session.ownShare;
    return own?.viewToken ? linkUrl({ kind: "room", id: own.id, token: own.viewToken }) : null;
  };

  return (
    <>
      <div class="status-line" data-status={status()}>
        <span class="status-dot" />
        <strong>{statusLabel(status(), session.viewOnly)}</strong>
        <span class="hint">{status() === "closed" ? client()?.closedReason : session.viewOnly ? "You can look, but not change anything." : STATUS_HINT[status()]}</span>
      </div>

      <Show when={status() !== "closed"}>
        <label class="field">
          <span class="field-label">Your name</span>
          <div class="name-field">
            <span class="peer-dot" style={{ background: toHex(session.identity.color) }} />
            <input
              class="text-input"
              value={session.identity.name}
              maxLength={40}
              onChange={(e) => session.setName(e.currentTarget.value)}
              autocomplete="nickname"
            />
          </div>
        </label>

        <div class="field">
          <span class="field-label">Here now · {client()?.peers.length ?? 0}</span>
          <ul class="peer-list">
            <For each={client()?.peers ?? []}>
              {(peer) => (
                <li class="peer-row">
                  <span class="peer-dot" style={{ background: toHex(peer.color) }} />
                  <span class="share-name">
                    {peer.name}
                    {peer.actor === client()?.actor ? " (you)" : ""}
                  </span>
                  <span class="share-meta">
                    {peer.role === "view"
                      ? "Viewing"
                      : (app.editor.layers.find((l) => l.id === peer.layer)?.name ?? "Editing")}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </div>

        <Show when={editLink()}>
          {(url) => <LinkField label="Edit link" url={url()} hint="Anyone with this link can change the model." />}
        </Show>
        <Show when={viewLink()}>{(url) => <LinkField label="View link" url={url()} hint="Anyone with this link can watch." />}</Show>
        <Show when={session.ownShare}>{(share) => <OwnerControls share={share()} />}</Show>
      </Show>

      <div class="button-row">
        <button type="button" class="button" onClick={actions.makeCopy.run}>
          Make a local copy
        </button>
        <button type="button" class="button" onClick={actions.leaveSession.run}>
          Back to my model
        </button>
      </div>
    </>
  );
}

// #endregion

// #region Parts

function LinkField(props: { label: string; url: string; hint?: string }) {
  const { editor } = useApp();
  const share = () =>
    navigator.share?.({ url: props.url, title: `${editor.name} on Voxeltoy` }).catch(() => {
      // cancelled
    });
  return (
    <div class="field">
      <span class="field-label">{props.label}</span>
      <div class="link-field">
        <input class="text-input" readOnly value={props.url} onFocus={(e) => e.currentTarget.select()} aria-label={props.label} />
        <IconButton icon="copy" label="Copy link" onClick={copyText(props.url, "Link copied")} />
        <Show when={typeof navigator.share === "function"}>
          <IconButton icon="share" label="Share link" onClick={share} />
        </Show>
      </div>
      <Show when={props.hint}>
        <p class="hint small">{props.hint}</p>
      </Show>
    </div>
  );
}

/** The owner key: shown once after creating a link, to keep somewhere safe. */
function OwnerKey(props: { share: ShareRecord }) {
  const save = () => {
    const blob = new Blob([`${ownerKey(props.share)}\n`], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${props.share.name.replace(/[\\/:*?"<>|]+/g, "-") || "Voxeltoy"} owner key.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  return (
    <div class="field owner-key">
      <span class="field-label">Owner key</span>
      <p class="hint small">
        It renews or stops this link. This browser keeps it; save a copy to manage the link elsewhere, or after clearing your
        browser data. It isn't part of the link.
      </p>
      <div class="button-row">
        <button type="button" class="button" onClick={copyText(ownerKey(props.share), "Owner key copied")}>
          Copy key
        </button>
        <button type="button" class="button" onClick={save}>
          Save key
        </button>
      </div>
    </div>
  );
}

function OwnerControls(props: { share: ShareRecord }) {
  const { actions } = useApp();
  const session = useSession();
  const run = useRun();
  const room = () => props.share.kind === "room";
  return (
    <div class="field">
      <span class="field-label">You own this link</span>
      <div class="button-row">
        <button type="button" class="button" onClick={() => run(() => session.rotate(props.share, "view"))}>
          New view link
        </button>
        <Show when={room()}>
          <button type="button" class="button" onClick={() => run(() => session.rotate(props.share, "edit"))}>
            New edit link
          </button>
        </Show>
      </div>
      <p class="hint small">A new link replaces the old one, which stops working, also for anyone using it now.</p>
      <button
        type="button"
        class="button danger"
        onClick={() => {
          const what = room() ? "End this live session for everyone? Its links stop working." : "Stop sharing? The link stops working.";
          if (!confirm(what)) return;
          run(async () => {
            await session.stop(props.share);
            if (!room()) actions.leaveSession.run();
          });
        }}
      >
        {room() ? "End session for everyone" : "Stop sharing"}
      </button>
    </div>
  );
}

// #endregion
