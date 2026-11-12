// One side of a live room: keeps the editor's document in step with the room. Edits made here
// show at once and are sent as they are committed; the room orders everyone's edits, and each
// client rebuilds "what the room has confirmed, plus my edits it hasn't answered yet" whenever
// someone else's edit arrives. Transport-agnostic and DOM-free: the session wires it to a
// WebSocket, the tests to an in-memory network.

import { createSignal } from "solid-js";
import type { Editor, LocalEdit } from "@voxeltoy/core/editor";
import { OpError, type DocOp } from "@voxeltoy/core/ops";
import type { Vec3 } from "@voxeltoy/core/types";
import {
  decodeOps,
  decodeSnapshot,
  editMessages,
  encodeOps,
  PROTOCOL_VERSION,
  type ClientMessage,
  type Peer,
  type RemoteEdit,
  type Role,
  type RoomSnapshot,
  type ServerMessage,
} from "./protocol";

/**
 * - connecting: waiting for the room to answer
 * - saving: some edits made here aren't confirmed yet
 * - saved: the room has durably accepted every edit made here
 * - reconnecting: the connection dropped; editing pauses until it is back
 * - closed: the session ended (deleted, access revoked); see `closedReason`
 */
export type SyncStatus = "connecting" | "saving" | "saved" | "reconnecting" | "closed";

export interface SyncOptions {
  token: string;
  name: string;
  color: number;
  send(message: ClientMessage): void;
  /** Ask the transport for a new connection (the protocol got out of step). */
  reconnect?(): void;
  /** The session ended for good. */
  onClose?(reason: string): void;
}

/** An edit made here that the room hasn't answered. */
export interface PendingEdit {
  id: string;
  label: string;
  /** The ops as applied here; the same objects the undo history holds. */
  ops: DocOp[];
  /** It no longer fits the document here, so it isn't applied; the room will turn it down. */
  doomed: boolean;
}

const signal = <T>(value: T) => {
  const [get, set] = createSignal<T>(value, { equals: false });
  return { get, set: (v: T) => set(() => v) };
};

export class SyncClient {
  private _status = signal<SyncStatus>("connecting");
  private _peers = signal<Peer[]>([]);
  private _role = signal<Role | null>(null);
  private _pending = signal(0);
  private pending: PendingEdit[] = [];
  /** The last revision applied here, or -1 before the first welcome. */
  revision = -1;
  actor = "";
  closedReason = "";
  private connected = false;
  private welcomed = false;
  private everWelcomed = false;
  private snapshotParts: { welcome: Extract<ServerMessage, { type: "welcome" }>; parts: string[] } | null = null;
  private stop: () => void;

  constructor(
    readonly editor: Editor,
    private options: SyncOptions,
  ) {
    this.stop = editor.onEdit((edit) => this.local(edit));
    editor.setReadOnly("Connecting…");
  }

  // #region State

  get status() {
    return this._status.get();
  }
  /** Everyone in the room, this client included. */
  get peers() {
    return this._peers.get();
  }
  get role() {
    return this._role.get();
  }
  /** How many edits made here wait for the room. */
  get pendingCount() {
    return this._pending.get();
  }
  /** The edits that wait for the room, for a local cache. */
  get unconfirmed(): readonly PendingEdit[] {
    return this.pending;
  }

  /**
   * Edits made here before a reload that the room may not have. They go back on top of the
   * room's document when it answers (the welcome says which it already has).
   */
  restore(edits: { id: string; label: string; ops: DocOp[] }[]) {
    // not applied here yet: the welcome applies them
    for (const edit of edits) this.pending.push({ ...edit, doomed: true });
    this.setStatus();
  }

  // #endregion

  // #region Transport

  /** The transport connected: say hello, asking for what changed since the last revision here. */
  open() {
    this.connected = true;
    this.welcomed = false;
    this.send({
      type: "hello",
      version: PROTOCOL_VERSION,
      token: this.options.token,
      name: this.options.name,
      color: this.options.color,
      revision: this.revision,
      pending: this.pending.map((p) => p.id),
    });
  }

