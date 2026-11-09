/**
 * The local agent's controller (#140): a small state machine that owns the
 * loop. The model proposes exactly one action per step as JSON; this module
 * validates it against a closed schema, runs it through the sandbox's tools,
 * and decides what the next prompt holds. The model never sees more than the
 * active-context budget, never writes control flow, and never runs anything
 * the schema does not name. No DOM here: tests drive it with a fake model.
 */

export type Action =
  | { action: "exec"; cmd: string }
  | { action: "read_file"; path: string }
  | { action: "write_file"; path: string; text: string }
  | { action: "set_color"; color: string }
  | { action: "answer"; text: string };

export type ModelStats = { promptTokens: number; outputTokens: number };

export type Model = {
  generate(
    system: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<{ text: string; stats: ModelStats }>;
};

export type ExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command's output made a PDF: {@link pdfMade}'s words,
   * which end the result the model and the pane see. */
  made?: string;
};

export type Tools = {
  exec(cmd: string, signal: AbortSignal): Promise<ExecResult>;
  readFile(path: string, signal: AbortSignal): Promise<string>;
  /** Resolves to what happened, for the model. */
  writeFile(path: string, text: string, signal: AbortSignal): Promise<string>;
  /** The demo PDF's text color; resolves to what happened, for the model. */
  setColor(color: string, signal: AbortSignal): Promise<string>;
};

/** A tool failure the model cannot fix by trying again: it ends the task. */
export class ToolFailed extends Error {}

export type Limits = {
  /** Model calls per task, invalid replies included. */
  maxSteps: number;
  /** Consecutive replies that are not an action before giving up. */
  maxInvalid: number;
  /** Characters of one tool result the model is shown. */
  maxObservation: number;
  /** Characters of the task; a longer one is refused, not cut. */
  maxTask: number;
  /** Characters of the whole prompt (task + steps): the active context. */
  maxPrompt: number;
  /** Wall-clock budget for the task. */
  timeoutMs: number;
};

export const DEFAULT_LIMITS: Limits = {
  maxSteps: 8,
  maxInvalid: 2,
  maxObservation: 1500,
  // Room for the demo's document and a message about it.
  maxTask: 4000,
  // ~2,500 tokens at 3.5 characters a token: with the system prompt and the
  // reply it stays inside the 4,096-token engine.
  maxPrompt: 9000,
  timeoutMs: 180_000,
};

export type AgentEvent =
  | { type: "repeat"; step: number }
  | { type: "step"; step: number; promptChars: number }
  | {
    type: "action";
    step: number;
    action: Action;
    raw: string;
    stats: ModelStats;
    ms: number;
  }
  | {
    type: "invalid";
    step: number;
    raw: string;
    stats: ModelStats;
    ms: number;
  }
  | {
    type: "observation";
    step: number;
    text: string;
    truncated: boolean;
    ms: number;
  }
  | { type: "answer"; text: string }
  | {
    type: "stopped";
    reason: "cancelled" | "steps" | "invalid" | "timeout" | "task" | "repeat";
  }
  | { type: "error"; message: string };

/** The system prompt. `python` says whether the sandbox has a python3: the
 * slim base image has none, and a model told otherwise reaches for it
 * first and spends its steps on "not found". */
export function systemPrompt(python: boolean): string {
  return [
    `You operate a Linux sandbox (${sandboxTools(python)}) for the user.`,
    ...PROMPT_RULES,
  ].join("\n");
}

/** What the sandbox offers, as the prompt says it. */
export function sandboxTools(python: boolean): string {
  return python
    ? "BusyBox, Python 3"
    : "BusyBox shell tools only; no Python, no Node";
}

/** A system prompt given as lines (agent-models.json's `instructions`), with
 * `{tools}` standing for {@link sandboxTools}. */
export function instructionsPrompt(lines: string[], python: boolean): string {
  return lines.join("\n").replaceAll("{tools}", sandboxTools(python));
}

/** The demo's document: both files are the sandbox's, so a later message in the
 * chat, or a restored sandbox, finds them. */
export const DEMO_TEXT_PATH = "/home/user/demo.txt";
export const DEMO_PDF_PATH = "/home/user/demo.pdf";
export const DEMO_COLOR_PATH = "/home/user/demo.color";
/** Where the prompt suggests a program goes: not the document's text. */
export const PROGRAM_PATH = "/home/user/main.py";
/** What the `mkpdf` command takes as a color. */
export const DEMO_COLOR = /^#[0-9a-f]{6}$/;
const shellQuoted = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;

