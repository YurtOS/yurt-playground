/**
 * A file of the site this script was served from. Every bundle sits at the
 * site's root, so resolving against the bundle's own URL names the same file
 * at `/` (production, the desktop app) and under a path (a GitHub Pages
 * preview, `/<repo>/preview/<branch>/`), from any page: the JupyterLite pages
 * under `jupyter/` included, where a page-relative `./` would not. Classic
 * worker bundles have `import.meta.url` rewritten to `self.location.href`
 * (scripts/serve.ts), their own URL at the same root.
 */
export function siteUrl(path: string): string {
  return new URL(path, import.meta.url).href;
}
