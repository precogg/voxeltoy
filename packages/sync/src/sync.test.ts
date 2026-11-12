import { describe, expect, test } from "bun:test";
import type { Editor } from "@voxeltoy/core/editor";
import type { Vec3 } from "@voxeltoy/core/types";
import { Network, seedDocument, type SimClient } from "./harness";
import { decodeCells, decodeOps, encodeCells, encodeOps, editMessages, PROTOCOL_VERSION } from "./protocol";

/** A room with clients, all connected and caught up. */
async function room(names: string[] = ["a", "b"], size: [number, number, number] = [8, 8, 8]) {
  const net = new Network(seedDocument(size));
  const clients = names.map((n) => net.addClient(n));
  for (const c of clients) net.connect(c);
  await net.settle();
  return { net, clients };
}

async function expectConverged(net: Network) {
  await net.settle();
  const state = net.roomState();
  for (const c of net.clients) {
    if (!c.connection) continue;
    expect({ client: c.name, state: net.state(c) }).toEqual({ client: c.name, state });
    expect(c.sync.pendingCount).toBe(0);
  }
}

const voxel = (c: SimClient, cell: Vec3, layer?: string) => c.editor.getVoxel(cell, layer);

describe("protocol", () => {
  test("cells round-trip as delta varints, in ascending order", () => {
    const cells = Uint32Array.of(500, 3, 70000, 4, 16_777_215);
    const { cells: text, order } = encodeCells(cells);
    expect(Array.from(decodeCells(text))).toEqual([3, 4, 500, 70000, 16_777_215]);
    expect(Array.from(order, (k) => cells[k])).toEqual([3, 4, 500, 70000, 16_777_215]);
  });

  test("ops survive the wire, with values paired to the right cells", () => {
    const ops = decodeOps(
      encodeOps([
        { t: "voxels", layer: "layer:a", gen: "g1", cells: Uint32Array.of(9, 2), before: new Uint8Array(2), after: Uint8Array.of(7, 3) },
      ]),
    );
    expect(ops[0]).toMatchObject({ t: "voxels", layer: "layer:a" });
    const op = ops[0] as Extract<(typeof ops)[0], { t: "voxels" }>;
    expect(Array.from(op.cells)).toEqual([2, 9]);
    expect(Array.from(op.after)).toEqual([3, 7]);
  });

  test("malformed ops are refused", () => {
    expect(() => decodeOps([{ t: "voxels", layer: "bad id!", gen: "g", cells: "", after: "" }])).toThrow();
    expect(() => decodeOps([{ t: "nope" }])).toThrow();
    expect(() => decodeOps("not a list")).toThrow();
  });

  test("big edits split into parts under the message limit", () => {
    const cells = Uint32Array.from({ length: 200_000 }, (_, i) => i * 3);
    const after = Uint8Array.from({ length: cells.length }, (_, i) => (i % 7) + 1);
    const messages = editMessages("edit:x", encodeOps([{ t: "voxels", layer: "layer:a", gen: "g", cells, before: new Uint8Array(cells.length), after }]), 64 * 1024);
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) expect(JSON.stringify(m).length).toBeLessThan(64 * 1024);
    const ops = decodeOps(messages.flatMap((m) => (m.type === "edit" ? m.ops : [])));
    expect(ops.reduce((n, op) => n + (op.t === "voxels" ? op.cells.length : 0), 0)).toBe(cells.length);
  });
});

