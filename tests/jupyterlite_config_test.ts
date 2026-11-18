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

Deno.test("no output renderer that fetches a URL the notebook names is loaded", async () => {
  // The page's policy allows its own origin, so a renderer in the page that
  // fetches what a notebook names makes the page do it (follow-up to #360):
  // - @jupyterlab/vega5-extension fetches a Vega or Vega-Lite spec's
  //   `data.url`; its output falls back to the bundle's image or text.
  // - @jupyterlab/mermaid-extension lays diagrams out in the page, where an
  //   image node or a label's <img> loads; Mermaid fences in Markdown show as
  //   code and `text/vnd.mermaid` output falls back to its text.
  const config = JSON.parse(
    await Deno.readTextFile(
      new URL("../jupyterlite/jupyter-lite.json", import.meta.url),
    ),
  );
  for (
    const name of [
      "@jupyterlab/vega5-extension",
      "@jupyterlab/mermaid-extension",
    ]
  ) {
    assertEquals(
      config["jupyter-config-data"].disabledExtensions?.includes(name),
      true,
      name,
    );
  }
});
