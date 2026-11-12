// The authority for a live room: one copy of the document that every edit is checked against
// and applied to, in the order edits arrive. It numbers accepted edits (revisions), answers
// each edit once (a retried edit gets the same answer), and keeps recent edits so a client
// that reconnects can catch up. Plain TypeScript: the Durable Object adds sockets and storage,
// and the tests drive it directly.

import { decodeRle, encodeRle } from "@voxeltoy/core/formats/moxel";
import { applyOps, OpError, randomId, revertOps, type DocOp, type DocTarget, type LayerRecord } from "@voxeltoy/core/ops";
import type { DocumentData, Json, Vec3 } from "@voxeltoy/core/types";
import {
  decodeOps,
  decodeSnapshot,
  encodeOps,
  encodeSnapshot,
  LIMITS,
  PROTOCOL_VERSION,
  type ClientMessage,
  type Peer,
  type RemoteEdit,
  type Role,
  type RoomSnapshot,
  type ServerMessage,
  type WireOp,
} from "./protocol";

/** Cells per stored chunk of a layer. */
export const CHUNK_CELLS = 32 * 1024;
/** Recent edits kept for catching up. */
const LOG_EDITS = 500;
const LOG_CHARS = 4 * 1024 * 1024;
/** Answers remembered for retried edits. */
const ANSWERS = 4000;

const cellCount = (size: Vec3) => size[0] * size[1] * size[2];

/** What changed since the document was last saved. */
export interface Changes {
  /** Name, size, grid or palette. */
  meta: boolean;
  /** Layer names or order. */
  layers: boolean;
  /** Layers whose every chunk needs writing (new layers, or all of them after a resize). */
  full: Set<string>;
  removed: Set<string>;
  /** Chunks written to, by layer. */
  chunks: Map<string, Set<number>>;
}

const noChanges = (): Changes => ({ meta: false, layers: false, full: new Set(), removed: new Set(), chunks: new Map() });

/** A room's copy of the document: plain data, tracking what changed for storage. */
export class RoomDocument implements DocTarget {
  name: string;
  size: Vec3;
  gen: string;
  palette: readonly number[];
  layers: LayerRecord[];
  /** The creator's active layer, for people who join. */
  activeLayer: number;
  /** Host data by namespace, kept as it is. */
  hostData: Readonly<Record<string, Json>>;
  changes = noChanges();
  private owner = new WeakMap<Uint8Array, string>();

  constructor(doc: DocumentData) {
    this.name = doc.name;
    this.size = [...doc.size];
    this.gen = doc.gen!;
    this.palette = [...doc.palette];
    this.activeLayer = doc.activeLayer;
    this.hostData = doc.hostData ? { ...doc.hostData } : {};
    this.layers = doc.layers.map((l) => ({
      id: l.id!,
      name: l.name,
      data: l.data,
      visible: l.visible,
      locked: l.locked,
      ...(l.hostData !== undefined && l.hostData !== null ? { hostData: l.hostData } : {}),
      ...(l.extra ? { extra: l.extra } : {}),
    }));
    for (const l of this.layers) this.owner.set(l.data, l.id);
  }

  static fromSnapshot(snapshot: RoomSnapshot) {
    return new RoomDocument(decodeSnapshot(snapshot));
  }

  setName(name: string) {
    this.name = name;
    this.changes.meta = true;
  }

  setPalette(palette: readonly number[]) {
    this.palette = palette;
    this.changes.meta = true;
  }

  setHostData(data: Readonly<Record<string, Json>>) {
    this.hostData = data;
    this.changes.meta = true;
  }

  setLayers(layers: readonly LayerRecord[]) {
    const before = new Set(this.layers.map((l) => l.id));
    const after = new Set(layers.map((l) => l.id));
    for (const l of layers) {
      if (!before.has(l.id)) {
        this.changes.full.add(l.id);
        this.changes.removed.delete(l.id);
      }
      this.owner.set(l.data, l.id);
    }
    for (const id of before) if (!after.has(id)) this.changes.removed.add(id);
    this.layers = [...layers];
    this.changes.layers = true;
  }

  setGrid(size: Vec3, gen: string, layers: readonly LayerRecord[]) {
    this.size = size;
    this.gen = gen;
    this.changes.meta = true;
    for (const l of this.layers) this.changes.removed.add(l.id);
    this.setLayers(layers);
    for (const l of layers) this.changes.full.add(l.id);
  }

  writeCell(data: Uint8Array, index: number, value: number) {
    data[index] = value;
    const layer = this.owner.get(data);
    if (!layer) return;
    let chunks = this.changes.chunks.get(layer);
    if (!chunks) this.changes.chunks.set(layer, (chunks = new Set()));
    chunks.add(Math.floor(index / CHUNK_CELLS));
  }

