// The sharing Worker: static assets, plus the sharing API under /api. The script name stays `moxel`.
//
//   POST   /api/snapshots              upload a gzipped .moxel; returns { id, viewToken, ownerToken }
//   GET    /api/snapshots/:id          the gzipped .moxel (Bearer view or owner token)
//   GET    /api/snapshots/:id/info     (Bearer owner token)
//   POST   /api/snapshots/:id/rotate   a new view token; the old link stops working (owner)
//   DELETE /api/snapshots/:id          stop sharing (owner)
//
//   POST   /api/rooms                  upload a gzipped room snapshot; returns { id, viewToken, editToken, ownerToken }
//   GET    /api/rooms/:id/socket       the room's WebSocket; the first message carries the token
//   GET    /api/rooms/:id/info         (owner)
//   POST   /api/rooms/:id/rotate       { which: "view" | "edit" } a new token; sessions on the old one end (owner)
//   DELETE /api/rooms/:id              end the session for everyone (owner)
//
//   GET    /api/status                 { rooms }: whether live sessions are on
//
// Live sessions have a kill switch: set the ROOMS_DISABLED secret to "1"
// (`wrangler secret put ROOMS_DISABLED`). New rooms and joins are refused, and since a new
// version restarts the rooms, everyone in one is told why and stops reconnecting. Owners can
// still look at, rotate and end their rooms. Delete the secret to turn them back on.

import type { ServerMessage } from "@voxeltoy/sync/protocol";
import { isShareId, json, newShareId, problem } from "./access";

export { LiveRoom } from "./room";
export { Snapshot } from "./snapshot";

declare global {
  interface Env {
    /** "1" turns live sessions off; a secret, so it outlives deploys. */
    ROOMS_DISABLED?: string;
  }
}

const ROOMS_OFF = "Live sessions are turned off for now. Try again later.";

/** Accept a room socket only to say live sessions are off; the client stops reconnecting. */
function roomsOffSocket() {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].send(JSON.stringify({ type: "error", reason: ROOMS_OFF, close: "disabled" } satisfies ServerMessage));
  pair[1].close(4000, "Live sessions are off");
  return new Response(null, { status: 101, webSocket: pair[0] });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    const [, , kind, id, action] = url.pathname.split("/");
    const roomsOff = env.ROOMS_DISABLED === "1";
    if (kind === "status" && !id && request.method === "GET") return json({ rooms: !roomsOff });
    const namespace = kind === "snapshots" ? env.SNAPSHOTS : kind === "rooms" ? env.ROOMS : null;
    if (!namespace) return problem(404, "Not found");

    if (!id) {
      if (request.method !== "POST") return problem(405, "Not allowed");
      if (kind === "rooms" && roomsOff) return problem(503, ROOMS_OFF);
      // creating uploads a copy of a model: a few a minute per address is plenty
      const address = request.headers.get("CF-Connecting-IP") ?? "local";
      const { success } = await env.CREATE_LIMIT.limit({ key: `${kind}:${address}` });
      if (!success) return problem(429, "Too many shares at once; try again in a minute");
      const shareId = newShareId();
      const stub = namespace.get(namespace.idFromName(shareId));
      const response = await stub.fetch(new Request("https://share/create", { method: "PUT", body: request.body, headers: request.headers }));
      if (!response.ok) return response;
      return json({ id: shareId, ...(await response.json<object>()) }, 201);
    }

    if (!isShareId(id) || (action && !["socket", "info", "rotate"].includes(action))) return problem(404, "Not found");
    if (kind === "rooms" && action === "socket" && roomsOff) {
      if (request.headers.get("Upgrade") !== "websocket") return problem(426, "Expected a WebSocket");
      return roomsOffSocket();
    }
    const stub = namespace.get(namespace.idFromName(id));
    return stub.fetch(new Request(`https://share/${action ?? ""}`, request));
  },
} satisfies ExportedHandler<Env>;
