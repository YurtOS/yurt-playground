// The unit-test suite is split across CI jobs so a push waits for the
// longest shard, not for their sum (yurt-playground#123). Every shard pays
// the site-inputs setup (~1m20), so the split is worth it only where a
// shard is minutes long: `python` is one file that boots three sandboxes
// and runs for ~5 minutes on a runner, `guest` is the rest of the
// sandbox-booting files (~2 min), and `fast` is everything else (~10 s).
//
// The shards must cover `tests/*_test.ts` exactly once -- a file in no
// shard would silently stop running (layout_test.ts asserts it).

/** Files named by a shard; `fast` is everything the others do not take. */
export const NAMED_SHARDS: Record<string, string[]> = {
  python: ["python_test.ts"],
  guest: [
    "boot_test.ts",
    "jupyter_test.ts",
    "notebook_kernel_test.ts",
    "stage_test.ts",
    "vi_test.ts",
  ],
};

/** The shard that takes whatever the named ones do not. The workflow's
 * `deno check` step rides it, and `layout_test.ts` asserts that the step's
 * condition names this shard, so renaming it cannot leave the type check
 * silently unrun (#123 review). */
export const CATCH_ALL_SHARD = "fast";

export const SHARDS = [...Object.keys(NAMED_SHARDS), CATCH_ALL_SHARD];

/** Where the suite lives, resolved from this file and not from the process's
 * working directory: a run from anywhere but the repository root would
 * otherwise find nothing (#123 review). */
export const TESTS_ROOT = new URL("../tests", import.meta.url).pathname;

/** Every `*_test.ts` under `root`, recursively, relative to it. Recursive
 * because `deno test` with no arguments discovers nested files too, so a
 * flat listing would drop `tests/sub/foo_test.ts` from every shard -- and
 * the coverage assertion could not see it either (#123 review). */
export async function allTestFiles(root = TESTS_ROOT): Promise<string[]> {
  const names: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory) {
        await walk(`${dir}/${entry.name}`, `${prefix}${entry.name}/`);
      } else if (entry.isFile && entry.name.endsWith("_test.ts")) {
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
  root = TESTS_ROOT,
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
  console.log((await filesFor(shard)).join(" "));
}
