import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  atomicWriteLine,
  buildListLine,
  checkPath,
  createYurt,
  hideAtomicTemp,
  parseListing,
  PathError,
  type YurtTransport,
} from "../src/agent_api.ts";
import type { ExecOptions, RawResult, Result } from "../src/executions.ts";

Deno.test("paths are absolute UTF-8 strings without NUL; others are refused, not mangled", () => {
  assertEquals(checkPath("/home/user/a b"), "/home/user/a b");
  assertThrows(() => checkPath("relative"), PathError, "not absolute");
  assertThrows(() => checkPath("/x\0y"), PathError, "not a path");
  assertThrows(() => checkPath(""), PathError, "not a path");
});

Deno.test("a listing is stat lines paired with NUL-terminated names, so any name survives", () => {
  const line = buildListLine("/tmp/it's");
  assertEquals(
    line.startsWith(
      `find '/tmp/it'\\''s' -mindepth 1 -maxdepth 1 -print0 | while IFS= read -r -d ''`,
    ),
    true,
  );
  const bytes = new TextEncoder().encode(
    "regular file|12|644\n/tmp/a b\0directory|0|755\n/tmp/new\nline\0symbolic link|3|777\n/tmp/l\0",
  );
  assertEquals(parseListing(bytes, "/tmp"), [
    { name: "a b", type: "file", size: 12, mode: 0o644 },
    { name: "new\nline", type: "dir", size: 0, mode: 0o755 },
    { name: "l", type: "link", size: 3, mode: 0o777 },
  ]);
  const notUtf8 = new Uint8Array([
    ...new TextEncoder().encode("regular file|1|644\n/tmp/"),
    0xff,
    0xfe,
    0,
  ]);
  assertThrows(
    () => parseListing(notUtf8, "/tmp"),
    PathError,
    "not a UTF-8 name",
  );
});

/** A transport that records what it was asked and answers from a script. */
function fakeTransport(
  answer: (cmd: string, opts: ExecOptions) => Partial<RawResult>,
) {
  const asked: Array<{ cmd: string; opts: ExecOptions }> = [];
  const results = new Map<string, RawResult>();
  let n = 0;
  const transport: YurtTransport = {
    spawn(cmd, opts) {
      asked.push({ cmd, opts });
      const id = `x${++n}`;
      results.set(id, {
        code: 0,
        signal: null,
        timedOut: false,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        stdoutTruncated: false,
        stderrTruncated: false,
        ...answer(cmd, opts),
      } as RawResult);
      return Promise.resolve(id);
    },
    waitRaw: (id) => Promise.resolve(results.get(id)!),
    wait(id) {
      const raw = results.get(id)!;
      const d = new TextDecoder();
      return Promise.resolve({
        ...raw,
        stdout: d.decode(raw.stdout),
        stderr: d.decode(raw.stderr),
      } as Result);
    },
    kill: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  };
  return { transport, asked };
}

Deno.test("fs.read is cat's bytes; fs.write feeds stdin to an atomic cat; a failure carries stderr", async () => {
  const saved: string[] = [];
  const { transport, asked } = fakeTransport((cmd) =>
    cmd.startsWith("cat -- '/nope'")
      ? { code: 1, stderr: new TextEncoder().encode("cat: can't open '/nope'") }
      : cmd.startsWith("cat --")
      ? { stdout: new Uint8Array([0, 1, 2, 255]) }
      : {}
  );
  const yurt = createYurt(transport, {
    current: () => "running",
    ready: Promise.resolve(),
  }, (name) => {
    saved.push(name);
  });
  assertEquals(await yurt.fs.read("/tmp/bin"), new Uint8Array([0, 1, 2, 255]));
  await assertRejects(
    () => yurt.fs.read("/nope"),
    Error,
    "read /nope: exit 1: cat: can't open",
  );
  await yurt.fs.write("/home/user/x.txt", "hi", { mode: 0o600 });
  const write = asked.at(-1)!;
  assertEquals(
    write.cmd.includes('cat > "$t" && mv -f -- "$t" \'/home/user/x.txt\''),
    true,
  );
  assertEquals(write.cmd.endsWith("&& chmod 600 -- '/home/user/x.txt'"), true);
  assertEquals(new TextDecoder().decode(write.opts.stdin as Uint8Array), "hi");
  await yurt.fs.download("/tmp/bin");
  assertEquals(saved, ["bin"]);
  await assertRejects(() => yurt.fs.read("nope"), PathError);
});

