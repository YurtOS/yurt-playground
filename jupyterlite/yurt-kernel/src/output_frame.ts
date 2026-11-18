/**
 * HTML output in a sandboxed frame (yurt-sandbox#382, option 2).
 *
 * A cell the visitor runs has trusted outputs, and JupyterLab inserts trusted
 * `text/html` into the page as it is. The page's CSP stops its scripts, but
 * not a `<meta http-equiv="refresh">` that navigates the whole page to an
 * outside URL carrying the guest's data, nor a `<style>` that restyles or
 * overlays the page. So every `text/html` output, trusted or not, renders in
 * an `<iframe srcdoc>` with `sandbox="allow-scripts allow-popups
 * allow-popups-to-escape-sandbox"`, the way Colab and VS Code do:
 *
 * - No `allow-same-origin`: the frame's origin is opaque, so nothing in it can
 *   reach the page's DOM, its storage or the OpenRouter key.
 * - No `allow-top-navigation*`: it cannot navigate the page. Its own
 *   navigation is checked against the page's `frame-src 'none'`, so a meta
 *   refresh to an outside URL is refused before any request leaves.
 * - `allow-scripts` only for {@link OUTPUT_FRAME_SIZER}, the one script the
 *   frame's policy admits (by hash): the page cannot measure an
 *   opaque-origin document, so the frame reports its own height. The
 *   output's own scripts stay blocked, as on the page.
 * - `allow-popups` (and escaping the sandbox) so a link in an output still
 *   opens, in a new tab, as before.
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
import { OUTPUT_FRAME_SIZER } from "./output_frame_sizer";

const OUTPUT_FRAME_SANDBOX =
  "allow-scripts allow-popups allow-popups-to-escape-sandbox";

/** Frames on the page, rendered again when the theme changes. */
const live = new Set<OutputFrame>();

/** The frame's head for the current theme, made on first use. */
let head: Promise<string> | undefined;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/** JupyterLab's rendered-HTML rules and the theme variables they use (a
 * custom property's computed value has its own `var()`s resolved). */
function pageCss(): string {
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
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
    "html{overflow:hidden}body{margin:0;background:transparent}" +
    ".yurt-frame-body{display:flow-root;overflow-x:auto}" + css;
}

async function makeHead(): Promise<string> {
  // The frame's own policy: the page's is inherited by Chrome but not
  // fully by WebKit, which fetched an outside <img> from the frame.
  const policy = [
    "default-src 'none'",
    `script-src 'sha256-${await sha256(OUTPUT_FRAME_SIZER)}'`,
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
    '<base target="_blank">' +
    `<style>${pageCss()}</style>` +
    // In the head, so no markup in the output can swallow it.
    `<script>${OUTPUT_FRAME_SIZER}</script></head>`;
}

/**
 * The output with its `<meta http-equiv>` pragmas made inert. A refresh to an
 * outside URL is refused by `frame-src 'none'` anyway, but one to the frame
 * itself (`content="0"`) would reload it forever, and with it the CPU. No
 * parse: a check that parses differently from the frame (a template, with
 * scripting off) misses `<col><meta ...>` and `<noscript>` tricks. The
 * tokenizer makes the attribute name only from this literal ASCII text, so
 * renaming every occurrence leaves no pragma; visible text that says
 * "http-equiv" changes too.
 */
function withoutPragmas(source: string): string {
  return source.replace(/http-equiv/gi, "data-inert-http-equiv");
}

/** A `text/html` output in a sandboxed frame sized to its content. */
class OutputFrame extends Widget implements IRenderMime.IRenderer {
  constructor(options: IRenderMime.IRendererOptions) {
    super();
    this._mimeType = options.mimeType;
    this.addClass("yurt-OutputFrame");
    this._frame = document.createElement("iframe");
    this._frame.setAttribute("sandbox", OUTPUT_FRAME_SANDBOX);
    this._frame.title = "HTML output";
    this.node.appendChild(this._frame);
    window.addEventListener("message", this._onMessage);
    live.add(this);
  }

  async renderModel(model: IRenderMime.IMimeModel): Promise<void> {
    this._source = String(model.data[this._mimeType]);
    await this.render();
  }

  async render(): Promise<void> {
    if (this._source === undefined) return;
    const source = this._source;
    const top = await (head ??= makeHead());
    if (this.isDisposed || source !== this._source) return;
    // Chrome never resumes a frame document that loaded while hidden (a
    // notebook in a background tab, the app during a theme switch): its
    // sizer stays silent. So the frame loads only while the output shows.
    this._stale = !this.isVisible;
    if (this._stale) return;
    this._frame.srcdoc = top +
      // jp-ThemedContainer: JupyterLab scopes some rendered-HTML rules under it.
      '<body class="jp-ThemedContainer"><div class="yurt-frame-body jp-RenderedHTMLCommon jp-RenderedHTML jp-OutputArea-output" data-mime-type="text/html">' +
      withoutPragmas(source) + "</div></body></html>";
  }

  protected onAfterAttach(): void {
    if (this._stale) void this.render();
  }

  protected onAfterShow(): void {
    if (this._stale) void this.render();
  }

  dispose(): void {
    if (this.isDisposed) return;
    window.removeEventListener("message", this._onMessage);
    live.delete(this);
    super.dispose();
  }

  /** Only this frame's sizer is heard, and only a height. */
  private _onMessage = (event: MessageEvent): void => {
    if (event.source !== this._frame.contentWindow) return;
    const height = (event.data as { yurtOutputHeight?: unknown })
      ?.yurtOutputHeight;
    if (typeof height !== "number" || !Number.isFinite(height) || height < 0) {
      return;
    }
    this._frame.style.height = `${Math.ceil(height)}px`;
  };

  private _mimeType: string;
  private _frame: HTMLIFrameElement;
  private _source: string | undefined;
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
    for (const frame of live) void frame.render();
  });
}

export const outputFramePlugin: JupyterFrontEndPlugin<void> = {
  id: "@yurt/jupyterlite-yurt-kernel:html-output-frames",
  autoStart: true,
  requires: [IRenderMimeRegistry],
  optional: [IThemeManager],
  activate: activateOutputFrames,
};
