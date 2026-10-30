// Is a pull request Markdown-only? (YurtOS/yurt-sandbox#367: such a pull
// request runs only fmt / lint.) ci.yml's `checks` job pipes the pull
// request's files into this script, one path per line, both names of a
// rename (`gh api pulls/<n>/files`), and writes its answer to the step's
// outputs: `docs_only=true` skips the test shards and the acceptance scenes,
// and the `integration (cross-repo)` gate accepts their skip.
//
// Fails closed: an empty list, or one that may be truncated (the API lists at
// most 3000 files), is not Markdown-only.
//
// Usage: gh api ... | deno run scripts/ci-docs-only.ts

/** The API's limit: a list this long may be missing files. */
export const MAX_LISTED_FILES = 3000;

/** Tests that read a Markdown file. `checks` runs them on a Markdown-only
 * pull request, since the shards that hold them do not run there;
 * `ci_docs_only_test.ts` asserts that every test reading a `.md` file is
 * named here. */
export const MARKDOWN_TESTS = ["tests/snapshot_table_test.ts"];

/** Markdown outside `public/`. `public/` is the deployed site: a file there
 * ships, so it is never "only docs". */
export function isDocsPath(path: string): boolean {
  return path.endsWith(".md") && !path.startsWith("public/");
}

/** True when every changed path is documentation and the list is complete. */
export function isDocsOnly(paths: string[]): boolean {
  const files = paths.map((p) => p.trim()).filter((p) => p !== "");
  if (files.length === 0 || files.length >= MAX_LISTED_FILES) return false;
  return files.every(isDocsPath);
}

if (import.meta.main) {
  const input = await new Response(Deno.stdin.readable).text();
  const docsOnly = isDocsOnly(input.split("\n"));
  console.log(`docs_only=${docsOnly}`);
}
