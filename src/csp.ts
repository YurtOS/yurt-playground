/**
 * Content Security Policy for the playground pages.
 *
 * The guest has no network; this is what keeps the *page* honest about it.
 * Every request the browser makes from a playground page must stay on the
 * site's own origin (`connect-src 'self'`), so notebook markdown, rich HTML
 * output or a broken frontend cannot phone out. Scripts come from the origin
 * plus the inline bootstraps JupyterLite emits in its index pages, allowed
 * by hash; the WebAssembly kernel needs `'wasm-unsafe-eval'`. Styles allow
 * inline because JupyterLab sets them everywhere.
 */

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

export type CspOptions = {
  /** `'sha256-…'` sources for the document's inline scripts. */
  scriptHashes?: string[];
  /**
   * JupyterLab compiles its settings schemas with ajv, which builds
   * validators with `new Function`; only the JupyterLite pages get this.
   */
  allowEval?: boolean;
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
    "connect-src 'self'",
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
  return contentSecurityPolicy({
    scriptHashes,
    allowEval: pathname.startsWith(JUPYTER_PREFIX),
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
      })
    }`,
  );
  return lines.join("\n") + "\n";
}
