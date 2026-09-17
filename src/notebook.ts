import type { JupyterReply } from "./jupyter.ts";

export type NotebookView = {
  ready(): void;
  result(id: string, reply: JupyterReply): void;
  error(id: string, message: string): void;
  dispose(): void;
};

/** `text` without ANSI escape sequences (CSI and simple two-byte ones). */
export function stripAnsi(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[@-Z\\-_]/g, "");
}

export function mountNotebook(
  root: HTMLElement,
  execute: (id: string, code: string) => void,
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
  const hint = document.createElement("span");
  hint.textContent = "one cell, on a real ipykernel in the sandbox";
  hint.style.color = "var(--muted)";
  actions.append(button, hint);
  const output = document.createElement("pre");
  output.id = "notebook-output";
  output.dataset.testid = "notebook-output";
  root.append(bar, editor, actions, output);
  const pending = new Set<string>();
  button.onclick = () => {
    const id = crypto.randomUUID();
    pending.add(id);
    button.disabled = true;
    status.textContent = "executing";
    execute(id, editor.value);
  };
  return {
    ready() {
      editor.disabled = false;
      button.disabled = false;
      status.textContent = "ready";
    },
    result(id, reply) {
      if (!pending.delete(id)) return;
      button.disabled = false;
      status.textContent = reply.status;
      // One element per stream, so a driver reading the cell can tell a
      // warning from a result; the traceback without the colour codes
      // ipykernel puts in it, which a <pre> would show as `[31m`.
      const streams: Array<[string, string]> = [
        ["stdout", reply.stdout],
        ["stderr", reply.stderr],
        ["display", reply.display],
        ["traceback", stripAnsi(reply.traceback.join("\n"))],
      ];
      output.replaceChildren(
        ...streams.filter(([, text]) => text !== "").map(([stream, text]) => {
          const span = document.createElement("span");
          span.dataset.stream = stream;
          span.textContent = text;
          return span;
        }),
      );
    },
    error(id, message) {
      if (!pending.delete(id)) return;
      button.disabled = false;
      status.textContent = "error";
      output.textContent = message;
    },
    dispose() {
      root.replaceChildren();
      pending.clear();
    },
  };
}
