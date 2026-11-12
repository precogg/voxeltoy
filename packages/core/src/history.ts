import { createSignal } from "solid-js";
import { applyOp, celData, invertOp, OpError, type DocOp, type DocTarget, type VoxelsOp } from "./ops";

/** A change that stays on this device (the selection): undoable, but never shared. */
export interface LocalChange {
  undo(): void;
  redo(): void;
}

/** One step of an undo entry, in the order it was applied: a document op or a local change. */
export type Item = { op: DocOp } | { local: LocalChange };

/**
 * Which parts of an op an entry may still take back. Another person's later write to the same
 * cell or property takes it away, so undo never reverts their work. Voxels track it per cell.
 */
export type Owned = boolean | Uint8Array;

export interface Entry {
  /** The edit that left the document in the state this entry takes back. */
  id: string;
  label: string;
  items: Item[];
  /** Parallel to `items`. */
  owned: Owned[];
  /**
   * Whether the room accepted the edit. Until it does, other people's edits are ordered before
   * it, so they can't take anything away from it.
   */
  confirmed: boolean;
}

const MAX_ENTRIES = 200;
/** Above this many cells, a log tracks which cells it has seen with a bitmap instead of a set. */
const SET_LIMIT = 1 << 16;

/** The first value of each cell written to one array, in write order. */
class CellLog {
  cells = new Uint32Array(16);
  before = new Uint8Array(16);
  length = 0;
  private set: Set<number> | null = new Set();
  private seen: Uint8Array | null = null;

  constructor(
    /** The layer's data array. A rebased edit can swap it for a new one; see `Transaction.current`. */
    public data: Uint8Array,
    readonly layer: string,
    /** The frame the layer's cel is in, where the document has frames. */
    readonly frame: string | undefined,
    readonly gen: string,
    readonly channel?: "coverage",
  ) {}

  add(index: number, before: number) {
    if (this.seen ? this.seen[index] : this.set!.has(index)) return;
    if (this.length === this.cells.length) {
      const cells = new Uint32Array(this.length * 2);
      cells.set(this.cells);
      this.cells = cells;
      const values = new Uint8Array(this.length * 2);
      values.set(this.before);
      this.before = values;
    }
    this.cells[this.length] = index;
    this.before[this.length] = before;
    this.length++;
    if (this.seen) {
      this.seen[index] = 1;
    } else {
      this.set!.add(index);
      if (this.set!.size > SET_LIMIT) {
        this.seen = new Uint8Array(this.data.length);
        for (const i of this.set!) this.seen[i] = 1;
        this.set = null;
      }
    }
  }

  toOp(): VoxelsOp {
    const cells = this.cells.slice(0, this.length);
    const after = new Uint8Array(this.length);
    for (let k = 0; k < this.length; k++) after[k] = this.data[cells[k]];
    return {
      t: "voxels",
      layer: this.layer,
      ...(this.frame !== undefined ? { frame: this.frame } : {}),
      gen: this.gen,
      ...(this.channel ? { channel: this.channel } : {}),
      cells,
      before: this.before.slice(0, this.length),
      after,
    };
  }
}

type Write = (data: Uint8Array, index: number, value: number) => void;

/**
 * Everything between `begin` and `commit` that becomes one undo step: voxel writes (coalesced
 * into one op per layer until something else happens), document ops, and selection changes.
 */
export class Transaction {
  private items: (Item | CellLog)[] = [];
  private open = new Map<Uint8Array, CellLog>();

  constructor(
    readonly label: string,
    private write: Write,
    private target: DocTarget,
  ) {}

  /**
   * A write to a layer's values in `frame`, or (`channel` "coverage") to an override layer's
   * coverage.
   */
  recordVoxel(
    data: Uint8Array,
    layer: string,
    frame: string | undefined,
    gen: string,
    index: number,
    before: number,
    channel?: "coverage",
  ) {
    this.log(data, layer, frame, gen, channel).add(index, before);
  }

  recordSelection(mask: Uint8Array, index: number, before: number) {
    this.log(mask, "", undefined, "").add(index, before);
  }

