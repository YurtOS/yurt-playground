import type { JupyterPartial, JupyterReply } from "./jupyter.ts";

export type NotebookView = {
  ready(): void;
  /** What the running cell has printed so far (yurt-playground#131). */
  stream(id: string, partial: JupyterPartial): void;
  result(id: string, reply: JupyterReply): void;
  error(id: string, message: string): void;
  dispose(): void;
};

/** The streams of a reply, in the order the pane shows them. `traceback`
 *  is the reply's alone: a cell that is still running has none. */
function streamSpans(
  parts: Array<[string, string]>,
): HTMLSpanElement[] {
  return parts.filter(([, text]) => text !== "").map(([stream, text]) => {
    const span = document.createElement("span");
    span.dataset.stream = stream;
    span.textContent = text;
    return span;
  });
}

/** `text` without ANSI escape sequences (CSI and simple two-byte ones). */
export function stripAnsi(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[@-Z\\-_]/g, "");
}

export function mountNotebook(
  root: HTMLElement,
  execute: (id: string, code: string) => void,
  /** Stop the running cell. Without one -- a page that cannot reach the
   * kernel's control channel -- there is no Stop button, as before. */
  interrupt?: () => void,
): NotebookView {
  root.replaceChildren();
  // The pane's bar: what this is, and where the kernel stands.
  const bar = document.createElement("div");
  bar.className = "bar";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = "Python";
  const status = document.createElement("span");
  status.id = "notebook-status";
  status.dataset.testid = "notebook-status";
  status.textContent = "waiting for the sandbox";
  bar.append(name, status);
  const editor = document.createElement("textarea");
  editor.id = "notebook-input";
  editor.dataset.testid = "notebook-input";
  editor.setAttribute("aria-label", "Python cell");
  editor.value = "1+1";
  editor.disabled = true;
  const actions = document.createElement("div");
  actions.className = "actions";
  const button = document.createElement("button");
  button.id = "notebook-execute";
  button.dataset.testid = "notebook-execute";
  button.type = "button";
  button.textContent = "Run";
  button.disabled = true;
  // Stop: a loop in the cell used to cost the reader the whole boot, since
  // Run is disabled while one runs and reload was the only way out (#130).
  const stop = document.createElement("button");
  stop.id = "notebook-interrupt";
  stop.dataset.testid = "notebook-interrupt";
  stop.type = "button";
  stop.textContent = "Stop";
  stop.hidden = true;
  const hint = document.createElement("span");
  hint.textContent = "one cell, on a real ipykernel in the sandbox";
  hint.style.color = "var(--muted)";
  actions.append(button, ...(interrupt ? [stop] : []), hint);
  const output = document.createElement("pre");
  output.id = "notebook-output";
  output.dataset.testid = "notebook-output";
  root.append(bar, editor, actions, output);
  const pending = new Set<string>();
  /** Run is back, Stop is gone: one place, so no path leaves the cell
   * without a control. */
  const settle = (state: string) => {
    button.disabled = false;
    stop.hidden = true;
    stop.disabled = false;
    status.textContent = state;
  };
  button.onclick = () => {
    const id = crypto.randomUUID();
    pending.add(id);
    button.disabled = true;
    stop.hidden = interrupt === undefined;
    stop.disabled = false;
    status.textContent = "executing";
    output.replaceChildren();
    execute(id, editor.value);
  };
  stop.onclick = () => {
    if (pending.size === 0) return;
    // The kernel answers the interrupt with the cell's own error frame, so
    // `result` does the settling; until then say what was asked for.
    stop.disabled = true;
    status.textContent = "interrupting";
    interrupt?.();
  };
  return {
    ready() {
      editor.disabled = false;
      button.disabled = false;
      status.textContent = "ready";
    },
    stream(id, partial) {
      if (!pending.has(id)) return;
      output.replaceChildren(...streamSpans([
        ["stdout", partial.stdout],
        ["stderr", partial.stderr],
        ["display", partial.display],
      ]));
    },
    result(id, reply) {
      if (!pending.delete(id)) return;
      settle(reply.status);
      // One element per stream, so a driver reading the cell can tell a
      // warning from a result; the traceback without the colour codes
      // ipykernel puts in it, which a <pre> would show as `[31m`.
      output.replaceChildren(...streamSpans([
        ["stdout", reply.stdout],
        ["stderr", reply.stderr],
        ["display", reply.display],
        ["traceback", stripAnsi(reply.traceback.join("\n"))],
      ]));
    },
    error(id, message) {
      if (!pending.delete(id)) return;
      settle("error");
      output.textContent = message;
    },
    dispose() {
      root.replaceChildren();
      pending.clear();
    },
  };
}
