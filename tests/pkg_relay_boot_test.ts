/**
 * The package relay (src/pkg_relay.ts) in a booted sandbox: the guest
 * connects to a listener the page owns, and the guest's own `pkg` reaches
 * the repository through it. Booting needs the pinned artifacts; without
 * them each test skips, as boot_test.ts's do.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { bootAshSession, repoRoot, typeCommand } from "./ash_harness.ts";
import { PACKAGE_REPO_URL, PKG_RELAY_URL } from "../src/packages.ts";
import type { RelayFetch } from "../src/pkg_relay.ts";

const FIXTURE = join(repoRoot, "tests/fixtures/yurt-packages");

/** Answers like raw.githubusercontent.com would, from `files`: a 404 for
 * anything else, and every URL asked for recorded. */
function fakeUpstream(files: Record<string, Uint8Array>) {
  const asked: string[] = [];
  const fetch: RelayFetch = (url) => {
    asked.push(url);
    const path = url.slice(PACKAGE_REPO_URL.length);
    const body = files[path];
    return Promise.resolve(
      body === undefined
        ? new Response("404: Not Found", { status: 404 })
        : new Response(body.slice(), {
          headers: { "content-length": String(body.byteLength) },
        }),
    );
  };
  return { fetch, asked };
}

const clean = (text: string) => text.replace(/\r/g, "");

Deno.test({
  name: "pkg relay: the guest reaches the page's listener, eight at a time",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const upstream = fakeUpstream({
      "index.json": new TextEncoder().encode("index-bytes\n"),
      ...Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [
          `packages/p${i}.json`,
          new TextEncoder().encode(`metadata ${i}\n`),
        ]),
      ),
    });
    const session = await bootAshSession({
      pkgRelay: { tablet: false, fetch: upstream.fetch },
    });
    if (!session) return;
    try {
      const one = await typeCommand(
        session.term,
        `wget -q -O - ${PKG_RELAY_URL}index.json`,
        30_000,
      );
      assertStringIncludes(clean(one), "\nindex-bytes\n");
      assertEquals(upstream.asked, [`${PACKAGE_REPO_URL}index.json`]);

      // pkg fetches up to 8 files at once.
      const many = await typeCommand(
        session.term,
        `for i in 0 1 2 3 4 5 6 7; do wget -q -O /tmp/p$i ${PKG_RELAY_URL}packages/p$i.json & done; wait; cat /tmp/p0 /tmp/p1 /tmp/p2 /tmp/p3 /tmp/p4 /tmp/p5 /tmp/p6 /tmp/p7`,
        60_000,
      );
      for (let i = 0; i < 8; i++) {
        assertStringIncludes(clean(many), `metadata ${i}\n`);
      }

      // Outside the repository: refused, and nothing fetched.
      const before = upstream.asked.length;
      const refused = await typeCommand(
        session.term,
        `wget -q -O - ${PKG_RELAY_URL}a/../../x || echo refused-$?`,
        30_000,
      );
      assertStringIncludes(clean(refused), "refused-");
      const missing = await typeCommand(
        session.term,
        `wget -q -O - ${PKG_RELAY_URL}nothing.json || echo missing-$?`,
        30_000,
      );
      assertStringIncludes(clean(missing), "missing-");
      assertEquals(upstream.asked.slice(before), [
        `${PACKAGE_REPO_URL}nothing.json`,
      ]);

      // The configuration pkg reads names the relay, root's and 0644.
      const conf = clean(
        await typeCommand(
          session.term,
          "ls -l /etc/yurt-pkg/trusted-repos.toml; grep '^url' /etc/yurt-pkg/trusted-repos.toml",
          30_000,
        ),
      );
      assertStringIncludes(conf, "-rw-r--r--");
      assertStringIncludes(conf, `url = "${PKG_RELAY_URL}"`);
    } finally {
      session.dispose();
    }
  },
});

Deno.test({
  name: "pkg relay: an archive passes at 5 MB/s or more",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const size = 10 * 1024 * 1024;
    const archive = new Uint8Array(size).map((_, i) => (i * 31) & 0xff);
    const upstream = fakeUpstream({ "artifacts/big.yurtpkg": archive });
    const session = await bootAshSession({
      pkgRelay: { tablet: false, fetch: upstream.fetch },
    });
    if (!session) return;
    try {
      // The prompt's own round trip, taken off the transfer's.
      const t0 = performance.now();
      await typeCommand(session.term, "true", 30_000);
      const roundTrip = performance.now() - t0;
      const t1 = performance.now();
      const out = await typeCommand(
        session.term,
        `wget -q -O - ${PKG_RELAY_URL}artifacts/big.yurtpkg | wc -c`,
        120_000,
      );
      const seconds = (performance.now() - t1 - roundTrip) / 1000;
      assertStringIncludes(clean(out), `\n${size}\n`);
      const rate = size / seconds / 1e6;
      console.log(`pkg relay: ${rate.toFixed(1)} MB/s for a 10 MiB archive`);
      assert(rate >= 5, `${rate.toFixed(1)} MB/s is under 5 MB/s`);
    } finally {
      session.dispose();
    }
  },
});

Deno.test({
  name: "pkg relay: the guest's own pkg update reaches the repository",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // The published snapshot of the repository whose signatures are
    // placeholders: pkg must get every file through the relay, then
    // refuse the index. Before the relay it never got that far
    // ("HTTP request failed").
    const files: Record<string, Uint8Array> = {};
    for (const path of ["index.json", "index.json.bundle"]) {
      files[path] = await Deno.readFile(join(FIXTURE, path));
    }
    const upstream = fakeUpstream(files);
    const session = await bootAshSession({
      pkgRelay: { tablet: false, fetch: upstream.fetch },
    });
    if (!session) return;
    try {
      const out = clean(
        await typeCommand(session.term, "sudo pkg update", 120_000),
      );
      assert(!out.includes("HTTP request failed"), out);
      assertStringIncludes(out, "failed to update official");
      assertStringIncludes(out, "verif");
      assertEquals(upstream.asked, [
        `${PACKAGE_REPO_URL}index.json`,
        `${PACKAGE_REPO_URL}index.json.bundle`,
      ]);
    } finally {
      session.dispose();
    }
  },
});

Deno.test({
  name: "pkg relay: sudo pkg update and install from the live repository",
  // The network and the live repository: run by hand, not in CI.
  ignore: Deno.env.get("PLAYGROUND_PKG_LIVE") !== "1",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const name = Deno.env.get("PLAYGROUND_PKG_NAME") ?? "pkgconf";
    const session = await bootAshSession({
      requireArtifacts: true,
      pkgRelay: { tablet: false },
    });
    try {
      const term = session!.term;
      const run = async (command: string) => {
        const t0 = performance.now();
        const out = clean(await typeCommand(term, command, 300_000));
        console.log(
          `${command}: ${Math.round(performance.now() - t0)} ms\n${out}`,
        );
        return out;
      };
      assertStringIncludes(await run("sudo pkg update"), "updated official");
      // The relay's ETag: the same index again is current, not a rollback.
      assertStringIncludes(
        await run("sudo pkg update"),
        "official already current",
      );
      assertStringIncludes(
        await run(`sudo pkg install ${name}`),
        `install ${name} `,
      );
      assertStringIncludes(await run("sudo pkg list"), `\n${name} `);
    } finally {
      session!.dispose();
    }
  },
});
