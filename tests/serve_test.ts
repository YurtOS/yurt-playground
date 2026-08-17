import { assertEquals } from "@std/assert";
import {
  handlePlaygroundRequest,
  resolvePlaygroundPath,
} from "../src/serve.ts";

const isolation = {
  coop: "same-origin",
  coep: "require-corp",
};

Deno.test("playground HTTP responses carry COOP/COEP", async () => {
  const res = await handlePlaygroundRequest(new Request("http://playground/"));
  assertEquals(res.headers.get("Cross-Origin-Opener-Policy"), isolation.coop);
  assertEquals(
    res.headers.get("Cross-Origin-Embedder-Policy"),
    isolation.coep,
  );
  const html = await res.text();
  assertEquals(html.includes("crossOriginIsolated"), true);
});

Deno.test("path resolver rejects a .. segment", () => {
  assertEquals(resolvePlaygroundPath("/foo/../index.html"), null);
  assertEquals(resolvePlaygroundPath("/../../pins.json"), null);
});

Deno.test("handler rejects a malformed percent-encoding", async () => {
  const res = await handlePlaygroundRequest(
    new Request("http://playground/%zz"),
  );
  assertEquals(res.status, 404);
  assertEquals(res.headers.get("Cross-Origin-Opener-Policy"), isolation.coop);
  await res.body?.cancel();
});

Deno.test("handler 404s also carry isolation headers", async () => {
  const res = await handlePlaygroundRequest(
    new Request("http://playground/nope"),
  );
  assertEquals(res.status, 404);
  assertEquals(res.headers.get("Cross-Origin-Opener-Policy"), isolation.coop);
  assertEquals(
    res.headers.get("Cross-Origin-Embedder-Policy"),
    isolation.coep,
  );
  await res.body?.cancel();
});