  private log(data: Uint8Array, layer: string, frame: string | undefined, gen: string, channel?: "coverage") {
    let log = this.open.get(data);
    if (!log) {
      log = new CellLog(data, layer, frame, gen, channel);
      this.open.set(data, log);
      this.items.push(log);
    }
    return log;
  }

  /** Record a document op that has been applied. */
  push(op: DocOp) {
    this.open.clear();
    this.items.push({ op });
  }

  pushLocal(change: LocalChange) {
    this.open.clear();
    this.items.push({ local: change });
  }

  get isEmpty() {
    return this.items.length === 0;
  }

  /** Freeze the recorded steps. */
  seal(): Item[] {
    for (const item of this.items) if (item instanceof CellLog) this.current(item);
    this.open.clear();
    return this.items.map((item) => (item instanceof CellLog ? this.freeze(item) : item));
  }

  /**
   * The array a log's cel has now. Rebasing edits underneath an unfinished stroke can give a
   * layer a new array (a resize or a layer put back); writes follow the layer and frame, not the
   * array. Null if the layer or frame is gone or the grid changed.
   */
  private current(log: CellLog): Uint8Array | null {
    if (!log.layer) return log.data;
    const layer = this.target.layers.find((l) => l.id === log.layer);
    if (!layer || this.target.gen !== log.gen) return null;
    const array = log.channel === "coverage" ? layer.coverage : celData(this.target, log.frame, layer);
    if (!array) return null;
    if (array !== log.data) {
      if (this.open.get(log.data) === log) {
        this.open.delete(log.data);
        this.open.set(array, log);
      }
      log.data = array;
    }
    return log.data;
  }

  private freeze(log: CellLog): Item {
    if (log.layer) return { op: log.toOp() };
    // selection changes stay local
    const { data: mask, cells, before } = log;
    const n = log.length;
    const after = new Uint8Array(n);
    for (let k = 0; k < n; k++) after[k] = mask[cells[k]];
    const write = this.write;
    return {
      local: {
        undo: () => {
          for (let k = 0; k < n; k++) write(mask, cells[k], before[k]);
        },
        redo: () => {
          for (let k = 0; k < n; k++) write(mask, cells[k], after[k]);
        },
      },
    };
  }

  /** Revert everything recorded so far (a cancelled stroke). */
  revert() {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item instanceof CellLog) {
        const data = this.current(item);
        if (data) for (let k = item.length - 1; k >= 0; k--) this.write(data, item.cells[k], item.before[k]);
      } else if ("local" in item) {
        item.local.undo();
      } else {
        applyOp(this.target, invertOp(item.op));
      }
    }
    this.items = [];
    this.open.clear();
  }

  /**
   * Lift this unfinished transaction's voxel writes off the document, so someone else's edit can
   * land underneath. Returns a function that puts them back on top, over whatever is there then.
   */
  lift(): () => void {
    const logs = this.items.filter((item): item is CellLog => item instanceof CellLog && !!item.layer);
    const afters = logs.map((log) => {
      const data = this.current(log);
      const after = new Uint8Array(log.length);
      if (!data) return after;
      for (let k = log.length - 1; k >= 0; k--) {
        const i = log.cells[k];
        after[k] = data[i];
        this.write(data, i, log.before[k]);
      }
      return after;
    });
    return () => {
      logs.forEach((log, n) => {
        const data = this.current(log);
        if (!data) return;
        const after = afters[n];
        for (let k = 0; k < log.length; k++) {
          const i = log.cells[k];
          log.before[k] = data[i];
          this.write(data, i, after[k]);
        }
      });
    };
  }
}

/** What taking back an entry did: the steps applied (an entry that takes them back in turn), and how many were skipped. */
export interface Inversion {
  items: Item[];
  skipped: number;
}

/**
 * Take back an entry: each op it still owns, newest first. Ops that no longer fit (a layer
 * deleted, the model resized) and cells someone else wrote since are skipped.
 */