/** Make a PDF from a text file, in the document's color if it has one. */
export function makePdfCommand(text: string, pdf: string): string {
  return `command -v mkpdf >/dev/null || { sudo pkg update && sudo pkg install mkpdf; }; { [ -f ${DEMO_COLOR_PATH} ] && echo "%color $(cat ${DEMO_COLOR_PATH})"; cat ${
    shellQuoted(text)
  }; } | mkpdf ${shellQuoted(pdf)}`;
}

/** Run after each write of the demo's text. */
export const MAKE_DEMO_PDF = makePdfCommand(DEMO_TEXT_PATH, DEMO_PDF_PATH);

/** What a tool says when it made a PDF: the pane's cue to offer it. */
export const pdfMade = (path: string) => `made ${path}`;
export const madePdfPath = (result: string) =>
  /made (\/.*\.pdf)$/.exec(result)?.[1];
export const DEMO_PDF_MADE = pdfMade(DEMO_PDF_PATH);

const DEMO_TEXT_WORD = DEMO_TEXT_PATH.replaceAll(".", "\\.");
/** Output (not a numbered stream like `2>`) sent into the demo's text. */
const DEMO_TEXT_REDIRECT = new RegExp(
  `(?<![\\d&>])>>?\\s*['"]?${DEMO_TEXT_WORD}['"]?(?=\\s|;|&|\\||$)`,
);

/** How a shell command writes the demo's text, if it does: `> ` or `>> `
 * it, and whether the same command reads it first, which the shell would
 * empty before the read (`python3 demo.txt > demo.txt`). Commands joined
 * by `;`, `&&` or `||` run one after another, so only the one holding the
 * redirect counts; a pipe runs together with it. */
export function demoTextRedirect(
  cmd: string,
): { readsItFirst: boolean } | undefined {
  const redirect = DEMO_TEXT_REDIRECT.exec(cmd);
  if (redirect === null) return undefined;
  const command = cmd.slice(0, redirect.index).split(/;|&&|\|\||\n/).pop()!;
  return {
    readsItFirst: new RegExp(`${DEMO_TEXT_WORD}(?![\\w.])`).test(command),
  };
}

const PROMPT_RULES = [
  "Reply with exactly one JSON object and nothing else. It must be one of:",
  '{"action":"exec","cmd":"<shell command>"}',
  '{"action":"read_file","path":"<absolute path>"}',
  '{"action":"write_file","path":"<absolute path>","text":"<the whole file>"}',
  '{"action":"set_color","color":"<#rrggbb>"}',
  '{"action":"answer","text":"<final answer for the user>"}',
  "Use exec or read_file to get facts from the sandbox, one step at a time.",
  `To create or change a PDF, write_file its whole text to ${DEMO_TEXT_PATH}: plain ASCII with no markdown, under 300 words, since a page holds 40 lines of 65 characters. That also makes the PDF at ${DEMO_PDF_PATH}; do nothing more for it.`,
  `A program goes in its own file, such as ${PROGRAM_PATH}, never in ${DEMO_TEXT_PATH}. To put its output in that PDF, exec it with the output redirected: python3 ${PROGRAM_PATH} > ${DEMO_TEXT_PATH}. That makes the PDF too. Never type out a program's output yourself.`,
  "Send one action per reply; you see its result before the next.",
  "set_color sets the color of the whole text of that PDF and remakes it; it changes no words. Give the requested color's #rrggbb value.",
  `To read the text of that PDF, exec: mkpdf --text ${DEMO_PDF_PATH} and pipe it to other commands, such as wc -w. Do not count or calculate in your head: report what the command printed.`,
  "When a step is done, do not repeat it: use the answer action. If a step failed, say so; never claim it worked.",
  "Only if the user names another PDF file, write_file its text to that path ending in .pdf, which makes a real PDF. Otherwise use the file above.",
  "Every PDF made gets a Download button under this chat. If asked to download one, say so; you cannot download it yourself.",
  "The PDF can do nothing else: no bold, sizes, images or background. If asked for those, say so; never claim a change you did not make.",
  "Answer only from what you have seen. Keep the answer short.",
];

export const SYSTEM_PROMPT = systemPrompt(true);

/** One message of a chat as the agent's task: its words, after the document as
 * it stands, so an edit changes that text and not a new one, and after the
 * earlier messages, which say what "it" refers to. The oldest go first when they
 * do not fit `maxTask`; a message too long on its own is left for runAgent to
 * refuse. */
