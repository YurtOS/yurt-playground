// deploy-pages.yml publishes production only from main and every other branch
// to its own Cloudflare Pages preview alias. scripts/deploy-target.sh decides
// which, so the split is tested on the script itself, and the workflow's shape
// is checked to route each mode to its own deploy step.

import { assertEquals, assertMatch } from "@std/assert";

const SCRIPT = decodeURIComponent(
  new URL("../scripts/deploy-target.sh", import.meta.url).pathname,
);
const SHA = "0123456789abcdef0123456789abcdef01234567";

type Target = { code: number; out: Record<string, string>; err: string };

async function target(
  event: string,
  ref: string,
  input = "",
): Promise<Target> {
  const result = await new Deno.Command("bash", {
    args: [SCRIPT],
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      EVENT: event,
      GITHUB_REF: ref,
      GITHUB_SHA: SHA,
      INPUT_REF: input,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out: Record<string, string> = {};
  for (const line of new TextDecoder().decode(result.stdout).split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return {
    code: result.code,
    out,
    err: new TextDecoder().decode(result.stderr),
  };
}

Deno.test("a push to main deploys production at the pushed commit", async () => {
  const t = await target("push", "refs/heads/main");
  assertEquals(t.code, 0, t.err);
  assertEquals(t.out, { mode: "production", branch: "main", ref: SHA });
});

Deno.test("a dispatch from main with no ref redeploys production", async () => {
  const t = await target("workflow_dispatch", "refs/heads/main");
  assertEquals(t.code, 0, t.err);
  assertEquals(t.out, { mode: "production", branch: "main", ref: SHA });
});

Deno.test("a dispatch with a ref previews that branch", async () => {
  const t = await target(
    "workflow_dispatch",
    "refs/heads/main",
    "agent/yurt-playground-phone-snapshot",
  );
  assertEquals(t.code, 0, t.err);
  assertEquals(t.out, {
    mode: "preview",
    branch: "agent/yurt-playground-phone-snapshot",
    ref: "refs/heads/agent/yurt-playground-phone-snapshot",
    // 28 characters, then the hyphen the cut left at the end dropped: a DNS
    // label cannot end in one.
    alias: "agent-yurt-playground-phone",
  });
});

Deno.test("a dispatch from another branch previews it, never production", async () => {
  // Before the split, `gh workflow run deploy-pages.yml --ref <branch>`
  // published that branch to production.
  const t = await target("workflow_dispatch", "refs/heads/Fix/API_v2");
  assertEquals(t.code, 0, t.err);
  assertEquals(t.out, {
    mode: "preview",
    branch: "Fix/API_v2",
    ref: "refs/heads/Fix/API_v2",
    alias: "fix-api-v2",
  });
  assertEquals(
    (await target("workflow_dispatch", "refs/heads/main", "refs/heads/x")).out
      .ref,
    "refs/heads/x",
  );
});

Deno.test("the preview path refuses the production branch", async () => {
  for (const input of ["main", "refs/heads/main", "Main", "MAIN"]) {
    const t = await target("workflow_dispatch", "refs/heads/main", input);
    assertEquals(t.code, 1, `${input}: ${JSON.stringify(t.out)}`);
    assertEquals(t.out.mode, undefined, input);
    assertMatch(t.err, /production/, input);
  }
});

Deno.test("the preview path takes only a well-formed branch name", async () => {
  for (
    const input of [
      "a b",
      "x;rm -rf /",
      "$(id)",
      "-x",
      "a..b",
      "a\nmode=production",
      "feature/",
      "---",
    ]
  ) {
    const t = await target("workflow_dispatch", "refs/heads/main", input);
    assertEquals(t.code, 1, `${JSON.stringify(input)}: ${t.err}`);
    assertEquals(t.out.mode, undefined, JSON.stringify(input));
  }
  // A tag or a pull-request ref is not a branch to preview.
  for (const ref of ["refs/tags/v1", "refs/pull/1/merge"]) {
    const t = await target("workflow_dispatch", ref);
    assertEquals(t.code, 1, ref);
    assertEquals(t.out.mode, undefined, ref);
  }
});

Deno.test("no other event deploys, and a push deploys only main", async () => {
  for (
    const [event, ref] of [
      ["push", "refs/heads/feature"],
      ["pull_request", "refs/pull/1/merge"],
      ["pull_request_target", "refs/heads/main"],
    ]
  ) {
    const t = await target(event, ref);
    assertEquals(t.code, 1, `${event} ${ref}`);
    assertEquals(t.out.mode, undefined, `${event} ${ref}`);
  }
});

/** The text of one step of the deploy job, found by its name. */
function step(workflow: string, name: string): string {
  const start = workflow.indexOf(`- name: ${name}\n`);
  assertEquals(start >= 0, true, `no step named ${name}`);
  const next = workflow.indexOf("\n      - ", start + 1);
  return workflow.slice(start, next < 0 ? undefined : next);
}

Deno.test("deploy-pages.yml routes production and previews to separate steps", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/deploy-pages.yml", import.meta.url),
  );
  // Fork pull requests must never reach the Cloudflare secret.
  const triggers = workflow.slice(
    workflow.indexOf("\non:\n"),
    workflow.indexOf("\nenv:\n"),
  );
  assertEquals(/pull_request/.test(triggers), false, "a pull_request trigger");
  assertEquals(triggers.includes("branches: [main]"), true);
  assertEquals(triggers.includes("workflow_dispatch:"), true);
  // The dispatch input reaches the script through the environment, never
  // spliced into a shell line.
  assertEquals(workflow.includes("INPUT_REF: ${{ inputs.ref }}"), true);
  assertEquals(/run:[^\n]*\$\{\{ inputs\./.test(workflow), false);
  assertEquals(workflow.includes("scripts/deploy-target.sh"), true);
  // The site is built from the target's ref, so a preview is that branch.
  assertEquals(workflow.includes("ref: ${{ needs.target.outputs.ref }}"), true);
  assertEquals(workflow.includes("needs.target.outputs.ref != ''"), true);
  // The site names the commit it was built from: the checked-out one, which
  // in a preview dispatched from main is not GITHUB_SHA.
  assertEquals(
    step(workflow, "Build static site").includes(
      "GITHUB_SHA=$(git rev-parse HEAD) deno task build-static",
    ),
    true,
  );

  const production = step(workflow, "Deploy to Cloudflare Pages");
  assertEquals(
    production.includes("if: needs.target.outputs.mode == 'production'"),
    true,
  );
  assertEquals(production.includes("--branch main "), true);
  assertEquals(production.includes('--commit-hash "$GITHUB_SHA"'), true);

  const preview = step(workflow, "Deploy a preview to Cloudflare Pages");
  assertEquals(
    preview.includes("if: needs.target.outputs.mode == 'preview'"),
    true,
  );
  assertEquals(preview.includes('--branch "$BRANCH"'), true);
  // An empty branch would make wrangler deploy production; refused first.
  assertEquals(
    preview.indexOf('[ -n "$BRANCH" ]') >= 0 &&
      preview.indexOf('[ -n "$BRANCH" ]') < preview.indexOf("pages deploy"),
    true,
  );
  assertEquals(/--branch main/.test(preview), false, "preview names main");
  // Cloudflare makes a deployment production when its branch is the
  // project's production branch, whatever this repository calls it: the step
  // asks the project and refuses that branch, then checks what Cloudflare
  // says it made.
  assertEquals(preview.includes(".result.production_branch"), true);
  assertMatch(preview, /\[ "\$BRANCH" = "\$production" \]/);
  assertMatch(preview, /\.environment/);
  assertEquals(preview.includes("GITHUB_STEP_SUMMARY"), true);
  // Exactly one step of each kind deploys.
  assertEquals(workflow.match(/wrangler@[\d.]+ pages deploy/g)?.length, 2);
});
