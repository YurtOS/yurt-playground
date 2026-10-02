import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
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
    write.cmd.includes('cat > "$t" && mv -f -- "$t" "$d"') &&
      write.cmd.includes("d='/home/user/x.txt'"),
    true,
  );
  assertEquals(write.cmd.endsWith('&& chmod 600 -- "$d"'), true);
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
      "sh: can't create /etc/probe.yurt-tmp.99: Permission denied\n" +
        "\nyurt-atomic-temp=/etc/probe.yurt-tmp.99",
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

Deno.test("hideAtomicTemp replaces only the temporary path the shell names; other digits and names stay", () => {
  const mark = (temp: string) => `\nyurt-atomic-temp=${temp}`;
  // dash's form: the digit before the path is a line number.
  assertEquals(
    hideAtomicTemp(
      "sh: 1: cannot create /srv/run.yurt-tmp.4242: Directory nonexistent\n" +
        mark("/srv/run.yurt-tmp.4242"),
    ),
    "sh: 1: cannot create /srv/run: Directory nonexistent\n",
  );
  // `/srv/run2`, `/srv/run.1` and another pid's temporary name are other
  // files, kept; every copy of this write's temporary name is replaced.
  assertEquals(
    hideAtomicTemp(
      "mv: can't rename '/srv/run.yurt-tmp.7': /srv/run2, /srv/run.1 and /srv/run.yurt-tmp.8 busy; /srv/run.yurt-tmp.7 kept" +
        mark("/srv/run.yurt-tmp.7"),
    ),
    "mv: can't rename '/srv/run': /srv/run2, /srv/run.1 and /srv/run.yurt-tmp.8 busy; /srv/run kept",
  );
  // A file whose own name holds the suffix keeps it: only the last one,
  // the write's, goes.
  assertEquals(
    hideAtomicTemp(
      "can't create /v/x.yurt-tmp.1.yurt-tmp.31: EROFS" +
        mark("/v/x.yurt-tmp.1.yurt-tmp.31"),
    ),
    "can't create /v/x.yurt-tmp.1: EROFS",
  );
  // Through a symlink (#166) the temporary file sits beside the link's
  // target, and the error names the target.
  assertEquals(
    hideAtomicTemp(
      "sh: can't create /data/real.yurt-tmp.5: No space left" +
        mark("/data/real.yurt-tmp.5"),
    ),
    "sh: can't create /data/real: No space left",
  );
  // No mark (a non-atomic write, a refusal before the temporary file):
  // unchanged, even where a name holds the suffix.
  assertEquals(
    hideAtomicTemp("sh: /srv/x.yurt-tmp.3: Permission denied"),
    "sh: /srv/x.yurt-tmp.3: Permission denied",
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
            `${fake}\n${
              atomicWriteLine(dest, () => ` && : > '${dir}/suffix-ran'`)
            }`,
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

Deno.test("an atomic write to a directory fails as one and leaves nothing in it", async () => {
  // #163: `mv -f tmp dir` moved the temporary file into the directory and
  // the write succeeded. Real shells run the line.
  for (const sh of realShells()) {
    const dir = await Deno.makeTempDir();
    try {
      const target = `${dir}/sub`;
      await Deno.mkdir(target);
      const { transport } = fakeTransport((cmd, opts) => {
        const input = `${dir}.stdin`;
        Deno.writeFileSync(input, opts.stdin as Uint8Array);
        const out = new Deno.Command(sh, {
          args: ["-c", `exec < "$0"; ${cmd}`, input],
        }).outputSync();
        Deno.removeSync(input);
        return { code: out.code, stderr: out.stderr };
      });
      const yurt = createYurt(transport, {
        current: () => "running",
        ready: Promise.resolve(),
      });
      const error = await assertRejects(() => yurt.fs.write(target, "x"));
      assertEquals(
        (error as Error).message,
        `write ${target}: exit 1: ${target}: Is a directory`,
        sh,
      );
      assertEquals([...Deno.readDirSync(target)], [], sh);
      assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), ["sub"], sh);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

/** The POSIX shells on this machine that run the write line; at least
 * one, so a loop over them cannot pass without running. */
function realShells(): string[] {
  const shells = ["/bin/sh", "/bin/dash"].filter((sh) => {
    try {
      return Deno.statSync(sh).isFile;
    } catch {
      return false;
    }
  });
  assert(shells.length > 0, "no /bin/sh or /bin/dash to run the line");
  return shells;
}

Deno.test("an atomic write fails when a directory appears at the path while stdin streams", async () => {
  // #163 review: the check before `cat` passes, a directory is made at the
  // path while `cat` still reads, and `mv` moves the temporary file into
  // it. The line must see that after the `mv`, remove the file and fail.
  for (const sh of realShells()) {
    const dir = await Deno.makeTempDir();
    try {
      const target = `${dir}/target`;
      const child = new Deno.Command(sh, {
        args: [
          "-c",
          atomicWriteLine(target, () => ` && : > '${dir}/suffix-ran'`),
        ],
        stdin: "piped",
        stderr: "piped",
      }).spawn();
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode("data"));
      // `cat` has its first bytes, so the check before it is behind us.
      const tmp = new RegExp(`^target\\.yurt-tmp\\.\\d+$`);
      const deadline = Date.now() + 10_000;
      while (![...Deno.readDirSync(dir)].some((e) => tmp.test(e.name))) {
        assert(Date.now() < deadline, `${sh}: no temporary file appeared`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await Deno.mkdir(target);
      await writer.close();
      const out = await child.output();
      assertEquals(out.code, 1, sh);
      assertEquals(
        new TextDecoder().decode(out.stderr),
        `${target}: Is a directory\n`,
        sh,
      );
      assertEquals([...Deno.readDirSync(target)], [], sh);
      assertEquals(
        [...Deno.readDirSync(dir)].map((e) => e.name),
        ["target"],
        sh,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

/** A Yurt whose fs.write runs its line in `sh`, a real shell, in
 * `scratch`, after `prelude`. */
function shellYurt(sh: string, scratch: string, prelude = "") {
  const { transport } = fakeTransport((cmd, opts) => {
    const input = `${scratch}.stdin`;
    Deno.writeFileSync(input, opts.stdin as Uint8Array);
    const out = new Deno.Command(sh, {
      args: ["-c", `exec < "$0"; ${prelude}\n${cmd}`, input],
      cwd: scratch,
    }).outputSync();
    Deno.removeSync(input);
    return { code: out.code, stderr: out.stderr };
  });
  return createYurt(transport, {
    current: () => "running",
    ready: Promise.resolve(),
  });
}

/** A chmod that behaves as the guest's must be served: it refuses a
 * symlink, whose own mode the guest's chmod would change
 * (yurtos-kernel#3038), and otherwise runs the real chmod. It also takes
 * the `--` that macOS chmod lacks. */
const GUEST_CHMOD = `chmod() {
  m=$1; shift
  [ "$1" = -- ] && shift
  if [ -L "$1" ]; then echo "chmod: $1: a symlink" >&2; return 1; fi
  command chmod "$m" "$1"
}`;

Deno.test("an atomic write through a symlink writes the target and keeps the link", async () => {
  // #166: `mv -f tmp link` replaced the link with a regular file and left
  // the target's old content. Linux open(O_TRUNC) writes through it.
  for (const sh of realShells()) {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${dir}/data`);
      await Deno.writeTextFile(`${dir}/data/real`, "old");
      // Absolute, relative, and a chain of two with a relative `..` hop.
      await Deno.symlink(`${dir}/data/real`, `${dir}/abs`);
      await Deno.symlink("data/real", `${dir}/rel`);
      await Deno.mkdir(`${dir}/links`);
      await Deno.symlink("../rel", `${dir}/links/chain`);
      const yurt = shellYurt(sh, dir);
      for (const link of ["abs", "rel", "links/chain"]) {
        const what = `${sh} ${link}`;
        await yurt.fs.write(`${dir}/${link}`, `new ${link}`);
        assert(Deno.lstatSync(`${dir}/${link}`).isSymlink, what);
        assertEquals(
          Deno.readTextFileSync(`${dir}/data/real`),
          `new ${link}`,
          what,
        );
      }
      assertEquals(Deno.readLinkSync(`${dir}/rel`), "data/real");
      assertEquals(
        [...Deno.readDirSync(`${dir}/data`)].map((e) => e.name),
        ["real"],
        sh,
      );
      assertEquals(
        [...Deno.readDirSync(dir)].map((e) => e.name).sort(),
        ["abs", "data", "links", "rel"],
        sh,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("an atomic write to a dangling symlink creates its target, as O_CREAT does", async () => {
  for (const sh of realShells()) {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.symlink("made", `${dir}/dangling`);
      const yurt = shellYurt(sh, dir);
      await yurt.fs.write(`${dir}/dangling`, "created");
      assert(Deno.lstatSync(`${dir}/dangling`).isSymlink, sh);
      assertEquals(Deno.readTextFileSync(`${dir}/made`), "created", sh);
      assertEquals(
        [...Deno.readDirSync(dir)].map((e) => e.name).sort(),
        ["dangling", "made"],
        sh,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("an atomic write to a symlink to a directory fails as the directory does", async () => {
  for (const sh of realShells()) {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${dir}/sub`);
      await Deno.symlink("sub", `${dir}/link`);
      const yurt = shellYurt(sh, dir);
      const error = await assertRejects(() =>
        yurt.fs.write(`${dir}/link`, "x")
      );
      assertEquals(
        (error as Error).message,
        `write ${dir}/link: exit 1: ${dir}/link: Is a directory`,
        sh,
      );
      assert(Deno.lstatSync(`${dir}/link`).isSymlink, sh);
      assertEquals([...Deno.readDirSync(`${dir}/sub`)], [], sh);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("an atomic write to a symlink loop fails as one and writes nothing", async () => {
  for (const sh of realShells()) {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.symlink("b", `${dir}/a`);
      await Deno.symlink("a", `${dir}/b`);
      const yurt = shellYurt(sh, dir);
      const error = await assertRejects(() => yurt.fs.write(`${dir}/a`, "x"));
      assertEquals(
        (error as Error).message,
        `write ${dir}/a: exit 1: ${dir}/a: Symbolic link loop`,
        sh,
      );
      assertEquals(
        [...Deno.readDirSync(dir)].map((e) => e.name).sort(),
        ["a", "b"],
        sh,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("a write through a symlink with a mode chmods the target, atomic or not", async () => {
  // The guest's chmod of a symlink changes the link (yurtos-kernel#3038),
  // so both write lines must hand chmod the resolved file. GUEST_CHMOD
  // refuses a link and otherwise runs the real chmod.
  for (const sh of realShells()) {
    for (const atomic of [true, false]) {
      const dir = await Deno.makeTempDir();
      const what = `${sh} atomic=${atomic}`;
      try {
        await Deno.writeTextFile(`${dir}/real`, "old");
        Deno.chmodSync(`${dir}/real`, 0o644);
        await Deno.symlink("real", `${dir}/link`);
        const yurt = shellYurt(sh, dir, GUEST_CHMOD);
        await yurt.fs.write(`${dir}/link`, "new", { mode: 0o600, atomic });
        assert(Deno.lstatSync(`${dir}/link`).isSymlink, what);
        assertEquals(Deno.readTextFileSync(`${dir}/real`), "new", what);
        assertEquals(Deno.statSync(`${dir}/real`).mode! & 0o777, 0o600, what);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    }
  }
});

Deno.test("a failed atomic write keeps a file name that itself holds the temporary suffix", async () => {
  // A missing parent makes the temporary file's creation fail; the error
  // names the file asked for, `x.yurt-tmp.1`, in full, prefix included.
  for (const sh of realShells()) {
    const dir = await Deno.makeTempDir();
    try {
      const target = `${dir}/nodir/x.yurt-tmp.1`;
      const yurt = shellYurt(sh, dir);
      const error = await assertRejects(() => yurt.fs.write(target, "x"));
      const message = (error as Error).message;
      assert(message.startsWith(`write ${target}: exit `), `${sh}: ${message}`);
      assert(message.includes(`${target}: `), `${sh}: ${message}`);
      assert(!message.includes(".yurt-tmp.1.yurt-tmp."), `${sh}: ${message}`);
      assert(!message.includes("yurt-atomic-temp"), `${sh}: ${message}`);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("a symlink target is taken byte for byte: a trailing newline, spaces, quotes, $() and a leading -", async () => {
  // `$(readlink)` strips trailing newlines, which wrote `tail` for a link
  // to "tail\n". The other names would break a line that lost quoting;
  // `$(touch pwned)` would leave a file behind.
  const names = ["tail\n", `-a b'c"$(touch pwned)`];
  for (const sh of realShells()) {
    for (const atomic of [true, false]) {
      for (const name of names) {
        for (const absolute of [false, true]) {
          const dir = await Deno.makeTempDir();
          const what = `${sh} atomic=${atomic} ${JSON.stringify(name)} ${
            absolute ? "absolute" : "relative"
          }`;
          try {
            await Deno.symlink(absolute ? `${dir}/${name}` : name, `${dir}/l`);
            const yurt = shellYurt(sh, dir, GUEST_CHMOD);
            await yurt.fs.write(`${dir}/l`, "through", { atomic, mode: 0o640 });
            assertEquals(
              Deno.readTextFileSync(`${dir}/${name}`),
              "through",
              what,
            );
            assertEquals(
              Deno.statSync(`${dir}/${name}`).mode! & 0o777,
              0o640,
              what,
            );
            assert(Deno.lstatSync(`${dir}/l`).isSymlink, what);
            assertEquals(
              [...Deno.readDirSync(dir)].map((e) => e.name).sort(),
              [name, "l"].sort(),
              what,
            );
          } finally {
            await Deno.remove(dir, { recursive: true });
          }
        }
      }
    }
  }
});

Deno.test("a write follows 40 symlinks and calls the 41st a loop", async () => {
  for (const sh of realShells()) {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(`${dir}/real`, "old");
      // l1 -> l2 -> ... -> l41 -> real: from l2 that is 40 links, from
      // l1 41.
      for (let i = 1; i <= 41; i++) {
        await Deno.symlink(i === 41 ? "real" : `l${i + 1}`, `${dir}/l${i}`);
      }
      const yurt = shellYurt(sh, dir, GUEST_CHMOD);
      // The non-atomic write's `cat >` has the host kernel follow the
      // chain, and macOS stops at 32, so only the atomic line is held to
      // 40. Both refuse 41 before anything is opened.
      await yurt.fs.write(`${dir}/l2`, "40", { mode: 0o600 });
      for (const atomic of [true, false]) {
        const what = `${sh} atomic=${atomic}`;
        assertEquals(Deno.readTextFileSync(`${dir}/real`), "40", what);
        const error = await assertRejects(() =>
          yurt.fs.write(`${dir}/l1`, "41", { atomic, mode: 0o600 })
        );
        assertEquals(
          (error as Error).message,
          `write ${dir}/l1: exit 1: ${dir}/l1: Symbolic link loop`,
          what,
        );
        assertEquals(Deno.readTextFileSync(`${dir}/real`), "40", what);
      }
      assertEquals(Deno.statSync(`${dir}/real`).mode! & 0o777, 0o600, sh);
      assertEquals([...Deno.readDirSync(dir)].length, 42, sh);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