export function chatTask(
  earlier: readonly string[],
  message: string,
  maxTask: number,
  document?: string,
): string {
  const now = document === undefined && earlier.length === 0
    ? message
    : `Now the user asks: ${message}`;
  const shown =
    `The text in ${DEMO_TEXT_PATH} now, to change only as asked:\n<<<\n${document}\n>>>\n\n`;
  // A document too long to show must not block every later message.
  const text = document === undefined
    ? ""
    : shown.length + now.length <= maxTask
    ? shown
    : `${DEMO_TEXT_PATH} is too long to show here; read_file it if you need it.\n\n`;
  const heading = "Earlier in this chat the user asked:\n";
  const kept: string[] = [];
  let room = maxTask - now.length - text.length - heading.length - 1;
  for (let i = earlier.length - 1; i >= 0; i--) {
    const line = `- ${earlier[i]}\n`;
    if (line.length > room) break;
    kept.unshift(line);
    room -= line.length;
  }
  const asked = kept.length === 0 ? "" : `${heading}${kept.join("")}\n`;
  return `${asked}${text}${now}`;
}

/** The demo: a task the pane offers until the visitor types their own. */
// The task names the file: told only to "make it a PDF" and to say Yurt, the
// in-tab Gemma 4 E4B wrote /home/user/Yurt.txt and Yurt.pdf in 4 of 4 runs.
export const DEMO_TASK = [
  `Write a short explanation of this demo for someone seeing it for the first time, and make it the demo PDF: write_file its text to ${DEMO_TEXT_PATH}. Mention Yurt by name in the text.`,
  "What is true of it: a Linux sandbox (Yurt) runs inside this browser tab, started from a snapshot so it is ready in seconds.",
  "A language model on this computer proposes one action at a time, and the page runs each in the sandbox.",
  "The document's text and the PDF are files in that sandbox, and the user can change them by asking in this chat.",
  "What the user types stays on this computer. Do not claim anything else.",
].join(" ");

const FIELDS = {
  exec: ["cmd"],
  read_file: ["path"],
  write_file: ["path", "text"],
  set_color: ["color"],
  answer: ["text"],
} as const;

/** Exactly the keys of one variant, each a non-empty string. */
export function validateAction(value: unknown): Action | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  const fields: readonly string[] | undefined =
    FIELDS[v.action as keyof typeof FIELDS];
  if (fields === undefined) return null;
  if (Object.keys(v).length !== fields.length + 1) return null;
  for (const field of fields) {
    const arg = v[field];
    if (typeof arg !== "string" || arg.trim() === "") return null;
  }
  return v as Action;
}

/** Where the JSON object starting at `start` ends (its closing brace),
 * strings and escapes aside; -1 if it does not close. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

const FENCE = /```(json)?/g;

/** Gemma 4 E2B often drops the answer's "text" key:
 * {"action":"answer":"..."}. Not JSON, but there is only one way to read it. */
const KEYLESS_ANSWER =
  /^\{\s*"action"\s*:\s*"answer"\s*:\s*("(?:[^"\\]|\\.)*")\s*\}$/s;

function parseObject(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    const keyless = KEYLESS_ANSWER.exec(json);
    if (keyless === null) throw error;
    return { action: "answer", text: JSON.parse(keyless[1]) };
  }
}

/** The first action in a reply, and whether more text follows it. Small
 * models often wrap it in a ```json fence; nothing else may come first. A
 * model that plans ahead sends several actions in one reply: the first is
 * the one to run, and the rest wait for its result. */
export function firstAction(
  text: string,
): { action: Action; more: boolean } | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  if (text.slice(0, start).replace(FENCE, "").trim() !== "") return null;
  const end = objectEnd(text, start);
  if (end < 0) return null;
  try {
    const action = validateAction(parseObject(text.slice(start, end + 1)));
    if (action === null) return null;
    const more = text.slice(end + 1).replace(FENCE, "").trim() !== "";
    return { action, more };
  } catch {
    return null;
  }
}

/** The one JSON object in a reply, fenced or bare, and nothing else. */
export function parseAction(text: string): Action | null {
  const first = firstAction(text);
  return first === null || first.more ? null : first.action;
}

type Turn = { reply: string; result: string };

/** The prompt for the next step: the task, then as many of the latest
 * turns as fit `maxPrompt`. Older turns are named, not dropped silently;
 * a latest turn too big on its own is clipped. The result is never longer
 * than `maxPrompt`, given a task that fits (runAgent refuses one that
 * does not). */
export function buildPrompt(
  task: string,
  turns: Turn[],
  maxPrompt: number,
): string {
  const head = `Task: ${task}`;
  const rendered = turns.map((t, i) =>
    `Step ${i + 1}: you replied ${t.reply}\nResult:\n${t.result}`
  );
  const note = (n: number) => `(Steps 1-${n} are omitted to fit the context.)`;
  // Room for the omission note, whether or not it is needed.
  let budget = maxPrompt - head.length - (note(turns.length).length + 2);
  const kept: string[] = [];
  for (let i = rendered.length - 1; i >= 0; i--) {
    const cost = rendered[i].length + 2;
    if (cost <= budget) {
      kept.unshift(rendered[i]);
      budget -= cost;
      continue;
    }
    // The latest turn alone does not fit: keep its start, say how much went.
    const room = budget - 2 - CLIP_SUFFIX_MAX;
    if (kept.length === 0 && room > 0) {
      kept.unshift(clip(rendered[i], room).text);
    }
    break;
  }
  const omitted = rendered.length - kept.length;
  return [head, ...(omitted > 0 ? [note(omitted)] : []), ...kept].join("\n\n");
}

