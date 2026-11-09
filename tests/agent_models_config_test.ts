import { assertEquals } from "@std/assert";
import {
  AGENT_MODELS_URL,
  fetchAgentModels,
  parseAgentModels,
} from "../src/agent_models_config.ts";

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

Deno.test("the config comes from the agent-models branch, never deployed", () => {
  assertEquals(
    AGENT_MODELS_URL,
    "https://raw.githubusercontent.com/YurtOS/yurt-playground/agent-models/agent-models.json",
  );
});

Deno.test("a list that cannot be read now is the last one read; never read, none", async () => {
  const original = globalThis.fetch;
  try {
    localStorage.removeItem("yurt-agent-models");
    globalThis.fetch = () =>
      Promise.resolve(new Response("nope", { status: 404 }));
    assertEquals(await fetchAgentModels(), undefined);
    globalThis.fetch = () => Promise.resolve(new Response("{not json"));
    assertEquals(await fetchAgentModels(), undefined);
    globalThis.fetch = () => Promise.reject(new TypeError("offline"));
    assertEquals(await fetchAgentModels(), undefined);
    globalThis.fetch = () =>
      Promise.resolve(
        Response.json({ tablet: { openrouter: [{ id: "a/b" }] } }),
      );
    const read = { tablet: { openrouter: [{ id: "a/b", label: "a/b" }] } };
    assertEquals(await fetchAgentModels(), read);
    globalThis.fetch = () => Promise.reject(new TypeError("offline"));
    assertEquals(await fetchAgentModels(), read);
    globalThis.fetch = () =>
      Promise.resolve(new Response("nope", { status: 503 }));
    assertEquals(await fetchAgentModels(), read);
  } finally {
    globalThis.fetch = original;
    localStorage.removeItem("yurt-agent-models");
  }
});