  /** Take what changed since the last call. */
  takeChanges(): Changes {
    const changes = this.changes;
    this.changes = noChanges();
    return changes;
  }

  /** How many chunks a layer has. */
  get chunkCount() {
    return Math.ceil(cellCount(this.size) / CHUNK_CELLS);
  }

  /** One chunk of a layer, run-length encoded, or null when it is empty. */
  chunk(layer: LayerRecord, n: number): Uint8Array | null {
    const cells = layer.data.subarray(n * CHUNK_CELLS, (n + 1) * CHUNK_CELLS);
    if (!cells.some((v) => v !== 0)) return null;
    return encodeRle(cells);
  }

  /** Load a stored chunk into a layer's data. */
  static readChunk(data: Uint8Array, n: number, rle: Uint8Array) {
    const start = n * CHUNK_CELLS;
    const count = Math.min(CHUNK_CELLS, data.length - start);
    if (count > 0) data.set(decodeRle(rle, count), start);
  }

  toData(): DocumentData {
    return {
      name: this.name,
      size: [...this.size],
      gen: this.gen,
      palette: [...this.palette],
      activeLayer: Math.min(this.layers.length - 1, Math.max(0, this.activeLayer)),
      ...(Object.keys(this.hostData).length ? { hostData: { ...this.hostData } } : {}),
      layers: this.layers.map((l) => ({
        id: l.id,
        name: l.name,
        visible: l.visible ?? true,
        locked: l.locked ?? false,
        data: l.data,
        ...(l.hostData !== undefined ? { hostData: l.hostData } : {}),
        ...(l.extra ? { extra: { ...l.extra } } : {}),
      })),
    };
  }

  snapshot(): RoomSnapshot {
    return encodeSnapshot(this.toData());
  }

  /** Cells times layers, for the room's size limit. */
  get load() {
    return cellCount(this.size) * this.layers.length;
  }
}

export type Outcome = { revision: number; reason?: undefined } | { reason: string; revision?: undefined };

export type Submission =
  | { ok: true; edit: RemoteEdit; duplicate: boolean }
  | { ok: false; reason: string };

export class Room {
  /** Recent accepted edits, oldest first. */
  private log: RemoteEdit[];
  private logChars: number;
  private answers = new Map<string, Outcome>();

  constructor(
    readonly doc: RoomDocument,
    public revision = 0,
    log: RemoteEdit[] = [],
    answers: [string, Outcome][] = [],
  ) {
    this.log = log;
    this.logChars = log.reduce((n, e) => n + JSON.stringify(e.ops).length, 0);
    for (const [id, outcome] of answers) this.answers.set(id, outcome);
    for (const e of log) this.answers.set(e.id, { revision: e.revision });
  }

  /** What happened to an edit, if it was answered. */
  answer(id: string): Outcome | undefined {
    return this.answers.get(id);
  }

  /**
   * Check an edit against the document and apply it, all or nothing. An edit answered before
   * gets the same answer again.
   */
  submit(actor: string, id: string, wire: WireOp[]): Submission {
    const known = this.answers.get(id);
    if (known?.revision !== undefined) {
      const edit = this.log.find((e) => e.id === id) ?? { revision: known.revision, id, actor, ops: [] };
      return { ok: true, edit, duplicate: true };
    }
    if (known) return { ok: false, reason: known.reason };
    let ops: DocOp[];
    try {
      ops = decodeOps(wire, LIMITS.roomCells);
      applyOps(this.doc, ops, true);
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      return this.refuse(id, e.message);
    }
    if (this.doc.load > LIMITS.roomCells) {
      revertOps(this.doc, ops);
      return this.refuse(id, "The model is too big for a live session");
    }
    this.revision++;
    const edit: RemoteEdit = { revision: this.revision, id, actor, ops: encodeOps(ops) };
    this.log.push(edit);
    this.logChars += JSON.stringify(edit.ops).length;
    while (this.log.length > LOG_EDITS || (this.logChars > LOG_CHARS && this.log.length > 1)) {
      this.logChars -= JSON.stringify(this.log.shift()!.ops).length;
    }
    this.remember(id, { revision: this.revision });
    return { ok: true, edit, duplicate: false };
  }

  private refuse(id: string, reason: string): Submission {
    this.remember(id, { reason });
    return { ok: false, reason };
  }

  private remember(id: string, outcome: Outcome) {
    this.answers.set(id, outcome);
    if (this.answers.size > ANSWERS) this.answers.delete(this.answers.keys().next().value!);
  }

