import type { JupyterReply, JupyterStream } from "./jupyter.ts";

export type NotebookView = {
  ready(): void;
  /** What the running cell has printed so far (yurt-playground#131). */
  stream(id: string, chunk: JupyterStream): void;
  result(id: string, reply: JupyterReply): void;
  error(id: string, message: string): void;
  dispose(): void;
};

/** The streams the pane shows, in order. One span each, created once and
 *  updated in place: rebuilding the pane on every stream message relaid
 *  out the whole of a growing <pre>, and threw away the reader's scroll
 *  position with it (yurt-playground#131 review). */
const STREAMS = ["stdout", "stderr", "display", "traceback"] as const;
type Stream = typeof STREAMS[number];

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
  interrupt?: (id: string) => void,
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
  const spans = new Map<Stream, HTMLSpanElement>();
  for (const stream of STREAMS) {
    const span = document.createElement("span");
    span.dataset.stream = stream;
    spans.set(stream, span);
    output.append(span);
  }
  root.append(bar, editor, actions, output);
  const pending = new Set<string>();
  /** What the pane should show; rendered at most once an animation frame.
   * A cell printing 30,000 lines sends hundreds of messages, and drawing
   * each one is quadratic work on the main thread. */
  let showing: Record<Stream, string> | undefined;
  let frame = 0;
  const render = () => {
    frame = 0;
    if (showing === undefined) return;
    // Stick to the bottom only if the reader is already there, so a scroll
    // back through the output is not yanked away by the next message.
    const atBottom =
      output.scrollHeight - output.scrollTop - output.clientHeight < 4;
    for (const stream of STREAMS) {
      const span = spans.get(stream)!;
      const text = showing[stream];
      if (span.textContent !== text) span.textContent = text;
    }
    if (atBottom) output.scrollTop = output.scrollHeight;
  };
  const show = (next: Partial<Record<Stream, string>>) => {
    showing = {
      stdout: "",
      stderr: "",
      display: "",
      traceback: "",
      ...next,
    };
    if (frame === 0) {
      frame = typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(render)
        : setTimeout(render, 0) as unknown as number;
    }
  };
  /** Run is back, Stop is gone: one place, so no path leaves the cell
   * without a control. */
  const settle = (state: string) => {
    button.disabled = false;
    stop.hidden = true;
    status.textContent = state;
  };
  button.onclick = () => {
    const id = crypto.randomUUID();
    pending.add(id);
    button.disabled = true;
    stop.hidden = interrupt === undefined;
    status.textContent = "executing";
    show({});
    execute(id, editor.value);
  };
  stop.onclick = () => {
    if (pending.size === 0) return;
    // The kernel answers the interrupt with the cell's own error frame, so
    // `result` does the settling; until then say what was asked for.
    //
    // Stop stays enabled. An interrupt the kernel cannot honour -- a
    // CPU-bound loop, yurtos-kernel#2811 -- would otherwise leave the
    // reader with two dead buttons and a status claiming an interrupt is
    // in progress, which is worse than what this set out to fix.
    status.textContent = "interrupting";
    const id = pending.values().next().value;
    if (id !== undefined) interrupt?.(id);
  };
  return {
    ready() {
      editor.disabled = false;
      button.disabled = false;
      status.textContent = "ready";
    },
    stream(id, chunk) {
      if (!pending.has(id)) return;
      showing ??= { stdout: "", stderr: "", display: "", traceback: "" };
      showing[chunk.stream] += chunk.text;
      if (frame === 0) {
        frame = typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(render)
          : setTimeout(render, 0) as unknown as number;
      }
    },
    result(id, reply) {
      if (!pending.delete(id)) return;
      settle(reply.status);
      // One element per stream, so a driver reading the cell can tell a
      // warning from a result; the traceback without the colour codes
      // ipykernel puts in it, which a <pre> would show as `[31m`.
      show({
        stdout: reply.stdout,
        stderr: reply.stderr,
        display: reply.display,
        traceback: stripAnsi(reply.traceback.join("\n")),
      });
    },
    error(id, message) {
      if (!pending.delete(id)) return;
      settle("error");
      // Appended, not written over what the cell printed. A cell that
      // times out after 120 s had streamed everything it did up to then,
      // and that text was the only record of it (#131 review).
      show({
        ...(showing ?? {
          stdout: "",
          stderr: "",
          display: "",
          traceback: "",
        }),
        traceback: message,
      });
    },
    dispose() {
      root.replaceChildren();
      pending.clear();
    },
  };
}
