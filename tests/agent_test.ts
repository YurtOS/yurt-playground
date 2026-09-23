import { assert, assertEquals } from "@std/assert";
import {
  type AgentEvent,
  buildPrompt,
  DEFAULT_LIMITS,
  type Model,
  parseAction,
  runAgent,
  type Tools,
  validateAction,
} from "../src/agent.ts";

/** A deterministic model: replies in order, and records every prompt. */
function scripted(replies: string[]) {
  const prompts: string[] = [];
  const model: Model = {
    generate(_system, prompt) {
      prompts.push(prompt);
      const text = replies.shift();
      if (text === undefined) throw new Error("script ran out");
      return Promise.resolve({
        text,
        stats: { promptTokens: prompt.length, outputTokens: text.length },
      });
    },
  };
  return { model, prompts };
}

const passwd = "root:x:0:0\nuser:x:1000:1000\n";
const tools = (log: string[] = []): Tools => ({
  exec(cmd) {
    log.push(`exec ${cmd}`);
    return Promise.resolve({ code: 0, stdout: "2\n", stderr: "" });
  },
  readFile(path) {
    log.push(`read ${path}`);
    return Promise.resolve(passwd);
  },
});

async function run(
  replies: string[],
  opts: {
    tools?: Tools;
    limits?: Partial<typeof DEFAULT_LIMITS>;
    cancel?: AbortSignal;
  } = {},
) {
  const events: AgentEvent[] = [];
  const { model, prompts } = scripted(replies);
  await runAgent(
    "How many users?",
    model,
    opts.tools ?? tools(),
    (e) => events.push(e),
    opts.cancel ?? new AbortController().signal,
    { ...DEFAULT_LIMITS, ...opts.limits },
  );
  return { events, prompts, types: events.map((e) => e.type) };
}

Deno.test("validateAction accepts exactly the three variants", () => {
  assertEquals(validateAction({ action: "exec", cmd: "ls" }), {
    action: "exec",
    cmd: "ls",
  });
  assertEquals(validateAction({ action: "exec", path: "/x" }), null);
  assertEquals(validateAction({ action: "exec", cmd: "ls", extra: 1 }), null);
  assertEquals(validateAction({ action: "exec", cmd: "  " }), null);
  assertEquals(validateAction({ action: "eval", code: "1" }), null);
  assertEquals(validateAction([{ action: "answer", text: "x" }]), null);
});

Deno.test("parseAction takes one object, fenced or bare, and nothing else", () => {
  assertEquals(parseAction('{"action":"answer","text":"hi"}'), {
    action: "answer",
    text: "hi",
  });
  assertEquals(
    parseAction('```json\n{"action":"read_file","path":"/etc/hostname"}\n```'),
    { action: "read_file", path: "/etc/hostname" },
  );
  assertEquals(parseAction('Sure! {"action":"answer","text":"hi"}'), null);
  assertEquals(parseAction("the answer is 2"), null);
  assertEquals(parseAction('{"action":"answer","text":"a"} {"x":1}'), null);
});

Deno.test("a tool step feeds its result into the next prompt, then answers", async () => {
  const log: string[] = [];
  const { types, prompts, events } = await run([
    '{"action":"read_file","path":"/etc/passwd"}',
    '{"action":"answer","text":"2"}',
  ], { tools: tools(log) });
  assertEquals(log, ["read /etc/passwd"]);
  assertEquals(types, [
    "step",
    "action",
    "observation",
    "step",
    "action",
    "answer",
  ]);
  assert(prompts[1].includes(passwd.trim()));
  assertEquals(events.at(-1), { type: "answer", text: "2" });
});

Deno.test("an invalid reply is retried with a correction, then limited", async () => {
  const corrected = await run([
    "There are 2 users.",
    '{"action":"answer","text":"2"}',
  ]);
  assertEquals(corrected.types, [
    "step",
    "invalid",
    "step",
    "action",
    "answer",
  ]);
  assert(corrected.prompts[1].includes("not one of the three JSON actions"));

  const gaveUp = await run(["no", "still no", "never"], {
    limits: { maxInvalid: 2 },
  });
  assertEquals(gaveUp.events.at(-1), { type: "stopped", reason: "invalid" });
  assertEquals(gaveUp.prompts.length, 3);
});

