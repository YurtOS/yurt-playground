import { assertEquals, assertThrows } from "@std/assert";
import {
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

class FakeConn {
  readonly writes: Uint8Array[] = [];
  #incoming: Uint8Array;
  #closed = false;

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
