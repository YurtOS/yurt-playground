/**
 * What turns a built site (dist/) into a GitHub Pages preview
 * (scripts/build-static.ts --gh-pages-preview, .github/workflows/
 * preview-gh-pages.yml). GitHub Pages sends none of `_headers`, so:
 *
 * - cross-origin isolation comes from a service worker
 *   (scripts/gh-pages-preview/), which every page loads first. It is the
 *   only one: JupyterLite's own (its service-worker-manager plugin) would
 *   control jupyter/ instead, and unregisters every other worker on the
 *   origin when it first starts, so the Workers a JupyterLite page starts
 *   from the site's root would get no isolation headers. Nothing the
 *   playground ships uses it: it serves in-browser kernels' file and stdin
 *   requests, and the Yurt kernel runs in the sandbox;
 * - each page carries the CSP it would get from `_headers`, as a `<meta>`,
 *   minus `frame-ancestors`, which a `<meta>` cannot set. Workers get no CSP
 *   at all, there is no Permissions-Policy, and `'self'` is all of
 *   yurtos.github.io, every YurtOS Pages site: a preview must not be used to
 *   test security or isolation changes (docs/MAINTAINING.md "Previews").
 *
 * A production build never calls this, and never carries any of it.
 */
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { documentPolicy, inlineScriptHashes } from "../../src/csp.ts";
import type { SnapshotKind } from "../../src/snapshot_pin.ts";

const shimDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "gh-pages-preview",
);

/** The device snapshots a preview publishes: GitHub Pages refuses a site over
 * 1 GB, and all of them are over 500 MB. The desktop one only, 143 MB, since
 * a desktop browser's Notebook and Lab pages require it
 * (src/lite_bridge.ts); the other pages boot the image without theirs. */
export const PREVIEW_SNAPSHOT_KINDS: readonly SnapshotKind[] = ["desktop"];

/** The registration script and its service worker, at the site's root. */
export const PREVIEW_FILES = ["isolation.js", "isolation-sw.js"];

/** JupyterLite's site configuration, and the plugin that registers its
 * service worker. */
const JUPYTER_CONFIG = "jupyter/jupyter-lite.json";
export const JUPYTER_SERVICE_WORKER_PLUGIN =
  "@jupyterlite/application-extension:service-worker-manager";

/** The policy a `<meta>` can carry for the page at `pathname`. */
export function metaPolicy(pathname: string, scriptHashes: string[]): string {
  return documentPolicy(pathname, scriptHashes).split("; ")
    .filter((directive) => !directive.startsWith("frame-ancestors "))
    .join("; ");
}

/** `html` with the policy and the isolation script first in its `<head>`.
 * `root` is the site's root relative to the page (`./`, `../../`). */
export async function previewDocument(
  html: string,
  pathname: string,
  root: string,
): Promise<string> {
  const policy = metaPolicy(pathname, await inlineScriptHashes(html));
  if (policy.includes('"')) throw new Error(`quote in the CSP: ${policy}`);
  const head = /<head\b[^>]*>/i.exec(html);
  if (head === null) throw new Error(`${pathname} has no <head>`);
  const at = head.index + head[0].length;
  return html.slice(0, at) +
    `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
    `<script src="${root}isolation.js"></script>` + html.slice(at);
}

async function htmlFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) found.push(...await htmlFiles(path));
    else if (entry.name.endsWith(".html")) found.push(path);
  }
  return found;
}

/** Make the built site in `dist` a GitHub Pages preview, in place. */
export async function writeGhPagesPreview(dist: string): Promise<void> {
  for (const file of PREVIEW_FILES) {
    await Deno.copyFile(join(shimDir, file), join(dist, file));
  }
  for (const path of await htmlFiles(dist)) {
    const page = relative(dist, path);
    const depth = page.split("/").length - 1;
    await Deno.writeTextFile(
      path,
      await previewDocument(
        await Deno.readTextFile(path),
        `/${page}`,
        depth === 0 ? "./" : "../".repeat(depth),
      ),
    );
  }
  const configPath = join(dist, JUPYTER_CONFIG);
  const config = JSON.parse(await Deno.readTextFile(configPath));
  const data = config["jupyter-config-data"];
  data.disabledExtensions = [
    ...(data.disabledExtensions ?? []),
    JUPYTER_SERVICE_WORKER_PLUGIN,
  ];
  await Deno.writeTextFile(configPath, JSON.stringify(config, null, 2) + "\n");
  // Not read by GitHub Pages; left out so nobody takes it for what the
  // preview enforces.
  await Deno.remove(join(dist, "_headers"));
}
