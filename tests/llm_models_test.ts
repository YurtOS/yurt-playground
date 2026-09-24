import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { LOCAL_MODELS, modelCacheKey, modelUrl } from "../src/llm_models.ts";
import { handlePlaygroundRequest, LITERT_WASM_DIR } from "../src/serve.ts";

const get = (path: string) =>
  handlePlaygroundRequest(new Request(`http://127.0.0.1${path}`));

Deno.test("a model downloads from its pinned Hugging Face commit", () => {
  for (const model of LOCAL_MODELS) {
    assertEquals(model.file, `gemma-4-${model.id}-it-web.litertlm`);
    assert(/^[0-9a-f]{40}$/.test(model.commit), model.id);
    assertEquals(
      modelUrl(model),
      `https://huggingface.co/litert-community/gemma-4-${model.id}-it-litert-lm/resolve/${model.commit}/${model.file}`,
    );
    // The cache key is on the page's origin and names the pin.
    assertStringIncludes(modelCacheKey(model), `?sha256=${model.sha256}`);
    assert(modelCacheKey(model).startsWith("/llm/"));
  }
});

Deno.test("the dev server offers every model and the gzipped runtime", async () => {
  const models = await get("/llm/models.json");
  assertEquals(await models.json(), LOCAL_MODELS.map((m) => m.id));

  const name = "litertlm_wasm_internal.wasm";
  const gz = await get(`/llm/wasm/${name}.gz`);
  assertEquals(gz.status, 200);
  assertEquals(
    new Uint8Array(gunzipSync(new Uint8Array(await gz.arrayBuffer()))),
    await Deno.readFile(join(LITERT_WASM_DIR, name)),
  );
  const glue = await get("/llm/wasm/litertlm_wasm_internal.js");
  assertEquals(glue.status, 200);
  await glue.body?.cancel();

  // The raw .wasm is not served: the worker fetches only the gzipped form
  // the static build ships. Nor are weights, or anything outside wasm/.
  for (
    const path of [
      `/llm/wasm/${name}`,
      `/llm/${LOCAL_MODELS[0].file}`,
      "/llm/wasm/../../deno.json",
      "/llm/wasm/sub/x.js",
    ]
  ) {
    const response = await get(path);
    assertEquals(response.status, 404, path);
    await response.body?.cancel();
  }
});
