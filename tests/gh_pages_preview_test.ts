// The GitHub Pages preview (.github/workflows/preview-gh-pages.yml): where a
// branch goes (scripts/gh-pages-preview/target.sh), what is published there
// and nothing else (publish.sh), and what a preview build adds to the site
// (scripts/lib/gh_pages_preview.ts) that production never carries.

import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import {
  JUPYTER_SERVICE_WORKER_PLUGIN,
  metaPolicy,
  PREVIEW_FILES,
  PREVIEW_SNAPSHOT_KINDS,
  previewDocument,
  writeGhPagesPreview,
} from "../scripts/lib/gh_pages_preview.ts";
import { cspSources, documentPolicy, inlineScriptHashes } from "../src/csp.ts";
import { ISOLATION_HEADERS } from "../src/serve.ts";

const path = (relative: string) =>
  decodeURIComponent(new URL(relative, import.meta.url).pathname);
const TARGET = path("../scripts/gh-pages-preview/target.sh");
const PUBLISH = path("../scripts/gh-pages-preview/publish.sh");

type Run = { code: number; out: string; err: string };

async function run(
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<Run> {
  const result = await new Deno.Command(args[0], {
    args: args.slice(1),
    cwd,
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      HOME: Deno.env.get("HOME") ?? "/tmp",
      ...env,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  return {
    code: result.code,
    out: text(result.stdout),
    err: text(result.stderr),
  };
}

async function target(ref: string) {
  const t = await run(["bash", TARGET], { INPUT_REF: ref });
  const out: Record<string, string> = {};
  for (const line of t.out.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return { ...t, out };
}

Deno.test("a branch previews in a folder named after it", async () => {
  for (
    const [ref, folder] of [
      [
        "agent/yurt-playground-gh-pages-preview",
        "agent-yurt-playground-gh-pages-preview",
      ],
      ["Fix/Touch_Keys", "fix-touch-keys"],
      ["a_b/--c", "a-b-c"],
      ["x.y_", "x-y"],
    ]
  ) {
    const t = await target(ref);
    assertEquals(t.code, 0, `${ref}: ${t.err}`);
    assertEquals(t.out, { branch: ref, ref: `refs/heads/${ref}`, folder }, ref);
  }
});

Deno.test("main, and what is not a branch, are never previewed", async () => {
  for (
    const ref of [
      "",
      "main",
      "MAIN",
      "refs/heads/main",
      "refs/heads/agent/x",
      "a b",
      "x;rm -rf /",
      "a/.lock",
      "a..",
      "---",
      "$(id)",
    ]
  ) {
    const t = await target(ref);
    assertEquals(t.code, 1, ref);
    assertEquals(t.out, {}, ref);
    assertMatch(t.err, /::error title=No GitHub Pages preview::/, ref);
  }
});

/** A gh-pages branch in a local bare repository, as GitHub has it: the
 * release notes, a CI file and another branch's preview. */
async function pagesRepository(dir: string): Promise<string> {
  const bare = join(dir, "remote.git");
  const seed = join(dir, "seed");
  const git = (args: string[], cwd = seed) =>
    run(["git", ...args], {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    }, cwd);
  await Deno.mkdir(join(seed, "ci/zsh"), { recursive: true });
  await Deno.mkdir(join(seed, "preview/other"), { recursive: true });
  await Deno.writeTextFile(join(seed, "index.html"), "notes\n");
  await Deno.writeTextFile(join(seed, ".nojekyll"), "");
  await Deno.writeTextFile(join(seed, "ci/zsh/SHA256SUMS"), "sums\n");
  await Deno.writeTextFile(join(seed, "preview/other/index.html"), "other\n");
  for (
    const args of [
      ["init", "-q", "-b", "gh-pages"],
      ["add", "-A"],
      ["commit", "-q", "-m", "seed"],
      ["init", "-q", "--bare", bare],
      ["-C", bare, "config", "uploadpack.allowFilter", "true"],
      ["push", "-q", bare, "gh-pages"],
    ]
  ) {
    const r = await git(args);
    assertEquals(r.code, 0, `git ${args.join(" ")}: ${r.err}`);
  }
  return bare;
}

async function pagesTree(bare: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const list = await run([
    "git",
    "-C",
    bare,
    "ls-tree",
    "-r",
    "--name-only",
    "gh-pages",
  ], {});
  for (const name of list.out.trim().split("\n")) {
    files[name] =
      (await run(["git", "-C", bare, "show", `gh-pages:${name}`], {})).out;
  }
  return files;
}

async function publish(
  bare: string,
  dir: string,
  args: string[],
  others = "0",
  env: Record<string, string> = {},
) {
  // gh answers the one question publish.sh asks it: the size of the files
  // outside the preview's folder.
  const bin = join(dir, "bin");
  await Deno.mkdir(bin, { recursive: true });
  await Deno.writeTextFile(join(bin, "gh"), `#!/bin/sh\necho ${others}\n`);
  await Deno.chmod(join(bin, "gh"), 0o755);
  return await run(["bash", PUBLISH, ...args], {
    PATH: `${bin}:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}`,
    GH_TOKEN: "t",
    REPO: "YurtOS/yurt-playground",
    FOLDER: "agent-x",
    BRANCH: "agent/x",
    COMMIT: "c0ffee",
    PAGES_REMOTE: `file://${bare}`,
    ...env,
  }, dir);
}

Deno.test("a preview is published to its folder, and nothing else on gh-pages changes", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const bare = await pagesRepository(dir);
    const before = await pagesTree(bare);
    const site = join(dir, "site");
    await Deno.mkdir(join(site, "jupyter"), { recursive: true });
    await Deno.writeTextFile(join(site, "index.html"), "one\n");
    await Deno.writeTextFile(join(site, "jupyter/index.html"), "lab\n");
    const first = await publish(bare, dir, ["publish", site]);
    assertEquals(first.code, 0, first.err);
    assertEquals(await pagesTree(bare), {
      ...before,
      "preview/agent-x/.preview-branch": "agent/x\n",
      "preview/agent-x/index.html": "one\n",
      "preview/agent-x/jupyter/index.html": "lab\n",
    });
    // Another branch whose name makes the same folder is refused, both
    // ways.
    for (const args of [["publish", site], ["remove"]]) {
      const other = await publish(bare, dir, args, "0", { BRANCH: "agent-x" });
      assertEquals(other.code, 2, other.err);
      assertStringIncludes(other.err, "holds the preview of agent/x");
    }
    // A new publish replaces the folder: a file the new build lacks goes.
    await Deno.remove(join(site, "jupyter"), { recursive: true });
    await Deno.writeTextFile(join(site, "index.html"), "two\n");
    const second = await publish(bare, dir, ["publish", site]);
    assertEquals(second.code, 0, second.err);
    assertEquals(await pagesTree(bare), {
      ...before,
      "preview/agent-x/.preview-branch": "agent/x\n",
      "preview/agent-x/index.html": "two\n",
    });
    const subject = await run(
      ["git", "-C", bare, "log", "-1", "--format=%s", "gh-pages"],
      {},
    );
    assertEquals(subject.out.trim(), "preview: agent/x at c0ffee");
    // Removing it leaves gh-pages as it was.
    const removed = await publish(bare, dir, ["remove"]);
    assertEquals(removed.code, 0, removed.err);
    assertEquals(await pagesTree(bare), before);
    // Removing what is not there is a warning, not a commit.
    const again = await publish(bare, dir, ["remove"]);
    assertEquals(again.code, 0, again.err);
    assertStringIncludes(again.out, "there is no preview at preview/agent-x");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a preview that would take the site past its limit is refused", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const bare = await pagesRepository(dir);
    const before = await pagesTree(bare);
    const site = join(dir, "site");
    await Deno.mkdir(site);
    await Deno.writeTextFile(join(site, "index.html"), "x".repeat(100));
    const refused = await publish(bare, dir, ["publish", site], "950", {
      SITE_LIMIT_BYTES: "1000",
    });
    assertEquals(refused.code, 2, refused.err);
    assertStringIncludes(refused.err, "remove an old preview first");
    assertEquals(await pagesTree(bare), before);
    const fits = await publish(bare, dir, ["publish", site], "900", {
      SITE_LIMIT_BYTES: "1000",
    });
    assertEquals(fits.code, 0, fits.err);
    // A folder name the target script could not have made is refused.
    const bad = await publish(bare, dir, ["remove"], "0", { FOLDER: "../x" });
    assertEquals(bad.code, 2, bad.err);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the isolation worker sends production's isolation headers", async () => {
  const worker = await Deno.readTextFile(
    path("../scripts/gh-pages-preview/isolation-sw.js"),
  );
  for (
    const name of [
      "Cross-Origin-Opener-Policy",
      "Cross-Origin-Embedder-Policy",
      "Cross-Origin-Resource-Policy",
    ] as const
  ) {
    assertStringIncludes(worker, `"${name}": "${ISOLATION_HEADERS[name]}"`);
  }
});

Deno.test("a preview page carries its CSP as a <meta>, without what a <meta> cannot set", async () => {
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><script>boot()</script></head><body></body></html>';
  const out = await previewDocument(html, "/jupyter/lab/index.html", "../../");
  const [hash] = await inlineScriptHashes(html);
  const policy = metaPolicy("/jupyter/lab/index.html", [hash]);
  assertEquals(
    out,
    '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="' +
      policy + '"><script src="../../isolation.js"></script>' +
      '<meta charset="utf-8"><script>boot()</script></head><body></body></html>',
  );
  // Everything _headers would send, but frame-ancestors.
  assertEquals(
    policy,
    documentPolicy("/jupyter/lab/index.html", [hash]).replace(
      "; frame-ancestors 'none'",
      "",
    ),
  );
  assertEquals(cspSources(policy, "script-src").includes(hash), true);
  assertEquals(
    cspSources(policy, "script-src").includes("'unsafe-eval'"),
    true,
  );
  // The home page's policy is the site's: no eval.
  assertEquals(
    cspSources(metaPolicy("/index.html", []), "script-src").includes(
      "'unsafe-eval'",
    ),
    false,
  );
});

Deno.test("a preview build adds the isolation worker to every page and turns off JupyterLite's", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "jupyter/lab"), { recursive: true });
    const page = "<html><head></head><body></body></html>";
    for (
      const file of [
        "index.html",
        "jupyter/index.html",
        "jupyter/lab/index.html",
      ]
    ) {
      await Deno.writeTextFile(join(dir, file), page);
    }
    await Deno.writeTextFile(
      join(dir, "jupyter/jupyter-lite.json"),
      JSON.stringify({
        "jupyter-config-data": {
          appName: "Yurt playground",
          disabledExtensions: ["@jupyterlab/javascript-extension"],
        },
      }),
    );
    await Deno.writeTextFile(join(dir, "_headers"), "/*\n");
    await writeGhPagesPreview(dir);
    for (const file of PREVIEW_FILES) {
      assertEquals(
        await Deno.readTextFile(join(dir, file)),
        await Deno.readTextFile(path(`../scripts/gh-pages-preview/${file}`)),
      );
    }
    for (
      const [file, root] of [
        ["index.html", "./"],
        ["jupyter/index.html", "../"],
        ["jupyter/lab/index.html", "../../"],
      ]
    ) {
      assertStringIncludes(
        await Deno.readTextFile(join(dir, file)),
        `<script src="${root}isolation.js"></script>`,
      );
    }
    assertEquals(
      JSON.parse(
        await Deno.readTextFile(join(dir, "jupyter/jupyter-lite.json")),
      ),
      {
        "jupyter-config-data": {
          appName: "Yurt playground",
          disabledExtensions: [
            "@jupyterlab/javascript-extension",
            JUPYTER_SERVICE_WORKER_PLUGIN,
          ],
        },
      },
    );
    assertEquals(
      await Deno.stat(join(dir, "_headers")).then(() => true, () => false),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a preview publishes the snapshot a desktop Notebook page requires", async () => {
  // src/lite_bridge.ts restores the desktop snapshot with no fallback to
  // the image: a preview without it has no desktop Jupyter kernel.
  const bridge = await Deno.readTextFile(path("../src/lite_bridge.ts"));
  assertStringIncludes(bridge, 'snapshotKind: "desktop" as const');
  assertStringIncludes(bridge, "snapshotRequired: true");
  assertEquals(PREVIEW_SNAPSHOT_KINDS, ["desktop"]);
  const { publishedSnapshotKinds } = await import("../scripts/build-static.ts");
  const { SNAPSHOT_KIND_NAMES } = await import("../src/sandbox_snapshot.ts");
  assertEquals(publishedSnapshotKinds({ ghPagesPreview: true }), ["desktop"]);
  // Production publishes every kind it has.
  assertEquals(publishedSnapshotKinds({}), SNAPSHOT_KIND_NAMES);
  assertEquals(SNAPSHOT_KIND_NAMES.length, 4);
});