  /** The transport dropped. Edits pause; unanswered ones wait to be sent again. */
  disconnected() {
    if (this._status.get() === "closed") return;
    this.connected = false;
    this.welcomed = false;
    this.snapshotParts = null;
    this.editor.setReadOnly(this.everWelcomed ? "Reconnecting… editing pauses until the connection is back" : "Connecting…");
    this.setStatus();
  }

  /** Stop listening to the editor. The document stays as it is. */
  dispose() {
    this.stop();
    this.connected = false;
  }

  receive(message: ServerMessage) {
    if (this._status.get() === "closed") return;
    switch (message.type) {
      case "welcome":
        if (message.snapshotParts) {
          this.snapshotParts = { welcome: message, parts: [] };
          return;
        }
        return this.welcome(message);
      case "snapshot": {
        const pending = this.snapshotParts;
        if (!pending) return;
        pending.parts[message.part] = message.data;
        if (pending.parts.filter((p) => p !== undefined).length < pending.welcome.snapshotParts!) return;
        this.snapshotParts = null;
        return this.welcome({ ...pending.welcome, snapshot: JSON.parse(pending.parts.join("")) as RoomSnapshot });
      }
      // until the welcome, answers are stale: the welcome covers them
      case "edit":
        return this.welcomed ? this.remote(message) : undefined;
      case "ack":
        return this.welcomed ? this.ack(message.id, message.revision) : undefined;
      case "reject":
        return this.welcomed ? this.reject(message.id, message.reason) : undefined;
      case "peers":
        return this._peers.set(message.peers);
      case "presence":
        return this._peers.set(
          this.peers.map((p) => (p.actor === message.actor ? { ...p, layer: message.layer, pointer: message.pointer } : p)),
        );
      case "error":
        if (message.close) return this.close(message.reason);
        this.editor.notify(message.reason);
        return;
      case "pong":
        return;
    }
  }

  /** Share where this person is working: their layer, and their pointer on the model. */
  presence(update: { layer?: string; pointer?: Vec3 | null; name?: string; color?: number }) {
    if (update.name !== undefined) this.options.name = update.name;
    if (update.color !== undefined) this.options.color = update.color;
    if (this.welcomed) this.send({ type: "presence", ...update });
  }

  private send(message: ClientMessage) {
    this.options.send(message);
  }

  private close(reason: string) {
    this.closedReason = reason;
    this.connected = false;
    this.welcomed = false;
    this.editor.setReadOnly(reason);
    this._status.set("closed");
    this.options.onClose?.(reason);
  }

  // #endregion

  // #region Edits

  private local(edit: LocalEdit) {
    const pending: PendingEdit = { id: edit.id, label: edit.label, ops: edit.ops, doomed: false };
    this.pending.push(pending);
    if (this.welcomed) this.sendEdit(pending);
    this.setStatus();
  }

  private sendEdit(pending: PendingEdit) {
    for (const message of editMessages(pending.id, encodeOps(pending.ops))) this.send(message);
  }

