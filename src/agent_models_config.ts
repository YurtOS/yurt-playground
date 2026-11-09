/**
 * Which models the agent pane offers on each platform, read at page load
 * from `agent-models.json` on this repository's `agent-models` branch. That
 * branch never deploys, so a model is added or removed by editing that one
 * file (GitHub's raw cache serves the edit within about five minutes).
 * There is no built-in list: without the file the pane offers no model.
 *
 *   {
 *     "desktop": { "local": ["E4B", "E2B"],
 *                  "openrouter": [{ "id": "vendor/model:free", "label": "…" }] },
 *     "tablet":  { "openrouter": [ … ] },
 *     "phone":   { "openrouter": [] }
 *   }
 *
 * `local` names in-tab models (src/llm_models.ts ids) and is ignored where
 * none fit (a tablet). `openrouter` lists OpenRouter model ids, the first
 * being the default. A platform left out offers no model.
 */
import type { Platform } from "./device.ts";
import { SNAPSHOT_SOURCE } from "./snapshot_source.ts";

export const AGENT_MODELS_BRANCH = "agent-models";
export const AGENT_MODELS_URL =
  `${SNAPSHOT_SOURCE}${AGENT_MODELS_BRANCH}/agent-models.json`;

export type OpenrouterEntry = { id: string; label: string };
export type PlatformModels = {
  local?: string[];
  openrouter?: OpenrouterEntry[];
};
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
    const { local, openrouter } = raw as Record<string, unknown>;
    const entry: PlatformModels = {};
    if (Array.isArray(local)) {
      entry.local = local.filter((id): id is string => typeof id === "string");
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
    config[platform] = entry;
  }
  return config;
}

/** The published config, or undefined (offline, missing, malformed, slow). */
export async function fetchAgentModels(
  url = AGENT_MODELS_URL,
  timeoutMs = 4000,
): Promise<AgentModelsConfig | undefined> {
  try {
    const response = await fetch(url, {
      cache: "no-cache",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    return parseAgentModels(await response.json());
  } catch {
    return undefined;
  }
}
