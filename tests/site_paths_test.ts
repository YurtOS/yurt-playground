import { assertEquals } from "@std/assert";

/**
 * The site works at `/` (production, the desktop app) and under a path (a
 * GitHub Pages preview, `/yurt-playground/preview/<branch>/`), so code that
 * runs in the browser names the site's own files relative to the site
 * (src/site_url.ts, or `./` from a page or worker at the root), never from the
 * origin's root. The servers (src/serve.ts, the desktop launcher, and the
 * policy they and the build serve, src/csp.ts) and 404.html, which Cloudflare
 * serves at any depth, are the exceptions. Comments are not read.
 */
const root = new URL("..", import.meta.url);

const SERVER_SIDE = new Set([
  "src/serve.ts",
  "src/desktop.ts",
  "src/desktop_api.ts",
  "src/csp.ts",
]);

/** Lines that name a root path on purpose, and why. */
const ALLOWED = new Map([
  [
    // Never fetched: one key per origin, so every preview shares the
    // downloaded model with the others.
    "src/llm_models.ts",
    "return `/llm/${model.file}?sha256=${model.sha256}`;",
  ],
]);

/** Top-level names the built site has (scripts/build-static.ts). */
async function siteNames(): Promise<string[]> {
  const names = new Set([
    "pins.json",
    "yurt_kernel.wasm",
    "integrity.json",
    "xterm.css",
    "llm",
    "jupyter",
    "snapshot",
    "playground.yurtimg",
    "playground-slim.yurtimg",
    "coordinator.bundle.js",
    "boot.bundle.js",
    "snapshot.bundle.js",
    "snapshot_page.bundle.js",
    "notebook_kernel.bundle.js",
    "llm_worker.bundle.js",
    "worker_bootstrap.js",
    "playground-bridge.js",
    "snapshot-bridge.js",
  ]);
  for await (const entry of Deno.readDir(new URL("public/", root))) {
    names.add(entry.name);
  }
  return [...names];
}

async function browserSources(): Promise<string[]> {
  const files = ["jupyterlite/yurt-kernel/src/index.ts"];
  for await (const entry of Deno.readDir(new URL("src/", root))) {
    const path = `src/${entry.name}`;
    if (entry.name.endsWith(".ts") && !SERVER_SIDE.has(path)) files.push(path);
  }
  for (const name of ["verify.js", "memory-probe.js"]) {
    files.push(`public/${name}`);
  }
  for await (const entry of Deno.readDir(new URL("public/", root))) {
    if (entry.name.endsWith(".html") && entry.name !== "404.html") {
      files.push(`public/${entry.name}`);
    }
  }
  return files.sort();
}

Deno.test("browser code names the site's files relative to the site, not the origin's root", async () => {
  const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const absolute = new RegExp(
    `["'\`(]/(?:${(await siteNames()).map(escape).join("|")})(?=[/"'\`?#)])`,
  );
  const found: string[] = [];
  for (const file of await browserSources()) {
    const lines = (await Deno.readTextFile(new URL(file, root))).split("\n");
    lines.forEach((line, index) => {
      const code = line.trim();
      if (/^(\/\/|\/\*|\*)/.test(code) || ALLOWED.get(file) === code) return;
      if (absolute.test(code)) found.push(`${file}:${index + 1}: ${code}`);
    });
  }
  assertEquals(found, []);
});
