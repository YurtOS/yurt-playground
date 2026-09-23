import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { LOCAL_MODELS } from "../src/llm_models.ts";
import { availableModels } from "../src/serve.ts";

Deno.test("scripts/fetch-llm.sh pins the models src/llm_models.ts names", async () => {
  const script = await Deno.readTextFile(
    new URL("../scripts/fetch-llm.sh", import.meta.url),
  );
  for (const model of LOCAL_MODELS) {
    assert(
      script.includes(`${model.id}) echo "${model.commit} ${model.sha256}"`),
      `${model.id} pin differs between the script and src/llm_models.ts`,
    );
    assertEquals(model.file, `gemma-4-${model.id}-it-web.litertlm`);
  }
});

Deno.test("a model is available only when its file has the pinned size", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await availableModels(dir), []);
    const [model] = LOCAL_MODELS;
    // A partial download is not a model.
    await Deno.writeFile(join(dir, model.file), new Uint8Array(10));
    assertEquals(await availableModels(dir), []);
    const file = await Deno.open(join(dir, model.file), { write: true });
    await file.truncate(model.bytes); // sparse: no gigabytes written
    file.close();
    assertEquals(await availableModels(dir), [model.id]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
