/**
 * HTML output in a sandboxed frame (yurt-sandbox#382, option 2).
 *
 * A cell the visitor runs has trusted outputs, and JupyterLab inserts trusted
 * `text/html` into the page as it is. The page's CSP stops its scripts, but
 * not a `<meta http-equiv="refresh">` that navigates the whole page to an
 * outside URL carrying the guest's data, nor a `<style>` that restyles or
 * overlays the page. So every `text/html` output, trusted or not, renders in
 * an `<iframe srcdoc>` with `sandbox="allow-popups
 * allow-popups-to-escape-sandbox"`:
 *
 * - No `allow-same-origin`: the frame's origin is opaque, so nothing in it can
 *   reach the page's DOM, its storage or the OpenRouter key.
 * - No `allow-scripts`: nothing runs in the frame, and the browser refuses a
 *   meta refresh in it and in every frame nested in it, so no output can
 *   reload itself in a loop (the stall a shared notebook's Run All could
 *   cause) or navigate anywhere without a click.
 * - No `allow-top-navigation*`: a click cannot navigate the page either.
 * - `allow-popups` (and escaping the sandbox) so a link in an output still
 *   opens, in a new tab (`<base target="_blank">`).
 *
 * With no script in the frame, the page cannot learn the height of its
 * content (an opaque origin), so the frame scrolls and the visitor sets its
 * height with a resize handle. Its first height is a guess: the output's
 * sanitized markup, laid out hidden in the page with the same rules, as
 * JupyterLab renders any untrusted output there; never its raw markup.
 *
 * Untrusted output (a stored output of a notebook someone supplied, #336) is
 * also sanitized before it is framed, as JupyterLab does inline.
 *
 * The frame gets the page's look: JupyterLab's rendered-HTML rules and the
 * theme's `--jp-*` variables, collected from the page's style sheets, and the
 * theme's color scheme. A theme change renders every frame again.
 *
 * Markdown outputs render sanitized, as markdown cells do: the sanitizer drops
 * `meta`, `style`, `link` and `base`, and they keep their math typesetting,
 * which a frame would lose. SVG output is already an `<img>` and LaTeX is
 * typeset text, so neither inserts raw HTML.
 */
import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
} from "@jupyterlab/application";
import { IThemeManager } from "@jupyterlab/apputils";
import { IRenderMimeRegistry, MimeModel } from "@jupyterlab/rendermime";
import type { IRenderMime } from "@jupyterlab/rendermime-interfaces";
import { Widget } from "@lumino/widgets";

const OUTPUT_FRAME_SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

/** The first height's bounds (px): a one-line output is not a big empty
 * box, and a long table takes part of the screen and scrolls. */
const MIN_HEIGHT = 44;
const MAX_FIRST_HEIGHT = 480;
/** Room for the frame's sideways scroll bar when the guess overflows. */
const SCROLLBAR = 17;

/** Frames on the page, rendered again when the theme changes. */
const live = new Set<OutputFrame>();

/** The frame's head for the current theme, made on first use. */
let head: string | undefined;

/** JupyterLab's rendered-HTML rules and the theme variables they use (a
 * custom property's computed value has its own `var()`s resolved). */
function pageCss(): string {
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      // Another origin's sheet (one an extension injects): not JupyterLab's.
      continue;
    }
    for (const rule of Array.from(list)) {
      if (
        rule instanceof CSSStyleRule &&
        rule.selectorText.includes("jp-RenderedHTML")
      ) {
        rules.push(rule.cssText);
      }
    }
  }
  const css = rules.join("");
  const names = new Set(css.match(/--jp-[\w-]+/g));
  const computed = getComputedStyle(document.body);
  const vars = [...names].map((name) =>
    `${name}:${computed.getPropertyValue(name)};`
  ).join("");
  const scheme = document.body.dataset.jpThemeLight === "false"
    ? "dark"
    : "light";
  return `:root{color-scheme:${scheme};${vars}}` +
    "body{margin:0;background:transparent}" +
    ".yurt-frame-body{display:flow-root}" + css;
}

function makeHead(): string {
  // The frame's own policy, on top of the page's that a srcdoc frame
  // inherits: WebKit loaded an outside <img> from such a frame once.
  const policy = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
    '<base target="_blank">' +
    `<style>${pageCss()}</style></head>`;
}

