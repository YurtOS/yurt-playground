/**
 * What turns a built site (dist/) into a GitHub Pages preview
 * (scripts/build-static.ts --gh-pages-preview, .github/workflows/
 * preview-gh-pages.yml). GitHub Pages sends none of `_headers`, so:
 *
 * - cross-origin isolation comes from a service worker
 *   (scripts/gh-pages-preview/), which every page loads first;
 * - each page carries the CSP it would get from `_headers`, as a `<meta>`,
 *   minus `frame-ancestors`, which a `<meta>` cannot set. Workers get no CSP
 *   at all, and there is no Permissions-Policy: a preview must not be used to
 *   test security or isolation changes (docs/MAINTAINING.md "Previews").
 *
 * A production build never calls this, and never carries any of it.
 */
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { documentPolicy, inlineScriptHashes } from "../../src/csp.ts";

const shimDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "gh-pages-preview",
);

/** The registration script and its service worker, at the site's root. */
export const PREVIEW_FILES = ["isolation.js", "isolation-sw.js"];

/** JupyterLite's own service worker: it controls the pages under jupyter/,
 * so it imports the isolation worker too. */
const JUPYTER_SERVICE_WORKER = "jupyter/service-worker.js";

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
  const jupyterWorker = join(dist, JUPYTER_SERVICE_WORKER);
  await Deno.writeTextFile(
    jupyterWorker,
    'importScripts("../isolation-sw.js");\n' +
      await Deno.readTextFile(jupyterWorker),
  );
  // Not read by GitHub Pages; left out so nobody takes it for what the
  // preview enforces.
  await Deno.remove(join(dist, "_headers"));
}
