// The test suite is split across CI jobs so a push waits for the longest
// shard, not for their sum (yurt-playground#123). Every shard pays the
// site-inputs setup (~1m20), so the split is worth it only where a shard is
// minutes long: `python` is one file that boots three sandboxes and runs for
// ~5 minutes on a runner, `guest` is the rest of the sandbox-booting files
// (~2 min), and `fast` is everything else (~10 s).
//
// The shards must cover what `deno test` discovers exactly once -- a file in
// no shard would silently stop running, which `layout_test.ts` asserts
// against.

/** Files named by a shard, relative to the repository root; `fast` is
 * everything the others do not take. */
export const NAMED_SHARDS: Record<string, string[]> = {
  python: ["tests/python_test.ts"],
  // `jupyter_test.ts` is deliberately absent: since its two production
  // backoffs were fixed it is a 16 ms unit test and belongs with the fast
  // ones (#123 review).
  guest: [
    "tests/boot_test.ts",
    "tests/notebook_kernel_test.ts",
    "tests/stage_test.ts",
    "tests/vi_test.ts",
  ],
};

/** The shard that takes whatever the named ones do not. The workflow's
 * `deno check` step rides it, and `layout_test.ts` asserts that the step's
 * condition names this shard, so renaming it cannot leave the type check
 * silently unrun (#123 review). */
export const CATCH_ALL_SHARD = "fast";

export const SHARDS = [...Object.keys(NAMED_SHARDS), CATCH_ALL_SHARD];

/** The repository root, resolved from this file rather than the process's
 * working directory, so the suite runs from anywhere. Decoded: a checkout
 * path containing a space comes back percent-encoded from `URL.pathname`
 * and `readDir` then throws on a path the developer does not have (#123
 * review). */
export const REPO_ROOT = decodeURIComponent(
  new URL("..", import.meta.url).pathname,
).replace(/\/$/, "");

/** `deno test`'s own filename patterns. Matching only `*_test.ts` under
 * `tests/` would drop `src/x.test.ts` out of every shard *and* out of the
 * coverage assertion, which is the silent-drop this file exists to prevent
 * (#123 review). */
function isTestFile(name: string): boolean {
  return name.endsWith("_test.ts") || name.endsWith(".test.ts") ||
    name === "test.ts";
}

/** What `deno.json` keeps out of the suite; the same list `deno test` obeys. */
async function excluded(root: string): Promise<string[]> {
  const text = await Deno.readTextFile(`${root}/deno.json`);
  const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
  return ((config.exclude ?? []) as string[]).map((e) => `${root}/${e}`);
}

/** Every test file `deno test` would run, as paths relative to the root. */
export async function allTestFiles(root = REPO_ROOT): Promise<string[]> {
  const skip = await excluded(root);
  const names: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    if (skip.some((e) => dir === e || dir.startsWith(`${e}/`))) return;
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) {
          continue;
        }
        await walk(path, `${prefix}${entry.name}/`);
      } else if (
        entry.isFile && isTestFile(entry.name) && !skip.includes(path)
      ) {
        names.push(`${prefix}${entry.name}`);
      }
    }
  };
  await walk(root, "");
  return names.sort();
}

/** The files one shard runs, as paths `deno test` takes. */
export async function filesFor(
  shard: string,
  root = REPO_ROOT,
): Promise<string[]> {
  const named = NAMED_SHARDS[shard];
  const all = await allTestFiles(root);
  const taken = new Set(Object.values(NAMED_SHARDS).flat());
  const names = named ?? all.filter((name) => !taken.has(name));
  return names.map((name) => `${root}/${name}`);
}

if (import.meta.main) {
  const shard = Deno.args[0];
  if (shard === undefined || !SHARDS.includes(shard)) {
    console.error(`usage: ci-shards.ts <${SHARDS.join("|")}>`);
    Deno.exit(2);
  }
  const files = await filesFor(shard);
  // An empty shard would otherwise print a blank line, which the workflow
  // cannot tell from "no files" -- and `deno test ""` runs everything.
  if (files.length === 0) {
    console.error(`shard ${shard} matched no test files`);
    Deno.exit(3);
  }
  console.log(files.join(" "));
}
