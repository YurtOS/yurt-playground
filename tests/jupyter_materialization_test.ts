import { assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import { canonicalTreeTar } from "../scripts/canonical-tree-tar.ts";
import { materializeJupyter } from "../scripts/materialize-jupyter.ts";
import { sha256Bytes } from "../scripts/materialize-jupyter.ts";
import { updateLockHash } from "../scripts/update-jupyter-lock-hash.ts";

const REV = "c30f1073c244aab166c67dc3b9b1ff1048def0d4";
const VALID_LOCK = JSON.stringify({
  yurtJupyterRev: REV,
  payloadTreeSha256: "0".repeat(64),
  packages: [{
    name: "example",
    version: "1.0.0",
    sha256: "0".repeat(64),
  }],
});

async function withTempDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "yurt-jupyter-materialize-" });
  try {
    return await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("the lock hash generator writes the staged tree's hash", async () => {
  await withTempDir(async (root) => {
    const lockPath = `${root}/requirements.lock`;
    await Deno.writeTextFile(lockPath, VALID_LOCK);
    const stage = `${root}/yurt-jupyter/stage`;
    await Deno.mkdir(`${stage}/usr/local/lib/python3.14/site-packages`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${stage}/usr/local/lib/python3.14/site-packages/ipykernel.py`,
      "x",
    );
    const written = await updateLockHash(lockPath, `${root}/yurt-jupyter`);
    const expected = await sha256Bytes(await canonicalTreeTar(stage));
    assertEquals(written, expected);
    const lock = JSON.parse(await Deno.readTextFile(lockPath));
    assertEquals(lock.payloadTreeSha256, expected);
    // The rest of the lock survives the rewrite.
    assertEquals(lock.packages.length, JSON.parse(VALID_LOCK).packages.length);
  });
});

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
    await Deno.writeTextFile(
      `${root}/requirements.lock`,
      VALID_LOCK,
    );
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

Deno.test("materializer accepts any CPython 3.14 patch release", async () => {
  // setup-python resolves "3.14" to the newest patch (3.14.7 today), and the
  // guest CPython in yurt-ports is 3.14.4. Only the minor version has to match:
  // the payload is pure Python staged under python3.14.
  await withTempDir(async (root) => {
    await Deno.writeTextFile(`${root}/requirements.lock`, VALID_LOCK);
    const stub = `${root}/python-3.14.7`;
    await Deno.writeTextFile(
      stub,
      "#!/bin/sh\necho 'cpython (3, 14, 7) x86_64'\n",
    );
    await Deno.chmod(stub, 0o755);
    const failure = await materializeJupyter({
      repoRoot: root,
      lockPath: `${root}/requirements.lock`,
      python: stub,
      outputDir: `${root}/out`,
    }).then(() => undefined, (error: unknown) => String(error));
    // It still fails — there is no yurt-jupyter checkout here — but never on
    // the interpreter version.
    assertEquals(failure?.includes("requires CPython"), false);
  });
});

Deno.test("materializer requires the pinned yurt-jupyter revision", async () => {
  await withTempDir(async (root) => {
    await Deno.writeTextFile(
      `${root}/requirements.lock`,
      VALID_LOCK,
    );
    const fakePython = `${root}/python3.14`;
    await Deno.writeTextFile(
      fakePython,
      '#!/bin/sh\nif [ "$1" = "-c" ]; then echo "cpython (3, 14, 0) x86_64"; fi\n',
    );
    await Deno.chmod(fakePython, 0o755);
    await assertRejects(
      () =>
        materializeJupyter({
          repoRoot: root,
          lockPath: `${root}/requirements.lock`,
          python: fakePython,
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
      VALID_LOCK,
    );
    await Deno.mkdir(`${root}/yurt-jupyter`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/yurt-jupyter/REVISION`,
      "c30f1073c244aab166c67dc3b9b1ff1048def0d4\n",
    );
    await Deno.mkdir(`${root}/yurt-jupyter/site-packages/zmq`, {
      recursive: true,
    });
    const fakePython = `${root}/python3.14`;
    await Deno.writeTextFile(
      fakePython,
      '#!/bin/sh\nif [ "$1" = "-c" ]; then echo "cpython (3, 14, 0) x86_64"; fi\n',
    );
    await Deno.chmod(fakePython, 0o755);
    await assertRejects(
      () =>
        materializeJupyter({
          repoRoot: root,
          lockPath: `${root}/requirements.lock`,
          python: fakePython,
          outputDir: `${root}/out`,
        }),
      Error,
      "zmq",
    );
  });
});

Deno.test("materializer allows a nested path merely named psutil", async () => {
  // The real payload carries two of these: jedi ships typeshed stubs under
  // .../jedi/third_party/typeshed/stubs/psutil/, and the staging script
  // deliberately installs usr/share/yurt-jupyter/psutil.py as the shim that
  // shadows the guest package. Neither duplicates a site-packages module.
  await withTempDir(async (root) => {
    await Deno.writeTextFile(`${root}/requirements.lock`, VALID_LOCK);
    await Deno.mkdir(`${root}/yurt-jupyter`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/yurt-jupyter/REVISION`,
      "c30f1073c244aab166c67dc3b9b1ff1048def0d4\n",
    );
    const site =
      `${root}/yurt-jupyter/stage/usr/local/lib/python3.14/site-packages`;
    await Deno.mkdir(
      `${site}/jedi/third_party/typeshed/stubs/psutil/psutil`,
      { recursive: true },
    );
    await Deno.writeTextFile(
      `${site}/jedi/third_party/typeshed/stubs/psutil/psutil/__init__.pyi`,
      "",
    );
    await Deno.mkdir(`${root}/yurt-jupyter/stage/usr/share/yurt-jupyter`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${root}/yurt-jupyter/stage/usr/share/yurt-jupyter/psutil.py`,
      "",
    );
    const fakePython = `${root}/python3.14`;
    await Deno.writeTextFile(
      fakePython,
      '#!/bin/sh\nif [ "$1" = "-c" ]; then echo "cpython (3, 14, 0) x86_64"; fi\n',
    );
    await Deno.chmod(fakePython, 0o755);
    const failure = await materializeJupyter({
      repoRoot: root,
      lockPath: `${root}/requirements.lock`,
      python: fakePython,
      outputDir: `${root}/out`,
    }).then(() => undefined, (error: unknown) => String(error));
    // It still fails on the lock hashes; it must not fail on psutil.
    assertEquals(failure?.includes("forbidden package"), false);
  });
});

Deno.test("materializer copies only a payload matching every lock hash", async () => {
  await withTempDir(async (root) => {
    const stage = join(root, "yurt-jupyter/stage");
    const dist = join(
      stage,
      "usr/local/lib/python3.14/site-packages/example-1.0.0.dist-info",
    );
    await Deno.mkdir(dist, { recursive: true });
    await Deno.writeTextFile(
      join(dist, "METADATA"),
      "Name: example\nVersion: 1.0.0\n",
    );
    const launcher = join(stage, "usr/share/yurt-jupyter/launcher.py");
    await Deno.mkdir(join(stage, "usr/share/yurt-jupyter"), {
      recursive: true,
    });
    await Deno.writeTextFile(launcher, "#!/usr/bin/env python3\n");
    await Deno.chmod(launcher, 0o755);
    const packageSha256 = await sha256Bytes(await canonicalTreeTar(dist));
    const payloadTreeSha256 = await sha256Bytes(await canonicalTreeTar(stage));
    await Deno.writeTextFile(join(root, "yurt-jupyter/REVISION"), `${REV}\n`);
    await Deno.writeTextFile(
      join(root, "requirements.lock"),
      JSON.stringify({
        yurtJupyterRev: REV,
        payloadTreeSha256,
        packages: [{
          name: "example",
          version: "1.0.0",
          sha256: packageSha256,
        }],
      }),
    );
    const python = join(root, "python3.14");
    await Deno.writeTextFile(
      python,
      '#!/bin/sh\nif [ "$1" = "-c" ]; then echo "cpython (3, 14, 0) x86_64"; fi\n',
    );
    await Deno.chmod(python, 0o755);

    const result = await materializeJupyter({
      repoRoot: root,
      lockPath: join(root, "requirements.lock"),
      python,
      outputDir: join(root, "out"),
    });
    if (result.treeSha256 !== payloadTreeSha256) {
      throw new Error("materializer returned a different payload digest");
    }
    assertEquals(
      await Deno.readTextFile(
        join(
          root,
          "out/usr/local/lib/python3.14/site-packages/example-1.0.0.dist-info/METADATA",
        ),
      ),
      "Name: example\nVersion: 1.0.0\n",
    );
    assertEquals(
      (await Deno.stat(join(root, "out/usr/share/yurt-jupyter/launcher.py")))
        .mode! & 0o111,
      0o111,
    );
    await Deno.writeTextFile(join(stage, "tampered.py"), "changed\n");
    await assertRejects(
      () =>
        materializeJupyter({
          repoRoot: root,
          lockPath: join(root, "requirements.lock"),
          python,
          outputDir: join(root, "out-tampered"),
        }),
      Error,
      "tree hash",
    );
  });
});
