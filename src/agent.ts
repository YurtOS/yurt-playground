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
};

export type Tools = {
  exec(cmd: string, signal: AbortSignal): Promise<ExecResult>;
  readFile(path: string, signal: AbortSignal): Promise<string>;
};

export type Limits = {
  /** Model calls per task, invalid replies included. */
  maxSteps: number;
  /** Consecutive replies that are not an action before giving up. */
  maxInvalid: number;
  /** Characters of one tool result the model is shown. */
  maxObservation: number;
  /** Characters of the whole prompt (task + steps): the active context. */
  maxPrompt: number;
  /** Wall-clock budget for the task. */
  timeoutMs: number;
};

export const DEFAULT_LIMITS: Limits = {
  maxSteps: 8,
  maxInvalid: 2,
  maxObservation: 1500,
  // ~2,500 tokens at 3.5 characters a token: with the system prompt and the
  // reply it stays inside the 4,096-token engine.
  maxPrompt: 9000,
  timeoutMs: 180_000,
};

export type AgentEvent =
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
  | { type: "stopped"; reason: "cancelled" | "steps" | "invalid" | "timeout" }
  | { type: "error"; message: string };

export const SYSTEM_PROMPT = [
  "You operate a Linux sandbox (BusyBox, Python 3) for the user.",
  "Reply with exactly one JSON object and nothing else. It must be one of:",
  '{"action":"exec","cmd":"<shell command>"}',
  '{"action":"read_file","path":"<absolute path>"}',
  '{"action":"answer","text":"<final answer for the user>"}',
  "Use exec or read_file to get facts from the sandbox, one step at a time.",
  "Answer only from what you have seen. Keep the answer short.",
].join("\n");

const FIELDS = { exec: "cmd", read_file: "path", answer: "text" } as const;

/** Exactly the keys of one variant, each a non-empty string. */
export function validateAction(value: unknown): Action | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  const field = FIELDS[v.action as keyof typeof FIELDS];
  if (field === undefined) return null;
  const keys = Object.keys(v);
  if (keys.length !== 2 || !keys.includes(field)) return null;
  const arg = v[field];
  if (typeof arg !== "string" || arg.trim() === "") return null;
  return v as Action;
}

/** The one JSON object in a reply. Small models often wrap it in a
 * ```json fence; anything more than one object is not an action. */
export function parseAction(text: string): Action | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  const outside = text.slice(0, start) + text.slice(end + 1);
  if (outside.replace(/```(json)?/g, "").trim() !== "") return null;
  try {
    return validateAction(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return null;
  }
}

type Turn = { reply: string; result: string };

/** The prompt for the next step: the task, then as many of the latest
 * turns as fit `maxPrompt`. Older turns are named, not dropped silently. */
export function buildPrompt(
  task: string,
  turns: Turn[],
  maxPrompt: number,
): string {
  const head = `Task: ${task}`;
  const rendered = turns.map((t, i) =>
    `Step ${i + 1}: you replied ${t.reply}\nResult:\n${t.result}`
  );
  let budget = maxPrompt - head.length;
  let keep = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    if (rendered[i].length + 2 > budget && keep > 0) break;
    budget -= rendered[i].length + 2;
    keep++;
  }
  const omitted = rendered.length - keep;
  const parts = [head];
  if (omitted > 0) {
    parts.push(`(Steps 1-${omitted} are omitted to fit the context.)`);
  }
  parts.push(...rendered.slice(omitted));
  return parts.join("\n\n");
}

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
): Promise<void> {
  const timeout = AbortSignal.timeout(limits.timeoutMs);
  const signal = AbortSignal.any([cancel, timeout]);
  const stopped = () =>
    onEvent({
      type: "stopped",
      reason: cancel.aborted ? "cancelled" : "timeout",
    });
  const turns: Turn[] = [];
  let invalid = 0;
  try {
    for (let step = 1; step <= limits.maxSteps; step++) {
      if (signal.aborted) return stopped();
      const prompt = buildPrompt(task, turns, limits.maxPrompt);
      onEvent({ type: "step", step, promptChars: prompt.length });
      let started = performance.now();
      const { text, stats } = await model.generate(
        SYSTEM_PROMPT,
        prompt,
        signal,
      );
      if (signal.aborted) return stopped();
      const ms = performance.now() - started;
      const action = parseAction(text);
      if (action === null) {
        onEvent({ type: "invalid", step, raw: text, stats, ms });
        if (++invalid > limits.maxInvalid) {
          return onEvent({ type: "stopped", reason: "invalid" });
        }
        turns.push({
          reply: JSON.stringify(text.slice(0, 200)),
          result:
            "That is not one of the three JSON actions. Reply with exactly one.",
        });
        continue;
      }
      invalid = 0;
      onEvent({ type: "action", step, action, raw: text, stats, ms });
      if (action.action === "answer") {
        return onEvent({ type: "answer", text: action.text });
      }
      started = performance.now();
      let raw: string;
      try {
        if (action.action === "exec") {
          const r = await tools.exec(action.cmd, signal);
          raw = `exit ${r.code ?? "none"}\n${r.stdout}${r.stderr}`;
        } else {
          raw = await tools.readFile(action.path, signal);
        }
      } catch (error) {
        if (signal.aborted) return stopped();
        raw = `error: ${error instanceof Error ? error.message : error}`;
      }
      if (signal.aborted) return stopped();
      const result = clip(raw, limits.maxObservation);
      onEvent({
        type: "observation",
        step,
        text: result.text,
        truncated: result.truncated,
        ms: performance.now() - started,
      });
      turns.push({ reply: JSON.stringify(action), result: result.text });
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
