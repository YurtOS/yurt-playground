/**
 * Sanitized markup fetches nothing.
 *
 * Markdown, cells and `text/markdown` output alike, renders sanitized in the
 * page itself (so its math typesets), where the page's policy allows its own
 * origin. JupyterLab's sanitizer keeps image, media and CSS URLs, so
 * {@link refuseUrlsIn} makes the app's one sanitizer also drop every URL the
 * browser would load without a click, unless it is a `data:` URL:
 *
 * - `src`, `srcset`, `poster`, `background`, `data` and `xlink:href` on any
 *   element, and `href` on anything but a link (`a`, `area`);
 * - style declarations holding `url()`, `image()`, `image-set()`,
 *   `cross-fade()`, `src()` or `element()`.
 *
 * Of these the sanitizer keeps `src`, `poster` and style; the rest are
 * covered in case its rules change. An `img` keeps an `attachment:` source,
 * which JupyterLab replaces with the cell attachment's `data:` URL (an
 * unresolved one loads nothing).
 */
import type { IRenderMime } from "@jupyterlab/rendermime-interfaces";

/** Attributes whose URL the browser fetches without a click. */
const FETCHED = new Set([
  "src",
  "srcset",
  "poster",
  "background",
  "data",
  "xlink:href",
  "href",
]);

/** CSS functions that take a URL (or an image that may be one). */
const CSS_FETCH = /(?:url|image|image-set|cross-fade|src|element)\s*\(/i;
/** A `data:` URL as the CSSOM serializes it. */
const CSS_DATA_URL = /url\("data:(?:[^"\\]|\\.)*"\)/gi;

/** Nothing may come before the scheme: the URL parser strips leading
 * controls and spaces, but JupyterLab then takes " data:x" for a drive path,
 * and a Unicode space makes it a relative URL. */
function isData(url: string): boolean {
  return /^data:/i.test(url);
}

/** Whether `element` may keep `name="value"`. */
function keeps(element: Element, name: string, value: string): boolean {
  if (!FETCHED.has(name)) return true;
  if (
    name === "href" &&
    (element.localName === "a" || element.localName === "area")
  ) {
    return true;
  }
  if (name === "srcset") return false;
  if (
    name === "src" && element.localName === "img" &&
    /^attachment:/i.test(value)
  ) {
    return true;
  }
  return isData(value);
}

/** `html` with every URL the browser would fetch without a click, other
 * than a `data:` URL, removed. It is parsed in an inert document, which loads
 * nothing, and serialized again. */
export function refuseUrls(html: string): string {
  const doc = new DOMParser().parseFromString(
    `<!doctype html><body>${html}`,
    "text/html",
  );
  for (const element of Array.from(doc.body.querySelectorAll("*"))) {
    for (const { name, value } of Array.from(element.attributes)) {
      if (name === "style") continue;
      if (!keeps(element, name.toLowerCase(), value)) {
        element.removeAttribute(name);
      }
    }
    const style = (element as HTMLElement).style;
    if (style === undefined || !element.hasAttribute("style")) continue;
    for (const property of Array.from(style)) {
      const value = style.getPropertyValue(property);
      if (CSS_FETCH.test(value.replace(CSS_DATA_URL, ""))) {
        style.removeProperty(property);
      }
    }
    if (style.length === 0) element.removeAttribute("style");
  }
  // The parser drops a newline right after <pre> or <textarea> and the
  // serializer does not write it back, so a leading blank line would be lost.
  for (
    const element of Array.from(doc.body.querySelectorAll("pre, textarea"))
  ) {
    const first = element.firstChild;
    if (
      first?.nodeType === Node.TEXT_NODE && first.textContent!.startsWith("\n")
    ) {
      first.textContent = "\n" + first.textContent;
    }
  }
  return doc.body.innerHTML;
}

/**
 * Make `sanitizer` refuse URLs too. The app has one sanitizer: rendermime's
 * renderers (a notebook's are a copy, so its Markdown cells too) and the
 * Table of Contents, which renders a Markdown heading to find its id, both
 * use it.
 */
export function refuseUrlsIn(sanitizer: IRenderMime.ISanitizer): void {
  if (unpatched.has(sanitizer)) return;
  const sanitize = sanitizer.sanitize.bind(sanitizer);
  unpatched.set(sanitizer, sanitize);
  sanitizer.sanitize = (dirty, options) => refuseUrls(sanitize(dirty, options));
}

/** `sanitizer` as JupyterLab made it, URLs kept: only for markup that goes
 * into an output frame, whose own policy and sandbox refuse them. */
export function sanitizeKeepingUrls(
  sanitizer: IRenderMime.ISanitizer,
  dirty: string,
): string {
  return (unpatched.get(sanitizer) ?? sanitizer.sanitize)(dirty);
}

/** Each patched sanitizer's own `sanitize`. */
const unpatched = new WeakMap<
  IRenderMime.ISanitizer,
  IRenderMime.ISanitizer["sanitize"]
>();
