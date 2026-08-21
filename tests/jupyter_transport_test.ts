import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { encodeJupyterMessage } from "../src/jupyter_protocol.ts";
import {
  createJupyterTransport,
  decodeJupyterChannelMessage,
  decodeZmtpFrames,
  encodeZmtpGreeting,
  encodeZmtpMessage,
  encodeZmtpReady,
  openZmtpTransport,
} from "../src/jupyter_transport.ts";

Deno.test("ZMTP NULL greeting is the 64-byte 3.1 client greeting", () => {
  const greeting = encodeZmtpGreeting(false);
  assertEquals(greeting.length, 64);
  assertEquals([...greeting.slice(0, 12)], [
    0xff,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0x7f,
    3,
    1,
  ]);
  assertEquals(new TextDecoder().decode(greeting.slice(12, 16)), "NULL");
  assertEquals(greeting[32], 0);
});

Deno.test("ZMTP READY advertises a DEALER socket", () => {
  const ready = encodeZmtpReady();
  assertEquals([...ready.slice(0, 8)], [4, 41, 5, 82, 69, 65, 68, 89]);
  assertEquals(new TextDecoder().decode(ready.slice(8, 20)), "\x0bSocket-Type");
  assertEquals(new TextDecoder().decode(ready.slice(24, 30)), "DEALER");
});

Deno.test("ZMTP READY advertises the requested socket type", () => {
  for (const socketType of ["SUB", "REQ"] as const) {
    const ready = encodeZmtpReady(socketType);
    assertEquals(
      new TextDecoder().decode(ready.slice(24, 24 + socketType.length)),
      socketType,
    );
  }
});

Deno.test("ZMTP multipart message marks every non-final frame with MORE", () => {
  const encoded = encodeZmtpMessage([
    new Uint8Array([1]),
    new Uint8Array([2, 3]),
  ]);
  assertEquals([...encoded], [1, 1, 1, 0, 2, 2, 3]);
  assertEquals(decodeZmtpFrames(encoded), [
    new Uint8Array([1]),
    new Uint8Array([2, 3]),
  ]);
});

Deno.test("ZMTP decoder rejects incomplete frame bodies", () => {
  assertThrows(() => decodeZmtpFrames(new Uint8Array([0, 4, 1, 2])));
});

Deno.test("ZMTP transport completes the NULL greeting handshake", async () => {
  const incoming = concat([
    encodeZmtpGreeting(true),
    encodeZmtpReady(),
  ]);
  const conn = new FakeConn(incoming);
  const transport = await openZmtpTransport(conn);
  assertEquals(conn.writes.length, 2);
  assertEquals(conn.writes[0], encodeZmtpGreeting(false));
  assertEquals(conn.writes[1], encodeZmtpReady());
  await transport.close();
});

Deno.test("ZMTP transport preserves long frame lengths", async () => {
  const payload = Uint8Array.from({ length: 300 }, (_, index) => index & 0xff);
  const incoming = concat([
    encodeZmtpGreeting(true),
    encodeZmtpReady(),
    encodeZmtpMessage([payload]),
  ]);
  const conn = new FakeConn(incoming);
  const transport = await openZmtpTransport(conn);
  assertEquals(await transport.receive(), [payload]);
  await transport.close();
});

Deno.test("Jupyter channels use their required ZMTP socket types", async () => {
  const ports = [5555, 5556, 5557, 5558, 5559];
  const connections = ports.map(() =>
    new FakeConn(concat([encodeZmtpGreeting(true), encodeZmtpReady()]))
  );
  const transport = await createJupyterTransport(
    (port) => connections[ports.indexOf(port)],
    {
      key: "yurt",
      shell: ports[0],
      iopub: ports[1],
      stdin: ports[2],
      control: ports[3],
      heartbeat: ports[4],
    },
  );

  assertEquals(socketTypeFromReady(connections[0].writes[1]), "DEALER");
  assertEquals(socketTypeFromReady(connections[1].writes[1]), "SUB");
  assertEquals(socketTypeFromReady(connections[2].writes[1]), "DEALER");
  assertEquals(socketTypeFromReady(connections[3].writes[1]), "DEALER");
  assertEquals(socketTypeFromReady(connections[4].writes[1]), "REQ");
  assertEquals(connections[1].writes[2], encodeZmtpCommand("SUBSCRIBE"));
  await transport.close();
});

Deno.test("Jupyter IOPub decoding removes the topic frame", async () => {
  const message = {
    header: {
      msg_id: "msg-1",
      username: "user",
      session: "session-1",
      msg_type: "stream",
      version: "5.3",
    },
    parent_header: {},
    metadata: {},
    content: { name: "stdout", text: "hello" },
  };
  const encoded = await encodeJupyterMessage(message, "yurt");
  const decoded = await decodeJupyterChannelMessage(
    [new TextEncoder().encode("stream.stdout"), ...encoded],
    "yurt",
  );
  assertEquals(decoded, { ...message, buffers: [] });
});

Deno.test("Jupyter channel setup closes channels opened before a failure", async () => {
  const ports = [5555, 5556, 5557, 5558, 5559];
  const connections = ports.map((_, index) =>
    index === 2
      ? new FakeConn(new Uint8Array())
      : new FakeConn(concat([encodeZmtpGreeting(true), encodeZmtpReady()]))
  );

  await assertRejects(() =>
    createJupyterTransport(
      (port) => connections[ports.indexOf(port)],
      {
        key: "yurt",
        shell: ports[0],
        iopub: ports[1],
        stdin: ports[2],
        control: ports[3],
        heartbeat: ports[4],
      },
    )
  );
  assertEquals(connections.map((connection) => connection.closed), [
    true,
    true,
    false,
    true,
    true,
  ]);
});

class FakeConn {
  readonly writes: Uint8Array[] = [];
  #incoming: Uint8Array;
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  constructor(incoming: Uint8Array) {
    this.#incoming = incoming;
  }

  write(bytes: Uint8Array): Promise<void> {
    this.writes.push(bytes.slice());
    return Promise.resolve();
  }

  read(length: number): Promise<Uint8Array> {
    if (this.#incoming.length === 0) {
      return Promise.resolve(new Uint8Array());
    }
    const result = this.#incoming.slice(0, Math.min(3, length));
    this.#incoming = this.#incoming.slice(result.length);
    return Promise.resolve(result);
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }
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

function socketTypeFromReady(ready: Uint8Array): string {
  const bodyLength = ready[1];
  const body = ready.slice(2, 2 + bodyLength);
  const nameLength = body[6];
  const valueLengthOffset = 7 + nameLength;
  const valueLength = new DataView(
    body.buffer,
    body.byteOffset,
    body.byteLength,
  ).getUint32(valueLengthOffset, false);
  return new TextDecoder().decode(
    body.slice(valueLengthOffset + 4, valueLengthOffset + 4 + valueLength),
  );
}

function encodeZmtpCommand(name: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  return Uint8Array.of(4, nameBytes.length + 1, nameBytes.length, ...nameBytes);
}
