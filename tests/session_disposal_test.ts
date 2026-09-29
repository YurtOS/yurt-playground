import { assertRejects, assertThrows } from "@std/assert";
import { bootPlayground } from "../src/boot.ts";
import { ExecutionRegistry } from "../src/executions.ts";
import {
  fetchViaHandler,
  memoryTerm,
  resolvePlaygroundArtifacts,
} from "./ash_harness.ts";
Deno.test("browser disposal releases live guest waits and pending finite output sweeps", async () => {
  await resolvePlaygroundArtifacts(true);
  const session = await bootPlayground({
    isolated: true,
    fetchBytes: fetchViaHandler,
    term: memoryTerm(),
    show: () => {},
  });
  try {
    const registry = new ExecutionRegistry(session.process!, session.signal!);
    await registry.wait(await registry.spawn("true"));
    session.stop();
    await session.spawn("exec sleep 600");
  } finally {
    session.dispose();
    session.dispose();
  }
  await assertRejects(
    () => session.spawn("exec sleep 1"),
    Error,
    "disposed",
  );
  assertThrows(() => session.dialSandboxPort(8001), Error, "disposed");
});

Deno.test("browser disposal rejects a process launch already in flight", async () => {
  await resolvePlaygroundArtifacts(true);
  const session = await bootPlayground({
    isolated: true,
    fetchBytes: fetchViaHandler,
    term: memoryTerm(),
    show: () => {},
  });
  const launch = session.spawn("exec sleep 600");
  session.dispose();
  await assertRejects(() => launch, Error, "disposed");
});

Deno.test("browser boot releases its kernel when image loading fails", async () => {
  await resolvePlaygroundArtifacts(true);
  await assertRejects(
    () =>
      bootPlayground({
        isolated: true,
        fetchBytes: (path) => {
          if (path.endsWith("playground.yurtimg")) {
            return Promise.reject(new Error("image unavailable"));
          }
          return fetchViaHandler(path);
        },
        term: memoryTerm(),
        show: () => {},
      }),
    Error,
    "image unavailable",
  );
});
