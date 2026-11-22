import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";

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

type LiteBuild = {
  /** Runs build.sh from the scratch root, into public/jupyter by default. */
  build: (
    env?: Record<string, string>,
    args?: string[],
  ) => Promise<Deno.CommandOutput>;
  /** The built site's jupyter-lite.json, or undefined if there is none. */
  built: () => Promise<
    { "jupyter-config-data": { disabledExtensions?: string[] } } | undefined
  >;
  /** The scratch root build.sh runs from. */
  root: string;
};

/** Runs `fn` against a copy of jupyterlite/build.sh in a scratch tree, with
 *  `npm` and `jupyter` stubbed beside JUPYTERLITE_PYTHON. The stub
 *  `jupyter lite build` behaves like doit: it applies jupyter-lite.json only
 *  when no .jupyterlite.doit.db is left from an earlier build. */
async function withLiteBuild(fn: (lite: LiteBuild) => Promise<void>) {
  const root = await Deno.makeTempDir();
  try {
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
    const stubs: Record<string, string> = {
      python3: 'exec python3 "$@"',
      npm: "mkdir -p yurt_jupyterlite_kernel/labextension",
      jupyter: [
        'out="$4"; mkdir -p "$out"',
        'if [ -e .jupyterlite.doit.db ] || [ -n "${STUB_DROP_CONFIG:-}" ]; then',
        `  echo '{"jupyter-config-data": {}}' > "$out/jupyter-lite.json"`,
        "else",
        '  cp jupyter-lite.json "$out/jupyter-lite.json"',
        "fi",
        "touch .jupyterlite.doit.db",
        'if [ -n "${STUB_FAIL:-}" ]; then exit 1; fi',
      ].join("\n"),
    };
    for (const [name, body] of Object.entries(stubs)) {
      await Deno.writeTextFile(`${bin}/${name}`, `#!/bin/sh\n${body}\n`);
      await Deno.chmod(`${bin}/${name}`, 0o755);
    }
    await fn({
      root,
      build: (env = {}, args = []) =>
        new Deno.Command(`${here}/build.sh`, {
          args,
          cwd: root,
          // bin/ is not on PATH, so the python3 stub execs the real one.
          clearEnv: true,
          env: {
            JUPYTERLITE_PYTHON: `${bin}/python3`,
            PATH: Deno.env.get("PATH") ?? "",
            ...env,
          },
          stdout: "null",
          stderr: "piped",
        }).output(),
      built: async () => {
        try {
          return JSON.parse(
            await Deno.readTextFile(`${root}/public/jupyter/jupyter-lite.json`),
          );
        } catch (e) {
          if (e instanceof Deno.errors.NotFound) return undefined;
          throw e;
        }
      },
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const wantedDisabled = async () =>
  JSON.parse(
    await Deno.readTextFile(
      new URL("../jupyterlite/jupyter-lite.json", import.meta.url),
    ),
  )["jupyter-config-data"].disabledExtensions;

Deno.test("a rebuild over a stale doit database keeps the disabled extensions", async () => {
  // The doit database marks the config patch up to date, so an incremental
  // rebuild ships a site without our config (#372).
  await withLiteBuild(async (lite) => {
    for (let i = 0; i < 2; i++) {
      const out = await lite.build();
      assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
    }
    assertEquals(
      (await lite.built())?.["jupyter-config-data"].disabledExtensions,
      await wantedDisabled(),
    );
  });
});

for (
  const [what, env] of [
    ["lacks the disabled extensions", { STUB_DROP_CONFIG: "1" }],
    ["fails partway", { STUB_FAIL: "1" }],
  ] as const
) {
  Deno.test(`build.sh fails and leaves no site when the build ${what}`, async () => {
    await withLiteBuild(async (lite) => {
      assertEquals((await lite.build()).code, 0);
      const out = await lite.build(env);
      assertEquals(out.success, false);
      if ("STUB_DROP_CONFIG" in env) {
        assertStringIncludes(
          new TextDecoder().decode(out.stderr),
          "lacks disabledExtensions",
        );
      }
      // Nothing under the served tree, not even a staging copy.
      assertEquals(
        await Array.fromAsync(
          Deno.readDir(`${lite.root}/public`),
          (e) => e.name,
        ),
        [],
      );
    });
  });
}

Deno.test("a `.` output dir fails the build and deletes nothing", async () => {
  // rm refuses `.`, so the argument must reach it as given.
  await withLiteBuild(async (lite) => {
    assertEquals((await lite.build({}, ["."])).success, false);
    await Deno.stat(`${lite.root}/jupyterlite/jupyter-lite.json`);
    await Deno.stat(`${lite.root}/bin/jupyter`);
  });
});
