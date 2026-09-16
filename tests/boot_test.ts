import { assertEquals, assertRejects } from "@std/assert";
import { bootPlayground, fetchPlaygroundBytes } from "../src/boot.ts";
import {
  assertNoTouchFailure,
  bootAshSession,
  memoryTerm,
  typeCommand,
  waitFor,
} from "./ash_harness.ts";

Deno.test("bootPlayground fails closed when the page is not isolated", async () => {
  let shown = "";
  try {
    await bootPlayground({
      isolated: false,
      fetchBytes: () => Promise.resolve(new Uint8Array()),
      show: (text: string) => {
        shown = text;
      },
      term: memoryTerm(),
    });
    throw new Error("expected bootPlayground to reject");
  } catch (error) {
    if (
      !(error instanceof Error) || error.message !== "not crossOriginIsolated"
    ) {
      throw error;
    }
  }
  assertEquals(shown, "need COOP/COEP");
});

Deno.test("fetchPlaygroundBytes retries pins.json after a failed load", async () => {
  const originalFetch = globalThis.fetch;
  const artifact = new Uint8Array();
  const pins = {
    kernelWasm: {
      repo: "test/repo",
      rev: "a".repeat(40),
      build: "test",
      path: "yurt_kernel.wasm",
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
    image: {
      repo: "test/repo",
      rev: "b".repeat(40),
      build: "test",
      path: "playground.yurtimg",
      sha256:
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
  };
  let pinsRequests = 0;
  try {
    globalThis.fetch = (input) => {
      const url = String(input);
      if (url === "./pins.json") {
        pinsRequests++;
        return Promise.resolve(
          pinsRequests === 1
            ? new Response("temporary failure", { status: 503 })
            : new Response(JSON.stringify(pins), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(artifact, { status: 200 }));
    };

    await assertRejects(() => fetchPlaygroundBytes("./yurt_kernel.wasm"));
    assertEquals(
      await fetchPlaygroundBytes("http://playground/yurt_kernel.wasm"),
      artifact,
    );
    assertEquals(pinsRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test({
  name: "ash session: login, owners, redirects, and touch",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const session = await bootAshSession();
    if (!session) return;
    const { term } = session;
    try {
      const hi = await typeCommand(term, "echo hi");
      if (!/^hi$/m.test(hi.replace(/\r/g, ""))) {
        throw new Error(`echo hi: ${JSON.stringify(hi)}`);
      }
      const uname = await typeCommand(term, "uname");
      if (!/^Linux$/m.test(uname.replace(/\r/g, ""))) {
        throw new Error(`uname: ${JSON.stringify(uname)}`);
      }
      const ls = await typeCommand(term, "ls");
      if (ls.includes("No such file") || ls.includes("Permission denied")) {
        throw new Error(`ls: ${JSON.stringify(ls)}`);
      }

      const id = await typeCommand(term, "id");
      if (
        !id.includes("uid=1000(user)") || !id.includes("gid=1000(user)")
      ) {
        throw new Error(`login id: ${JSON.stringify(id)}`);
      }
      const pwd = await typeCommand(term, "pwd");
      if (!pwd.includes("/home/user")) {
        throw new Error(`login pwd: ${JSON.stringify(pwd)}`);
      }

      const bin = await typeCommand(term, "ls -ld /bin");
      if (!/root\s+root.*\/bin/.test(bin.replace(/\r/g, ""))) {
        throw new Error(`ls -ld /bin: ${JSON.stringify(bin)}`);
      }
      const home = await typeCommand(term, "ls -ld /home");
      if (!/root\s+root.*\/home(?:\n|$)/.test(home.replace(/\r/g, ""))) {
        throw new Error(`ls -ld /home: ${JSON.stringify(home)}`);
      }
      const homeUser = await typeCommand(term, "ls -ld /home/user");
      if (!/user\s+user.*\/home\/user/.test(homeUser.replace(/\r/g, ""))) {
        throw new Error(`ls -ld /home/user: ${JSON.stringify(homeUser)}`);
      }

      // ash `>` and hidden names: `ls -l` omits dotfiles (Linux).
      await typeCommand(term, "echo xxx > visible");
      await typeCommand(term, "echo yyy > .hidden");
      const listing = await typeCommand(term, "ls -l");
      if (!/-rw-r--r--\s+1 user\s+user\s+4 .*visible/.test(listing)) {
        throw new Error(`ls -l missing visible: ${JSON.stringify(listing)}`);
      }
      if (listing.includes(".hidden")) {
        throw new Error(`ls -l showed hidden file: ${JSON.stringify(listing)}`);
      }
      const all = await typeCommand(term, "ls -la");
      if (!/-rw-r--r--\s+1 user\s+user\s+4 .*\.hidden/.test(all)) {
        throw new Error(`ls -la missing .hidden: ${JSON.stringify(all)}`);
      }
      const cats = await typeCommand(
        term,
        "cat visible; echo --; cat .hidden; echo ENDCAT",
      );
      if (!/xxx[\r\n]+--[\r\n]+yyy[\r\n]+ENDCAT/.test(cats)) {
        throw new Error(`redirect contents: ${JSON.stringify(cats)}`);
      }

      // Unqualified `touch` must exec /bin/touch. After other commands a
      // leftover wait errno used to print ECHILD; a second touch on the
      // created file is the existing-path stamp.
      // FEATURE_SH_STANDALONE=n: ash only finds applets that exist on PATH.
      for (const applet of ["date", "ps"]) {
        const which = await typeCommand(term, `command -v ${applet}`);
        if (!which.includes(`/bin/${applet}`)) {
          throw new Error(
            `${applet} must resolve on PATH: ${JSON.stringify(which)}`,
          );
        }
      }
      const date = await typeCommand(term, "date");
      if (date.includes("not found")) {
        throw new Error(`date: ${JSON.stringify(date)}`);
      }
      const ps = await typeCommand(term, "ps");
      if (ps.includes("not found")) {
        throw new Error(`ps: ${JSON.stringify(ps)}`);
      }

      const whichTouch = await typeCommand(term, "command -v touch");
      if (!whichTouch.includes("/bin/touch")) {
        throw new Error(
          `touch must resolve on PATH: ${JSON.stringify(whichTouch)}`,
        );
      }
      const touchOut = await typeCommand(term, "touch sss");
      assertNoTouchFailure(touchOut, "touch sss");
      const touched = await typeCommand(term, "ls -l sss");
      if (!/-rw-r--r--\s+1 user\s+user\s+0 .*sss/.test(touched)) {
        throw new Error(`touch did not create sss: ${JSON.stringify(touched)}`);
      }
      const retouch = await typeCommand(term, "touch sss");
      assertNoTouchFailure(retouch, "second touch sss");
    } finally {
      session.stop();
    }
  },
});

Deno.test({
  name: "a second ash boot is a fresh sandbox",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const first = await bootAshSession();
    if (!first) return;
    try {
      await typeCommand(first.term, "echo leftover > /home/user/stale");
      const seen = await typeCommand(first.term, "ls /home/user/stale");
      if (!seen.includes("stale")) {
        throw new Error(`first boot missing stale: ${JSON.stringify(seen)}`);
      }
    } finally {
      first.stop();
    }

    const second = await bootAshSession();
    if (!second) return;
    try {
      const gone = await typeCommand(second.term, "ls /home/user/stale");
      if (!gone.includes("No such file")) {
        throw new Error(
          `reload reused the previous overlay: ${JSON.stringify(gone)}`,
        );
      }
    } finally {
      second.stop();
    }
  },
});

Deno.test({
  name: "exit at the prompt ends the shell cleanly; later keys go nowhere",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const session = await bootAshSession();
    if (!session) return;
    try {
      await typeCommand(session.term, "echo ready");
      session.term.type("exit\n");
      await waitFor(
        () => session.shown() === "shell exited",
        `status after exit, shown=${JSON.stringify(session.shown())}`,
        20_000,
      );
      if (!session.term.output().includes("[the shell exited")) {
        throw new Error(
          `no exit notice in the terminal: ${
            JSON.stringify(session.term.output())
          }`,
        );
      }
      // A key after the shell is gone is dropped, not written to a closed
      // pty (which surfaced as "ptyMasterWrite failed: rc=-9").
      session.term.type("ls\n");
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (session.shown() !== "shell exited") {
        throw new Error(`status changed after a key: ${session.shown()}`);
      }
    } finally {
      session.stop();
    }
  },
});

Deno.test({
  name: "ash consumes Up-arrow as command history",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const session = await bootAshSession({ requireArtifacts: true });
    if (!session) throw new Error("required ash session unexpectedly skipped");
    try {
      const marker = "__YURT_ARROW_HISTORY__";
      const before = session.term.output().length;
      session.term.type(`printf '${marker}\\n'\n`);
      await waitFor(
        () => {
          const added = session.term.output().slice(before).replace(/\r/g, "");
          return added.split("\n").filter((line) => line === marker).length >=
              1 &&
            /\$ $/.test(added);
        },
        "initial arrow-history command and prompt",
        60_000,
      );
      session.term.type("\x1b[A\n");
      await waitFor(
        () =>
          session.term.output().slice(before).split(/\r?\n/).filter((line) =>
            line === marker
          ).length >= 2,
        `replayed arrow-history command: ${
          JSON.stringify(session.term.output().slice(before))
        }`,
        60_000,
      );
    } finally {
      session.stop();
    }
  },
});
