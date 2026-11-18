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
  const keys = touchDevice() ? withTouchKeys(host as HTMLElement, term) : null;
  const pane = keys?.pane ?? host as HTMLElement;
  term.open(pane);
  // Every input, typed, pasted or from the key bar, passes the bar's Ctrl
  // once, here, before any handler sees it.
  const handlers: ((data: string) => void)[] = [];
  term.onData((data) => {
    const sent = keys?.control(data) ?? data;
    for (const handler of handlers) handler(sent);
  });
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
      handlers.push(handler);
    },
    onResize(handler: (size: { rows: number; cols: number }) => void) {
      term.onResize(handler);
    },
  };
}

/** The control character a terminal sends for Ctrl and `key`: Ctrl-A to
 * Ctrl-Z, Ctrl-@ and Ctrl-[ \ ] ^ _ (C0, the key's code less 0x40, either
 * case for letters) and Ctrl-? (DEL). Anything else has none. */
function controlCharacter(key: string): string | undefined {
  if (key === "?") return "\x7f";
  if (!/^[@-_a-z]$/.test(key)) return undefined;
  return String.fromCharCode(key.toUpperCase().charCodeAt(0) - 0x40);
}

/** A bar under the terminal with the keys a touch device lacks (#273): iOS
 * offers no paste menu on xterm's hidden textarea, and the iPhone and iPad
 * keyboards have no Esc, Tab or Ctrl, nor arrow keys for the shell's history
 * or for moving along the command line. Returns the element the terminal
 * opens in, above the bar, and `control`, the filter every input passes. */
function withTouchKeys(
  host: HTMLElement,
  term: Terminal,
): { pane: HTMLElement; control: (data: string) => string } {
  const pane = document.createElement("div");
  Object.assign(pane.style, { flex: "1 1 0", minHeight: "0" });
  const bar = document.createElement("div");
  bar.dataset.testid = "term-keys";
  Object.assign(bar.style, {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 10px 6px 0",
    // An iPhone in portrait is narrower than the keys: they scroll sideways
    // rather than wrap or shrink below a touch target.
    overflowX: "auto",
  });
  const note = document.createElement("span");
  note.dataset.testid = "term-key-note";
  note.setAttribute("role", "status");
  Object.assign(note.style, {
    color: "#9a948a",
    fontSize: "13px",
    flex: "none",
    whiteSpace: "nowrap",
  });
  let clearNote: number | undefined;
  const say = (text: string) => {
    note.textContent = text;
    // Past the keys on a narrow screen: bring it into view.
    bar.scrollLeft = bar.scrollWidth;
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
  const arrow = (final: "A" | "B" | "C" | "D") =>
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
    // to keep its keyboard up) puts it back. Not pointerdown: canceling it
    // also cancels a tap's compatibility mouse events, and on iOS those
    // and the click are dispatched as one.
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      note.textContent = "";
      term.focus();
      action();
    });
    return button;
  };
  // Ctrl is sticky: a tap holds it (aria-pressed) for the next input, a
  // second tap lets it go. That input releases it; only a single character
  // with a control character (a letter typed on the iOS keyboard) becomes
  // that character. Longer input (a paste, dictation, a composed word, Esc
  // or Tab) passes unchanged. xterm's own replies (cursor reports, device
  // attributes, focus and mouse reports) come through onData too, as an
  // escape sequence: they pass without releasing it, and so do the arrow
  // keys, the only sequences on the bar. A bracketed paste starts with one
  // as well, but is input.
  const ctrl = key("Ctrl", "Control", "ctrl", () => hold(!held));
  let held = false;
  const hold = (on: boolean) => {
    held = on;
    ctrl.setAttribute("aria-pressed", String(on));
    Object.assign(ctrl.style, {
      color: on ? "#1c212a" : "#e6e1d7",
      background: on ? "#e0a458" : "#2c3340",
    });
  };
  hold(false);
  const control = (data: string) => {
    const sequence = data.length > 1 && data.startsWith("\x1b") &&
      !data.startsWith("\x1b[200~");
    if (!held || sequence) return data;
    hold(false);
    return controlCharacter(data) ?? data;
  };
  bar.append(
    key("Esc", "Escape", "esc", () => term.input("\x1b")),
    key("Tab", "Tab", "tab", () => term.input("\t")),
    ctrl,
    key("↑", "Previous command", "up", () => arrow("A")),
    key("↓", "Next command", "down", () => arrow("B")),
    key("←", "Cursor left", "left", () => arrow("D")),
    key("→", "Cursor right", "right", () => arrow("C")),
    key("Paste", "Paste", "paste", () => void paste()),
    note,
  );
  Object.assign(host.style, { display: "flex", flexDirection: "column" });
  host.append(pane, bar);
  return { pane, control };
}
