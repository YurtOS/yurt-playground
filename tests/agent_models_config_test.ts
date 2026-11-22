import { assertEquals } from "@std/assert";
import {
  AGENT_MODELS_PATH,
  fetchAgentModels,
  parseAgentModels,
} from "../src/agent_models_config.ts";
import { siteUrl } from "../src/site_url.ts";
import { SNAPSHOT_SOURCE } from "../src/snapshot_source.ts";

Deno.test("the config is read per platform, keeping only well-formed entries", () => {
  assertEquals(
    parseAgentModels({
      desktop: {
        local: ["E4B", 7, "E2B"],
        openrouter: [
          { id: "nvidia/nemotron-3.5-super-vl:free", label: " Nemotron " },
          { id: "google/gemma-4-31b-it" },
          { id: "not an id", label: "x" },
          { id: "https://evil/x", label: "x" },
          "vendor/bare-string",
          null,
        ],
      },
      tablet: { openrouter: [{ id: "a/b:free", label: "AB" }] },
      phone: "nonsense",
      laptop: { openrouter: [{ id: "a/b", label: "ignored" }] },
    }),
    {
      desktop: {
        local: ["E4B", "E2B"],
        openrouter: [
          { id: "nvidia/nemotron-3.5-super-vl:free", label: "Nemotron" },
          { id: "google/gemma-4-31b-it", label: "google/gemma-4-31b-it" },
        ],
      },
      tablet: { openrouter: [{ id: "a/b:free", label: "AB" }] },
    },
  );
});

Deno.test("a file that is not an object is no config", () => {
  for (const json of [null, [], "x", 3]) {
    assertEquals(parseAgentModels(json), undefined);
  }
});

Deno.test("the page reads the list from its own site, never from main (#368)", async () => {
  const original = globalThis.fetch;
  const asked: string[] = [];
  try {
    globalThis.fetch = (input) => {
      asked.push(String(input instanceof Request ? input.url : input));
      return Promise.resolve(Response.json({}));
    };
    await fetchAgentModels();
  } finally {
    globalThis.fetch = original;
  }
  // The file the deploy built in (scripts/build-static.ts), beside the
  // bundles: a merge to main changes nothing a visitor gets.
  assertEquals(asked, [siteUrl(AGENT_MODELS_PATH)]);
  assertEquals(AGENT_MODELS_PATH, "config/agent-models.json");
  assertEquals(asked[0].startsWith(SNAPSHOT_SOURCE), false);
});

Deno.test("a list that cannot be read now is none, even after one was read", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = () =>
      Promise.resolve(
        Response.json({ tablet: { openrouter: [{ id: "a/b" }] } }),
      );
    assertEquals(await fetchAgentModels(), {
      tablet: { openrouter: [{ id: "a/b", label: "a/b" }] },
    });
    // No list kept from an earlier load: what the page offers is the
    // deployed file's, or nothing.
    globalThis.fetch = () =>
      Promise.resolve(new Response("nope", { status: 404 }));
    assertEquals(await fetchAgentModels(), undefined);
    globalThis.fetch = () => Promise.resolve(new Response("{not json"));
    assertEquals(await fetchAgentModels(), undefined);
    globalThis.fetch = () => Promise.reject(new TypeError("offline"));
    assertEquals(await fetchAgentModels(), undefined);
    globalThis.fetch = () => Promise.resolve(Response.json([]));
    assertEquals(await fetchAgentModels(), undefined);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("a platform's prompts are read when well-formed, and dropped when not", () => {
  assertEquals(
    parseAgentModels({
      phone: {
        instructions: ["You operate ({tools}).", "Reply with JSON."],
        task: "  show me the files  ",
      },
      tablet: { instructions: ["ok", 3], task: "" },
      desktop: { instructions: [], task: "x".repeat(4001) },
    }),
    {
      phone: {
        instructions: ["You operate ({tools}).", "Reply with JSON."],
        task: "show me the files",
      },
      tablet: {},
      desktop: {},
    },
  );
  assertEquals(
    parseAgentModels({ phone: { instructions: ["x".repeat(12_001)] } }),
    { phone: {} },
  );
});

Deno.test("an in-tab model may carry its menu name", () => {
  assertEquals(
    parseAgentModels({
      desktop: {
        local: [
          { id: "E4B", label: " Gemma 4 E4B — in this tab " },
          "E2B",
          { id: 7, label: "no id" },
          { id: "X", label: "" },
        ],
      },
    }),
    {
      desktop: {
        local: ["E4B", "E2B", "X"],
        localLabels: { E4B: "Gemma 4 E4B — in this tab" },
      },
    },
  );
});
