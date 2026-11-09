/**
 * Which models the agent pane offers on each platform, read at page load
 * from `config/agent-models.json` on this repository's main, through
 * raw.githubusercontent.com. A change to that file alone builds and deploys
 * nothing (ci.yml and deploy-pages.yml ignore it; its pull request runs only
 * the checks, which validate it), so a model or a prompt changes with one
 * merged pull request (GitHub's raw cache serves it within about five
 * minutes).
 * There is no built-in list. A browser keeps the last list it loaded, so a
 * load while GitHub is slow or down (the agent's own resume reloads among
 * them) offers what that list did; never having loaded one, it offers none.
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
import { SNAPSHOT_SOURCE } from "./snapshot_source.ts";

/** The list, in this repository. */
export const AGENT_MODELS_PATH = "config/agent-models.json";
export const AGENT_MODELS_URL = `${SNAPSHOT_SOURCE}main/${AGENT_MODELS_PATH}`;

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

const LAST_LIST_STORAGE = "yurt-agent-models";

function lastList(): AgentModelsConfig | undefined {
  try {
    const saved = localStorage.getItem(LAST_LIST_STORAGE);
    return saved === null ? undefined : parseAgentModels(JSON.parse(saved));
  } catch {
    return undefined;
  }
}

/** The published config; if it cannot be read now (offline, missing,
 * malformed, slow), the last one this browser read; else undefined. */
export async function fetchAgentModels(
  url = AGENT_MODELS_URL,
  timeoutMs = 4000,
): Promise<AgentModelsConfig | undefined> {
  try {
    const response = await fetch(url, {
      cache: "no-cache",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return lastList();
    const json = await response.json();
    const config = parseAgentModels(json);
    if (config === undefined) return lastList();
    try {
      localStorage.setItem(LAST_LIST_STORAGE, JSON.stringify(json));
    } catch {
      // Storage blocked: the next load fetches again anyway.
    }
    return config;
  } catch {
    return lastList();
  }
}
