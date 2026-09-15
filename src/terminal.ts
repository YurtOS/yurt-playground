import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { PlaygroundTerm } from "./boot.ts";

export function createPlaygroundTerminal(host: unknown): PlaygroundTerm {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 14,
    theme: {
      background: "#1c212a",
      foreground: "#e6e1d7",
      cursor: "#e0a458",
      selectionBackground: "#2c3340",
    },
  });
  // The terminal fills its pane, and follows it: the guest sees the real
  // size through the resize handler below.
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host as HTMLElement);
  fit.fit();
  new ResizeObserver(() => fit.fit()).observe(host as HTMLElement);
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
