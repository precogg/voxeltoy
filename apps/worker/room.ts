// A live room: one Durable Object per shared document. It holds the authoritative copy in
// SQLite (meta, layers, voxel chunks, recent edits), speaks the room protocol over hibernatable
// WebSockets, and checks every edit before saving it. A client hears "ack" only once the edit
// is stored: the Durable Object's output gate holds messages until writes are durable.

import { DurableObject } from "cloudflare:workers";
import { decodeSnapshot, LIMITS, type RemoteEdit, type Role, type RoomSnapshot, type ServerMessage } from "@voxeltoy/sync/protocol";
import { Room, RoomDocument, RoomHost, type Session } from "@voxeltoy/sync/room";
import type { LayerRecord } from "@voxeltoy/core/ops";
import type { Json, Vec3 } from "@voxeltoy/core/types";
import { bearer, gunzip, hashToken, json, newToken, problem, readBody, RETENTION_MS, sameHash } from "./access";

const LOG_KEEP = 500;

interface Attachment {
  session: Session | null;
}

export class LiveRoom extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;
  private host: RoomHost<WebSocket> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.migrate();
    // pings are answered without waking the room
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS layers (id TEXT PRIMARY KEY, position INTEGER NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (layer TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (layer, n));
      CREATE TABLE IF NOT EXISTS log (revision INTEGER PRIMARY KEY, id TEXT NOT NULL, actor TEXT NOT NULL, ops TEXT NOT NULL);
    `);
  }

  /** End every session and forget everything; the object stays usable (and empty). */
  private async erase(reason: string) {
    if (this.exists) this.load().disconnect(reason, "deleted");
    this.host = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.migrate();
  }

  // #region Storage

  private get(key: string): string | null {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row?.value ?? null;
  }

  private set(key: string, value: string) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  private get exists() {
    return this.get("editHash") !== null;
  }

  /** The room, loaded from storage the first time it is needed after waking. */
  private load(): RoomHost<WebSocket> {
    if (this.host) return this.host;
    const doc = JSON.parse(this.get("doc")!) as {
      name: string;
      size: Vec3;
      gen: string;
      palette: number[];
      activeLayer: number;
      hostData?: Record<string, Json>;
    };
    const count = doc.size[0] * doc.size[1] * doc.size[2];
    const layers = this.sql
      .exec<{ id: string; record: string }>("SELECT id, record FROM layers ORDER BY position")
      .toArray()
      .map((row): LayerRecord => ({ id: row.id, ...JSON.parse(row.record), data: new Uint8Array(count) }));
    const byId = new Map(layers.map((l) => [l.id, l]));
    for (const row of this.sql.exec<{ layer: string; n: number; data: ArrayBuffer }>("SELECT layer, n, data FROM chunks")) {
      const layer = byId.get(row.layer);
      if (layer) RoomDocument.readChunk(layer.data, row.n, new Uint8Array(row.data));
    }
    const document = new RoomDocument({
      ...doc,
      layers: layers.map((l) => ({
        id: l.id,
        name: l.name,
        data: l.data,
        visible: l.visible ?? true,
        locked: l.locked ?? false,
        ...(l.hostData !== undefined ? { hostData: l.hostData } : {}),
        ...(l.extra ? { extra: { ...l.extra } } : {}),
      })),
    });
    const log = this.sql
      .exec<{ revision: number; id: string; actor: string; ops: string }>("SELECT revision, id, actor, ops FROM log ORDER BY revision")
      .toArray()
      .map((row): RemoteEdit => ({ revision: row.revision, id: row.id, actor: row.actor, ops: JSON.parse(row.ops) }));
    const room = new Room(document, Number(this.get("revision") ?? 0), log);
    this.host = new RoomHost(room, {
      send: (ws, message: ServerMessage) => {
        try {
          ws.send(JSON.stringify(message));
        } catch {
          // already closing
        }
      },
      sessions: () => this.sessions(),
      setSession: (ws, session) => ws.serializeAttachment({ session } satisfies Attachment),
      close: (ws, reason) => {
        try {
          ws.close(4000, reason.slice(0, 120));
        } catch {
          // already closed
        }
      },
      authorize: (token) => this.authorize(token),
      commit: (edit) => this.save(room, edit),
    });
    return this.host;
  }

  /** Write everything that changed in the document, and the edit, as one transaction. */
  private save(room: Room, edit: RemoteEdit | null) {
    const doc = room.doc;
    const changes = doc.takeChanges();
    this.ctx.storage.transactionSync(() => {
      if (changes.meta || !this.get("doc")) {
        this.set(
          "doc",
          JSON.stringify({
            name: doc.name,
            size: doc.size,
            gen: doc.gen,
            palette: doc.palette,
            activeLayer: doc.activeLayer,
            ...(Object.keys(doc.hostData).length ? { hostData: doc.hostData } : {}),
          }),
        );
      }
      if (changes.layers || changes.full.size || changes.removed.size) {
        this.sql.exec("DELETE FROM layers");
        doc.layers.forEach((l, position) => {
          const { id, data: _, ...record } = l;
          this.sql.exec("INSERT INTO layers (id, position, record) VALUES (?, ?, ?)", id, position, JSON.stringify(record));
        });
      }
      for (const id of changes.removed) {
        if (!changes.full.has(id)) this.sql.exec("DELETE FROM chunks WHERE layer = ?", id);
      }
      const byId = new Map(doc.layers.map((l) => [l.id, l]));
      for (const id of changes.full) {
        const layer = byId.get(id);
        this.sql.exec("DELETE FROM chunks WHERE layer = ?", id);
        if (!layer) continue;
        for (let n = 0; n < doc.chunkCount; n++) this.writeChunk(doc, layer, n);
      }
      for (const [id, chunks] of changes.chunks) {
        const layer = byId.get(id);
        if (!layer || changes.full.has(id)) continue;
        for (const n of chunks) this.writeChunk(doc, layer, n);
      }
      if (edit) {
        this.sql.exec("INSERT INTO log (revision, id, actor, ops) VALUES (?, ?, ?, ?)", edit.revision, edit.id, edit.actor, JSON.stringify(edit.ops));
        this.sql.exec("DELETE FROM log WHERE revision <= ?", edit.revision - LOG_KEEP);
        this.set("revision", String(edit.revision));
      }
    });
    this.touch();
  }

  private writeChunk(doc: RoomDocument, layer: LayerRecord, n: number) {
    const chunk = doc.chunk(layer, n);
    if (chunk) {
      this.sql.exec(
        "INSERT INTO chunks (layer, n, data) VALUES (?, ?, ?) ON CONFLICT (layer, n) DO UPDATE SET data = excluded.data",
        layer.id,
        n,
        chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength),
      );
    } else {
      this.sql.exec("DELETE FROM chunks WHERE layer = ? AND n = ?", layer.id, n);
    }
  }

  /** Note activity, and keep the room for another retention period. */
  private touch() {
    const now = Date.now();
    const used = Number(this.get("used") ?? 0);
    if (now - used < 60 * 60 * 1000) return;
    this.set("used", String(now));
    void this.ctx.storage.setAlarm(now + RETENTION_MS);
  }

  async alarm() {
    const used = Number(this.get("used") ?? 0);
    if (Date.now() - used < RETENTION_MS) return void (await this.ctx.storage.setAlarm(used + RETENTION_MS));
    await this.erase("This session expired");
  }

  // #endregion

  // #region Access

  private async authorize(token: string): Promise<Role | null> {
    const hash = await hashToken(token);
    if (sameHash(this.get("editHash"), hash)) return "edit";
    if (sameHash(this.get("viewHash"), hash)) return "view";
    return null;
  }

  private *sessions(): Generator<[WebSocket, Session]> {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment?.session && ws.readyState === WebSocket.OPEN) yield [ws, attachment.session];
    }
  }

  // #endregion

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.split("/").pop();
    if (request.method === "PUT") return this.create(request);
    if (!this.exists) return problem(404, "This session doesn't exist, or sharing stopped");

    if (action === "socket") {
      if (request.headers.get("Upgrade") !== "websocket") return problem(426, "Expected a WebSocket");
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ session: null } satisfies Attachment);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const token = bearer(request);
    const owner = token ? sameHash(this.get("ownerHash"), await hashToken(token)) : false;
    if (!owner) return problem(403, "Only the owner can manage this session");
    const host = this.load();
    if (request.method === "GET" && action === "info") return json(this.info(host));
    if (request.method === "POST" && action === "rotate") {
      const body = (await request.json().catch(() => null)) as { which?: unknown } | null;
      const which = body?.which;
      if (which !== "view" && which !== "edit") return problem(400, "Rotate the view or the edit link");
      const next = newToken();
      this.set(`${which}Hash`, await hashToken(next));
      // people who joined with the old link lose access now, not when they reconnect
      host.disconnect("This link was replaced by a new one", "revoked", (s) => s.role !== which);
      return json({ [`${which}Token`]: next });
    }
    if (request.method === "DELETE") {
      await this.erase("The owner stopped sharing this session");
      return new Response(null, { status: 204 });
    }
    return problem(405, "Not allowed");
  }

  private async create(request: Request) {
    if (this.exists) return problem(409, "Already exists");
    const body = await readBody(request, LIMITS.upload);
    const text = body ? await gunzip(body, 4 * LIMITS.roomCells) : "too big";
    if (text === "too big") return problem(413, "The model is too big for a live session");
    if (text === "damaged") return problem(400, "The upload is damaged");
    let snapshot: RoomSnapshot;
    let document: RoomDocument;
    try {
      snapshot = JSON.parse(new TextDecoder().decode(text));
      const data = decodeSnapshot(snapshot);
      document = new RoomDocument(data);
    } catch (e) {
      return problem(400, `Not a shared Voxeltoy document: ${(e as Error).message}`);
    }
    if (document.load > LIMITS.roomCells) return problem(413, "The model is too big for a live session");
    const viewToken = newToken();
    const editToken = newToken();
    const ownerToken = newToken();
    const hashes = await Promise.all([viewToken, editToken, ownerToken].map(hashToken));
    this.set("created", String(Date.now()));
    this.set("viewHash", hashes[0]);
    this.set("ownerHash", hashes[2]);
    const room = new Room(document);
    // everything is new: write the whole document
    for (const l of document.layers) document.changes.full.add(l.id);
    document.changes.meta = true;
    document.changes.layers = true;
    this.save(room, null);
    this.set("revision", "0");
    // the edit hash goes last: it is what marks the room as existing
    this.set("editHash", hashes[1]);
    return json({ viewToken, editToken, ownerToken, ...this.info(this.load()) });
  }

  private info(host: RoomHost<WebSocket>) {
    return {
      kind: "room",
      name: host.room.doc.name,
      created: Number(this.get("created")),
      revision: host.room.revision,
      participants: [...this.sessions()].length,
      expires: Number(this.get("used") ?? Date.now()) + RETENTION_MS,
    };
  }

  // #region Sockets

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return ws.close(4000, "Text messages only");
    if (!this.exists) return ws.close(4000, "This session ended");
    const attachment = ws.deserializeAttachment() as Attachment | null;
    await this.load().message(ws, attachment?.session ?? null, message);
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code, "Closing");
    } catch {
      // already closed
    }
    if (this.exists) this.load().closed(ws);
  }

  async webSocketError(ws: WebSocket) {
    if (this.exists) this.load().closed(ws);
  }

  // #endregion
}
