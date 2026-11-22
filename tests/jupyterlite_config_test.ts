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
  // fetches what a notebook names makes the page do it:
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

/** Runs a copy of jupyterlite/build.sh in a scratch tree, with `npm` and
 *  `jupyter` stubbed beside JUPYTERLITE_PYTHON. The stub `jupyter lite build`
 *  behaves like doit: it applies jupyter-lite.json only when no
 *  .jupyterlite.doit.db is left from an earlier build. */
async function liteBuildFixture() {
  const root = await Deno.makeTempDir();
  const here = `${root}/jupyterlite`;
  const bin = `${root}/bin`;
  await Deno.mkdir(`${here}/yurt-kernel/node_modules`, { recursive: true });
  await Deno.mkdir(bin);
  for (const name of ["build.sh", "jupyter-lite.json"]) {
    await Deno.copyFile(
      new URL(`../jupyterlite/${name}`, import.meta.url),
      `${here}/${name}`,
    );
  }
  await Deno.chmod(`${here}/build.sh`, 0o755);
  await Deno.symlink(
    new TextDecoder().decode(
      (await new Deno.Command("sh", { args: ["-c", "command -v python3"] })
        .output()).stdout,
    ).trim(),
    `${bin}/python`,
  );
  const stubs: Record<string, string> = {
    npm: "mkdir -p yurt_jupyterlite_kernel/labextension",
    jupyter: [
      'out="$4"; mkdir -p "$out"',
      'if [ -e .jupyterlite.doit.db ] || [ -n "${STUB_DROP_CONFIG:-}" ]; then',
      `  echo '{"jupyter-config-data": {}}' > "$out/jupyter-lite.json"`,
      "else",
      '  cp jupyter-lite.json "$out/jupyter-lite.json"',
      "fi",
      "touch .jupyterlite.doit.db",
    ].join("\n"),
  };
  for (const [name, body] of Object.entries(stubs)) {
    await Deno.writeTextFile(`${bin}/${name}`, `#!/bin/sh\n${body}\n`);
    await Deno.chmod(`${bin}/${name}`, 0o755);
  }
  const build = (env: Record<string, string> = {}) =>
    new Deno.Command(`${here}/build.sh`, {
      args: [`${root}/out`],
      env: { JUPYTERLITE_PYTHON: `${bin}/python`, ...env },
      stdout: "null",
      stderr: "null",
    }).output();
  const disabled = async () =>
    JSON.parse(await Deno.readTextFile(`${root}/out/jupyter-lite.json`))[
      "jupyter-config-data"
    ].disabledExtensions;
  return { root, build, disabled };
}

Deno.test("a rebuild over a stale doit database keeps the disabled extensions", async () => {
  // The doit database marks the config patch up to date, so an incremental
  // rebuild ships a site without our config (#372).
  const fixture = await liteBuildFixture();
  try {
    assertEquals((await fixture.build()).code, 0);
    assertEquals((await fixture.build()).code, 0);
    assertEquals(
      await fixture.disabled(),
      JSON.parse(
        await Deno.readTextFile(
          new URL("../jupyterlite/jupyter-lite.json", import.meta.url),
        ),
      )["jupyter-config-data"].disabledExtensions,
    );
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});

Deno.test("build.sh fails when the built site lacks the disabled extensions", async () => {
  const fixture = await liteBuildFixture();
  try {
    const out = await fixture.build({ STUB_DROP_CONFIG: "1" });
    assertEquals(out.success, false);
  } finally {
    await Deno.remove(fixture.root, { recursive: true });
  }
});