export function invertEntry(target: DocTarget, entry: Entry): Inversion {
  const items: Item[] = [];
  let skipped = 0;
  for (let i = entry.items.length - 1; i >= 0; i--) {
    const item = entry.items[i];
    if ("local" in item) {
      item.local.undo();
      items.push({ local: { undo: item.local.redo, redo: item.local.undo } });
      continue;
    }
    const owned = entry.owned[i];
    if (owned === false) {
      skipped++;
      continue;
    }
    let inverse = invertOp(item.op);
    if (owned instanceof Uint8Array && inverse.t === "voxels") {
      const keep: number[] = [];
      for (let k = 0; k < owned.length; k++) if (owned[k]) keep.push(k);
      if (keep.length < owned.length) skipped++;
      if (!keep.length) continue;
      const { cells, after } = inverse;
      inverse = {
        ...inverse,
        cells: Uint32Array.from(keep, (k) => cells[k]),
        after: Uint8Array.from(keep, (k) => after[k]),
        before: new Uint8Array(keep.length),
      };
    }
    try {
      applyOp(target, inverse);
      items.push({ op: inverse });
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      skipped++;
    }
  }
  return { items, skipped };
}

const cellIndex = new WeakMap<VoxelsOp, Map<number, number>>();

function positions(op: VoxelsOp) {
  let map = cellIndex.get(op);
  if (!map) {
    map = new Map();
    for (let k = 0; k < op.cells.length; k++) map.set(op.cells[k], k);
    cellIndex.set(op, map);
  }
  return map;
}

/** Whether two voxel edits are in the same frame. An edit without one is from a document with one frame. */
const sameFrame = (a: string | undefined, b: string | undefined) => a === undefined || b === undefined || a === b;

/** What `mine` still owns after someone else's later `theirs`. */
function disownOp(mine: DocOp, owned: Owned, theirs: DocOp): Owned {
  if (owned === false) return false;
  switch (mine.t) {
    case "voxels": {
      if (
        theirs.t !== "voxels" ||
        theirs.layer !== mine.layer ||
        !sameFrame(theirs.frame, mine.frame) ||
        theirs.gen !== mine.gen ||
        theirs.channel !== mine.channel
      ) {
        return owned;
      }
      const at = positions(mine);
      let flags = owned instanceof Uint8Array ? owned : null;
      for (const i of theirs.cells) {
        const k = at.get(i);
        if (k === undefined) continue;
        flags ??= new Uint8Array(mine.cells.length).fill(1);
        flags[k] = 0;
      }
      if (!flags) return owned;
      return flags.includes(1) ? flags : false;
    }
    case "name":
      return theirs.t === "name" ? false : owned;
    case "layer.add": {
      // deleting the layer again would lose what they did to it
      const id = mine.layer.id;
      const touched =
        (theirs.t === "voxels" && theirs.layer === id) ||
        (theirs.t === "layer.set" && theirs.id === id);
      return touched ? false : owned;
    }
    case "layer.set":
      return theirs.t === "layer.set" && theirs.id === mine.id && theirs.key === mine.key ? false : owned;
    case "layer.move":
      return theirs.t === "layer.move" && theirs.id === mine.id ? false : owned;
    case "palette.set":
      return (theirs.t === "palette.set" && theirs.index === mine.index) || theirs.t === "palette.replace" ? false : owned;
    case "palette.add":
    case "palette.remove":
    case "palette.replace":
      return theirs.t.startsWith("palette.") ? false : owned;
    case "resize":
    case "resolution":
      // shrinking back would crop or shift what they drew since
      return theirs.t === "voxels" || theirs.t === "resize" || theirs.t === "resolution" ? false : owned;
    case "layer.shape":
    case "layer.coverage":
      return (theirs.t === mine.t && theirs.id === mine.id) || (theirs.t === "voxels" && theirs.layer === mine.id) ? false : owned;
    case "frame.add": {
      // deleting the frame again would lose what they drew in it
      const id = mine.frame.id;
      const touched =
        (theirs.t === "voxels" && theirs.frame === id) ||
        ((theirs.t === "frame.duration" || theirs.t === "frame.move") && theirs.id === id);
      return touched ? false : owned;
    }
    case "frame.move":
    case "frame.duration":
      return theirs.t === mine.t && theirs.id === mine.id ? false : owned;
    case "tags":
      return theirs.t === "tags" ? false : owned;
    case "fps":
      return theirs.t === "fps" ? false : owned;
    case "layer.data":
      return theirs.t === "layer.data" && theirs.id === mine.id ? false : owned;
    case "data":
      return theirs.t === "data" && theirs.key === mine.key ? false : owned;
    case "marker.add":
    case "marker.set": {
      // taking it back would lose what they did to the marker since
      const id = mine.t === "marker.add" ? mine.marker.id : mine.id;
      return (theirs.t === "marker.set" || theirs.t === "marker.remove") && theirs.id === id ? false : owned;
    }
    case "origin":
      return theirs.t === "origin" ? false : owned;
    case "layer.mask":
      return (theirs.t === "layer.mask" && theirs.id === mine.id) || theirs.t === "resize" || theirs.t === "resolution" ? false : owned;
    case "group.add": {
      // removing the group again would lose what they put in it or changed on it
      const id = mine.group.id;
      const touched =
        (theirs.t === "group.set" && (theirs.id === id || (theirs.key === "group" && theirs.after === id))) ||
        (theirs.t === "layer.set" && theirs.key === "group" && theirs.after === id);
      return touched ? false : owned;
    }
    case "group.set":
      return theirs.t === "group.set" && theirs.id === mine.id && theirs.key === mine.key ? false : owned;
    case "group.remove":
    case "marker.remove":
    case "layer.remove":
    case "frame.remove":
      return owned;
  }
}

