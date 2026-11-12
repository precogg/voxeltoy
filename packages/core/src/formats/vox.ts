import type { DocumentData, Vec3 } from "../types";

// MagicaVoxel .vox (https://github.com/ephtracy/voxel-model).
//
// MagicaVoxel is Z-up; Voxeltoy is Y-up. Voxeltoy (x, y, z) maps to vox (x, sizeZ - 1 - z, y).
// Each Voxeltoy layer becomes one model in its own vox layer, all sharing the same frame.
// Rigged parts' parents and pivots aren't kept.

export const VOX_EXTENSION = ".vox";

type Mat3 = number[]; // row-major 3x3
interface Affine {
  r: Mat3;
  t: Vec3;
}

const IDENTITY: Affine = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

// #region Reading

interface VoxModel {
  size: Vec3;
  voxels: Uint8Array; // x, y, z, i quads
}

type SceneNode =
  | { type: "trn"; child: number; layer: number; transform: Affine; hidden: boolean }
  | { type: "grp"; children: number[] }
  | { type: "shp"; models: number[] };

export function parseVox(buffer: ArrayBuffer, name = "Untitled"): DocumentData {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "VOX ") throw new Error("Not a MagicaVoxel file");

  const models: VoxModel[] = [];
  const nodes = new Map<number, SceneNode>();
  const layerInfo = new Map<number, { name: string; hidden: boolean }>();
  let rgba: Uint8Array | null = null;
  let pendingSize: Vec3 | null = null;

  let p = 8;
  const i32 = () => {
    const v = view.getInt32(p, true);
    p += 4;
    return v;
  };
  const str = () => {
    const len = i32();
    const s = new TextDecoder().decode(bytes.subarray(p, p + len));
    p += len;
    return s;
  };
  const dict = () => {
    const d: Record<string, string> = {};
    const n = i32();
    for (let k = 0; k < n; k++) {
      const key = str();
      d[key] = str();
    }
    return d;
  };

  // MAIN chunk header, then its children in sequence
  p += 12;
  while (p + 12 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(p, p + 4));
    p += 4;
    const contentSize = i32();
    i32(); // children size
    const end = p + contentSize;

    switch (id) {
      case "SIZE":
        pendingSize = [i32(), i32(), i32()];
        break;
      case "XYZI": {
        const n = i32();
        models.push({ size: pendingSize ?? [0, 0, 0], voxels: bytes.slice(p, p + n * 4) });
        break;
      }
      case "RGBA":
        rgba = bytes.slice(p, p + 1024);
        break;
      case "nTRN": {
        const nodeId = i32();
        const attrs = dict();
        const child = i32();
        i32(); // reserved
        const layer = i32();
        const frames = i32();
        let transform = IDENTITY;
        if (frames > 0) {
          const f = dict();
          transform = {
            r: f._r ? decodeRotation(parseInt(f._r, 10)) : IDENTITY.r,
            t: f._t ? (f._t.split(/\s+/).map(Number) as Vec3) : [0, 0, 0],
          };
        }
        nodes.set(nodeId, { type: "trn", child, layer, transform, hidden: attrs._hidden === "1" });
        break;
      }
      case "nGRP": {
        const nodeId = i32();
        dict();
        const n = i32();
        const children: number[] = [];
        for (let k = 0; k < n; k++) children.push(i32());
        nodes.set(nodeId, { type: "grp", children });
        break;
      }
      case "nSHP": {
        const nodeId = i32();
        dict();
        const n = i32();
        const shapeModels: number[] = [];
        for (let k = 0; k < n; k++) {
          shapeModels.push(i32());
          dict();
        }
        nodes.set(nodeId, { type: "shp", models: shapeModels });
        break;
      }
      case "LAYR": {
        const layerId = i32();
        const attrs = dict();
        layerInfo.set(layerId, { name: attrs._name ?? `Layer ${layerId + 1}`, hidden: attrs._hidden === "1" });
        break;
      }
    }
    p = end;
  }

  // Resolve every model instance to (model, world transform, layer)
  const instances: { model: VoxModel; transform: Affine; layer: number; hidden: boolean }[] = [];
  if (nodes.has(0)) {
    const visit = (id: number, parent: Affine, layer: number, hidden: boolean) => {
      const node = nodes.get(id);
      if (!node) return;
      if (node.type === "trn") {
        visit(node.child, compose(parent, node.transform), node.layer >= 0 ? node.layer : layer, hidden || node.hidden);
      } else if (node.type === "grp") {
        for (const c of node.children) visit(c, parent, layer, hidden);
      } else {
        for (const m of node.models) {
          if (models[m]) instances.push({ model: models[m], transform: parent, layer, hidden });
        }
      }
    };
    visit(0, IDENTITY, 0, false);
  } else {
    // No scene graph: models sit at the origin, uncentered.
    models.forEach((model, i) => {
      const half = model.size.map((s) => Math.floor(s / 2)) as Vec3;
      instances.push({ model, transform: { r: IDENTITY.r, t: half }, layer: i, hidden: false });
    });
  }
  if (instances.length === 0) throw new Error("The file contains no models");

  // World-space bounds from each model's full extent, so empty margins survive a round trip.
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const toWorld = (inst: (typeof instances)[number], x: number, y: number, z: number): Vec3 => {
    const s = inst.model.size;
    return apply(inst.transform, [x - Math.floor(s[0] / 2), y - Math.floor(s[1] / 2), z - Math.floor(s[2] / 2)]);
  };
  for (const inst of instances) {
    const [sx, sy, sz] = inst.model.size;
    for (const corner of [
      [0, 0, 0],
      [sx - 1, sy - 1, sz - 1],
    ]) {
      const w = toWorld(inst, corner[0], corner[1], corner[2]);
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], w[a]);
        max[a] = Math.max(max[a], w[a]);
      }
    }
  }
  const voxSize = [0, 1, 2].map((a) => Math.min(256, max[a] - min[a] + 1)) as Vec3;
  const size: Vec3 = [voxSize[0], voxSize[2], voxSize[1]];
  const count = size[0] * size[1] * size[2];

  // Group instances into layers
  const layerIds = [...new Set(instances.map((i) => i.layer))].sort((a, b) => a - b);
  const layers = layerIds.map((id) => {
    const info = layerInfo.get(id);
    const data = new Uint8Array(count);
    let hidden = info?.hidden ?? false;
    for (const inst of instances.filter((i) => i.layer === id)) {
      hidden ||= inst.hidden && !info;
      const v = inst.model.voxels;
      for (let k = 0; k < v.length; k += 4) {
        const w = toWorld(inst, v[k], v[k + 1], v[k + 2]);
        const x = w[0] - min[0];
        const y = w[2] - min[2];
        const z = voxSize[1] - 1 - (w[1] - min[1]);
        if (x < 0 || y < 0 || z < 0 || x >= size[0] || y >= size[1] || z >= size[2]) continue;
        data[x + size[0] * (y + size[1] * z)] = v[k + 3];
      }
    }
    return { name: info?.name || `Layer ${id + 1}`, visible: !hidden, locked: false, data };
  });

  // Palette: value v uses RGBA entry v - 1
  const palette = [0];
  if (rgba) {
    for (let v = 1; v < 256; v++) {
      const o = (v - 1) * 4;
      palette.push((rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2]);
    }
  } else {
    palette.push(...DEFAULT_VOX_PALETTE);
  }

  return { name, size, palette, layers, activeLayer: layers.length - 1 };
}