Deno.test("exec is spawn + wait; status and ready come from the page", async () => {
  const { transport, asked } = fakeTransport(() => ({
    stdout: new TextEncoder().encode("out"),
  }));
  let status: "booting" | "running" = "booting";
  const yurt = createYurt(transport, {
    current: () => status,
    ready: Promise.resolve(),
  });
  assertEquals(yurt.status, "booting");
  status = "running";
  assertEquals(yurt.status, "running");
  const result = await yurt.exec("echo out", { cwd: "/tmp", timeoutMs: 5 });
  assertEquals(result.stdout, "out");
  assertEquals(asked[0], {
    cmd: "echo out",
    opts: { cwd: "/tmp", timeoutMs: 5 },
  });
});

/// #81: a reload loses every file, and reload used to be the only way out
/// of a wedged terminal. `fs.export` tars a directory (the login home by
/// default) with a process of its own -- it needs nothing from the user's
/// shell, so it works while a foreground command spins -- and saves it.
Deno.test("fs.export tars a directory in a process of its own and saves the archive", async () => {
  const saved: Array<[string, Uint8Array]> = [];
  const archive = new Uint8Array([0x1f, 0x8b, 8, 0, 42]);
  const { transport, asked } = fakeTransport((cmd) =>
    cmd.includes("tarfile") ? { stdout: archive } : {}
  );
  const yurt = createYurt(transport, {
    current: () => "running",
    ready: Promise.resolve(),
  }, (name, bytes) => {
    saved.push([name, bytes]);
  });
  await yurt.fs.export();
  const home = asked.at(-1)!;
  assertEquals(
    home.cmd.startsWith("cd '/home' && python3 -c "),
    true,
    home.cmd,
  );
  assertEquals(home.cmd.endsWith(" 'user' 'user'"), true, home.cmd);
  assertEquals(home.cmd.includes("mode="), true, home.cmd);
  assertEquals(
    (home.opts.maxOutputBytes ?? 0) >= 256 * 1024 * 1024,
    true,
    "an archive of the home is not bounded like a command's output",
  );
  assertEquals(saved, [["user.tgz", archive]]);
  await yurt.fs.export("/tmp/work dir");
  assertEquals(asked.at(-1)!.cmd.startsWith("cd '/tmp' && python3 -c "), true);
  assertEquals(asked.at(-1)!.cmd.endsWith(" 'work dir' 'work dir'"), true);
  assertEquals(saved.at(-1)![0], "work dir.tgz");
  await assertRejects(() => yurt.fs.export("/"), PathError);
  await assertRejects(() => yurt.fs.export("relative"), PathError);
});

Deno.test("a refused write names the path asked for, not the atomic write's temporary file", async () => {
  // yurt-sandbox#301 item 4: the desktop API's 403 read
  // "sh: can't create /etc/probe.yurt-tmp.99: Permission denied".
  const { transport } = fakeTransport(() => ({
    code: 1,
    stderr: new TextEncoder().encode(
      "sh: can't create /etc/probe.yurt-tmp.99: Permission denied\n",
    ),
  }));
  const yurt = createYurt(transport, {
    current: () => "running",
    ready: Promise.resolve(),
  });
  const error = await assertRejects(() => yurt.fs.write("/etc/probe", "x"));
  assertEquals(
    (error as Error).message,
    "write /etc/probe: exit 1: sh: can't create /etc/probe: Permission denied",
  );
});

