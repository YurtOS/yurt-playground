/**
 * The Notebook and JupyterLab pages' view of their sandbox's boot. The
 * frontend has nowhere to show it: a kernel whose `ready` rejects leaves
 * the welcome cell at `[*]` with no word of why (no python3 in the image,
 * an ipykernel that never answered). This is a small fixed line on the
 * page instead, built on first use like the memory banner
 * (src/memory_refused.ts): progress while the sandbox boots, gone once the
 * kernel answers, and a failure kept on screen.
 */
import { PYTHON_INSTALL, PYTHON_MISSING_TEXT } from "./notebook.ts";

export const BRIDGE_STATUS_ID = "yurt-bridge-status";

export type BridgeState =
  | { state: "booting"; text: string }
  | { state: "ready" }
  | { state: "error"; text: string }
  | { state: "python-missing"; error?: string };

/** What the line says in a state; `undefined` hides it. The coordinator's
 * empty status is "booted". */
export function describeBridgeState(state: BridgeState): string | undefined {
  switch (state.state) {
    case "booting":
      return state.text === ""
        ? "Yurt sandbox: the shell is up"
        : `Yurt sandbox: ${state.text}`;
    case "ready":
      return undefined;
    case "error":
      return `Yurt sandbox: ${state.text}`;
    case "python-missing":
      // A failed install says why; restarting the kernel tries again.
      return state.error !== undefined
        ? `Yurt sandbox: installing Python failed: ${state.error}. ` +
          "Restart the kernel to try again."
        : `${PYTHON_MISSING_TEXT}, so this notebook has no kernel. ` +
          `${PYTHON_INSTALL.reason}; the shell on the home page runs without it.`;
  }
}

const STYLE = [
  "position: fixed",
  "left: 12px",
  "bottom: 12px",
  "z-index: 10000",
  "max-width: min(560px, calc(100vw - 24px))",
  "margin: 0",
  "padding: 8px 12px",
  "border-radius: 6px",
  "background: #1f2430",
  "color: #e6e1d7",
  "font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  "white-space: pre-wrap",
].join("; ");

/** Show `state` on `doc`'s line, building it the first time. A failure
 * stays until a later state replaces it: a `booting` progress line after
 * an error (a status posted late) does not wipe the error. */
export function showBridgeState(doc: Document, state: BridgeState): void {
  let line = doc.getElementById(BRIDGE_STATUS_ID);
  const text = describeBridgeState(state);
  if (line === null) {
    if (text === undefined) return;
    line = doc.createElement("p");
    line.id = BRIDGE_STATUS_ID;
    line.dataset.testid = BRIDGE_STATUS_ID;
    line.style.cssText = STYLE;
    doc.body.append(line);
  }
  const failed = line.dataset.state === "error" ||
    line.dataset.state === "python-missing";
  if (failed && state.state === "booting") return;
  line.dataset.state = state.state;
  if (state.state === "error" || state.state === "python-missing") {
    line.setAttribute("role", "alert");
  } else {
    line.removeAttribute("role");
  }
  line.hidden = text === undefined;
  line.textContent = text ?? "";
}
