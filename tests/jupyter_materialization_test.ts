import { assertRejects } from "@std/assert";
import { materializeJupyter } from "../scripts/materialize-jupyter.ts";

async function withTempDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "yurt-jupyter-materialize-" });
  try {
    return await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("materializer rejects a missing lock file", async () => {
  await withTempDir(async (root) => {
    await assertRejects(
      () =>
        materializeJupyter({
          repoRoot: root,
          lockPath: `${root}/missing.lock`,
          python: "python3.14",
          outputDir: `${root}/out`,
        }),
      Error,
      "lock",
    );
  });
});

Deno.test("materializer rejects a non-CPython 3.14 interpreter", async () => {
  await withTempDir(async (root) => {
    await Deno.writeTextFile(`${root}/requirements.lock`, "");
    await assertRejects(
      () =>
        materializeJupyter({
          repoRoot: root,
          lockPath: `${root}/requirements.lock`,
          python: Deno.execPath(),
          outputDir: `${root}/out`,
        }),
      Error,
      "3.14",
    );
  });
});

Deno.test("materializer requires the pinned yurt-jupyter revision", async () => {
  await withTempDir(async (root) => {
    await Deno.writeTextFile(`${root}/requirements.lock`, "");
    await assertRejects(
      () =>
        materializeJupyter({
          repoRoot: root,
          lockPath: `${root}/requirements.lock`,
          python: "python3.14",
          outputDir: `${root}/out`,
        }),
      Error,
      "yurt-jupyter",
    );
  });
});

Deno.test("materializer rejects duplicate compiled-package trees", async () => {
  await withTempDir(async (root) => {
    await Deno.writeTextFile(
      `${root}/requirements.lock`,
      "yurt-jupyter-rev = c30f1073c244aab166c67dc3b9b1ff1048def0d4\n",
    );
    await Deno.mkdir(`${root}/yurt-jupyter`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/yurt-jupyter/REVISION`,
      "c30f1073c244aab166c67dc3b9b1ff1048def0d4\n",
    );
    await Deno.mkdir(`${root}/yurt-jupyter/site-packages/zmq`, {
      recursive: true,
    });
    await assertRejects(
      () =>
        materializeJupyter({
          repoRoot: root,
          lockPath: `${root}/requirements.lock`,
          python: "python3.14",
          outputDir: `${root}/out`,
        }),
      Error,
      "zmq",
    );
  });
});