Deno.test("a failed atomic write removes its temporary file, since the error no longer names it", async () => {
  // The error above names the requested path, so a partial
  // `<path>.yurt-tmp.<pid>` left behind would be a file nobody was told of.
  // A real shell runs the line; a one-block file size limit fails the cat.
  const dir = await Deno.makeTempDir();
  try {
    const { transport } = fakeTransport((cmd, opts) => {
      const input = `${dir}.stdin`;
      Deno.writeFileSync(input, opts.stdin as Uint8Array);
      const out = new Deno.Command("sh", {
        args: ["-c", `exec < "$0"; trap '' XFSZ; ulimit -f 1; ${cmd}`, input],
      }).outputSync();
      Deno.removeSync(input);
      return { code: out.code, stderr: out.stderr };
    });
    const yurt = createYurt(transport, {
      current: () => "running",
      ready: Promise.resolve(),
    });
    const error = await assertRejects(() =>
      yurt.fs.write(`${dir}/big`, new Uint8Array(100_000))
    );
    assertEquals((error as Error).message.includes(".yurt-tmp."), false);
    const left = [...Deno.readDirSync(dir)].map((e) => e.name);
    assertEquals(left, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("hideAtomicTemp drops only the temporary suffix and its pid; other digits after the path stay", () => {
  const path = "/srv/run";
  // dash's form: the digit before the path is a line number, and the
  // pid follows the suffix.
  assertEquals(
    hideAtomicTemp(
      "write /srv/run: exit 2: sh: 1: cannot create /srv/run.yurt-tmp.4242: Directory nonexistent",
      path,
    ),
    "write /srv/run: exit 2: sh: 1: cannot create /srv/run: Directory nonexistent",
  );
  // `/srv/run2` and `/srv/run.1` are other files: their digits are the
  // error's, not a pid, and are kept. Every temporary name is replaced.
  assertEquals(
    hideAtomicTemp(
      "mv: can't rename '/srv/run.yurt-tmp.7': /srv/run2 and /srv/run.1 busy; /srv/run.yurt-tmp.7 kept",
      path,
    ),
    "mv: can't rename '/srv/run': /srv/run2 and /srv/run.1 busy; /srv/run kept",
  );
  // A path that ends in digits keeps them.
  assertEquals(
    hideAtomicTemp("can't create /v/2024.yurt-tmp.31: EROFS", "/v/2024"),
    "can't create /v/2024: EROFS",
  );
  // No temporary name: the message is unchanged.
  assertEquals(
    hideAtomicTemp("sh: /srv/run: Permission denied", path),
    "sh: /srv/run: Permission denied",
  );
});

Deno.test("the atomic write line keeps a failing cat's or mv's status, removes the temporary file, and skips the mode suffix", async () => {
  // Real shells run the line; a shell function stands in for the command
  // that fails, with a status no real failure here would give.
  const shells = ["/bin/sh", "/bin/dash"].filter((sh) => {
    try {
      return Deno.statSync(sh).isFile;
    } catch {
      return false;
    }
  });
  for (const sh of shells) {
    for (
      const [fake, status] of [
        ["cat() { command cat > /dev/null; return 7; }", 7],
        ["mv() { return 9; }", 9],
        ["", 0],
      ] as const
    ) {
      const dir = await Deno.makeTempDir();
      try {
        const dest = `${dir}/out`;
        const out = await new Deno.Command(sh, {
          args: [
            "-c",
            // The mode suffix stands in for `&& chmod`: macOS chmod has no
            // `--`, and a marker file shows whether the suffix ran.
            `${fake}\n${atomicWriteLine(dest, ` && : > '${dir}/suffix-ran'`)}`,
          ],
          stdin: "piped",
          stderr: "piped",
        }).spawn();
        const writer = out.stdin.getWriter();
        await writer.write(new TextEncoder().encode("hi"));
        await writer.close();
        const { code } = await out.output();
        const what = `${sh} ${fake || "no failure"}`;
        assertEquals(code, status, what);
        const left = [...Deno.readDirSync(dir)].map((e) => e.name);
        if (status === 0) {
          assertEquals(left.sort(), ["out", "suffix-ran"], what);
          assertEquals(Deno.readTextFileSync(dest), "hi", what);
        } else {
          assertEquals(left, [], what);
        }
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    }
  }
});
