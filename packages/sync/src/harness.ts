// A deterministic, in-memory network for testing live rooms: one room host, any number of
// clients (each a real Editor with a SyncClient), and message queues the test delivers one at
// a time, in any order it likes. Messages cross as JSON text, like the real WebSocket.

import { Editor } from "@voxeltoy/core/editor";
import { encodeRle } from "@voxeltoy/core/formats/moxel";
import type { DocumentData } from "@voxeltoy/core/types";
import { SyncClient } from "./client";
import { encodeSnapshot, type ClientMessage, type RemoteEdit, type Role, type ServerMessage } from "./protocol";
import { Room, RoomDocument, RoomHost, type Session } from "./room";

export interface Connection {
  id: number;
  client: SimClient;
  session: Session | null;
  /** Messages on their way to the room, and to the client. */
  up: string[];
  down: string[];
  open: boolean;
}

export interface SimClient {
  name: string;
  editor: Editor;
  sync: SyncClient;
  connection: Connection | null;
  token: string;
}

/** Everything shared about a document, comparable with `toEqual`. */
export function sharedState(doc: DocumentData) {
  return {
    name: doc.name,
    size: doc.size,
    gen: doc.gen,
    palette: doc.palette,
    layers: doc.layers.map((l) => ({
      id: l.id,
      name: l.name,
      voxels: Array.from(encodeRle(l.data)),
    })),
  };
}

export class Network {
  room: Room;
  host: RoomHost<Connection>;
  clients: SimClient[] = [];
  connections: Connection[] = [];
  /** What the room saved: its state as of the last commit, to restart from. */
  saved: { snapshot: string; revision: number; log: RemoteEdit[] };
  private nextId = 1;

  constructor(seed: DocumentData) {
    this.room = new Room(new RoomDocument(cloneDoc(seed)));
    this.host = this.createHost();
    this.saved = this.save();
  }

  private createHost() {
    return new RoomHost<Connection>(this.room, {
      send: (c, message: ServerMessage) => {
        if (c.open) c.down.push(JSON.stringify(message));
      },
      sessions: () =>
        this.connections.filter((c) => c.open && c.session).map((c) => [c, c.session!] as [Connection, Session]),
      setSession: (c, session) => {
        c.session = session;
      },
      // the socket closes after what was sent on it arrives
      close: (c) => {
        const messages = c.down;
        c.down = [];
        for (const text of messages) c.client.sync.receive(JSON.parse(text));
        this.drop(c.client);
      },
      authorize: (token): Role | null => (token === "edit" ? "edit" : token === "view" ? "view" : null),
      commit: () => {
        this.saved = this.save();
      },
    });
  }

  private save() {
    return {
      snapshot: JSON.stringify(this.room.doc.snapshot()),
      revision: this.room.revision,
      log: [...this.room.recent],
    };
  }

  /** Start the room again from what it saved, like a Durable Object waking up. Connections drop. */
  restart() {
    for (const client of this.clients) this.drop(client);
    this.room = new Room(RoomDocument.fromSnapshot(JSON.parse(this.saved.snapshot)), this.saved.revision, this.saved.log);
    this.host = this.createHost();
  }

  addClient(name: string, token = "edit"): SimClient {
    const editor = new Editor();
    const client: SimClient = {
      name,
      editor,
      token,
      connection: null,
      sync: null as unknown as SyncClient,
    };
    client.sync = new SyncClient(editor, {
      token,
      name,
      color: 0x336699,
      send: (message: ClientMessage) => {
        const c = client.connection;
        if (c?.open) c.up.push(JSON.stringify(message));
      },
    });
    this.clients.push(client);
    return client;
  }

  connect(client: SimClient) {
    const connection: Connection = { id: this.nextId++, client, session: null, up: [], down: [], open: true };
    this.connections.push(connection);
    client.connection = connection;
    client.sync.open();
    return connection;
  }

  /** Cut a client's connection; messages in flight are lost. */
  drop(client: SimClient) {
    const c = client.connection;
    if (!c || !c.open) return;
    c.open = false;
    c.up = [];
    c.down = [];
    client.connection = null;
    this.connections = this.connections.filter((x) => x !== c);
    this.host.closed(c);
    client.sync.disconnected();
  }

  /** Deliver the next message from a client to the room. */
  async up(client: SimClient) {
    const c = client.connection;
    const text = c?.up.shift();
    if (c && text !== undefined) await this.host.message(c, c.session, text);
  }

  /** Deliver the next message from the room to a client. */
  down(client: SimClient) {
    const c = client.connection;
    const text = c?.down.shift();
    if (c && text !== undefined) client.sync.receive(JSON.parse(text));
  }

  /** Deliver everything, in order, until the network is quiet. */
  async settle() {
    for (let guard = 0; guard < 100_000; guard++) {
      const busy = this.connections.find((c) => c.up.length || c.down.length);
      if (!busy) return;
      if (busy.up.length) await this.up(busy.client);
      else this.down(busy.client);
    }
    throw new Error("The network never settled");
  }

  /** The room's document, in the comparable shape. */
  roomState() {
    return sharedState(this.room.doc.toData());
  }

  state(client: SimClient) {
    return sharedState(client.editor.getDocument());
  }
}

/** A deep copy, sharing no arrays. */
export function cloneDoc(doc: DocumentData): DocumentData {
  return { ...doc, size: [...doc.size], palette: [...doc.palette], layers: doc.layers.map((l) => ({ ...l, data: l.data.slice() })) };
}

/** A seed document with ids, as a room is created from. */
export function seedDocument(size: [number, number, number] = [8, 8, 8]): DocumentData {
  const editor = new Editor();
  editor.newDocument(size);
  return cloneDoc(editor.getDocument());
}

export { encodeSnapshot };