/** A `text/html` output in a sandboxed, scrolling frame the visitor sizes. */
class OutputFrame extends Widget implements IRenderMime.IRenderer {
  constructor(options: IRenderMime.IRendererOptions) {
    super();
    this._mimeType = options.mimeType;
    this._sanitizer = options.sanitizer;
    this.addClass("yurt-OutputFrame");
    this._frame = document.createElement("iframe");
    this._frame.setAttribute("sandbox", OUTPUT_FRAME_SANDBOX);
    this._frame.title = "HTML output";
    this.node.appendChild(this._frame);
    live.add(this);
  }

  async renderModel(model: IRenderMime.IMimeModel): Promise<void> {
    const source = String(model.data[this._mimeType]);
    this._source = model.trusted ? source : this._sanitizer.sanitize(source);
    this._fitted = false;
    this.render();
  }

  render(): void {
    if (this._source === undefined) return;
    // The first height is measured from a layout, which a hidden output
    // (a notebook in a background tab) does not have: wait until it shows.
    this._stale = !this.isVisible;
    if (this._stale) return;
    if (!this._fitted) {
      this._fit(this._source);
      this._fitted = true;
    }
    this._frame.srcdoc = (head ??= makeHead()) +
      // jp-ThemedContainer: JupyterLab scopes some rendered-HTML rules under it.
      '<body class="jp-ThemedContainer"><div class="yurt-frame-body jp-RenderedHTMLCommon jp-RenderedHTML jp-OutputArea-output" data-mime-type="text/html">' +
      this._source + "</div></body></html>";
  }

  /** The first height: the sanitized markup's, laid out hidden here. */
  private _fit(source: string): void {
    const probe = document.createElement("div");
    probe.className =
      "yurt-OutputFrame-probe jp-RenderedHTMLCommon jp-RenderedHTML";
    probe.innerHTML = this._sanitizer.sanitize(source);
    this.node.appendChild(probe);
    const wide = probe.scrollWidth > probe.clientWidth ? SCROLLBAR : 0;
    const grip = parseFloat(getComputedStyle(this.node).paddingBottom);
    const height = Math.ceil(probe.scrollHeight) + wide + grip;
    probe.remove();
    this.node.style.height = `${
      Math.min(Math.max(height, MIN_HEIGHT), MAX_FIRST_HEIGHT)
    }px`;
  }

  protected onAfterAttach(): void {
    if (this._stale) this.render();
  }

  protected onAfterShow(): void {
    if (this._stale) this.render();
  }

  dispose(): void {
    if (this.isDisposed) return;
    live.delete(this);
    super.dispose();
  }

  private _mimeType: string;
  private _sanitizer: IRenderMime.ISanitizer;
  private _frame: HTMLIFrameElement;
  private _source: string | undefined;
  private _fitted = false;
  private _stale = false;
}

/** Install the frame renderer for `text/html` and the sanitized markdown. */
export function activateOutputFrames(
  _app: JupyterFrontEnd,
  rendermime: IRenderMimeRegistry,
  themes: IThemeManager | null,
): void {
  rendermime.addFactory(
    {
      safe: true,
      mimeTypes: ["text/html"],
      createRenderer: (options) => new OutputFrame(options),
    },
    rendermime.getRank("text/html"),
  );
  const markdown = rendermime.getFactory("text/markdown")!;
  rendermime.addFactory(
    {
      ...markdown,
      createRenderer: (options) => {
        const renderer = markdown.createRenderer(options);
        const render = renderer.renderModel.bind(renderer);
        renderer.renderModel = (model) =>
          render(
            new MimeModel({
              data: model.data,
              metadata: model.metadata,
              trusted: false,
            }),
          );
        return renderer;
      },
    },
    rendermime.getRank("text/markdown"),
  );
  themes?.themeChanged.connect(() => {
    head = undefined;
    for (const frame of live) frame.render();
  });
}

export const outputFramePlugin: JupyterFrontEndPlugin<void> = {
  id: "@yurt/jupyterlite-yurt-kernel:html-output-frames",
  autoStart: true,
  requires: [IRenderMimeRegistry],
  optional: [IThemeManager],
  activate: activateOutputFrames,
};
