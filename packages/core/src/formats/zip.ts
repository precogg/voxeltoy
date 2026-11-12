// A minimal zip writer: files stored without compression, for bundling exports (PNGs are
// compressed already) into one download, and a reader for stored or deflated files. No DOM. See https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT

export interface ZipEntry {
  /** A path inside the archive, with forward slashes. */
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Bundle files into a zip archive (stored, UTF-8 names, no timestamps). */
export function writeZip(entries: readonly ZipEntry[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const records = entries.map((e) => ({ name: encoder.encode(e.name), data: e.data, crc: crc32(e.data) }));
  const localSize = records.reduce((n, r) => n + 30 + r.name.length + r.data.length, 0);
  const centralSize = records.reduce((n, r) => n + 46 + r.name.length, 0);
  if (localSize + centralSize > 0xffffffff || records.length > 0xffff) throw new Error("Too much to put in one zip");
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];
  // version 2.0, UTF-8 names (bit 11), stored
  const header = (signature: number, central: boolean, r: (typeof records)[number], offset: number) => {
    view.setUint32(at, signature, true);
    at += 4;
    if (central) {
      view.setUint16(at, 20, true);
      at += 2;
    }
    view.setUint16(at, 20, true);
    view.setUint16(at + 2, 0x0800, true);
    view.setUint16(at + 4, 0, true); // stored
    view.setUint16(at + 6, 0, true); // time
    view.setUint16(at + 8, 0x21, true); // date: 1980-01-01
    view.setUint32(at + 10, r.crc, true);
    view.setUint32(at + 14, r.data.length, true);
    view.setUint32(at + 18, r.data.length, true);
    view.setUint16(at + 22, r.name.length, true);
    view.setUint16(at + 24, 0, true); // extra
    at += 26;
    if (central) {
      view.setUint16(at, 0, true); // comment
      view.setUint16(at + 2, 0, true); // disk
      view.setUint16(at + 4, 0, true); // internal attributes
      view.setUint32(at + 6, 0, true); // external attributes
      view.setUint32(at + 10, offset, true);
      at += 14;
    }
    out.set(r.name, at);
    at += r.name.length;
  };
  for (const r of records) {
    offsets.push(at);
    header(0x04034b50, false, r, 0);
    out.set(r.data, at);
    at += r.data.length;
  }
  const central = at;
  records.forEach((r, i) => header(0x02014b50, true, r, offsets[i]));
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, records.length, true);
  view.setUint16(at + 10, records.length, true);
  view.setUint32(at + 12, at - central, true);
  view.setUint32(at + 16, central, true);
  return out;
}

/**
 * The files in a zip archive, by name. Reads stored and deflated files (what exports and common
 * zip tools write), through the central directory. Folders are skipped.
 */
export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record is the last thing in the file, before a comment of up to 65535 bytes.
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error("Not a zip archive");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new Error("Zip directory is damaged");
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/")) continue;

    if (view.getUint32(local, true) !== 0x04034b50) throw new Error(`Zip entry ${name} is damaged`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const stored = bytes.subarray(start, start + compressedSize);
    let data: Uint8Array;
    if (method === 0) data = stored.slice();
    else if (method === 8) {
      const out = new Blob([stored as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      data = new Uint8Array(await new Response(out).arrayBuffer());
    } else throw new Error(`Zip entry ${name} uses compression method ${method}, which is not supported`);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`Zip entry ${name} is damaged`);
    files.set(name, data);
  }
  return files;
}
