const MAGIC = "YURT-SNAPSHOT\n";
const VERSION = 1;

export type SnapshotResource = {
  id: string;
  kind: "pty" | "jupyter-port" | "other";
};

export type SnapshotEnvelope = {
  version: 1;
  resourceGraphDigest: string;
  resources: SnapshotResource[];
  payload: Uint8Array;
};

export function encodeSnapshot(envelope: SnapshotEnvelope): Uint8Array {
  validateMetadata(envelope);
  const metadata = new TextEncoder().encode(
    JSON.stringify({
      version: VERSION,
      resourceGraphDigest: envelope.resourceGraphDigest,
      resources: envelope.resources,
      payloadLength: envelope.payload.byteLength,
    }),
  );
  const prefix = new TextEncoder().encode(MAGIC);
  const output = new Uint8Array(
    prefix.length + metadata.length + 1 + envelope.payload.length,
  );
  output.set(prefix);
  output.set(metadata, prefix.length);
  output[prefix.length + metadata.length] = 10;
  output.set(envelope.payload, prefix.length + metadata.length + 1);
  return output;
}

export function decodeSnapshot(bytes: Uint8Array): SnapshotEnvelope {
  const magic = new TextEncoder().encode(MAGIC);
  if (!startsWith(bytes, magic)) throw new Error("invalid snapshot magic");
  const headerStart = magic.length;
  const separator = bytes.indexOf(10, headerStart);
  if (separator < 0) throw new Error("snapshot metadata is missing");
  let metadata: unknown;
  try {
    metadata = JSON.parse(
      new TextDecoder().decode(bytes.slice(headerStart, separator)),
    );
  } catch {
    throw new Error("snapshot metadata is invalid");
  }
  if (metadata === null || typeof metadata !== "object") {
    throw new Error("snapshot metadata is invalid");
  }
  const value = metadata as Record<string, unknown>;
  const payload = bytes.slice(separator + 1);
  if (value.payloadLength !== payload.byteLength) {
    throw new Error("snapshot payload length mismatch");
  }
  const envelope = {
    version: value.version,
    resourceGraphDigest: value.resourceGraphDigest,
    resources: value.resources,
    payload,
  } as SnapshotEnvelope;
  validateMetadata(envelope);
  return envelope;
}

export function snapshotDownload(
  envelope: SnapshotEnvelope,
  name = "yurt-sandbox.yurtsnapshot",
): { blob: Blob; name: string } {
  const bytes = encodeSnapshot(envelope);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return {
    blob: new Blob([copy.buffer], {
      type: "application/x-yurt-snapshot",
    }),
    name: name.endsWith(".yurtsnapshot") ? name : `${name}.yurtsnapshot`,
  };
}

function validateMetadata(envelope: SnapshotEnvelope): void {
  if (envelope.version !== VERSION) {
    throw new Error("unsupported snapshot version");
  }
  if (!/^[0-9a-f]{64}$/.test(envelope.resourceGraphDigest)) {
    throw new Error("snapshot resource graph digest is invalid");
  }
  if (!Array.isArray(envelope.resources) || envelope.resources.length === 0) {
    throw new Error("snapshot resource graph is empty");
  }
  const ids = new Set<string>();
  for (const resource of envelope.resources) {
    if (
      resource === null ||
      typeof resource !== "object" ||
      typeof resource.id !== "string" ||
      !resource.id ||
      !["pty", "jupyter-port", "other"].includes(resource.kind)
    ) {
      throw new Error("snapshot resource entry is invalid");
    }
    if (ids.has(resource.id)) {
      throw new Error("snapshot resource ids are duplicated");
    }
    ids.add(resource.id);
  }
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}
