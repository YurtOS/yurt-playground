// The Markdown-only classifier (scripts/ci-docs-only.ts) and the workflow
// wiring around it. ci.yml's `checks` job runs this file on every run, not
// only in the `fast` shard: the shards are what a Markdown-only pull request
// skips, so a change that broke the classifier into answering "Markdown-only"
// would otherwise skip its own test and go green.
import { assertEquals, assertMatch } from "@std/assert";
import {
  isDocsOnly,
  MARKDOWN_TESTS,
  MAX_LISTED_FILES,
} from "../scripts/ci-docs-only.ts";
import { allTestFiles, REPO_ROOT } from "../scripts/ci-shards.ts";

/** This file names Markdown paths as classifier input; it reads none. */
const SELF = "tests/ci_docs_only_test.ts";

const workflow = () =>
  Deno.readTextFile(new URL("../.github/workflows/ci.yml", import.meta.url));

/** The `checks` job's text: from its key to the next job's. */
function checksJob(text: string): string {
  const start = text.indexOf("\n  checks:\n");
  const end = text.indexOf("\n  tests:\n", start);
  if (start < 0 || end < 0) throw new Error("ci.yml: no checks job");
  return text.slice(start, end);
}

Deno.test("the Markdown-only classifier", () => {
  assertEquals(isDocsOnly(["README.md", "docs/ROADMAP.md"]), true);
  // Both names of a rename are listed: a .ts moved to .md is code.
  assertEquals(isDocsOnly(["docs/x.md", "src/x.ts"]), false);
  // public/ is the deployed site, so Markdown there ships.
  assertEquals(isDocsOnly(["public/demo/README.md"]), false);
  // The agent's model list ships by being merged: the page reads it from main.
  assertEquals(isDocsOnly(["config/agent-models.json"]), true);
  assertEquals(isDocsOnly(["config/agent-models.json", "README.md"]), true);
  assertEquals(isDocsOnly(["config/other.json"]), false);
  assertEquals(isDocsOnly(["config/agent-models.json", "src/page.ts"]), false);
  // Fail closed: no list, or one the API may have cut short.
  assertEquals(isDocsOnly([]), false);
  assertEquals(isDocsOnly([""]), false);
  assertEquals(
    isDocsOnly(Array.from({ length: MAX_LISTED_FILES }, (_, i) => `${i}.md`)),
    false,
  );
});

Deno.test("checks runs this file on every run, Markdown-only or not", async () => {
  // A step of its own with no `if:`, so no output of the classifier can
  // skip it.
  assertMatch(
    checksJob(await workflow()),
    new RegExp(
      `\\n      - name: [^\\n]+\\n        run: deno test --no-check --allow-read ${SELF}\\n`,
    ),
  );
});

Deno.test("a Markdown-only pull request runs only fmt / lint (yurt-sandbox#367)", async () => {
  const text = await workflow();
  // The file list is read through the API when the run starts, never from
  // the event, and only on a pull request without ci:full.
  assertEquals(
    text.includes(
      `gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$PR/files" --jq '.[] | .filename, (.previous_filename // empty)'`,
    ),
    true,
  );
  assertEquals(text.includes("deno run scripts/ci-docs-only.ts"), true);
  // Never on a push, a dispatch or with ci:full: those run everything.
  assertMatch(text, /id: docs\n\s+if: steps\.tier\.outputs\.full == 'false'\n/);
  assertEquals(text.includes('echo "full=$FULL" >> "$GITHUB_OUTPUT"'), true);
  assertEquals(
    text.includes("docs_only: ${{ steps.docs.outputs.docs_only }}"),
    true,
  );
  // The test shards and every acceptance scene skip; fmt / lint does not.
  const legGate =
    "if: ${{ !cancelled() && needs.checks.outputs.present == 'true' && needs.checks.outputs.docs_only != 'true' }}";
  assertEquals(text.split(legGate).length - 1, 2, "tests + acceptance");
  // The required gate passes on the skip only when docs_only said so.
  assertEquals(
    text.includes("DOCS_ONLY: ${{ needs.checks.outputs.docs_only }}"),
    true,
  );
  assertMatch(
    text,
    /"\$DOCS_ONLY" = true \] && \[ "\$TESTS" = skipped \] && \[ "\$ACCEPTANCE" = skipped \]/,
  );
});

Deno.test("every test that reads Markdown runs in checks", async () => {
  const checks = checksJob(await workflow());
  for (const file of MARKDOWN_TESTS) {
    assertEquals(checks.includes(file), true, `${file} not run in checks`);
  }
  // Any string literal naming a local .md path: "../README.md" as well as
  // join(ROOT, "README.md"). A URL does not match (`${BASE}main/README.md`
  // has no quote before the path).
  const readsMarkdown: string[] = [];
  for (const file of await allTestFiles()) {
    if (file === SELF) continue;
    const text = await Deno.readTextFile(`${REPO_ROOT}/${file}`);
    if (/["'`][\w./-]*\.md["'`]/.test(text)) readsMarkdown.push(file);
  }
  assertEquals(readsMarkdown.sort(), [...MARKDOWN_TESTS].sort());
});

Deno.test("the agent's model list alone builds and deploys nothing, and is validated", async () => {
  const ci = await workflow();
  const deploy = await Deno.readTextFile(
    new URL("../.github/workflows/deploy-pages.yml", import.meta.url),
  );
  // A push to main that changes only the list starts neither workflow.
  for (const text of [ci, deploy]) {
    assertMatch(
      text,
      new RegExp(
        "\\n  push:\\n    branches: \\[main\\]\\n(?:    #[^\\n]*\\n)*" +
          "    paths-ignore: \\[config/agent-models\\.json\\]\\n",
      ),
    );
  }
  // Its pull request runs only the checks job, which validates it on every
  // run: a step of its own, with no `if:`.
  assertMatch(
    checksJob(ci),
    new RegExp(
      "\\n      - name: [^\\n]+\\n        run: deno test --no-check " +
        "--allow-read tests/agent_models_file_test\\.ts\\n",
    ),
  );
});
