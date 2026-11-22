import { assertEquals, assertThrows } from "@std/assert";
import {
  acceptKey,
  encodeFrame,
  MessageReader,
  OPCODE,
  parseFrames,
} from "../src/ws_frames.ts";

/** A client frame as a browser or Playwright sends it: masked. */
function clientFrame(
  opcode: number,
  payload: Uint8Array,
  fin = true,
  mask = [1, 2, 3, 4],
): Uint8Array {
  const n = payload.length;
  const header = n < 126 ? 2 : n < 0x10000 ? 4 : 10;
  const out = new Uint8Array(header + 4 + n);
  out[0] = (fin ? 0x80 : 0) | opcode;
  if (header === 2) out[1] = 0x80 | n;
  else if (header === 4) {
    out[1] = 0x80 | 126;
    out[2] = n >> 8;
    out[3] = n & 0xff;
  } else {
    out[1] = 0x80 | 127;
    new DataView(out.buffer).setBigUint64(2, BigInt(n));
  }
  out.set(mask, header);
  for (let i = 0; i < n; i++) out[header + 4 + i] = payload[i] ^ mask[i & 3];
  return out;
}

const text = (s: string) => new TextEncoder().encode(s);

Deno.test("the accept key is RFC 6455's example", async () => {
  assertEquals(
    await acceptKey("dGhlIHNhbXBsZSBub25jZQ=="),
    "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
  );
});

Deno.test("a masked text frame of each length form reads back", () => {
  for (const n of [0, 5, 125, 126, 1000, 70_000]) {
    const body = "x".repeat(n);
    const { frames, rest } = parseFrames(clientFrame(OPCODE.text, text(body)));
    assertEquals(frames.length, 1);
    assertEquals(new TextDecoder().decode(frames[0].payload), body);
    assertEquals(rest.length, 0);
  }
});

Deno.test("a frame split across reads waits for the rest", () => {
  const whole = clientFrame(OPCODE.text, text('{"id":1}'));
  const reader = new MessageReader();
  assertEquals(reader.push(whole.subarray(0, 5)).messages, []);
  assertEquals(reader.push(whole.subarray(5)).messages, ['{"id":1}']);
});

Deno.test("fragments join; ping gets a pong; close is answered and ends", () => {
  const reader = new MessageReader();
  const bytes = [
    clientFrame(OPCODE.text, text('{"a":'), false),
    clientFrame(OPCODE.ping, text("hi")),
    clientFrame(OPCODE.continuation, text("1}")),
    clientFrame(OPCODE.close, new Uint8Array([0x03, 0xe8])),
  ];
  const all = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of bytes) (all.set(b, at), at += b.length);
  const out = reader.push(all);
  assertEquals(out.messages, ['{"a":1}']);
  assertEquals(out.closed, true);
  assertEquals(out.replies, [
    encodeFrame(OPCODE.pong, text("hi")),
    encodeFrame(OPCODE.close, new Uint8Array([0x03, 0xe8])),
  ]);
});

Deno.test("an unmasked client frame is refused", () => {
  assertThrows(
    () => parseFrames(encodeFrame(OPCODE.text, text("x"))),
    Error,
    "masked",
  );
});

Deno.test("server frames use the shortest length form", () => {
  assertEquals(
    encodeFrame(OPCODE.text, text("ab")),
    new Uint8Array([0x81, 2, 97, 98]),
  );
  assertEquals(
    encodeFrame(OPCODE.text, new Uint8Array(300)).subarray(0, 4),
    new Uint8Array([0x81, 126, 1, 44]),
  );
  assertEquals(
    encodeFrame(OPCODE.text, new Uint8Array(70_000)).subarray(0, 2),
    new Uint8Array([0x81, 127]),
  );
});

Deno.test("a large frame fed in small reads comes out whole, once", () => {
  const body = "y".repeat(200_000);
  const whole = clientFrame(OPCODE.text, text(body));
  const reader = new MessageReader();
  const messages: string[] = [];
  for (let at = 0; at < whole.length; at += 1000) {
    messages.push(...reader.push(whole.subarray(at, at + 1000)).messages);
  }
  assertEquals(messages.length, 1);
  assertEquals(messages[0].length, body.length);
});

Deno.test("a malformed close gets 1002 and a binary frame 1003", () => {
  assertEquals(
    new MessageReader().push(clientFrame(OPCODE.close, new Uint8Array([1])))
      .replies,
    [encodeFrame(OPCODE.close, new Uint8Array([0x03, 0xea]))],
  );
  const binary = new MessageReader().push(
    clientFrame(OPCODE.binary, new Uint8Array([1, 2])),
  );
  assertEquals(binary.closed, true);
  assertEquals(binary.messages, []);
  assertEquals(binary.replies, [
    encodeFrame(OPCODE.close, new Uint8Array([0x03, 0xeb])),
  ]);
});

Deno.test("an unmasked frame fails at its header; fragments keep their order", () => {
  assertThrows(
    () => new MessageReader().push(new Uint8Array([0x81, 10])),
    Error,
    "masked",
  );
  // A new text frame inside an open message, and a continuation outside one.
  assertThrows(
    () =>
      new MessageReader().push(
        new Uint8Array([
          ...clientFrame(OPCODE.text, text("abc"), false),
          ...clientFrame(OPCODE.text, text('{"id":1}')),
        ]),
      ),
    Error,
    "out of order",
  );
  assertThrows(
    () => new MessageReader().push(clientFrame(OPCODE.continuation, text("x"))),
    Error,
    "out of order",
  );
});