function decodeRotation(bits: number): Mat3 {
  const r = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const i0 = bits & 3;
  const i1 = (bits >> 2) & 3;
  const i2 = 3 - i0 - i1;
  r[0 + i0] = bits & 16 ? -1 : 1;
  r[3 + i1] = bits & 32 ? -1 : 1;
  r[6 + i2] = bits & 64 ? -1 : 1;
  return r;
}

function apply(a: Affine, v: Vec3): Vec3 {
  const r = a.r;
  return [
    r[0] * v[0] + r[1] * v[1] + r[2] * v[2] + a.t[0],
    r[3] * v[0] + r[4] * v[1] + r[5] * v[2] + a.t[1],
    r[6] * v[0] + r[7] * v[1] + r[8] * v[2] + a.t[2],
  ];
}

function compose(parent: Affine, child: Affine): Affine {
  const a = parent.r;
  const b = child.r;
  const r: Mat3 = [];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return { r, t: apply(parent, child.t) };
}

/** MagicaVoxel's default palette, used when a file has no RGBA chunk. Index v - 1 is value v. */
const DEFAULT_VOX_PALETTE: number[] = (() => {
  const steps = [0xff, 0xcc, 0x99, 0x66, 0x33, 0x00];
  const out: number[] = [];
  for (const r of steps) for (const g of steps) for (const b of steps) if (r || g || b) out.push((r << 16) | (g << 8) | b);
  const ramp = [0xee, 0xdd, 0xbb, 0xaa, 0x88, 0x77, 0x55, 0x44, 0x22, 0x11];
  for (const v of ramp) out.push(v << 16);
  for (const v of ramp) out.push(v << 8);
  for (const v of ramp) out.push(v);
  for (const v of ramp) out.push((v << 16) | (v << 8) | v);
  return out;
})();

