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

export const SHARDS = [...Object.keys(NAMED_SHARDS), "fast"];

/** Every `tests/*_test.ts`, as the shards name them (basenames). */
export async function allTestFiles(root = "tests"): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (entry.isFile && entry.name.endsWith("_test.ts")) names.push(entry.name);
  }
  return names.sort();
}

/** The files one shard runs, as paths `deno test` takes. */
export async function filesFor(
  shard: string,
  root = "tests",
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