describe("live rooms", () => {
  test("everyone starts from the room's document", async () => {
    const { net, clients } = await room();
    for (const c of clients) {
      expect(c.sync.status).toBe("saved");
      expect(c.editor.readOnly).toBeNull();
    }
    await expectConverged(net);
  });

  test("edits to different cells merge", async () => {
    const { net, clients: [a, b] } = await room();
    a.editor.applyCells([[0, 0, 0]], "add", 2);
    b.editor.applyCells([[1, 0, 0]], "add", 3);
    expect(a.sync.status).toBe("saving");
    await expectConverged(net);
    expect(voxel(a, [1, 0, 0])).toBe(3);
    expect(voxel(b, [0, 0, 0])).toBe(2);
    expect(a.sync.status).toBe("saved");
  });

  test("the same cell, edited at once, ends up as the room ordered it", async () => {
    const { net, clients: [a, b] } = await room();
    a.editor.applyCells([[0, 0, 0]], "add", 2);
    b.editor.applyCells([[0, 0, 0]], "add", 3);
    // b's edit reaches the room first
    await net.up(b);
    await net.up(a);
    // each still shows its own edit on top until it hears back
    expect(voxel(a, [0, 0, 0])).toBe(2);
    expect(voxel(b, [0, 0, 0])).toBe(3);
    await expectConverged(net);
    expect(voxel(a, [0, 0, 0])).toBe(2);
    expect(voxel(b, [0, 0, 0])).toBe(2);
  });

  test("a stroke in progress stays on top of edits arriving underneath, and cancelling it reveals them", async () => {
    const { net, clients: [a, b] } = await room();
    a.editor.beginStroke("Paint");
    a.editor.applyCells([[0, 0, 0]], "add", 2);
    b.editor.applyCells([[0, 0, 0], [1, 0, 0]], "add", 5);
    await net.settle();
    expect(voxel(a, [0, 0, 0])).toBe(2);
    expect(voxel(a, [1, 0, 0])).toBe(5);
    // a second finger cancels the stroke: no edit goes out, and b's work shows
    a.editor.cancelStroke();
    expect(voxel(a, [0, 0, 0])).toBe(5);
    await expectConverged(net);
  });

  test("a finished stroke goes out as one edit", async () => {
    const { net, clients: [a, b] } = await room();
    a.editor.beginStroke("Paint");
    a.editor.applyCells([[0, 0, 0]], "add", 2);
    a.editor.applyCells([[1, 0, 0]], "add", 2);
    expect(a.connection!.up).toHaveLength(0);
    a.editor.endStroke();
    expect(a.connection!.up).toHaveLength(1);
    await expectConverged(net);
    expect(voxel(b, [1, 0, 0])).toBe(2);
  });

  test("undo after someone else overwrote a cell keeps their work, and redo too", async () => {
    const { net, clients: [a, b] } = await room();
    a.editor.applyCells([[0, 0, 0], [1, 0, 0]], "add", 2);
    await net.settle();
    b.editor.applyCells([[0, 0, 0]], "paint", 5);
    await net.settle();
    a.editor.undo();
    await expectConverged(net);
    expect(voxel(b, [0, 0, 0])).toBe(5);
    expect(voxel(b, [1, 0, 0])).toBe(0);
    a.editor.redo();
    await expectConverged(net);
    expect(voxel(b, [0, 0, 0])).toBe(5);
    expect(voxel(b, [1, 0, 0])).toBe(2);
  });

  test("undo of an edit the room hasn't confirmed yet takes it all back", async () => {
    const { net, clients: [a, b] } = await room();
    a.editor.applyCells([[0, 0, 0]], "add", 2);
    b.editor.applyCells([[0, 0, 0]], "add", 3);
    await net.up(b);
    net.down(a); // b's edit lands under a's pending one
    a.editor.undo();
    await expectConverged(net);
    expect(voxel(a, [0, 0, 0])).toBe(3);
  });

  test("editing a layer someone deleted is turned down, and the editor puts things back", async () => {
    const { net, clients: [a, b] } = await room();
    const layer = a.editor.createLayer("Arm")!;
    await net.settle();
    b.editor.selectLayer(layer);
    b.editor.applyCells([[2, 2, 2]], "add", 4);
    a.editor.deleteLayer(layer);
    await net.up(a);
    await net.up(b);
    await expectConverged(net);
    expect(b.editor.layers.some((l) => l.id === layer)).toBe(false);
    expect(b.editor.toast?.message).toContain("wasn't saved");
    expect(b.editor.canUndo).toBe(false);
  });

  test("two people adding a palette color at once can't share a slot", async () => {
    const { net, clients: [a, b] } = await room();
    const length = a.editor.palette.length;
    a.editor.addPaletteColor(0x111111);
    b.editor.addPaletteColor(0x222222);
    await expectConverged(net);
    expect(a.editor.palette.length).toBe(length + 1);
    expect(a.editor.palette[length]).toBe(0x111111);
    expect(b.editor.toast?.message).toContain("wasn't saved");
  });

  test("painting with a color a new palette removed is turned down", async () => {
    const { net, clients: [a, b] } = await room();
    a.editor.loadPalette([0xff0000, 0x00ff00]);
    b.editor.applyCells([[0, 0, 0]], "add", 20);
    await net.up(a);
    await net.up(b);
    await expectConverged(net);
    expect(voxel(a, [0, 0, 0])).toBe(0);
  });

  test("edits from before someone resized are turned down", async () => {
    const { net, clients: [a, b] } = await room();
    a.editor.resize([10, 8, 10]);
    b.editor.applyCells([[0, 0, 0]], "add", 2);
    await net.up(a);
    await net.up(b);
    await expectConverged(net);
    expect(b.editor.size).toEqual([10, 8, 10]);
    expect(voxel(b, [0, 0, 0])).toBe(0);
  });

  test("a lost acknowledgement doesn't apply an edit twice", async () => {
    const { net, clients: [a, b] } = await room();
    a.editor.addPaletteColor(0x123456);
    await net.up(a); // the room applies it...
    net.drop(a); // ...but the answer is lost
    expect(a.editor.readOnly).toContain("Reconnecting");
    expect(a.sync.status).toBe("reconnecting");
    net.connect(a);
    await expectConverged(net);
    expect(net.room.revision).toBe(1);
    expect(b.editor.palette.filter((c) => c === 0x123456)).toHaveLength(1);
  });

  test("a client that missed edits catches up when it reconnects", async () => {
    const { net, clients: [a, b] } = await room();
    net.drop(b);
    a.editor.applyCells([[3, 3, 3]], "add", 6);
    a.editor.createLayer("New");
    await net.settle();
    net.connect(b);
    await expectConverged(net);
    expect(voxel(b, [3, 3, 3], b.editor.layers[0].id)).toBe(6);
  });

  test("a client that was gone for long gets a fresh snapshot, keeping its unsent edits", async () => {
    const { net, clients: [a, b] } = await room();
    net.drop(b);
    for (let i = 0; i < 520; i++) a.editor.setCells([[i % 8, Math.floor(i / 8) % 8, Math.floor(i / 64) % 8]], (i % 5) + 1);
    await net.settle();
    net.connect(b);
    await expectConverged(net);
  });

  test("the room restarts from what it saved, and clients carry on", async () => {
    const { net, clients: [a, b] } = await room();
    a.editor.applyCells([[1, 1, 1]], "add", 3);
    await net.settle();
    b.editor.applyCells([[2, 2, 2]], "add", 4);
    net.restart();
    net.connect(a);
    net.connect(b);
    await expectConverged(net);
    expect(voxel(a, [2, 2, 2])).toBe(4);
  });

  test("view-only links can look but not edit", async () => {
    const net = new Network(seedDocument());
    const viewer = net.addClient("viewer", "view");
    net.connect(viewer);
    await net.settle();
    expect(viewer.sync.role).toBe("view");
    expect(viewer.editor.readOnly).toContain("view only");
    expect(viewer.editor.applyCells([[0, 0, 0]], "add", 2)).toBe(0);
    // even a hand-made edit is turned down
    viewer.connection!.up.push(JSON.stringify({ type: "edit", id: "edit:sneaky", ops: [{ t: "name", after: "Mine" }] }));
    await net.settle();
    expect(net.room.doc.name).toBe("Untitled");
  });

  test("bad tokens and old clients are refused", async () => {
    const net = new Network(seedDocument());
    const stranger = net.addClient("stranger", "guess");
    net.connect(stranger);
    await net.settle();
    expect(stranger.sync.status).toBe("closed");
    const old = net.addClient("old");
    net.connect(old);
    old.connection!.up[0] = JSON.stringify({ ...JSON.parse(old.connection!.up[0]), version: PROTOCOL_VERSION + 1 });
    await net.settle();
    expect(old.sync.status).toBe("closed");
  });

  test("revoking access ends existing sessions", async () => {
    const { net, clients: [a] } = await room(["a"]);
    net.host.disconnect("The owner stopped sharing", "revoked");
    await net.settle();
    expect(a.sync.status).toBe("closed");
    expect(a.editor.readOnly).toBe("The owner stopped sharing");
  });

  test("presence reaches everyone", async () => {
    const { net, clients: [a, b] } = await room();
    a.sync.presence({ layer: a.editor.activeLayerId, pointer: [1, 2, 3] });
    await net.settle();
    const seen = b.sync.peers.find((p) => p.actor === a.sync.actor);
    expect(seen?.pointer).toEqual([1, 2, 3]);
    expect(b.sync.peers).toHaveLength(2);
    net.drop(a);
    await net.settle();
    expect(b.sync.peers).toHaveLength(1);
  });

  test("a big fill arrives in parts and applies once", async () => {
    const { net, clients: [a, b] } = await room(["a", "b"], [128, 128, 128]);
    a.editor.selectBox({ min: [0, 0, 0], max: [127, 127, 127] });
    a.editor.fillSelection(3);
    expect(a.connection!.up.length).toBeGreaterThan(1);
    await expectConverged(net);
    expect(voxel(b, [127, 127, 127])).toBe(3);
    expect(net.room.revision).toBe(1);
  });
});

