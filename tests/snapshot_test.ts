import { assertEquals, assertRejects } from "@std/assert";
import {
  decodeSnapshot,
  encodeSnapshot,
  snapshotDownload,
  type SnapshotEnvelope,
} from "../src/snapshot.ts";

const envelope: SnapshotEnvelope = {
  version: 1,
  resourceGraphDigest: "a".repeat(64),
  resources: [
    { id: "pty-0", kind: "pty" },
    { id: "jupyter-0", kind: "jupyter-port" },
  ],
  payload: new Uint8Array([1, 2, 3]),
};

Deno.test("snapshot envelope round-trips opaque kernel bytes", () => {
  const decoded = decodeSnapshot(encodeSnapshot(envelope));
  assertEquals(decoded.version, envelope.version);
  assertEquals(decoded.resourceGraphDigest, envelope.resourceGraphDigest);
  assertEquals(decoded.resources, envelope.resources);
  assertEquals(decoded.payload, envelope.payload);
});

Deno.test("snapshot validation rejects malformed metadata and truncation", async () => {
  await assertRejects(
    async () => decodeSnapshot(new TextEncoder().encode("bad")),
    Error,
    "magic",
  );
  const encoded = encodeSnapshot(envelope).slice(0, -1);
  await assertRejects(
    async () => decodeSnapshot(encoded),
    Error,
    "length",
  );
});

Deno.test("snapshot download uses the browser file type and extension", async () => {
  const download = snapshotDownload(envelope, "session");
  assertEquals(download.name, "session.yurtsnapshot");
  assertEquals(download.blob.type, "application/x-yurt-snapshot");
  assertEquals(
    new Uint8Array(await download.blob.arrayBuffer()),
    encodeSnapshot(envelope),
  );
});