export class History {
  private undos: Entry[] = [];
  private redos: Entry[] = [];
  private version = createSignal(0);

  get canUndo() {
    this.version[0]();
    return this.undos.length > 0;
  }

  get canRedo() {
    this.version[0]();
    return this.redos.length > 0;
  }

  /** The label of the step `undo` would take back. */
  get undoLabel(): string | null {
    this.version[0]();
    return this.undos[this.undos.length - 1]?.label ?? null;
  }

  get redoLabel(): string | null {
    this.version[0]();
    return this.redos[this.redos.length - 1]?.label ?? null;
  }

  /** The entry `undo` (or `redo`) would take back next. */
  peek(stack: "undo" | "redo"): Entry | undefined {
    const list = stack === "undo" ? this.undos : this.redos;
    return list[list.length - 1];
  }

  /** Record a new edit. It replaces whatever could be redone. */
  push(entry: Entry) {
    this.redos = [];
    this.pushTo("undo", entry);
  }

  pushTo(stack: "undo" | "redo", entry: Entry) {
    const list = stack === "undo" ? this.undos : this.redos;
    list.push(entry);
    if (list.length > MAX_ENTRIES) list.shift();
    this.bump();
  }

  pop(stack: "undo" | "redo"): Entry | undefined {
    const entry = (stack === "undo" ? this.undos : this.redos).pop();
    if (entry) this.bump();
    return entry;
  }

  clear() {
    this.undos = [];
    this.redos = [];
    this.bump();
  }

  /** The room accepted edit `id`. */
  confirm(id: string) {
    for (const entry of this.entries()) if (entry.id === id) entry.confirmed = true;
  }

  /** Forget the entries for edit `id` (the room turned it down). */
  drop(id: string) {
    const before = this.undos.length + this.redos.length;
    this.undos = this.undos.filter((e) => e.id !== id);
    this.redos = this.redos.filter((e) => e.id !== id);
    if (this.undos.length + this.redos.length !== before) this.bump();
  }

  /** Someone else's edit, ordered after every confirmed entry, took over what it wrote. */
  disown(ops: readonly DocOp[]) {
    for (const entry of this.entries()) {
      if (!entry.confirmed) continue;
      entry.items.forEach((item, i) => {
        if (!("op" in item)) return;
        for (const theirs of ops) entry.owned[i] = disownOp(item.op, entry.owned[i], theirs);
      });
    }
  }

  private *entries() {
    yield* this.undos;
    yield* this.redos;
  }

  private bump() {
    this.version[1]((v) => v + 1);
  }
}

/** A new entry that owns everything it did. */
export function entryOf(id: string, label: string, items: Item[]): Entry {
  return { id, label, items, owned: items.map(() => true), confirmed: false };
}
