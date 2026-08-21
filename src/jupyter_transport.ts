import type { SandboxPortConn } from "@yurt/kernel-host-interface-js";
import {
  decodeJupyterMessage,
  encodeJupyterMessage,
  type JupyterMessage,
} from "./jupyter_protocol.ts";

const encoder = new TextEncoder();

export function encodeZmtpGreeting(asServer: boolean): Uint8Array {
  const greeting = new Uint8Array(64);
  greeting[0] = 0xff;
  greeting[9] = 0x7f;
  greeting[10] = 3;
  greeting[11] = 1;
  greeting.set(encoder.encode("NULL"), 12);
  greeting[32] = asServer ? 1 : 0;
  return greeting;
}

export function encodeZmtpReady(): Uint8Array {
  const body = new Uint8Array(41);
  body[0] = 5;
  body.set(encoder.encode("READY"), 1);
  let offset = 6;
  offset = writeProperty(body, offset, "Socket-Type", encoder.encode("DEALER"));
  writeProperty(body, offset, "Identity", new Uint8Array());
  return Uint8Array.of(4, body.length, ...body);
}

export function encodeZmtpMessage(frames: readonly Uint8Array[]): Uint8Array {
  if (frames.length === 0) throw new Error("ZMTP message must contain a frame");
  const encoded: Uint8Array[] = [];
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    if (frame.length > 255) {
      const header = new Uint8Array(10);
      header[0] = index + 1 < frames.length ? 3 : 2;
      new DataView(header.buffer).setBigUint64(1, BigInt(frame.length), false);
      encoded.push(header, frame);
    } else {
      encoded.push(
        Uint8Array.of(index + 1 < frames.length ? 1 : 0, frame.length),
        frame,
      );
    }
  }
  return concat(encoded);
}

export function decodeZmtpFrames(bytes: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 2 > bytes.length) {
      throw new Error("ZMTP frame header is truncated");
    }
    const flags = bytes[offset++];
    const length = flags & 2 ? readLongLength(bytes, offset) : bytes[offset++];
    if (flags & 2) offset += 8;
    if (offset + length > bytes.length) {
      throw new Error("ZMTP frame body is truncated");
    }
    frames.push(bytes.slice(offset, offset + length));
    offset += length;
    if ((flags & 1) === 0 && offset !== bytes.length) {
      throw new Error("ZMTP message contains trailing frames");
    }
  }
  return frames;
}

export type ZmtpTransport = {
  send(frames: readonly Uint8Array[]): Promise<void>;
  receive(): Promise<Uint8Array[]>;
  close(): Promise<void>;
};

export type JupyterConfig = {
  key: string;
  shell: number;
  iopub: number;
  stdin: number;
  control: number;
  heartbeat: number;
};

export type JupyterTransport = {
  send(message: JupyterMessage): Promise<void>;
  subscribe(listener: (message: JupyterMessage) => void): () => void;
  close(): Promise<void>;
};

export async function createJupyterTransport(
  dial: (port: number) => SandboxPortConn,
  config: JupyterConfig,
): Promise<JupyterTransport> {
  const channels = await Promise.all([
    openZmtpTransport(dial(config.shell)),
    openZmtpTransport(dial(config.iopub)),
    openZmtpTransport(dial(config.stdin)),
    openZmtpTransport(dial(config.control)),
    openZmtpTransport(dial(config.heartbeat)),
  ]);
  const listeners = new Set<(message: JupyterMessage) => void>();
  let closed = false;
  for (const channel of channels.slice(0, 4)) {
    void readMessages(channel, config.key, listeners).catch(() => {
      // The next request or close observes a disconnected channel.
    });
  }
  return {
    async send(message) {
      if (closed) throw new Error("Jupyter transport is closed");
      await channels[0].send(await encodeJupyterMessage(message, config.key));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all(channels.map((channel) => channel.close()));
      listeners.clear();
    },
  };
}

export async function openZmtpTransport(
  conn: SandboxPortConn,
): Promise<ZmtpTransport> {
  await conn.write(encodeZmtpGreeting(false));
  await readExactly(conn, 64);
  await conn.write(encodeZmtpReady());
  await readZmtpCommand(conn, "READY");
  return new RawZmtpTransport(conn);
}

class RawZmtpTransport implements ZmtpTransport {
  constructor(private readonly conn: SandboxPortConn) {}

  async send(frames: readonly Uint8Array[]): Promise<void> {
    await this.conn.write(encodeZmtpMessage(frames));
  }

  async receive(): Promise<Uint8Array[]> {
    const first = await readExactOrShort(this.conn, 2);
    const flags = first[0];
    let length: number;
    if (flags & 2) {
      length = readLongLength(await readExactly(this.conn, 8), 0);
    } else {
      length = first[1];
    }
    const frames = [await readExactly(this.conn, length)];
    while (flags & 1) {
      const header = await readExactly(this.conn, 2);
      const nextFlags = header[0];
      const nextLength = nextFlags & 2
        ? readLongLength(await readExactly(this.conn, 8), 0)
        : header[1];
      frames.push(await readExactly(this.conn, nextLength));
      if ((nextFlags & 1) === 0) break;
    }
    return frames;
  }

  close(): Promise<void> {
    return this.conn.close();
  }
}

function writeProperty(
  target: Uint8Array,
  offset: number,
  name: string,
  value: Uint8Array,
): number {
  const nameBytes = encoder.encode(name);
  target[offset++] = nameBytes.length;
  target.set(nameBytes, offset);
  offset += nameBytes.length;
  new DataView(target.buffer).setUint32(offset, value.length, false);
  offset += 4;
  target.set(value, offset);
  return offset + value.length;
}

function readLongLength(bytes: Uint8Array, offset: number): number {
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getBigUint64(offset, false);
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("ZMTP frame is too large");
  }
  return Number(length);
}

async function readZmtpCommand(
  conn: SandboxPortConn,
  expected: string,
): Promise<void> {
  const header = await readExactly(conn, 2);
  if (header[0] !== 4) throw new Error("ZMTP READY command has invalid flags");
  const body = await readExactly(conn, header[1]);
  const actual = new TextDecoder().decode(body.slice(1, 1 + body[0]));
  if (actual !== expected) {
    throw new Error(`ZMTP expected ${expected}, got ${actual}`);
  }
}

async function readMessages(
  channel: ZmtpTransport,
  key: string,
  listeners: Set<(message: JupyterMessage) => void>,
): Promise<void> {
  for (;;) {
    const message = await decodeJupyterMessage(await channel.receive(), key);
    for (const listener of listeners) listener(message);
  }
}

async function readExactly(
  conn: SandboxPortConn,
  length: number,
): Promise<Uint8Array> {
  const result = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const chunk = await conn.read(length - offset);
    if (chunk.length === 0) throw new Error("ZMTP connection closed");
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function readExactOrShort(
  conn: SandboxPortConn,
  length: number,
): Promise<Uint8Array> {
  return await readExactly(conn, length);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
