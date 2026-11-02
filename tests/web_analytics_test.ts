import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { contentSecurityPolicy, headersFile } from "../src/csp.ts";
import {
  BEACON_PAGES,
  BEACON_REPORT_ORIGIN,
  BEACON_SCRIPT_ORIGIN,
  beaconSnippet,
  WEB_ANALYTICS_TOKEN,
  withBeacon,
} from "../src/web_analytics.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";
const BEACON = "static.cloudflareinsights.com/beacon.min.js";

/** A directive's sources in a CSP line. */
function directive(policy: string, name: string): string[] {
  const found = policy.split(";").map((part) => part.trim().split(/\s+/))
    .find(([directiveName]) => directiveName === name);
  if (found === undefined) throw new Error(`no ${name} in ${policy}`);
  return found.slice(1);
}

/** A temp copy of the built pages the beacon touches, plus a JupyterLite
 * page with an inline bootstrap. */
async function fakeDist(): Promise<string> {
  const dir = await Deno.makeTempDir();
  for (const page of [...BEACON_PAGES, "404.html", "terminal.html"]) {
    await Deno.copyFile(
      new URL(`../public/${page}`, import.meta.url),
      `${dir}/${page}`,
    );
  }
  await Deno.mkdir(`${dir}/jupyter`);
  await Deno.writeTextFile(
    `${dir}/jupyter/index.html`,
    "<html><head><script>boot()</script></head></html>",
  );
  return dir;
}

async function readPages(dir: string): Promise<Record<string, string>> {
  const pages: Record<string, string> = {};
  for (const page of [...BEACON_PAGES, "404.html", "terminal.html"]) {
    pages[page] = await Deno.readTextFile(`${dir}/${page}`);
  }
  pages["jupyter/index.html"] = await Deno.readTextFile(
    `${dir}/jupyter/index.html`,
  );
  return pages;
}

Deno.test("the committed beacon token is empty or well formed", () => {
  if (WEB_ANALYTICS_TOKEN !== "") beaconSnippet(WEB_ANALYTICS_TOKEN);
});

Deno.test("with no token the policy and the pages are untouched", async () => {
  const policy = contentSecurityPolicy();
  assertEquals(policy.includes("cloudflareinsights"), false);
  assertEquals(
    headersFile({}, [], []).includes("cloudflareinsights"),
    false,
  );
  assertEquals(withBeacon("<head></head>", ""), "<head></head>");

  const { injectBeacon, siteHeaders } = await import(
    "../scripts/build-static.ts"
  );
  const dir = await fakeDist();
  try {
    const before = await readPages(dir);
    await injectBeacon(dir, "");
    assertEquals(await readPages(dir), before);
    const headers = await siteHeaders(dir, "");
    assertEquals(headers.includes("cloudflareinsights"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("with a token the deployed pages carry the beacon once and the site policy admits it", async () => {
  const { injectBeacon, siteHeaders } = await import(
    "../scripts/build-static.ts"
  );
  const dir = await fakeDist();
  try {
    const before = await readPages(dir);
    const plainHeaders = await siteHeaders(dir, "");
    await injectBeacon(dir, TOKEN);
    const after = await readPages(dir);
    for (const page of BEACON_PAGES) {
      assertEquals(after[page].split(BEACON).length - 1, 1, page);
      assertStringIncludes(after[page], beaconSnippet(TOKEN));
      assertStringIncludes(after[page], `"token": "${TOKEN}"`);
      // In the head, before the page's own scripts run.
      const tag = after[page].indexOf(BEACON);
      assertEquals(tag < after[page].indexOf("</head>"), true, page);
      assertEquals(
        after[page].replace(beaconSnippet(TOKEN) + "\n  ", ""),
        before[page],
        page,
      );
    }
    assertEquals(after["404.html"], before["404.html"]);
    assertEquals(after["terminal.html"], before["terminal.html"]);
    assertEquals(after["jupyter/index.html"], before["jupyter/index.html"]);

    const headers = await siteHeaders(dir, TOKEN);
    const [siteRule, jupyterRule] = headers.split("/jupyter/*");
    const sitePolicy = siteRule.split("Content-Security-Policy: ")[1];
    assertEquals(
      directive(sitePolicy, "script-src").includes(BEACON_SCRIPT_ORIGIN),
      true,
    );
    assertEquals(
      directive(sitePolicy, "connect-src").includes(BEACON_REPORT_ORIGIN),
      true,
    );
    // The report endpoint is not a script source, the script host not a
    // connect target.
    assertEquals(
      directive(sitePolicy, "script-src").includes(BEACON_REPORT_ORIGIN),
      false,
    );
    assertEquals(
      directive(sitePolicy, "connect-src").includes(BEACON_SCRIPT_ORIGIN),
      false,
    );
    // The beacon is an external script: no new inline hash.
    assertEquals(sitePolicy.includes("'sha256-"), false);
    // JupyterLite's rule is exactly what it was without analytics.
    assertEquals(jupyterRule, plainHeaders.split("/jupyter/*")[1]);
    assertEquals(jupyterRule.includes("cloudflareinsights"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a malformed token is refused rather than breaking the tag", () => {
  for (const token of [`a'b`, `a"b`, "a b", "a<b"]) {
    assertThrows(() => beaconSnippet(token));
  }
  assertThrows(() => withBeacon("<body></body>", TOKEN));
});