describe("random editing converges", () => {
  /** A small seeded random number generator, so failures replay. */
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomEdit(e: Editor, r: () => number, inStroke: boolean) {
    const pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)];
    const cell = (): Vec3 => e.size.map((n) => Math.floor(r() * n)) as Vec3;
    const color = () => 1 + Math.floor(r() * (e.palette.length - 1));
    const layer = () => pick(e.layers).id;
    if (inStroke) return e.applyCells([cell(), cell()], pick(["add", "erase", "paint"] as const), color());
    const roll = r();
    if (roll < 0.35) return e.applyCells([cell(), cell(), cell()], pick(["add", "erase", "paint"] as const), color());
    if (roll < 0.4) return e.fill(cell(), color());
    if (roll < 0.47) return e.selectLayer(layer());
    if (roll < 0.52) return e.createLayer();
    if (roll < 0.55) return e.deleteLayer(layer());
    if (roll < 0.58) return e.duplicateLayer(layer());
    if (roll < 0.61) return e.renameLayer(layer(), `L${Math.floor(r() * 99)}`);
    if (roll < 0.64) return e.moveLayer(layer(), Math.floor(r() * e.layers.length));
    if (roll < 0.7) return e.renameLayer(layer(), `M${Math.floor(r() * 99)}`);
    if (roll < 0.72) return e.mergeDown(layer());
    if (roll < 0.75) return e.setPaletteColor(color(), Math.floor(r() * 0xffffff));
    if (roll < 0.77) return e.addPaletteColor(Math.floor(r() * 0xffffff));
    if (roll < 0.78) return e.loadPalette(Array.from({ length: 4 + Math.floor(r() * 30) }, () => Math.floor(r() * 0xffffff)));
    if (roll < 0.79) return e.resize(e.size.map((n) => Math.max(2, n + Math.floor(r() * 5) - 2)) as Vec3);
    if (roll < 0.8) return e.setName(`Model ${Math.floor(r() * 9)}`);
    if (roll < 0.83) return e.flipLayer(pick([0, 1, 2] as const));
    if (roll < 0.92) return e.undo();
    return e.redo();
  }

  for (let seed = 1; seed <= 24; seed++) {
    test(`seed ${seed}`, async () => {
      const r = rng(seed);
      const { net, clients } = await room(["a", "b", "c", "d"], [5, 6, 5]);
      const strokes = new Set<SimClient>();
      for (let step = 0; step < 600; step++) {
        const c = clients[Math.floor(r() * clients.length)];
        const roll = r();
        if (roll < 0.3) {
          if (c.connection && !c.editor.readOnly) randomEdit(c.editor, r, strokes.has(c));
        } else if (roll < 0.35) {
          if (strokes.has(c)) {
            if (r() < 0.7) c.editor.endStroke();
            else c.editor.cancelStroke();
            strokes.delete(c);
          } else if (c.connection && !c.editor.readOnly) {
            c.editor.beginStroke("Stroke");
            strokes.add(c);
          }
        } else if (roll < 0.65) {
          await net.up(c);
        } else if (roll < 0.97) {
          net.down(c);
        } else if (roll < 0.99) {
          if (c.connection) net.drop(c);
          else net.connect(c);
          strokes.delete(c);
        } else {
          net.restart();
          strokes.clear();
        }
      }
      for (const c of clients) {
        if (strokes.has(c)) c.editor.endStroke();
        if (!c.connection) net.connect(c);
      }
      await expectConverged(net);
    });
  }
});

