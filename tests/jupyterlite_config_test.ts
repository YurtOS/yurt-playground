import { assertEquals } from "@std/assert";

Deno.test("the JavaScript output renderer is disabled in JupyterLite", async () => {
  // @jupyterlab/javascript-extension evals application/javascript outputs of a
  // trusted cell in the page's origin, and the guest controls every output
  // (yurt-sandbox#382). The /jupyter/* CSP needs 'unsafe-eval' for ajv, so the
  // CSP does not stop it; the extension must not load.
  const config = JSON.parse(
    await Deno.readTextFile(
      new URL("../jupyterlite/jupyter-lite.json", import.meta.url),
    ),
  );
  assertEquals(
    config["jupyter-config-data"].disabledExtensions?.includes(
      "@jupyterlab/javascript-extension",
    ),
    true,
  );
});
