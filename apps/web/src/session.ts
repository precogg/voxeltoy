// What the editor is showing: the local draft, a shared snapshot (view only), or a live room.
// Sharing uploads a copy; the local draft in localStorage is never replaced by opening a link,
// only by "Make a copy" (which asks first) or by opening a file. See docs/collaboration.md.

import { batch, createSignal } from "solid-js";
import { SyncClient, type PendingEdit } from "@voxeltoy/sync/client";
import { decodeOps, decodeSnapshot, encodeOps, encodeSnapshot, type WireOp } from "@voxeltoy/sync/protocol";
import type { Editor } from "@voxeltoy/core/editor";
import { loadAutosave, writeAutosave } from "./autosave";
import { readLocal, writeLocal } from "./storage";
import { parseMoxel, serializeMoxel } from "@voxeltoy/core/formats/moxel";
import type { DocumentData } from "@voxeltoy/core/types";

export type SessionMode = "local" | "snapshot" | "room";
export type ShareKind = "snapshot" | "room";

/** A link this device created, with the owner token that manages it. */
export interface ShareRecord {
  kind: ShareKind;
  id: string;
  name: string;
  created: number;
  ownerToken: string;
  viewToken?: string;
  editToken?: string;
}

export interface Link {
  kind: ShareKind;
  id: string;
  token: string;
}

export interface Identity {
  name: string;
  color: number;
}

const SHARES_KEY = "voxeltoy:shares";
const LEGACY_SHARES_KEY = "moxel:shares";
const IDENTITY_KEY = "voxeltoy:identity";
const LEGACY_IDENTITY_KEY = "moxel:identity";
const LIVE_KEY = "voxeltoy:live";
const LEGACY_LIVE_KEY = "moxel:live";
const roomKey = (id: string) => `voxeltoy:room:${id}`;
const legacyRoomKey = (id: string) => `moxel:room:${id}`;

const VIEW_ONLY_SNAPSHOT = "This is a shared snapshot. Make a copy to edit it.";

// #region Links

const HASH_KINDS: Record<string, ShareKind> = { snapshot: "snapshot", live: "room" };

/** A share link from a URL hash: #snapshot/<id>/<token> or #live/<id>/<token>. */
export function parseLink(hash: string): Link | null {
  const match = /^#(snapshot|live)\/([a-z0-9]{20})\/([\w-]{20,100})$/.exec(hash.trim());
  return match ? { kind: HASH_KINDS[match[1]], id: match[2], token: match[3] } : null;
}

export function linkUrl(link: Link) {
  const base = `${location.origin}${location.pathname}`;
  return `${base}#${link.kind === "room" ? "live" : "snapshot"}/${link.id}/${link.token}`;
}

/** An owner key: what manages a share from another device. Never part of a link. */
export function ownerKey(share: ShareRecord) {
  return `voxeltoy-owner:${share.kind}:${share.id}:${share.ownerToken}`;
}

export function parseOwnerKey(text: string): Pick<ShareRecord, "kind" | "id" | "ownerToken"> | null {
  const match = /(?:voxeltoy|moxel)-owner:(snapshot|room):([a-z0-9]{20}):([\w-]{20,100})/.exec(text.trim());
  return match ? { kind: match[1] as ShareKind, id: match[2], ownerToken: match[3] } : null;
}

// #endregion

// #region Server

async function gzip(text: string): Promise<Blob> {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
}

async function gunzip(blob: Blob): Promise<string> {
  return new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

async function api(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  let response: Response;
  try {
    response = await fetch(`/api/${path}`, { ...init, headers });
  } catch {
    throw new Error("Couldn't reach the server. Check your connection.");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `The server said ${response.status}`);
  }
  return response;
}

// #endregion

// #region Identity

