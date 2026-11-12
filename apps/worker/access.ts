// Capability links: whoever has a token has its access. The server keeps only SHA-256 hashes
// of tokens, and checks a token by hashing it.

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A share's public id: 20 characters, about 103 bits. */
export function newShareId() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => ALPHABET[b % 36]).join("");
}

export const isShareId = (id: string) => /^[a-z0-9]{20}$/.test(id);

/** A secret token: 32 random bytes, base64url. */
export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compare two hashes without stopping at the first difference. */
export function sameHash(a: string | null | undefined, b: string) {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The bearer token of a request, if any. */
export function bearer(request: Request) {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer ([\w-]{20,100})$/.exec(header);
  return match ? match[1] : null;
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const problem = (status: number, error: string) => json({ error }, status);

/** Read a request body up to `limit` bytes; null if it is bigger. */
export async function readBody(request: Request, limit: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > limit) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return concat(chunks, size);
}

/** Gunzip up to `limit` bytes of output: the bytes, or why not. */
export async function gunzip(bytes: Uint8Array, limit: number): Promise<Uint8Array | "too big" | "damaged"> {
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return "too big";
      }
      chunks.push(value);
    }
    return concat(chunks, size);
  } catch {
    return "damaged";
  }
}

function concat(chunks: Uint8Array[], size: number) {
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** How long a share is kept after it was last used. */
export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
