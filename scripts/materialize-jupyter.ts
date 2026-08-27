#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run

import { basename, dirname, join, relative, resolve } from "node:path";
import { canonicalTreeTar } from "./canonical-tree-tar.ts";

export type MaterializeJupyterOptions = {
  repoRoot: string;
  lockPath: string;
  python: string;
  outputDir: string;
};

export type MaterializedJupyter = {
  treeSha256: string;
  packagePath: string;
};

type Lock = {
  yurtJupyterRev: string;
  payloadTreeSha256: string;
  packages: Array<{ name: string; version: string; sha256: string }>;
};

const YURT_JUPYTER_REV = "c30f1073c244aab166c67dc3b9b1ff1048def0d4";

export async function materializeJupyter(
  options: MaterializeJupyterOptions,
): Promise<MaterializedJupyter> {
  const lock = await readLock(options.lockPath);
  await verifyInterpreter(options.python);
  if (lock.yurtJupyterRev !== YURT_JUPYTER_REV) {
    throw new Error(
      `yurt-jupyter revision ${lock.yurtJupyterRev} is not pinned to ${YURT_JUPYTER_REV}`,
    );
  }

  const jupyterRoot = findJupyterRoot(options.repoRoot);
  const revision = await jupyterRevision(jupyterRoot);
  if (revision !== YURT_JUPYTER_REV) {
    throw new Error(`yurt-jupyter revision marker is missing or mismatched`);
  }

  const source = await existingPayloadRoot(jupyterRoot);
  rejectForbiddenPackages(source);
  await verifyLockedPayload(source, lock);
  await Deno.remove(options.outputDir, { recursive: true }).catch(() => {});
  await copyTree(source, options.outputDir);
  const tar = await canonicalTreeTar(options.outputDir);
  const treeSha256 = await sha256Bytes(tar);
  return {
    treeSha256,
    packagePath: relative(
      resolve(options.repoRoot),
      resolve(options.outputDir),
    ),
  };
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function readLock(path: string): Promise<Lock> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch {
    throw new Error(`Jupyter dependency lock is missing: ${path}`);
  }
  try {
    const parsed = JSON.parse(raw) as Lock;
    if (
      !parsed.yurtJupyterRev ||
      !/^[0-9a-f]{64}$/.test(parsed.payloadTreeSha256) ||
      !Array.isArray(parsed.packages) ||
      parsed.packages.length === 0
    ) {
      throw new Error("invalid lock shape");
    }
    const names = new Set<string>();
    for (const packagePin of parsed.packages) {
      if (
        typeof packagePin.name !== "string" ||
        typeof packagePin.version !== "string" ||
        !/^[0-9a-f]{64}$/.test(packagePin.sha256) ||
        names.has(packagePin.name.toLowerCase())
      ) {
        throw new Error("invalid package lock entry");
      }
      names.add(packagePin.name.toLowerCase());
    }
    return parsed;
  } catch {
    throw new Error(`Jupyter dependency lock is invalid: ${path}`);
  }
}

async function verifyLockedPayload(root: string, lock: Lock): Promise<void> {
  const actualTreeSha256 = await sha256Bytes(await canonicalTreeTar(root));
  if (actualTreeSha256 !== lock.payloadTreeSha256) {
    throw new Error(
      `Jupyter payload tree hash mismatch: got ${actualTreeSha256}, ` +
        `lock ${lock.payloadTreeSha256}. The lock hashes the staged tree, which ` +
        `is only reproducible from the interpreter that built it — pip writes ` +
        `interpreter-dependent dist-info, so check the host Python patch.`,
    );
  }
  const metadata = new Map<string, { version: string; root: string }>();
  for (const entry of walk(root)) {
    if (!entry.endsWith(".dist-info/METADATA")) continue;
    const text = await Deno.readTextFile(entry);
    const name = text.match(/^Name:\s*(.+)$/mi)?.[1]?.trim();
    const version = text.match(/^Version:\s*(.+)$/mi)?.[1]?.trim();
    if (!name || !version) {
      throw new Error(`invalid package metadata: ${entry}`);
    }
    metadata.set(name.toLowerCase(), {
      version,
      root: entry.slice(0, -"/METADATA".length),
    });
  }
  if (metadata.size !== lock.packages.length) {
    throw new Error(
      `locked package count ${lock.packages.length} does not match payload ${metadata.size}`,
    );
  }
  for (const packagePin of lock.packages) {
    const actual = metadata.get(packagePin.name.toLowerCase());
    if (actual === undefined) {
      throw new Error(`locked package is missing: ${packagePin.name}`);
    }
    if (actual.version !== packagePin.version) {
      throw new Error(
        `locked package version mismatch for ${packagePin.name}: got ${actual.version}, lock ${packagePin.version}`,
      );
    }
    const actualSha256 = await sha256Bytes(
      await canonicalTreeTar(actual.root),
    );
    if (actualSha256 !== packagePin.sha256) {
      throw new Error(
        `locked package hash mismatch for ${packagePin.name}: got ${actualSha256}, lock ${packagePin.sha256}`,
      );
    }
  }
}

