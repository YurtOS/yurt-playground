/**
 * Content Security Policy for the playground pages.
 *
 * The guest has no network; this is what keeps the *page* honest about it.
 * Every request the browser makes from a playground page must stay on the
 * site's own origin (`connect-src 'self'`), so notebook markdown, rich HTML
 * output or a broken frontend cannot phone out. Two exceptions. Outside
 * JupyterLite only: the local agent's weights (#140) download from Hugging
 * Face ({@link MODEL_ORIGINS}); gigabytes do not fit the site's host. On
 * every page: the packages the sandbox installs come from the one
 * repository path YurtOS/yurt-packages ({@link PACKAGE_SOURCES},
 * src/packages.ts) -- on the slim image the Notebook and Lab pages install
 * Python from there before their kernel starts. Outside JupyterLite only:
 * uploaded sandbox snapshots (`?snapshot=<id>`) come from the one
 * repository path YurtOS/yurt-playground ({@link SNAPSHOT_SOURCE}), once
 * the GitHub API's list of its snapshot refs ({@link SNAPSHOT_REFS_API})
 * says the repository published them (src/snapshot_source.ts). Scripts come from the origin
 * plus the inline bootstraps JupyterLite emits in its index pages, allowed
 * by hash; the WebAssembly kernel needs `'wasm-unsafe-eval'`. Styles allow
 * inline because JupyterLab sets them everywhere.
 */

import { PACKAGE_SOURCES } from "./packages.ts";
import { SNAPSHOT_REFS_API, SNAPSHOT_SOURCE } from "./snapshot_source.ts";

const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

/** Inline script bodies a browser would execute (not JSON data blocks). */
export function inlineScripts(html: string): string[] {
  const bodies: string[] = [];
  for (const match of html.matchAll(INLINE_SCRIPT)) {
    const [, attrs, body] = match;
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1];
    if (
      type !== undefined && type !== "module" &&
      !/^(text|application)\/(javascript|ecmascript)$/i.test(type)
    ) {
      continue;
    }
    bodies.push(body);
  }
  return bodies;
}

/** `'sha256-…'` sources for a page's inline scripts, in document order. */
export async function inlineScriptHashes(html: string): Promise<string[]> {
  const hashes: string[] = [];
  for (const body of inlineScripts(html)) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body),
    );
    hashes.push(
      `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`,
    );
  }
  return hashes;
}

/** Where the agent's model weights come from (src/llm_models.ts):
 * `huggingface.co` answers with a redirect to its CDN under `hf.co`, and a
 * CSP checks every hop. */
export const MODEL_ORIGINS = ["https://huggingface.co", "https://*.hf.co"];

export type CspOptions = {
  /** `'sha256-…'` sources for the document's inline scripts. */
  scriptHashes?: string[];
  /**
   * JupyterLab compiles its settings schemas with ajv, which builds
   * validators with `new Function`; only the JupyterLite pages get this.
   */
  allowEval?: boolean;
  /** No model download and no uploaded snapshot: `connect-src` is the
   * origin and the packages repository's path only. */
  sameOriginOnly?: boolean;
};

export function contentSecurityPolicy(options: CspOptions = {}): string {
  const script = [
    "'self'",
    "'wasm-unsafe-eval'",
    ...(options.allowEval ? ["'unsafe-eval'"] : []),
    ...(options.scriptHashes ?? []),
  ].join(" ");
  return [
    "default-src 'self'",
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    [
      "connect-src 'self'",
      ...(options.sameOriginOnly ? [] : MODEL_ORIGINS),
      ...PACKAGE_SOURCES,
      ...(options.sameOriginOnly ? [] : [SNAPSHOT_SOURCE, SNAPSHOT_REFS_API]),
    ].join(" "),
    "worker-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** The path prefix whose documents get the JupyterLab allowances. */
export const JUPYTER_PREFIX = "/jupyter/";

/** The policy for a document served at `pathname` with the given inline hashes. */
export function documentPolicy(
  pathname: string,
  scriptHashes: string[],
): string {
  const jupyter = pathname.startsWith(JUPYTER_PREFIX);
  return contentSecurityPolicy({
    scriptHashes,
    allowEval: jupyter,
    sameOriginOnly: jupyter,
  });
}

/**
 * Cloudflare Pages `_headers`: a site-wide isolation + strict CSP rule, and a
 * JupyterLite rule that detaches the strict policy before adding its own
 * (Pages joins repeated headers with a comma, which would stack both
 * policies and keep the eval refusal).
 */
export function headersFile(
  isolation: Record<string, string>,
  siteScriptHashes: string[],
  jupyterScriptHashes: string[],
): string {
  const lines = ["/*"];
  for (const [name, value] of Object.entries(isolation)) {
    lines.push(`  ${name}: ${value}`);
  }
  lines.push(
    `  Content-Security-Policy: ${
      contentSecurityPolicy({ scriptHashes: siteScriptHashes })
    }`,
  );
  lines.push(`${JUPYTER_PREFIX}*`);
  lines.push("  ! Content-Security-Policy");
  lines.push(
    `  Content-Security-Policy: ${
      contentSecurityPolicy({
        scriptHashes: jupyterScriptHashes,
        allowEval: true,
        sameOriginOnly: true,
      })
    }`,
  );
  return lines.join("\n") + "\n";
}
