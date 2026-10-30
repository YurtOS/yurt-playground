import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { PlaygroundTerm } from "./boot.ts";
import { touchDevice } from "./device.ts";

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
  const pane = touchDevice()
    ? withTouchKeys(host as HTMLElement, term)
    : host as HTMLElement;
  term.open(pane);
  fit.fit();
  new ResizeObserver(() => fit.fit()).observe(pane);
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

/** A bar under the terminal with the keys a touch device lacks (#273): iOS
 * offers no paste menu on xterm's hidden textarea, and the iPad keyboard
 * has no arrow keys for the shell's history. Returns the element the
 * terminal opens in, above the bar. */
function withTouchKeys(host: HTMLElement, term: Terminal): HTMLElement {
  const pane = document.createElement("div");
  Object.assign(pane.style, { flex: "1 1 0", minHeight: "0" });
  const bar = document.createElement("div");
  bar.dataset.testid = "term-keys";
  Object.assign(bar.style, {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 10px 6px 0",
  });
  const note = document.createElement("span");
  note.dataset.testid = "term-key-note";
  note.setAttribute("role", "status");
  Object.assign(note.style, {
    color: "#9a948a",
    fontSize: "13px",
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  });
  let clearNote: number | undefined;
  const say = (text: string) => {
    note.textContent = text;
    clearTimeout(clearNote);
    clearNote = setTimeout(() => note.textContent = "", 4000);
  };
  // Through term.paste, as typed text would go: bracketed when the program
  // asked for it, newlines as Enter.
  const paste = async () => {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      say("no clipboard access");
      return;
    }
    if (text === "") say("clipboard empty");
    else term.paste(text);
  };
  // What xterm sends for the arrow keys: ESC O in application cursor mode.
  const arrow = (final: "A" | "B") =>
    term.input(
      (term.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[") + final,
    );
  const key = (
    label: string,
    name: string,
    id: string,
    action: () => void,
  ) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-label", name);
    button.dataset.testid = `term-key-${id}`;
    Object.assign(button.style, {
      font: "14px ui-monospace, SFMono-Regular, Menlo, monospace",
      color: "#e6e1d7",
      background: "#2c3340",
      border: "1px solid #3a4352",
      borderRadius: "4px",
      minWidth: "44px",
      minHeight: "34px",
      padding: "0 12px",
      flex: "none",
      touchAction: "manipulation",
    });
    // The focus, and with it the iOS keyboard, stays in the terminal: the
    // press does not move it, and the tap (a user gesture, which iOS needs
    // to keep its keyboard up) puts it back.
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      term.focus();
      action();
    });
    return button;
  };
  bar.append(
    key("Paste", "Paste", "paste", () => void paste()),
    key("↑", "Previous command", "up", () => arrow("A")),
    key("↓", "Next command", "down", () => arrow("B")),
    note,
  );
  Object.assign(host.style, { display: "flex", flexDirection: "column" });
  host.append(pane, bar);
  return pane;
}