  /** The edits after `revision`, or null if they are no longer all kept (send a snapshot instead). */
  since(revision: number): RemoteEdit[] | null {
    if (revision < 0 || revision > this.revision) return null;
    if (revision === this.revision) return [];
    const first = this.log[0];
    if (!first || first.revision > revision + 1) return null;
    return this.log.filter((e) => e.revision > revision);
  }

  /** The edits kept for catching up, to store. */
  get recent(): readonly RemoteEdit[] {
    return this.log;
  }

  /** The answers to remember across restarts. */
  get remembered(): [string, Outcome][] {
    return [...this.answers];
  }
}

// #region Host

/** A person connected to a room. */
export interface Session {
  actor: string;
  role: Role;
  name: string;
  color: number;
  layer?: string;
  pointer?: Vec3 | null;
}

/** How a host reaches its sockets, checks tokens and saves edits. */
export interface HostIO<S> {
  send(socket: S, message: ServerMessage): void;
  /** The sockets with a session, and their sessions. */
  sessions(): Iterable<[S, Session]>;
  setSession(socket: S, session: Session): void;
  close(socket: S, reason: string): void;
  /** The role a token grants, or null. */
  authorize(token: string): Promise<Role | null> | Role | null;
  /** Save an accepted edit before it is acknowledged. */
  commit(edit: RemoteEdit): void;
}

interface Partial {
  id: string;
  parts: WireOp[][];
  received: number;
  chars: number;
}

/** Speak the room protocol over any transport: hello and welcome, edits and answers, presence. */
export class RoomHost<S> {
  private partials = new Map<S, Partial>();
  private budgets = new Map<S, { tokens: number; at: number }>();

  constructor(
    readonly room: Room,
    private io: HostIO<S>,
    private now = () => Date.now(),
  ) {}

  async message(socket: S, session: Session | null, text: string) {
    if (text.length > LIMITS.message + 4096) return this.error(socket, "Message too big");
    let msg: ClientMessage;
    try {
      msg = JSON.parse(text);
    } catch {
      return this.error(socket, "Malformed message");
    }
    if (msg?.type === "hello") return this.hello(socket, session, msg);
    if (!session) return this.error(socket, "Say hello first", "unauthorized");
    switch (msg.type) {
      case "edit":
        return this.edit(socket, session, msg);
      case "presence":
        return this.presence(socket, session, msg);
      case "ping":
        return this.io.send(socket, { type: "pong" });
      default:
        return this.error(socket, "Unknown message");
    }
  }

  /** A socket went away. */
  closed(socket: S) {
    this.partials.delete(socket);
    this.budgets.delete(socket);
    this.broadcastPeers();
  }

  private async hello(socket: S, session: Session | null, msg: Extract<ClientMessage, { type: "hello" }>) {
    if (msg.version !== PROTOCOL_VERSION) return this.error(socket, "Reload Voxeltoy to join this session", "version");
    const role = await this.io.authorize(String(msg.token ?? ""));
    if (!role) return this.error(socket, "This link no longer works", "unauthorized");
    const others = [...this.io.sessions()].filter(([s]) => s !== socket);
    if (!session && others.length >= LIMITS.participants) return this.error(socket, "This session is full", "full");
    const next: Session = {
      actor: session?.actor ?? randomId("p", 10),
      role,
      name: cleanName(msg.name),
      color: Number.isInteger(msg.color) ? msg.color & 0xffffff : 0x888888,
    };
    this.io.setSession(socket, next);
    const pending = Array.isArray(msg.pending) ? msg.pending.filter((id) => typeof id === "string").slice(0, 1000) : [];
    const applied: { id: string; revision: number }[] = [];
    const rejected: { id: string; reason: string }[] = [];
    for (const id of pending) {
      const answer = this.room.answer(id);
      if (answer?.revision !== undefined) applied.push({ id, revision: answer.revision });
      else if (answer) rejected.push({ id, reason: answer.reason });
    }
    const edits = Number.isInteger(msg.revision) ? this.room.since(msg.revision) : null;
    const base = {
      type: "welcome" as const,
      actor: next.actor,
      role,
      revision: this.room.revision,
      applied,
      rejected,
      peers: this.peers(),
    };
    if (edits) {
      this.io.send(socket, { ...base, edits });
    } else {
      const text = JSON.stringify(this.room.doc.snapshot());
      const size = LIMITS.message;
      if (text.length <= size) {
        this.io.send(socket, { ...base, snapshot: JSON.parse(text) });
      } else {
        const parts = Math.ceil(text.length / size);
        this.io.send(socket, { ...base, snapshotParts: parts });
        for (let part = 0; part < parts; part++) {
          this.io.send(socket, { type: "snapshot", part, data: text.slice(part * size, (part + 1) * size) });
        }
      }
    }
    this.broadcastPeers();
  }

