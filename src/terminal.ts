import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import type { PlaygroundTerm } from "./boot.ts";

export function createPlaygroundTerminal(host: unknown): PlaygroundTerm {
  const element = host as HTMLElement;
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 14,
    theme: { background: "#111111", foreground: "#eeeeee" },
    // TUIs such as btop++ draw with braille and box characters whose widths
    // xterm's default (Unicode 6) table gets wrong.
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.open(element);
  // `?renderer=dom` keeps xterm's DOM renderer: slower, but the screen is
  // readable text, which tests and screen readers can see.
  const useWebgl = new URLSearchParams(globalThis.location?.search).get(
    "renderer",
  ) !== "dom";
  try {
    if (!useWebgl) throw new Error("dom renderer requested");
    // Full-screen redraws (btop++) are too slow on the DOM renderer. WebGL
    // can be unavailable or lost; xterm then falls back to its default.
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // keep the default renderer
  }
  // The PTY window size follows the element: fit() resizes the terminal,
  // which fires onResize and reaches the guest as TIOCSWINSZ / SIGWINCH.
  fit.fit();
  new ResizeObserver(() => fit.fit()).observe(element);
  term.focus();
  return {
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    write(data: string | Uint8Array) {
      term.write(typeof data === "string" ? data : data.slice());
    },
    onData(handler: (data: string) => void) {
      term.onData(handler);
    },
    onResize(handler: (size: { rows: number; cols: number }) => void) {
      term.onResize(handler);
    },
  };
}
