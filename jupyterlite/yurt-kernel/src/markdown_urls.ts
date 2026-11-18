/**
 * Markdown fetches nothing (follow-up to #360, yurt-sandbox#382).
 *
 * Markdown, a notebook's cells and `text/markdown` output alike, renders
 * sanitized in the playground page itself, not in a frame, so that its math
 * still typesets. JupyterLab's sanitizer keeps image, media and CSS URLs, and
 * the page's policy allows its own origin, the notebook's files included. So
 * a shared notebook's Markdown could make the page fetch a URL as soon as it
 * renders. {@link refuseUrls} runs on the sanitizer's output, before
 * JupyterLab puts it into the page, and drops every URL the browser would
 * load without a click unless it is a `data:` URL:
 *
 * - `src`, `srcset`, `poster`, `background`, `data` and `xlink:href` on any
 *   element, and `href` on anything but a link (`a`, `area`);
 * - a style attribute's declarations that hold a URL (`url()`, `image()`,
 *   `image-set()`, `cross-fade()`, `src()`, `element()`).
 *
 * Of these, JupyterLab's sanitizer keeps `src` (img, video, audio, input),
 * `poster` (video) and style; it drops `srcset`, `<source>`'s URLs, `<link>`,
 * `<style>` and `<meta>`. The rest are covered in case its rules change.
 *
 * One exception: an `img` keeps an `attachment:` source. JupyterLab replaces
 * it with the cell's attachment as a `data:` URL, or leaves it as is, which no
 * browser fetches.
 *
 * Links (`a`, `area`) keep their `href`: they load nothing until clicked.
 *
 * Mermaid fences are not drawn: Mermaid lays a diagram out in the page,
 * outside the sanitizer, where an image node loads. jupyter-lite.json
 * disables its extension, and Vega's, which fetches `data.url`
 * (tests/jupyterlite_config_test.ts says why).
 */

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

function isData(url: string): boolean {
  return /^\s*data:/i.test(url);
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
    name === "src" && element.localName === "img" && /^attachment:/i.test(value)
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
  return doc.body.innerHTML;
}
