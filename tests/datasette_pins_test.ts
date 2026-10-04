import { assertEquals } from "@std/assert";
import { parsePins } from "../src/pins.ts";
const kernel = "a".repeat(64), image = "b".repeat(64), rev = "c".repeat(40);
const pin = (sha256: string, rev: string) => ({
  repo: "YurtOS/example",
  rev,
  build: "build.sh",
  path: "artifact",
  sha256,
});
const base = {
  kernelWasm: pin(kernel, "d".repeat(40)),
  image: pin(image, rev),
};
const qualification = {
  version: "0.65.5",
  kernelSha256: kernel,
  imageSha256: image,
  portsRev: rev,
  inlineScriptHashes: ["sha256-" + "A".repeat(43) + "="],
};
Deno.test("Datasette pins require a qualified exact kernel/image/ports pair", () => {
  assertEquals(parsePins(base).datasette, undefined);
  assertEquals<unknown>(
    parsePins({ ...base, datasette: qualification }).datasette,
    qualification,
  );
  for (
    const change of [
      { version: "0.65.4" },
      { kernelSha256: "e".repeat(64) },
      { imageSha256: "f".repeat(64) },
      { portsRev: "1".repeat(40) },
      { inlineScriptHashes: [] },
      { inlineScriptHashes: ["unsafe-inline"] },
    ]
  ) {
    assertEquals(
      parsePins({ ...base, datasette: { ...qualification, ...change } })
        .datasette,
      undefined,
    );
  }
});
