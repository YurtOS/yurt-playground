import { assertEquals } from "@std/assert";
import { bootPlayground } from "../src/boot.ts";
import {
  assertNoTouchFailure,
  bootAshSession,
  memoryTerm,
  typeCommand,
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

Deno.test({
  name: "ash session: login, owners, redirects, and touch",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const session = await bootAshSession();
    if (!session) return;
    const { term } = session;
    try {
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