const ADJECTIVES = ["Amber", "Brisk", "Calm", "Dusty", "Eager", "Fuzzy", "Gentle", "Hazel", "Indigo", "Jolly", "Keen", "Lucky", "Mossy", "Nimble", "Olive", "Plucky", "Quiet", "Rusty", "Sunny", "Teal", "Witty"];
const ANIMALS = ["Badger", "Crane", "Dingo", "Egret", "Ferret", "Gecko", "Heron", "Ibis", "Jackal", "Koala", "Lemur", "Marten", "Newt", "Otter", "Panda", "Quail", "Robin", "Stoat", "Tapir", "Vole", "Wren"];
/** Distinct, readable on light and dark canvases. */
export const PEER_COLORS = [0xe5484d, 0xf76b15, 0xffc53d, 0x30a46c, 0x12a594, 0x0090ff, 0x6e56cf, 0xd6409f];

function newIdentity(): Identity {
  const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];
  return { name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color: pick(PEER_COLORS) };
}

function loadJson<T>(key: string, legacy: string, fallback: T): T {
  try {
    const text = readLocal(key, legacy);
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown) {
  return writeLocal(key, JSON.stringify(value));
}

// #endregion

/** What a live room keeps on this device, to show while offline and to resend what wasn't saved. */
interface RoomCache {
  name: string;
  revision: number;
  snapshot: ReturnType<typeof encodeSnapshot>;
  pending: { id: string; label: string; ops: WireOp[] }[];
}

/** A WebSocket to a room that reconnects with backoff until the session ends. */
class RoomSocket {
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: number | undefined;
  private ping: number | undefined;
  private stopped = false;

  constructor(
    private id: string,
    private client: () => SyncClient,
  ) {
    window.addEventListener("online", this.online);
    this.connect();
  }

  send(message: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private online = () => {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      clearTimeout(this.timer);
      this.connect();
    }
  };

  /** Reconnect now, as if the connection had dropped. */
  restart() {
    this.ws?.close();
  }

  private connect() {
    if (this.stopped) return;
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.host}/api/rooms/${this.id}/socket`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.client().open();
      clearInterval(this.ping);
      // the room answers pings without waking up; they keep proxies from closing the socket
      this.ping = window.setInterval(() => this.send({ type: "ping" }), 25_000);
    };
    ws.onmessage = (e) => {
      try {
        this.client().receive(JSON.parse(e.data as string));
      } catch (err) {
        console.error("Voxeltoy: bad message from the room", err);
      }
    };
    ws.onclose = () => {
      clearInterval(this.ping);
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      this.client().disconnected();
      if (this.client().status === "closed") return;
      const delay = Math.min(10_000, 500 * 2 ** this.retry++) * (0.75 + Math.random() / 2);
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.ping);
    window.removeEventListener("online", this.online);
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, "Leaving");
  }
}

const signal = <T>(value: T) => {
  const [get, set] = createSignal<T>(value, { equals: false });
  return { get, set: (v: T) => set(() => v) };
};

export class Session {
  private _mode = signal<SessionMode>("local");
  private _link = signal<Link | null>(null);
  private _client = signal<SyncClient | null>(null);
  private _shares = signal<ShareRecord[]>(loadJson(SHARES_KEY, LEGACY_SHARES_KEY, []));
  private _identity = signal<Identity>(loadJson<Identity | null>(IDENTITY_KEY, LEGACY_IDENTITY_KEY, null) ?? newIdentity());
  private _busy = signal<string | null>(null);
  private _roomsOn = signal(true);
  private socket: RoomSocket | null = null;
  /** Set while the session itself replaces the document, so that isn't taken for opening a file. */
  private loading = false;

  constructor(
    readonly editor: Editor,
    private hooks: { fit(): void },
  ) {
    saveJson(IDENTITY_KEY, this.identity);
    editor.onLoad((origin) => {
      // opening a file or starting a new model from a shared document makes it the local draft
      if (origin === "user" && !this.loading && this.mode !== "local") this.detach();
    });
  }

  // #region State

  get mode() {
    return this._mode.get();
  }
  /** The link this session was opened from. */
  get link() {
    return this._link.get();
  }
  /** The live room's client, in a room. */
  get client() {
    return this._client.get();
  }
  get shares() {
    return this._shares.get();
  }
  get identity() {
    return this._identity.get();
  }
  /** What the session is busy doing ("Creating link…"), or null. */
  get busy() {
    return this._busy.get();
  }
  /** Whether this device can start live sessions. Joining a live link always works. */
  get liveEnabled() {
    return import.meta.env.DEV || readLocal(LIVE_KEY, LEGACY_LIVE_KEY) === "1" || /[?&]live\b/.test(location.search);
  }
  /** Whether the server takes new live sessions; it can turn them off. Assumed until `checkStatus` says otherwise. */
  get roomsOn() {
    return this._roomsOn.get();
  }
  /** Ask the server whether live sessions are on. */
  async checkStatus() {
    try {
      const status = (await (await api("status")).json()) as { rooms?: boolean };
      this._roomsOn.set(status.rooms !== false);
    } catch {
      // offline or an older server: starting a session reports its own error
    }
  }
  /** The owner record for the open shared document, if this device created it (or has its owner key). */
  get ownShare(): ShareRecord | null {
    const link = this.link;
    return (link && this.shares.find((s) => s.kind === link.kind && s.id === link.id)) ?? null;
  }
  /** Whether people here can look but not change anything: a snapshot, or a view-only room link. */
  get viewOnly() {
    return this.mode === "snapshot" || (this.mode === "room" && this.client?.role === "view");
  }

  setName(name: string) {
    const identity = { ...this.identity, name: name.trim().slice(0, 40) || this.identity.name };
    this._identity.set(identity);
    saveJson(IDENTITY_KEY, identity);
    this.client?.presence({ name: identity.name });
  }

  // #endregion

  // #region Opening

  /** Open the link in the URL, if there is one. */
  async openFromLocation(): Promise<boolean> {
    const link = parseLink(location.hash);
    if (!link) return false;
    await this.open(link);
    return true;
  }

  async open(link: Link) {
    // the draft is saved before anything shared replaces it, and reloaded before another link opens
    if (this.mode === "local") writeAutosave(this.editor);
    else this.leave();
    if (link.kind === "snapshot") await this.openSnapshot(link);
    else this.openRoom(link);
    if (location.hash !== new URL(linkUrl(link)).hash) history.replaceState(null, "", linkUrl(link));
  }

  private async openSnapshot(link: Link) {
    this._busy.set("Opening snapshot…");
    try {
      const response = await api(`snapshots/${link.id}`, { token: link.token });
      const doc = parseMoxel(await gunzip(await response.blob()));
      this.replace(doc);
      batch(() => {
        this._mode.set("snapshot");
        this._link.set(link);
      });
      this.editor.setReadOnly(VIEW_ONLY_SNAPSHOT);
      this.hooks.fit();
    } catch (e) {
      this.clearHash();
      throw e;
    } finally {
      this._busy.set(null);
    }
  }

  private openRoom(link: Link) {
    const cache = loadJson<RoomCache | null>(roomKey(link.id), legacyRoomKey(link.id), null);
    const editor = this.editor;
    // until the room answers, show what this device saw last
    if (cache) {
      try {
        this.replace(decodeSnapshot(cache.snapshot));
      } catch {
        // a damaged cache; the room's snapshot replaces it anyway
      }
    }
    const client = new SyncClient(editor, {
      token: link.token,
      name: this.identity.name,
      color: this.identity.color,
      send: (message) => this.socket?.send(message),
      reconnect: () => this.socket?.restart(),
      onClose: () => this.socket?.stop(),
    });
    if (cache?.pending.length) {
      try {
        client.restore(cache.pending.map((p) => ({ id: p.id, label: p.label, ops: decodeOps(p.ops) })));
      } catch {
        // unreadable edits can't be sent anyway
      }
    }
    let first = true;
    const stopFit = editor.onLoad((origin) => {
      if (origin === "room" && first) {
        first = false;
        this.hooks.fit();
      }
    });
    batch(() => {
      this._mode.set("room");
      this._link.set(link);
      this._client.set(client);
    });
    this.socket = new RoomSocket(link.id, () => client);
    this.stopRoom = () => {
      stopFit();
      this.socket?.stop();
      this.socket = null;
      client.dispose();
    };
  }

  private stopRoom: (() => void) | null = null;

  /** Load a shared document without it counting as opening a file. */
  private replace(doc: DocumentData) {
    this.loading = true;
    try {
      this.editor.loadDocument(doc, "session");
    } finally {
      this.loading = false;
    }
  }

  /** Stop following the shared document; what is open stays open, as the local draft. */
  private detach() {
    const room = this.mode === "room" ? this.link : null;
    if (room) this.saveRoomCache(room.id);
    this.stopRoom?.();
    this.stopRoom = null;
    batch(() => {
      this._mode.set("local");
      this._link.set(null);
      this._client.set(null);
    });
    this.editor.setReadOnly(null);
    this.clearHash();
  }

  /** Close the shared document and go back to the local draft. */
  leave() {
    if (this.mode === "local") return;
    this.detach();
    const draft = loadAutosave();
    this.loading = true;
    try {
      if (draft) this.editor.loadDocument(draft, "session");
      else this.editor.newDocument();
    } finally {
      this.loading = false;
    }
    this.hooks.fit();
  }

  /** Make the open shared document the local draft, to edit on this device. The draft it replaces is gone. */
  makeCopy() {
    if (this.mode === "local") return;
    const doc = this.editor.getDocument();
    this.detach();
    // a copy is a new document: new layer ids, its own history
    const copy: DocumentData = { ...doc, gen: undefined, layers: doc.layers.map(({ id: _, ...l }) => ({ ...l, data: l.data.slice() })) };
    this.replace(copy);
    writeAutosave(this.editor);
    this.editor.notify("Copied to this device");
  }

  /** Whether the local draft has voxels that "Make a copy" would replace. */
  draftHasContent() {
    const draft = loadAutosave();
    return !!draft?.layers.some((l) => l.data.some((v) => v !== 0));
  }

  private clearHash() {
    if (parseLink(location.hash)) history.replaceState(null, "", `${location.pathname}${location.search}`);
  }

  // #endregion

  // #region Sharing

  private remember(share: ShareRecord) {
    const shares = [share, ...this.shares.filter((s) => !(s.kind === share.kind && s.id === share.id))];
    this._shares.set(shares);
    saveJson(SHARES_KEY, shares);
  }

  forget(share: ShareRecord) {
    const shares = this.shares.filter((s) => !(s.kind === share.kind && s.id === share.id));
    this._shares.set(shares);
    saveJson(SHARES_KEY, shares);
  }

  /** Why the open document can't be shared at all, if it can't: sharing would lose its shape and override layers. */
  get shareBlocker(): string | null {
    if (!this.editor.isFlat) return "Models with shape or override layers can't be shared yet. Save the .voxeltoy file to keep them editable";
    return null;
  }

  /** Why the open document can't start a live session, if it can't: rooms don't carry frames yet. */
  get liveBlocker(): string | null {
    return this.shareBlocker ?? ((this.editor.isAnimated || this.editor.tags.length > 0) ? "Animations can be shared as a view link, but not in a live session yet" : null);
  }

  private checkShareable(live = false) {
    const blocker = live ? this.liveBlocker : this.shareBlocker;
    if (blocker) throw new Error(blocker);
  }

  /** Upload a fixed copy of the open document behind a new view link. */
  async createSnapshot(): Promise<ShareRecord> {
    this.checkShareable();
    this._busy.set("Creating link…");
    try {
      const body = await gzip(serializeMoxel(this.editor.getDocument()));
      const response = await api("snapshots", { method: "POST", body });
      const created = (await response.json()) as { id: string; viewToken: string; ownerToken: string; name: string; created: number };
      const share: ShareRecord = { kind: "snapshot", ...created };
      this.remember(share);
      return share;
    } finally {
      this._busy.set(null);
    }
  }

  /** Upload the open document as a new live room, and move into it. The local draft stays as it was. */
  async startLive(): Promise<ShareRecord> {
    this.checkShareable(true);
    this._busy.set("Starting live session…");
    try {
      const doc = this.editor.getDocument();
      const body = await gzip(JSON.stringify(encodeSnapshot(doc)));
      const response = await api("rooms", { method: "POST", body });
      const created = (await response.json()) as {
        id: string;
        viewToken: string;
        editToken: string;
        ownerToken: string;
        name: string;
        created: number;
      };
      const share: ShareRecord = { kind: "room", ...created };
      this.remember(share);
      await this.open({ kind: "room", id: share.id, token: share.editToken! });
      return share;
    } catch (e) {
      void this.checkStatus();
      throw e;
    } finally {
      this._busy.set(null);
    }
  }

  /** Replace a link with a new one; the old one stops working, also for anyone using it now. */
  async rotate(share: ShareRecord, which: "view" | "edit") {
    const path = share.kind === "room" ? `rooms/${share.id}/rotate` : `snapshots/${share.id}/rotate`;
    const response = await api(path, {
      method: "POST",
      token: share.ownerToken,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ which }),
    });
    const tokens = (await response.json()) as { viewToken?: string; editToken?: string };
    const next = { ...share, ...tokens };
    this.remember(next);
    // keep this session on the new link
    const link = this.link;
    if (link?.id === share.id && link.token === (which === "view" ? share.viewToken : share.editToken)) {
      const token = which === "view" ? next.viewToken! : next.editToken!;
      this._link.set({ ...link, token });
      history.replaceState(null, "", linkUrl({ ...link, token }));
    }
    return next;
  }

  /** Delete a share on the server: its links stop working, and a live session ends for everyone. */
  async stop(share: ShareRecord) {
    try {
      await api(share.kind === "room" ? `rooms/${share.id}` : `snapshots/${share.id}`, { method: "DELETE", token: share.ownerToken });
    } catch (e) {
      // already gone is fine
      if (!/doesn't exist/.test((e as Error).message)) throw e;
    }
    this.forget(share);
    try {
      localStorage.removeItem(roomKey(share.id));
      localStorage.removeItem(legacyRoomKey(share.id));
    } catch {
      // nothing cached
    }
  }

  /** Add a share from an owner key, after checking it with the server. */
  async importOwnerKey(text: string): Promise<ShareRecord> {
    const key = parseOwnerKey(text);
    if (!key) throw new Error("That isn't a Voxeltoy owner key");
    const response = await api(`${key.kind === "room" ? "rooms" : "snapshots"}/${key.id}/info`, { token: key.ownerToken });
    const info = (await response.json()) as { name: string; created: number };
    const share: ShareRecord = { ...key, name: info.name, created: info.created };
    this.remember({ ...this.shares.find((s) => s.id === key.id), ...share });
    return share;
  }

  // #endregion

  // #region Saving

  /** Save what is open where it belongs: the local draft, or a live room's cache. */
  private autosaveFailed = false;

  autosave() {
    if (this.mode === "local") {
      // say so once when saving stops working (a large model can outgrow local storage), and once when it works again
      const ok = writeAutosave(this.editor);
      if (ok === this.autosaveFailed) {
        this.autosaveFailed = !ok;
        this.editor.notify(
          ok ? "Saving on this device works again" : "This model is too big to keep on this device. Save it as a file to keep your work",
        );
      }
      return ok;
    }
    else if (this.mode === "room" && this.link) return this.saveRoomCache(this.link.id);
    return true;
  }

  private saveRoomCache(id: string) {
    const client = this.client;
    if (!client || client.revision < 0) return false;
    const pending: PendingEdit[] = [...client.unconfirmed];
    return saveJson(roomKey(id), {
      name: this.editor.name,
      revision: client.revision,
      snapshot: encodeSnapshot(this.editor.getDocument()),
      pending: pending.map((p) => ({ id: p.id, label: p.label, ops: encodeOps(p.ops) })),
    } satisfies RoomCache);
  }

  dispose() {
    this.stopRoom?.();
  }

  // #endregion
}