/** The longest suffix `clip` appends. */
const CLIP_SUFFIX_MAX = 40;

export function clip(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: `${text.slice(0, max)}\n[… ${text.length - max} more characters]`,
    truncated: true,
  };
}

/** Run one task to an answer or a stop. Every step is reported through
 * `onEvent`; the returned promise settles after the last event. */
export async function runAgent(
  task: string,
  model: Model,
  tools: Tools,
  onEvent: (event: AgentEvent) => void,
  cancel: AbortSignal,
  limits: Limits = DEFAULT_LIMITS,
  system: string = SYSTEM_PROMPT,
): Promise<void> {
  const timeout = AbortSignal.timeout(limits.timeoutMs);
  const signal = AbortSignal.any([cancel, timeout]);
  const stopped = () =>
    onEvent({
      type: "stopped",
      reason: cancel.aborted ? "cancelled" : "timeout",
    });
  if (task.length > limits.maxTask) {
    return onEvent({ type: "stopped", reason: "task" });
  }
  const turns: Turn[] = [];
  let invalid = 0;
  let lastAction: string | undefined;
  let repeats = 0;
  try {
    for (let step = 1; step <= limits.maxSteps; step++) {
      if (signal.aborted) return stopped();
      const prompt = buildPrompt(task, turns, limits.maxPrompt);
      onEvent({ type: "step", step, promptChars: prompt.length });
      let started = performance.now();
      const { text, stats } = await model.generate(
        system,
        prompt,
        signal,
      );
      if (signal.aborted) return stopped();
      const ms = performance.now() - started;
      const first = firstAction(text);
      const action = first?.action ?? null;
      if (action === null) {
        onEvent({ type: "invalid", step, raw: text, stats, ms });
        if (++invalid > limits.maxInvalid) {
          return onEvent({ type: "stopped", reason: "invalid" });
        }
        turns.push({
          reply: JSON.stringify(text.slice(0, 200)),
          result:
            "That is not one of the five JSON actions. Reply with exactly one.",
        });
        continue;
      }
      invalid = 0;
      // A model may not see that a step is done, and repeat it for ever. The
      // answer is exempt: it ends the task anyway.
      if (action.action !== "answer" && text.trim() === lastAction) {
        if (++repeats > 1) {
          return onEvent({ type: "stopped", reason: "repeat" });
        }
        onEvent({ type: "repeat", step });
        turns.push({
          reply: JSON.stringify(action),
          result:
            "You already did exactly this and its result is above, so it was not run again. Change the step, or use the answer action to say what happened.",
        });
        continue;
      }
      lastAction = text.trim();
      repeats = 0;
      onEvent({ type: "action", step, action, raw: text, stats, ms });
      if (action.action === "answer") {
        return onEvent({ type: "answer", text: action.text });
      }
      started = performance.now();
      let raw: string;
      let made: string | undefined;
      try {
        if (action.action === "exec") {
          const r = await tools.exec(action.cmd, signal);
          raw = `exit ${r.code ?? "none"}\n${r.stdout}${r.stderr}`;
          made = r.made;
        } else if (action.action === "set_color") {
          raw = await tools.setColor(action.color, signal);
        } else if (action.action === "write_file") {
          raw = await tools.writeFile(action.path, action.text, signal);
        } else {
          raw = await tools.readFile(action.path, signal);
        }
      } catch (error) {
        if (signal.aborted) return stopped();
        if (error instanceof ToolFailed) throw error;
        raw = `error: ${error instanceof Error ? error.message : error}`;
      }
      if (signal.aborted) return stopped();
      const clipped = clip(raw, limits.maxObservation);
      // Last, where madePdfPath reads it, and never clipped away.
      const result = made === undefined
        ? clipped
        : { ...clipped, text: `${clipped.text.trimEnd()}\n${made}` };
      onEvent({
        type: "observation",
        step,
        text: result.text,
        truncated: result.truncated,
        ms: performance.now() - started,
      });
      turns.push({
        reply: JSON.stringify(action),
        result: first?.more
          ? `${result.text}\n(Only your first action was run. Send one action per reply, after reading its result.)`
          : result.text,
      });
    }
    onEvent({ type: "stopped", reason: "steps" });
  } catch (error) {
    if (signal.aborted) return stopped();
    onEvent({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
