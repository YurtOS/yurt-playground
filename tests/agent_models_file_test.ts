// config/agent-models.json, the list the live page reads (src/
// agent_models_config.ts). A pull request that changes only that file runs
// only ci.yml's checks job, which runs this file on every run: the list
// must parse whole, and every platform that offers a model must say how.
import { assert, assertEquals } from "@std/assert";
import {
  AGENT_MODELS_PATH,
  parseAgentModels,
} from "../src/agent_models_config.ts";
import { LOCAL_MODELS } from "../src/llm_models.ts";

const raw = JSON.parse(
  await Deno.readTextFile(new URL(`../${AGENT_MODELS_PATH}`, import.meta.url)),
);

Deno.test("config/agent-models.json is a list the page accepts whole", () => {
  const config = parseAgentModels(raw);
  assert(config !== undefined, "not a JSON object");
  // Nothing the page would drop: every entry as written survives parsing.
  for (const platform of ["desktop", "tablet", "phone"] as const) {
    const given = raw[platform];
    if (given === undefined) continue;
    const parsed = config[platform]!;
    assertEquals(
      parsed.local?.length ?? 0,
      given.local?.length ?? 0,
      `${platform}: an in-tab entry is malformed`,
    );
    assertEquals(
      parsed.openrouter?.length ?? 0,
      given.openrouter?.length ?? 0,
      `${platform}: an OpenRouter entry is malformed`,
    );
    for (const id of parsed.local ?? []) {
      assert(
        LOCAL_MODELS.some((m) => m.id === id),
        `${platform}: no in-tab model ${id}`,
      );
    }
    const offers = (parsed.local?.length ?? 0) +
      (parsed.openrouter?.length ?? 0);
    if (offers > 0) {
      assert(
        parsed.instructions !== undefined,
        `${platform}: models but no (valid) instructions`,
      );
      assert(parsed.task !== undefined, `${platform}: no (valid) task`);
    }
  }
});

Deno.test("phones and tablets list no in-tab model, which they never offer", () => {
  for (const platform of ["tablet", "phone"]) {
    assertEquals(raw[platform]?.local, undefined, platform);
  }
});
