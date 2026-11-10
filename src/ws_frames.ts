// The server half of RFC 6455, as much as a DevTools client needs: the
// handshake's accept key, text frames both ways (fragmented ones joined),
// ping answered with pong, and close. The guest's Playwright is the client,
// so every frame it sends is masked and every frame sent back is not.

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** `Sec-WebSocket-Accept` for a request's `Sec-WebSocket-Key`. */
export async function acceptKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(key.trim() + GUID),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

/** One frame with its payload unmasked. */
export type Frame = { fin: boolean; opcode: number; payload: Uint8Array };

/** The largest message this end accepts (a CDP screenshot reply comes the
 *  other way; the guest's own messages are small). */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/** The frames whole in `buffer`, and the bytes after them. Throws on an
 *  unmasked client frame or one larger than {@link MAX_MESSAGE_BYTES}. */
export function parseFrames(
  buffer: Uint8Array,
): { frames: Frame[]; rest: Uint8Array } {
  const frames: Frame[] = [];
  let at = 0;
  for (;;) {
    if (buffer.length - at < 2) break;
    const b0 = buffer[at], b1 = buffer[at + 1];
    const masked = (b1 & 0x80) !== 0;
    let length = b1 & 0x7f;
    let header = 2;
    if (length === 126) {
      if (buffer.length - at < 4) break;
      length = (buffer[at + 2] << 8) | buffer[at + 3];
      header = 4;
    } else if (length === 127) {
      if (buffer.length - at < 10) break;
      const view = new DataView(buffer.buffer, buffer.byteOffset + at + 2, 8);
      const big = view.getBigUint64(0);
      if (big > BigInt(MAX_MESSAGE_BYTES)) {
        throw new Error(`a ${big}-byte frame is more than this bridge takes`);
      }
      length = Number(big);
      header = 10;
    }
    if (length > MAX_MESSAGE_BYTES) {
      throw new Error(`a ${length}-byte frame is more than this bridge takes`);
    }
    if (!masked) throw new Error("a client frame must be masked");
    if (buffer.length - at < header + 4 + length) break;
    const mask = buffer.subarray(at + header, at + header + 4);
    const payload = buffer.slice(at + header + 4, at + header + 4 + length);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
    at += header + 4 + length;
  }
  return { frames, rest: buffer.slice(at) };
}

/** A server frame (unmasked, final) with `payload`. */
export function encodeFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const length = payload.length;
  const header = length < 126 ? 2 : length < 0x10000 ? 4 : 10;
  const out = new Uint8Array(header + length);
  out[0] = 0x80 | opcode;
  if (header === 2) out[1] = length;
  else if (header === 4) {
    out[1] = 126;
    out[2] = length >> 8;
    out[3] = length & 0xff;
  } else {
    out[1] = 127;
    new DataView(out.buffer).setBigUint64(2, BigInt(length));
  }
  out.set(payload, header);
  return out;
}

/** Joins fragmented messages and answers control frames. */
export class MessageReader {
  #parts: Uint8Array[] = [];
  #size = 0;
  #pending: Uint8Array = new Uint8Array(0);

  /** Feed received bytes; returns the text messages they completed, the
   *  frames to send back (pongs, a close reply) and whether the peer
   *  closed. */
  push(
    bytes: Uint8Array,
  ): { messages: string[]; replies: Uint8Array[]; closed: boolean } {
    const joined = new Uint8Array(this.#pending.length + bytes.length);
    joined.set(this.#pending);
    joined.set(bytes, this.#pending.length);
    const { frames, rest } = parseFrames(joined);
    this.#pending = rest;
    const messages: string[] = [];
    const replies: Uint8Array[] = [];
    let closed = false;
    for (const frame of frames) {
      if (frame.opcode === OPCODE.ping) {
        replies.push(encodeFrame(OPCODE.pong, frame.payload));
      } else if (frame.opcode === OPCODE.close) {
        replies.push(encodeFrame(OPCODE.close, frame.payload.subarray(0, 2)));
        closed = true;
        break;
      } else if (
        frame.opcode === OPCODE.text || frame.opcode === OPCODE.binary ||
        frame.opcode === OPCODE.continuation
      ) {
        this.#parts.push(frame.payload);
        this.#size += frame.payload.length;
        if (this.#size > MAX_MESSAGE_BYTES) {
          throw new Error("a message larger than this bridge takes");
        }
        if (frame.fin) {
          const whole = new Uint8Array(this.#size);
          let at = 0;
          for (const part of this.#parts) {
            whole.set(part, at);
            at += part.length;
          }
          this.#parts = [];
          this.#size = 0;
          messages.push(new TextDecoder().decode(whole));
        }
      }
    }
    return { messages, replies, closed };
  }
}
