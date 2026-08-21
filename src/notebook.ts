import type { JupyterReply } from "./jupyter.ts";

export type NotebookView = {
  ready(): void;
  result(id: string, reply: JupyterReply): void;
  error(id: string, message: string): void;
  dispose(): void;
};

export function mountNotebook(
  root: HTMLElement,
  execute: (id: string, code: string) => void,
): NotebookView {
  root.replaceChildren();
  const editor = document.createElement("textarea");
  editor.id = "notebook-input";
  editor.value = "1+1";
  editor.disabled = true;
  const button = document.createElement("button");
  button.id = "notebook-execute";
  button.textContent = "Execute";
  button.disabled = true;
  const status = document.createElement("span");
  status.id = "notebook-status";
  status.textContent = "starting Jupyter";
  const output = document.createElement("pre");
  output.id = "notebook-output";
  root.append(editor, button, status, output);
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
      output.textContent = `${reply.stdout}${reply.display}${
        reply.traceback.join("\n")
      }`;
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
