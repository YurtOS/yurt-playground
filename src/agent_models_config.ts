/**
 * Which models the agent pane offers on each platform, read at page load
 * from `config/agent-models.json` beside the page: scripts/build-static.ts
 * copies the committed file into the site, and the dev server serves it from
 * the checkout. So a change to it, like any change to the page, goes live
 * only with a deploy; merging it changes nothing a visitor gets (#368).
 * There is no built-in list and no kept copy: a load that cannot read the
 * file offers no model.
 *
 *   {
 *     "desktop": { "local": ["E4B", "E2B"],
 *                  "openrouter": [{ "id": "vendor/model:free", "label": "…" }] },
 *     "tablet":  { "openrouter": [ … ] },
 *     "phone":   { "openrouter": [] }
 *   }
 *
 * Per platform, `instructions`: the model's system prompt as lines
 * (`{tools}` stands for what the sandbox has, with or without Python),
 * required wherever a model is offered: there are no built-in ones. And
 * `task`: the starter text in the task box, empty when left out.
 *
 * `local` names in-tab models (src/llm_models.ts ids) and is ignored where
 * none fit (a tablet or a phone). `openrouter` lists OpenRouter model ids, the first
 * being the default. A platform left out offers no model.
 */
import type { Platform } from "./device.ts";
import { siteUrl } from "./site_url.ts";

/** The list: its path in this repository and in the built site. */
export const AGENT_MODELS_PATH = "config/agent-models.json";

export type OpenrouterEntry = { id: string; label: string };
export type PlatformModels = {
  local?: string[];
  /** The menu's name for an in-tab model, by id, where the list gives one
   * (`"local": [{ "id": "E4B", "label": "…" }]`). */
  localLabels?: Record<string, string>;
  openrouter?: OpenrouterEntry[];
  /** The model's system prompt, as lines. */
  instructions?: string[];
  /** The starter text in the task box. */
  task?: string;
};

/** Bounds on the prompts a list may set: a prompt fills the model's context. */
const MAX_INSTRUCTIONS = 12_000;
const MAX_TASK = 4_000;
export type AgentModelsConfig = Partial<Record<Platform, PlatformModels>>;

const PLATFORMS: Platform[] = ["phone", "tablet", "desktop"];
/** An OpenRouter model id: `vendor/name`, optionally `:variant`. */
const MODEL_ID = /^[\w.-]+\/[\w.-]+(:[\w.-]+)?$/;

/** The config, keeping only well-formed entries; undefined when the file is
 * not an object at all. */
export function parseAgentModels(json: unknown): AgentModelsConfig | undefined {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return undefined;
  }
  const config: AgentModelsConfig = {};
  for (const platform of PLATFORMS) {
    const raw = (json as Record<string, unknown>)[platform];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const { local, openrouter, instructions, task } = raw as Record<
      string,
      unknown
    >;
    const entry: PlatformModels = {};
    if (Array.isArray(local)) {
      // An id, or { id, label }: the label is the menu's name for it.
      entry.local = [];
      for (const m of local) {
        if (typeof m === "string") entry.local.push(m);
        else if (m !== null && typeof m === "object") {
          const { id, label } = m as Record<string, unknown>;
          if (typeof id !== "string") continue;
          entry.local.push(id);
          if (typeof label === "string" && label.trim() !== "") {
            (entry.localLabels ??= {})[id] = label.trim().slice(0, 80);
          }
        }
      }
    }
    if (Array.isArray(openrouter)) {
      entry.openrouter = openrouter.flatMap((m) => {
        if (m === null || typeof m !== "object") return [];
        const { id, label } = m as Record<string, unknown>;
        if (typeof id !== "string" || !MODEL_ID.test(id)) return [];
        return [{
          id,
          label: typeof label === "string" && label.trim() !== ""
            ? label.trim().slice(0, 80)
            : id,
        }];
      });
    }
    if (
      Array.isArray(instructions) &&
      instructions.every((l) => typeof l === "string") &&
      instructions.length > 0 &&
      instructions.join("\n").length <= MAX_INSTRUCTIONS
    ) {
      entry.instructions = instructions;
    }
    if (
      typeof task === "string" && task.trim() !== "" &&
      task.length <= MAX_TASK
    ) {
      entry.task = task.trim();
    }
    config[platform] = entry;
  }
  return config;
}

/** The deployed config; undefined if it cannot be read (offline, missing,
 * malformed, slow). */
export async function fetchAgentModels(
  url = siteUrl(AGENT_MODELS_PATH),
  timeoutMs = 4000,
): Promise<AgentModelsConfig | undefined> {
  try {
    const response = await fetch(url, {
      // Revalidated, so a load after a deploy reads that deploy's list.
      cache: "no-cache",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    return parseAgentModels(await response.json());
  } catch {
    return undefined;
  }
}