async function verifyInterpreter(python: string): Promise<void> {
  let output: string;
  try {
    const command = new Deno.Command(python, {
      args: [
        "-c",
        "import platform,sys; print(sys.implementation.name, sys.version_info[:3], platform.machine())",
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    output = new TextDecoder().decode(result.stdout);
    if (!result.success) {
      throw new Error(new TextDecoder().decode(result.stderr));
    }
  } catch (error) {
    throw new Error(
      `unable to execute pinned Python 3.14 interpreter: ${error}`,
    );
  }
  // The minor version is what has to match: the payload is pure Python staged
  // under python3.14, the guest CPython is 3.14.x, and setup-python resolves
  // "3.14" to whatever patch is newest. Pinning a patch here pinned nothing
  // real and broke CI the day the runner moved off 3.14.0.
  if (
    !/cpython\s*\(3,\s*14,\s*\d+\)/i.test(output) &&
    !/cpython\s+3\.14\.\d+/i.test(output)
  ) {
    throw new Error(
      `materializer requires CPython 3.14.x, got: ${output.trim()}`,
    );
  }
  if (!/x86_64|amd64/i.test(output)) {
    throw new Error(
      `materializer requires x86_64 Python, got: ${output.trim()}`,
    );
  }
}

function findJupyterRoot(repoRoot: string): string {
  const candidates = [
    Deno.env.get("YURT_JUPYTER_ROOT"),
    join(repoRoot, "yurt-jupyter"),
    join(repoRoot, "..", "yurt-jupyter"),
  ].filter((value): value is string => value !== undefined);
  for (const candidate of candidates) {
    try {
      if (Deno.statSync(candidate).isDirectory) return candidate;
    } catch {
      // continue
    }
  }
  throw new Error("yurt-jupyter checkout is missing");
}

async function existingPayloadRoot(root: string): Promise<string> {
  for (const candidate of [join(root, "stage"), join(root, "site-packages")]) {
    try {
      if ((await Deno.stat(candidate)).isDirectory) return candidate;
    } catch {
      // continue
    }
  }
  throw new Error("yurt-jupyter staged payload is missing");
}

const FORBIDDEN_PACKAGES = /^(zmq|psutil)(-.*\.dist-info)?$/;

function rejectForbiddenPackages(root: string): void {
  for (const entry of walk(root)) {
    if (entry.endsWith(".so") || entry.endsWith(".dylib")) {
      throw new Error(
        `yurt-jupyter payload contains compiled extension ${entry}`,
      );
    }
    // Only an importable top-level module duplicates what the guest provides.
    // Matching the basename at any depth also rejected jedi's typeshed stubs
    // (.../jedi/third_party/typeshed/stubs/psutil) and the psutil.py shim the
    // staging script installs on purpose.
    if (
      basename(dirname(entry)) === "site-packages" &&
      FORBIDDEN_PACKAGES.test(basename(entry))
    ) {
      throw new Error(
        `yurt-jupyter payload duplicates forbidden package ${entry}`,
      );
    }
  }
}

function* walk(root: string): Generator<string> {
  for (const entry of Deno.readDirSync(root)) {
    const path = join(root, entry.name);
    yield path;
    if (entry.isDirectory) yield* walk(path);
  }
}

async function copyTree(source: string, destination: string): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory) await copyTree(from, to);
    else if (entry.isFile) {
      await Deno.copyFile(from, to);
      const info = await Deno.stat(from);
      await Deno.chmod(to, (info.mode ?? 0o644) & 0o777);
    } else throw new Error(`unsupported payload entry: ${from}`);
  }
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function jupyterRevision(root: string): Promise<string | undefined> {
  const marker = await readOptionalText(join(root, "REVISION"));
  if (marker !== undefined) return marker.trim();
  const result = await new Deno.Command("git", {
    args: ["-C", root, "rev-parse", "HEAD"],
    stdout: "piped",
    stderr: "null",
  }).output();
  return result.success
    ? new TextDecoder().decode(result.stdout).trim()
    : undefined;
}

if (import.meta.main) {
  const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
  const result = await materializeJupyter({
    repoRoot,
    lockPath: join(repoRoot, "artifacts/jupyter-requirements.lock"),
    python: Deno.env.get("HOST_PYTHON") ?? "python3.14",
    outputDir: join(repoRoot, "artifacts/jupyter-site-packages"),
  });
  console.log(JSON.stringify(result));
}