  private welcome(message: Extract<ServerMessage, { type: "welcome" }>) {
    this.actor = message.actor;
    this._role.set(message.role);
    this._peers.set(message.peers);
    const applied = new Map(message.applied.map((a) => [a.id, a.revision]));
    const rejected = new Map(message.rejected.map((r) => [r.id, r.reason]));

    if (message.snapshot) {
      // a fresh start: the snapshot includes every edit of ours the room applied
      const activeLayer = this.editor.activeLayerId;
      const notices = this.pending.filter((p) => rejected.has(p.id)).map((p) => `“${p.label}” wasn't saved: ${rejected.get(p.id)}`);
      this.pending = this.pending.filter((p) => !applied.has(p.id) && !rejected.has(p.id));
      let doc;
      try {
        doc = decodeSnapshot(message.snapshot);
      } catch (e) {
        return this.close(`This session can't be opened: ${(e as Error).message}`);
      }
      this.editor.loadDocument(doc, "room");
      this.editor.selectLayer(activeLayer);
      this.revision = message.revision;
      // what wasn't answered goes back on top
      for (const p of this.pending) {
        try {
          this.editor.applyOps(p.ops);
          p.doomed = false;
        } catch (e) {
          if (!(e instanceof OpError)) throw e;
          p.doomed = true;
        }
      }
      for (const notice of notices) this.editor.notify(notice);
    } else {
      for (const edit of message.edits ?? []) {
        if (this.pending.some((p) => p.id === edit.id)) this.ack(edit.id, edit.revision);
        else this.remote(edit);
      }
      for (const [id, reason] of rejected) this.reject(id, reason);
    }

    this.welcomed = true;
    this.everWelcomed = true;
    this.editor.setReadOnly(message.role === "view" ? "This link is view only" : null);
    for (const p of this.pending) this.sendEdit(p);
    this.setStatus();
  }

  /** Someone else's edit: put it under the edits of ours the room hasn't answered. */
  private remote(edit: RemoteEdit) {
    if (edit.revision !== this.revision + 1) return this.resync();
    let ops: DocOp[];
    try {
      ops = decodeOps(edit.ops);
    } catch {
      return this.resync();
    }
    let ok = true;
    this.editor.reconcile(ops, () => {
      ok = this.rebase(this.pending, () => this.editor.applyOps(ops));
      if (ok) this.editor.history.disown(ops);
    });
    if (!ok) return this.resync();
    this.revision = edit.revision;
    this.setStatus();
  }

  /**
   * Take `pending` edits off the document, run `fn`, then put them back on top. An edit that
   * no longer fits is left off (doomed). Returns false if `fn` failed with an `OpError`.
   */
  private rebase(pending: PendingEdit[], fn: () => void): boolean {
    const live = pending.filter((p) => !p.doomed);
    try {
      for (let i = live.length - 1; i >= 0; i--) this.editor.revertOps(live[i].ops);
    } catch (e) {
      if (e instanceof OpError) return false;
      throw e;
    }
    let ok = true;
    try {
      fn();
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      ok = false;
    }
    for (const p of live) {
      try {
        this.editor.applyOps(p.ops);
      } catch (e) {
        if (!(e instanceof OpError)) throw e;
        p.doomed = true;
      }
    }
    return ok;
  }

  private ack(id: string, revision: number) {
    const index = this.pending.findIndex((p) => p.id === id);
    if (index < 0) return;
    if (index > 0 || revision !== this.revision + 1) return this.resync();
    const [done] = this.pending.splice(0, 1);
    this.revision = revision;
    this.editor.history.confirm(id);
    // the room applied an edit that didn't fit here: we are out of step
    if (done.doomed) return this.resync();
    this.setStatus();
  }

  private reject(id: string, reason: string) {
    const index = this.pending.findIndex((p) => p.id === id);
    if (index < 0) return;
    const edit = this.pending[index];
    if (!edit.doomed) {
      const later = this.pending.slice(index + 1);
      this.editor.reconcile(edit.ops, () => {
        this.rebase(later, () => this.editor.revertOps(edit.ops));
      });
    }
    this.pending.splice(index, 1);
    this.editor.history.drop(id);
    this.editor.notify(`“${edit.label}” wasn't saved: ${reason}`);
    this.setStatus();
  }

  /** Out of step with the room: start again from a snapshot, keeping unanswered edits. */
  private resync() {
    this.revision = -1;
    this.welcomed = false;
    if (this.connected) this.open();
    else this.options.reconnect?.();
  }

  private setStatus() {
    this._pending.set(this.pending.length);
    if (this._status.get() === "closed") return;
    const status: SyncStatus = this.welcomed
      ? this.pending.length
        ? "saving"
        : "saved"
      : this.everWelcomed && !this.connected
        ? "reconnecting"
        : "connecting";
    this._status.set(status);
  }

  // #endregion
}