describe("host data in rooms", () => {
  test("document and layer host data reach everyone, survive a snapshot, and undo", async () => {
    const { net, clients } = await room();
    const [a, b] = clients;
    a.editor.setHostData("game", { level: 3 });
    a.editor.setLayerHostData(a.editor.activeLayerId, { role: "terrain" });
    await expectConverged(net);
    expect(b.editor.hostData).toEqual({ game: { level: 3 } });
    expect(b.editor.layers[0].hostData).toEqual({ role: "terrain" });

    // a layer duplicated with its data arrives with it
    a.editor.duplicateLayer(a.editor.activeLayerId);
    await expectConverged(net);
    expect(b.editor.layers.filter((l) => (l.hostData as { role?: string })?.role === "terrain").length).toBe(2);

    // someone joining later gets it from the room's snapshot
    const c = net.addClient("c");
    net.connect(c);
    await net.settle();
    expect(c.editor.hostData).toEqual({ game: { level: 3 } });

    b.editor.setHostData("game", null);
    await expectConverged(net);
    expect(a.editor.hostData).toEqual({});
    b.editor.undo();
    await expectConverged(net);
    expect(a.editor.hostData).toEqual({ game: { level: 3 } });
  });

  test("host data must be plain JSON on the wire", () => {
    expect(() => decodeOps([{ t: "data", key: "ns", after: { when: "x".repeat(70 * 1024) } }])).toThrow();
    expect(decodeOps([{ t: "layer.data", id: "layer:a", after: { ok: true } }])[0]).toMatchObject({ t: "layer.data", after: { ok: true } });
  });
});