  private edit(socket: S, session: Session, msg: Extract<ClientMessage, { type: "edit" }>) {
    const id = msg.id;
    if (typeof id !== "string" || id.length > 64 || !Array.isArray(msg.ops)) return this.error(socket, "Malformed edit");
    let ops = msg.ops;
    if (msg.parts !== undefined) {
      const parts = msg.parts;
      const part = msg.part ?? -1;
      if (!Number.isInteger(parts) || parts < 1 || parts > 1000 || !Number.isInteger(part) || part < 0 || part >= parts) {
        return this.error(socket, "Malformed edit");
      }
      let partial = this.partials.get(socket);
      if (!partial || partial.id !== id) {
        partial = { id, parts: new Array(parts), received: 0, chars: 0 };
        this.partials.set(socket, partial);
      }
      if (!partial.parts[part]) {
        partial.parts[part] = ops;
        partial.received++;
        partial.chars += JSON.stringify(ops).length;
      }
      if (partial.chars > LIMITS.edit) {
        this.partials.delete(socket);
        return this.answer(socket, id, { ok: false, reason: "The edit is too big to share" });
      }
      if (partial.received < parts) return;
      this.partials.delete(socket);
      ops = partial.parts.flat();
    }
    if (session.role !== "edit") return this.answer(socket, id, { ok: false, reason: "This link is view only" });
    if (!this.spend(socket)) return this.answer(socket, id, { ok: false, reason: "Too many edits at once" });
    this.answer(socket, id, this.room.submit(session.actor, id, ops));
  }

  private answer(socket: S, id: string, result: Submission) {
    if (!result.ok) return this.io.send(socket, { type: "reject", id, reason: result.reason });
    if (!result.duplicate) {
      this.io.commit(result.edit);
      for (const [other] of this.io.sessions()) {
        if (other !== socket) this.io.send(other, { type: "edit", ...result.edit });
      }
    }
    this.io.send(socket, { type: "ack", id, revision: result.edit.revision });
  }

  private presence(socket: S, session: Session, msg: Extract<ClientMessage, { type: "presence" }>) {
    const next: Session = { ...session };
    let renamed = false;
    if (typeof msg.name === "string") {
      next.name = cleanName(msg.name);
      renamed = next.name !== session.name;
    }
    if (Number.isInteger(msg.color)) {
      next.color = msg.color! & 0xffffff;
      renamed ||= next.color !== session.color;
    }
    if (msg.layer === undefined || typeof msg.layer === "string") next.layer = msg.layer?.slice(0, 64);
    if (msg.pointer === null || (Array.isArray(msg.pointer) && msg.pointer.length === 3 && msg.pointer.every(Number.isFinite))) {
      next.pointer = msg.pointer;
    }
    this.io.setSession(socket, next);
    if (renamed) return this.broadcastPeers();
    for (const [other] of this.io.sessions()) {
      if (other !== socket) this.io.send(other, { type: "presence", actor: next.actor, layer: next.layer, pointer: next.pointer });
    }
  }

  private peers(): Peer[] {
    return [...this.io.sessions()].map(([, s]) => ({
      actor: s.actor,
      name: s.name,
      color: s.color,
      role: s.role,
      ...(s.layer ? { layer: s.layer } : {}),
      ...(s.pointer ? { pointer: s.pointer } : {}),
    }));
  }

  private broadcastPeers() {
    const peers = this.peers();
    for (const [socket] of this.io.sessions()) this.io.send(socket, { type: "peers", peers });
  }

  /** A token bucket per socket: bursts of edits are fine, a flood is not. */
  private spend(socket: S) {
    const now = this.now();
    const rate = 40;
    const burst = 200;
    const budget = this.budgets.get(socket) ?? { tokens: burst, at: now };
    budget.tokens = Math.min(burst, budget.tokens + ((now - budget.at) / 1000) * rate);
    budget.at = now;
    this.budgets.set(socket, budget);
    if (budget.tokens < 1) return false;
    budget.tokens--;
    return true;
  }

  private error(socket: S, reason: string, close?: Extract<ServerMessage, { type: "error" }>["close"]) {
    this.io.send(socket, { type: "error", reason, ...(close ? { close } : {}) });
    if (close) this.io.close(socket, reason);
  }

  /** End every session (the room was deleted, or access changed). `keep` decides who stays. */
  disconnect(reason: string, close: "revoked" | "deleted", keep: (session: Session) => boolean = () => false) {
    for (const [socket, session] of this.io.sessions()) {
      if (keep(session)) continue;
      this.io.send(socket, { type: "error", reason, close });
      this.io.close(socket, reason);
    }
  }
}

function cleanName(name: unknown) {
  const text = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, 40) : "";
  return text || "Guest";
}

// #endregion
