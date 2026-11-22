/**
 * Model lists for the agent's tests. The page takes the model's instructions
 * and the starter task from agent-models.json alone, so a test's list carries
 * them: the built-in prompt and demo task (src/agent.ts), unless the test
 * gives its own.
 */
import { DEMO_TASK, systemPrompt } from "../src/agent.ts";
import {
  AGENT_MODELS_PATH,
  type AgentModelsConfig,
} from "../src/agent_models_config.ts";

/** The page's request for its model list, for `route`: the file at the
 * site's root, never a copy elsewhere (#368). */
export const AGENT_MODELS_ROUTE = (url: URL): boolean =>
  url.pathname === `/${AGENT_MODELS_PATH}`;

/** The built-in prompt as the list's lines, `{tools}` for the sandbox. */
export const PROMPT_LINES = systemPrompt(true).split("\n").map((line, i) =>
  i === 0 ? "You operate a Linux sandbox ({tools}) for the user." : line
);

/** `config` with the built-in prompts on every platform that sets none. */
export function withPrompts(config: AgentModelsConfig): AgentModelsConfig {
  return Object.fromEntries(
    Object.entries(config).map(([platform, entry]) => [platform, {
      instructions: PROMPT_LINES,
      task: DEMO_TASK,
      ...entry,
    }]),
  );
}