// #endregion

// #region Writing

export function writeVox(doc: DocumentData): Blob {
  const [sx, sy, sz] = doc.size;
  const chunks: Uint8Array[] = [];

  const chunk = (id: string, content: Uint8Array) => {
    const header = new Uint8Array(12);
    header.set([...id].map((c) => c.charCodeAt(0)));
    new DataView(header.buffer).setInt32(4, content.length, true);
    chunks.push(header, content);
  };

  // SIZE + XYZI per layer
  doc.layers.forEach((layer) => {
    chunk("SIZE", ints(sx, sz, sy));
    const cells: number[] = [];
    for (let z = 0; z < sz; z++)
      for (let y = 0; y < sy; y++)
        for (let x = 0; x < sx; x++) {
          const v = layer.data[x + sx * (y + sy * z)];
          if (v) cells.push(x, sz - 1 - z, y, v);
        }
    chunk("XYZI", concat(ints(cells.length / 4), Uint8Array.from(cells)));
  });

  // Scene graph: root transform -> group -> (transform -> shape) per layer
  const modelCount = doc.layers.length;
  chunk("nTRN", concat(ints(0), dictBytes({}), ints(1, -1, -1, 1), dictBytes({})));
  chunk("nGRP", concat(ints(1), dictBytes({}), ints(modelCount, ...doc.layers.map((_, i) => 2 + i * 2))));
  doc.layers.forEach((layer, i) => {
    const attrs: Record<string, string> = { _name: layer.name };
    if (!layer.visible) attrs._hidden = "1";
    chunk("nTRN", concat(ints(2 + i * 2), dictBytes(attrs), ints(3 + i * 2, -1, i, 1), dictBytes({})));
    chunk("nSHP", concat(ints(3 + i * 2), dictBytes({}), ints(1, i), dictBytes({})));
  });
  doc.layers.forEach((layer, i) => {
    const attrs: Record<string, string> = { _name: layer.name };
    if (!layer.visible) attrs._hidden = "1";
    chunk("LAYR", concat(ints(i), dictBytes(attrs), ints(-1)));
  });

  const rgba = new Uint8Array(1024);
  for (let v = 1; v < 256; v++) {
    const c = doc.palette[v] ?? 0;
    rgba.set([(c >> 16) & 255, (c >> 8) & 255, c & 255, 255], (v - 1) * 4);
  }
  chunk("RGBA", rgba);

  const childrenSize = chunks.reduce((n, c) => n + c.length, 0);
  const header = new Uint8Array(20);
  header.set([..."VOX "].map((c) => c.charCodeAt(0)));
  header.set([..."MAIN"].map((c) => c.charCodeAt(0)), 8);
  const hv = new DataView(header.buffer);
  hv.setInt32(4, 150, true);
  hv.setInt32(12, 0, true);
  hv.setInt32(16, childrenSize, true);
  return new Blob([header, ...chunks] as BlobPart[], { type: "application/octet-stream" });
}

function ints(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setInt32(i * 4, v, true));
  return out;
}

function stringBytes(s: string): Uint8Array {
  const encoded = new TextEncoder().encode(s);
  return concat(ints(encoded.length), encoded);
}

function dictBytes(d: Record<string, string>): Uint8Array {
  const entries = Object.entries(d);
  return concat(ints(entries.length), ...entries.flatMap(([k, v]) => [stringBytes(k), stringBytes(v)]));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}

// #endregion