Deno.test("the step limit stops a model that never answers", async () => {
  const { events, prompts } = await run(
    Array(10).fill('{"action":"exec","cmd":"true"}'),
    { limits: { maxSteps: 3 } },
  );
  assertEquals(prompts.length, 3);
  assertEquals(events.at(-1), { type: "stopped", reason: "steps" });
});

Deno.test("tool output is clipped to the observation limit", async () => {
  const big: Tools = {
    exec: () =>
      Promise.resolve({ code: 0, stdout: "x".repeat(5000), stderr: "" }),
    readFile: () => Promise.reject(new Error("unused")),
  };
  const { events, prompts } = await run([
    '{"action":"exec","cmd":"yes"}',
    '{"action":"answer","text":"done"}',
  ], { tools: big, limits: { maxObservation: 100 } });
  const observation = events.find((e) => e.type === "observation");
  assert(observation?.type === "observation" && observation.truncated);
  assert(prompts[1].length < 500, `prompt is ${prompts[1].length} chars`);
});

Deno.test("a failing tool is an observation, not the end of the task", async () => {
  const failing: Tools = {
    exec: () => Promise.reject(new Error("kernel_spawn_process failed")),
    readFile: () => Promise.reject(new Error("unused")),
  };
  const { types, prompts } = await run([
    '{"action":"exec","cmd":"ls"}',
    '{"action":"answer","text":"could not list"}',
  ], { tools: failing });
  assertEquals(types.at(-1), "answer");
  assert(prompts[1].includes("error: kernel_spawn_process failed"));
});

Deno.test("the prompt keeps the task and the latest steps within budget", () => {
  const turns = Array.from({ length: 20 }, (_, i) => ({
    reply: `{"action":"exec","cmd":"step ${i + 1}"}`,
    result: "y".repeat(400),
  }));
  const prompt = buildPrompt("the task", turns, 2000);
  assert(prompt.length <= 2000 + 80, `prompt is ${prompt.length} chars`);
  assert(prompt.startsWith("Task: the task"));
  assert(prompt.includes("step 20"), "latest step kept");
  assert(!prompt.includes('step 1"'), "oldest step dropped");
  assert(/Steps 1-\d+ are omitted/.test(prompt));
});

Deno.test("cancel stops a running tool and reports it", async () => {
  const controller = new AbortController();
  let killed = false;
  const slow: Tools = {
    exec: (_cmd, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          killed = true;
          reject(new Error("killed"));
        });
        controller.abort();
      }),
    readFile: () => Promise.reject(new Error("unused")),
  };
  const { events, prompts } = await run(
    ['{"action":"exec","cmd":"sleep 100"}', '{"action":"answer","text":"x"}'],
    { tools: slow, cancel: controller.signal },
  );
  assert(killed);
  assertEquals(prompts.length, 1);
  assertEquals(events.at(-1), { type: "stopped", reason: "cancelled" });
});

Deno.test("a task longer than the limit is refused before the model is asked", async () => {
  const { events, prompts } = await run(['{"action":"answer","text":"x"}'], {
    limits: { maxTask: 10 }, // the task is "How many users?", 16 chars
  });
  assertEquals(prompts.length, 0);
  assertEquals(events, [{ type: "stopped", reason: "task" }]);
});

Deno.test("a single turn larger than the budget is clipped to fit", () => {
  const turns = [{
    reply: '{"action":"exec","cmd":"cat big"}',
    result: "z".repeat(20_000),
  }];
  const prompt = buildPrompt("the task", turns, 2000);
  assert(prompt.length <= 2000, `prompt is ${prompt.length} chars`);
  assert(prompt.includes('"cmd":"cat big"'), "the latest reply is kept");
  assert(prompt.includes("more characters]"), "the clip is named");
});

Deno.test("the prompt never exceeds its budget", () => {
  for (const max of [600, 2000, 9000]) {
    for (const size of [0, 10, 300, 1500, 5000, 30_000]) {
      for (const count of [0, 1, 3, 12]) {
        const turns = Array.from({ length: count }, (_, i) => ({
          reply: `{"action":"exec","cmd":"step ${i}"}`,
          result: "r".repeat(size),
        }));
        const prompt = buildPrompt("t".repeat(200), turns, max);
        assert(
          prompt.length <= max,
          `max ${max}, ${count} turns of ${size}: ${prompt.length} chars`,
        );
      }
    }
  }
});
