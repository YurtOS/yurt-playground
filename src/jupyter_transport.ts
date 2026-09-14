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

export type ZmtpSocketType = "DEALER" | "SUB" | "REQ";

export function encodeZmtpReady(
  socketType: ZmtpSocketType = "DEALER",
): Uint8Array {
  const body = new Uint8Array(35 + socketType.length);
  body[0] = 5;
  body.set(encoder.encode("READY"), 1);
  let offset = 6;
  offset = writeProperty(
    body,
    offset,
    "Socket-Type",
    encoder.encode(socketType),
  );
  writeProperty(body, offset, "Identity", new Uint8Array());
  return Uint8Array.of(4, body.length, ...body);
}

export function encodeZmtpMessage(frames: readonly Uint8Array[]): Uint8Array {
  if (frames.length === 0) throw new Error("ZMTP message must contain a frame");
  const encoded: Uint8Array[] = [];
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    if (frame.length > 255) {
      const header = new Uint8Array(9);
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
  sendCommand(name: string, payload?: Uint8Array): Promise<void>;
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

/** The kernel-facing sockets a client writes to. */
export type JupyterRequestChannel = "shell" | "control" | "stdin";
/** Every socket the kernel writes to. */
export type JupyterChannel = JupyterRequestChannel | "iopub";

export type JupyterTransport = {
  send(
    message: JupyterMessage,
    channel?: JupyterRequestChannel,
  ): Promise<void>;
  subscribe(
    listener: (message: JupyterMessage, channel: JupyterChannel) => void,
  ): () => void;
  close(): Promise<void>;
};

/** Index into the socket list `createJupyterTransport` opens. */
const CHANNEL_INDEX: Record<JupyterChannel, number> = {
  shell: 0,
  iopub: 1,
  stdin: 2,
  control: 3,
};
const CHANNEL_OF_INDEX: JupyterChannel[] = [
  "shell",
  "iopub",
  "stdin",
  "control",
];

export async function decodeJupyterChannelMessage(
  frames: readonly Uint8Array[],
  key: string,
): Promise<JupyterMessage> {
  const delimiter = encoder.encode("<IDS|MSG>");
  const delimiterIndex = frames.findIndex((frame) =>
    bytesEqual(frame, delimiter)
  );
  if (delimiterIndex < 0) {
    throw new Error("Jupyter message is missing the identity delimiter");
  }
  return await decodeJupyterMessage(frames.slice(delimiterIndex), key);
}

export async function createJupyterTransport(
  dial: (port: number) => SandboxPortConn,
  config: JupyterConfig,
): Promise<JupyterTransport> {
  const channels: ZmtpTransport[] = [];
  try {
    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        openZmtpTransport(dial(config.shell), "DEALER")
      ),
      Promise.resolve().then(() =>
        openZmtpTransport(dial(config.iopub), "SUB")
      ),
      Promise.resolve().then(() =>
        openZmtpTransport(dial(config.stdin), "DEALER")
      ),
      Promise.resolve().then(() =>
        openZmtpTransport(dial(config.control), "DEALER")
      ),
      Promise.resolve().then(() =>
        openZmtpTransport(dial(config.heartbeat), "REQ")
      ),
    ]);
    const failure = results.find((result) => result.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    channels.push(
      ...results
        .filter((result): result is PromiseFulfilledResult<ZmtpTransport> =>
          result.status === "fulfilled"
        )
        .map((result) => result.value),
    );
    if (failure) throw failure.reason;
    await channels[1].sendCommand("SUBSCRIBE");
    const listeners = new Set<
      (message: JupyterMessage, channel: JupyterChannel) => void
    >();
    let closed = false;
    for (const [index, channel] of channels.slice(0, 4).entries()) {
      void readMessages(
        channel,
        CHANNEL_OF_INDEX[index],
        config.key,
        listeners,
      ).catch(() => {
        // The next request or close observes a disconnected channel.
      });
    }
    return {
      async send(message, channel = "shell") {
        if (closed) throw new Error("Jupyter transport is closed");
        await channels[CHANNEL_INDEX[channel]].send(
          await encodeJupyterMessage(message, config.key),
        );
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
  } catch (error) {
    await Promise.all(channels.map((channel) => channel.close()));
    throw error;
  }
}

export async function openZmtpTransport(
  conn: SandboxPortConn,
  socketType: ZmtpSocketType = "DEALER",
): Promise<ZmtpTransport> {
  try {
    await conn.write(encodeZmtpGreeting(false));
    await readExactly(conn, 64);
    await conn.write(encodeZmtpReady(socketType));
    await readZmtpCommand(conn, "READY");
    return new RawZmtpTransport(conn);
  } catch (error) {
    await conn.close().catch(() => {});
    throw error;
  }
}

class RawZmtpTransport implements ZmtpTransport {
  constructor(private readonly conn: SandboxPortConn) {}

  async send(frames: readonly Uint8Array[]): Promise<void> {
    await this.conn.write(encodeZmtpMessage(frames));
  }

  async sendCommand(name: string, payload = new Uint8Array()): Promise<void> {
    const nameBytes = encoder.encode(name);
    const body = Uint8Array.of(nameBytes.length, ...nameBytes, ...payload);
    await this.conn.write(Uint8Array.of(4, body.length, ...body));
  }

  async receive(): Promise<Uint8Array[]> {
    const frames: Uint8Array[] = [];
    for (;;) {
      const flags = (await readExactly(this.conn, 1))[0];
      const length = flags & 2
        ? readLongLength(await readExactly(this.conn, 8), 0)
        : (await readExactly(this.conn, 1))[0];
      frames.push(await readExactly(this.conn, length));
      if ((flags & 1) === 0) return frames;
    }
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
  socket: ZmtpTransport,
  channel: JupyterChannel,
  key: string,
  listeners: Set<(message: JupyterMessage, channel: JupyterChannel) => void>,
): Promise<void> {
  for (;;) {
    const frames = await socket.receive();
    const message = channel === "iopub"
      ? await decodeJupyterChannelMessage(frames, key)
      : await decodeJupyterMessage(frames, key);
    for (const listener of listeners) listener(message, channel);
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((byte, index) => byte === right[index]);
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
