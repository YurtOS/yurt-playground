const DELIMITER = new TextEncoder().encode("<IDS|MSG>");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type JupyterHeader = {
  msg_id: string;
  username: string;
  session: string;
  msg_type: string;
  version: string;
  [key: string]: unknown;
};

export type JupyterMessage = {
  header: JupyterHeader;
  parent_header: Record<string, unknown>;
  metadata: Record<string, unknown>;
  content: Record<string, unknown>;
  buffers?: Uint8Array[];
};

export type JupyterFrames = Uint8Array[];

export async function encodeJupyterMessage(
  message: JupyterMessage,
  key: string,
): Promise<JupyterFrames> {
  const jsonFrames = [
    encoder.encode(JSON.stringify(message.header)),
    encoder.encode(JSON.stringify(message.parent_header)),
    encoder.encode(JSON.stringify(message.metadata)),
    encoder.encode(JSON.stringify(message.content)),
  ];
  const signature = await sign(jsonFrames, key);
  return [
    DELIMITER.slice(),
    encoder.encode(signature),
    ...jsonFrames,
    ...(message.buffers ?? []).map((buffer) => buffer.slice()),
  ];
}

export async function decodeJupyterMessage(
  frames: JupyterFrames,
  key: string,
): Promise<JupyterMessage> {
  if (frames.length < 6) throw new Error("frame sequence is truncated");
  if (!sameBytes(frames[0], DELIMITER)) {
    throw new Error("Jupyter delimiter frame is missing");
  }
  const body = frames.slice(2, 6);
  const expected = await sign(body, key);
  const actual = decoder.decode(frames[1]);
  if (actual !== expected) {
    throw new Error("Jupyter message signature mismatch");
  }
  try {
    return {
      header: JSON.parse(decoder.decode(body[0])),
      parent_header: JSON.parse(decoder.decode(body[1])),
      metadata: JSON.parse(decoder.decode(body[2])),
      content: JSON.parse(decoder.decode(body[3])),
      buffers: frames.slice(6).map((buffer) => buffer.slice()),
    };
  } catch (error) {
    throw new Error("Jupyter message JSON is invalid", { cause: error });
  }
}

async function sign(
  frames: readonly Uint8Array[],
  key: string,
): Promise<string> {
  const material = concat(frames);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, material);
  return [...new Uint8Array(signature)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function concat(frames: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    frames.reduce((size, frame) => size + frame.length, 0),
  );
  let offset = 0;
  for (const frame of frames) {
    result.set(frame, offset);
    offset += frame.length;
  }
  return result;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((byte, index) => byte === right[index]);
}
