import { assertEquals, assertStringIncludes } from "@std/assert";
import { ensureGo, GO_FALLBACK_NOTE } from "../src/go_fallback.ts";

function fake(
  { has, installFails = false }: {
    has: boolean | undefined;
    installFails?: boolean;
  },
) {
  const said: string[] = [];
  let installs = 0;
  return {
    said,
    installs: () => installs,
    deps: {
      probe: () => Promise.resolve(has),
      install: () => {
        installs++;
        return installFails
          ? Promise.reject(new Error("pkg exited 1"))
          : Promise.resolve();
      },
      say: (text: string) => said.push(text),
    },
  };
}

Deno.test("a restored Go snapshot, which has go, installs nothing and says nothing", async () => {
  const run = fake({ has: true });
  assertEquals(await ensureGo(run.deps), "present");
  assertEquals([run.installs(), run.said], [0, []]);
  // A probe that cannot tell is no reason to install over the sandbox.
  const unsure = fake({ has: undefined });
  assertEquals(await ensureGo(unsure.deps), "present");
  assertEquals(unsure.installs(), 0);
});

Deno.test("a fallback boot without go installs it with pkg, saying the first build is slow", async () => {
  const run = fake({ has: false });
  assertEquals(await ensureGo(run.deps), "installed");
  assertEquals(run.installs(), 1);
  assertEquals(run.said[0], GO_FALLBACK_NOTE);
  assertStringIncludes(
    run.said[0],
    "first go build compiles the standard library",
  );
  assertEquals(run.said[1], "[go is installed]");
});

Deno.test("a failed go install is said, with what to type, and does not throw", async () => {
  const run = fake({ has: false, installFails: true });
  assertEquals(await ensureGo(run.deps), "failed");
  assertStringIncludes(run.said[1], "pkg exited 1");
  assertStringIncludes(run.said[1], "sudo pkg install go");
});
