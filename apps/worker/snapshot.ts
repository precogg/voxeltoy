// A shared snapshot: a fixed copy of a model behind a view link. One Durable Object per
// snapshot holds the gzipped .moxel file (in chunks, under SQLite's value limit), the hashes of
// its view and owner tokens, and when it was last used.

import { DurableObject } from "cloudflare:workers";
import { LIMITS } from "@voxeltoy/sync/protocol";
import { check, MAX_TEXT } from "./check";
import { bearer, gunzip, hashToken, json, newToken, problem, readBody, RETENTION_MS, sameHash } from "./access";

const CHUNK_BYTES = 1024 * 1024;

export class Snapshot extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.migrate();
  }

  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blob (n INTEGER PRIMARY KEY, data BLOB NOT NULL);
    `);
  }

  /** Forget everything; the object stays usable (and empty). */
  private async erase() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.migrate();
  }

  private get(key: string): string | null {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row?.value ?? null;
  }

  private set(key: string, value: string) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.split("/").pop();
    if (request.method === "PUT") return this.create(request);
    if (!this.get("viewHash")) return problem(404, "This link doesn't exist, or sharing stopped");
    const token = bearer(request);
    const hash = token ? await hashToken(token) : "";
    const owner = sameHash(this.get("ownerHash"), hash);
    const viewer = owner || sameHash(this.get("viewHash"), hash);

    if (request.method === "GET" && action === "info") {
      if (!owner) return problem(403, "Only the owner can manage this link");
      return json(this.info());
    }
    if (request.method === "GET") {
      if (!viewer) return problem(403, "This link doesn't work anymore");
      this.touch();
      const rows = this.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM blob ORDER BY n").toArray();
      return new Response(new Blob(rows.map((r) => r.data)), {
        headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
      });
    }
    if (request.method === "POST" && action === "rotate") {
      if (!owner) return problem(403, "Only the owner can manage this link");
      const viewToken = newToken();
      this.set("viewHash", await hashToken(viewToken));
      this.touch();
      return json({ viewToken });
    }
    if (request.method === "DELETE") {
      if (!owner) return problem(403, "Only the owner can manage this link");
      await this.erase();
      return new Response(null, { status: 204 });
    }
    return problem(405, "Not allowed");
  }

  private async create(request: Request) {
    if (this.get("viewHash")) return problem(409, "Already exists");
    const body = await readBody(request, LIMITS.upload);
    if (!body) return problem(413, "The model is too big to share");
    const text = await gunzip(body, MAX_TEXT);
    if (text === "too big") return problem(413, "The model is too big to share");
    if (text === "damaged") return problem(400, "The upload is damaged");
    const checked = check(new TextDecoder().decode(text));
    if ("error" in checked) return problem(400, checked.error);
    const { name } = checked;
    const viewToken = newToken();
    const ownerToken = newToken();
    this.ctx.storage.transactionSync(() => {
      for (let n = 0; n * CHUNK_BYTES < body.byteLength; n++) {
        this.sql.exec("INSERT INTO blob (n, data) VALUES (?, ?)", n, body.slice(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES).buffer);
      }
      this.set("created", String(Date.now()));
      this.set("bytes", String(body.byteLength));
      this.set("name", name);
    });
    this.set("viewHash", await hashToken(viewToken));
    this.set("ownerHash", await hashToken(ownerToken));
    this.touch();
    return json({ viewToken, ownerToken, ...this.info() });
  }

  private info() {
    return {
      kind: "snapshot",
      name: this.get("name"),
      created: Number(this.get("created")),
      bytes: Number(this.get("bytes")),
      expires: Number(this.get("used") ?? Date.now()) + RETENTION_MS,
    };
  }

  /** Note a use, and keep the snapshot for another retention period. */
  private touch() {
    const now = Date.now();
    const used = Number(this.get("used") ?? 0);
    if (now - used < 60 * 60 * 1000) return;
    this.set("used", String(now));
    void this.ctx.storage.setAlarm(now + RETENTION_MS);
  }

  async alarm() {
    const used = Number(this.get("used") ?? 0);
    if (Date.now() - used >= RETENTION_MS) await this.erase();
    else await this.ctx.storage.setAlarm(used + RETENTION_MS);
  }
}
