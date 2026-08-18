import { Terminal } from "@xterm/xterm";
import type { PlaygroundTerm } from "./boot.ts";

export function createPlaygroundTerminal(host: unknown): PlaygroundTerm {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 14,
    theme: { background: "#111111", foreground: "#eeeeee" },
  });
  term.open(host as HTMLElement);
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
