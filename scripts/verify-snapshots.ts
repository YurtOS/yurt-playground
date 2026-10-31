#!/usr/bin/env -S deno run --allow-all
/**
 * verify-snapshots.ts -- each pinned sandbox snapshot holds what its kind
 * is for (src/snapshot_pin.ts SNAPSHOT_KINDS), and no more:
 *
 *   desktop  the Python set (src/python_install.ts PYTHON_SET: python,
 *            numpy, pyzmq, jupyter-kernel); the Notebook starts on it
 *   tablet   the interpreter alone (TABLET_PYTHON_SET); no Jupyter
 *   phone    no Python at all ("Python not on phones")
 *
 * and they are ordered by what they hold: desktop > tablet > phone in
 * download size, kernel memory and the RAM a restore takes. A snapshot is
 * a seal with no process in it (src/sandbox_snapshot.ts refuses one with
 * any), so nothing is running or imported at capture: what differs is what
 * is installed (and precompiled) in its Linux, and what a restore starts.
 *
 * Usage: deno run -A scripts/verify-snapshots.ts [--files] [--live [--kind K]]
 *
 *   (none)   check artifacts/pins.json's three snapshot pins: present,
 *            each kind's packages (the capture's pkg list), its Python set
 *            key, the sizes and their order. Exit 1 with one line per
 *            problem. Run it once a train's snapshots are pinned and
 *            measured: mid-train, release-playground.sh drops the pins and
 *            each capture adds one, so the fast test
 *            (tests/verify_snapshots_test.ts) checks the committed pins
 *            with `complete: false` (the pins present, and their order)
 *   --files  also read each installed file in public/snapshot/
 *            (YURT_INSTALL_SNAPSHOT=1 scripts/install-pinned-artifacts.sh):
 *            its sha256 and its header's memory and contents are the pin's
 *   --live   also restore each one in headless Chromium in its device's
 *            emulation (`?start&platform=<kind>`), and probe the restored
 *            Linux through window.yurt: `ps`, `command -v python3`, the
 *            imports, /proc/meminfo, `df`, and on the desktop the
 *            Notebook's start. Prints one JSON line per kind
 *   --kind   only this kind, for --live
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSnapshotPin, type SnapshotPin } from "../src/pins.ts";
import {
  SNAPSHOT_KIND_NAMES,
  SNAPSHOT_KINDS,
  type SnapshotKind,
  TABLET_PYTHON_SET,
} from "../src/snapshot_pin.ts";
import { PYTHON_SET } from "../src/python_install.ts";

/** What each kind holds and what a restore of it can do. */
export const SNAPSHOT_EXPECTED: Record<SnapshotKind, {
  /** Packages its pkg list must have. */
  has: readonly string[];
  /** Packages it must not have. */
  lacks: readonly string[];
  /** python3 is on the PATH after a restore. */
  python: boolean;
  /** Python modules that import after a restore. */
  imports: readonly string[];
  /** The Notebook (Jupyter) starts after a restore. */
  notebook: boolean;
}> = {
  desktop: {
    has: PYTHON_SET,
    lacks: [],
    python: true,
    imports: ["numpy", "zmq"],
    notebook: true,
  },
  tablet: {
    has: TABLET_PYTHON_SET,
    lacks: PYTHON_SET.filter((name) => !TABLET_PYTHON_SET.includes(name)),
    python: true,
    imports: [],
    notebook: false,
  },
  phone: {
    has: [],
    lacks: PYTHON_SET,
    python: false,
    imports: [],
    notebook: false,
  },
};

/** Largest first: each holds less than the one before it. */
export const SNAPSHOT_SIZE_ORDER: readonly SnapshotKind[] = [
  "desktop",
  "tablet",
  "phone",
];

/** Every problem with `pins`' snapshot entries; none is a pass. With
 * `complete: false` a kind that is not pinned, or not measured yet (no
 * restorePeakMiB), is no problem -- a train between its image and its
 * captures -- and the order is checked among the kinds present. */
export function verifySnapshotPins(
  pins: Record<string, unknown>,
  { complete = true }: { complete?: boolean } = {},
): string[] {
  const problems: string[] = [];
  const parsed: Partial<Record<SnapshotKind, SnapshotPin>> = {};
  for (const kind of SNAPSHOT_KIND_NAMES) {
    const { pinKey } = SNAPSHOT_KINDS[kind];
    const entry = pins[pinKey];
    if (entry === undefined) {
      if (complete) problems.push(`${kind}: no ${pinKey} pin`);
      continue;
    }
    let pin: SnapshotPin;
    try {
      pin = parseSnapshotPin(entry);
    } catch (error) {
      problems.push(`${kind}: ${pinKey} does not parse: ${error}`);
      continue;
    }
    parsed[kind] = pin;
    const expected = SNAPSHOT_EXPECTED[kind];
    if (pin.contents === undefined) {
      problems.push(`${kind}: the pin records no contents`);
    } else {
      const names = new Set(pin.contents.packages.map((p) => p.name));
      for (const name of expected.has) {
        if (!names.has(name)) problems.push(`${kind}: lacks ${name}`);
      }
      for (const name of expected.lacks) {
        if (names.has(name)) problems.push(`${kind}: holds ${name}`);
      }
    }
    const set = pin.builtFrom.pythonSet;
    if (expected.python && set === null) {
      problems.push(`${kind}: built with no Python set`);
    } else if (!expected.python && set !== null) {
      problems.push(`${kind}: built with a Python set (${set})`);
    } else if (set !== null) {
      const inSet = new Set(
        set.slice(set.indexOf("/") + 1).split("+").map((part) =>
          part.slice(0, part.indexOf("@"))
        ),
      );
      for (const name of expected.has) {
        if (!inSet.has(name)) {
          problems.push(`${kind}: its Python set key lacks ${name}`);
        }
      }
      for (const name of expected.lacks) {
        if (inSet.has(name)) {
          problems.push(`${kind}: its Python set key holds ${name}`);
        }
      }
    }
    if (pin.memoryBytes === undefined) {
      problems.push(`${kind}: the pin records no memoryBytes`);
    }
    if (complete && pin.restorePeakMiB === undefined) {
      problems.push(
        `${kind}: the pin records no restorePeakMiB (scripts/measure-boot.ts)`,
      );
    }
  }
  const measures: [string, (pin: SnapshotPin) => number | undefined][] = [
    ["size", (pin) => pin.size],
    ["memoryBytes", (pin) => pin.memoryBytes],
    ["restorePeakMiB", (pin) => pin.restorePeakMiB],
  ];
  for (const [name, of] of measures) {
    // Each measured kind against the next measured one: a kind missing
    // in between does not hide the order of the two around it.
    const measured = SNAPSHOT_SIZE_ORDER.filter((kind) =>
      parsed[kind] !== undefined && of(parsed[kind]!) !== undefined
    );
    for (let i = 1; i < measured.length; i++) {
      const bigger = measured[i - 1];
      const smaller = measured[i];
      const a = of(parsed[bigger]!)!;
      const b = of(parsed[smaller]!)!;
      if (!(a > b)) {
        problems.push(
          `${name}: ${bigger} (${a}) is not larger than ${smaller} (${b})`,
        );
      }
    }
  }
  return problems;
}

/** What a live restore of one kind showed. */
export type SnapshotProbe = {
  kind: SnapshotKind;
  /** The page restored the snapshot (did not boot the image instead). */
  restored: boolean;
  /** The kernel memory the restore reported, in bytes. */
  restoredBytes: number | null;
  processes: string[];
  python: boolean;
  /** Each probed module: whether it imported. */
  imports: Record<string, boolean>;
  notebook: boolean;
  memTotalKiB: number | null;
  df: string;
};

/** The modules a live probe tries, on every kind. */
export const PROBED_IMPORTS = ["numpy", "zmq"];

/** Every way `probe` differs from what its kind should do. */
export function verifySnapshotProbe(
  probe: SnapshotProbe,
  pin?: SnapshotPin,
): string[] {
  const { kind } = probe;
  const expected = SNAPSHOT_EXPECTED[kind];
  const problems: string[] = [];
  if (!probe.restored) problems.push(`${kind}: not restored from its snapshot`);
  if (
    pin?.memoryBytes !== undefined && probe.restoredBytes !== null &&
    probe.restoredBytes !== pin.memoryBytes
  ) {
    problems.push(
      `${kind}: restored ${probe.restoredBytes} bytes of kernel memory, the pin says ${pin.memoryBytes}`,
    );
  }
  if (probe.python !== expected.python) {
    problems.push(
      `${kind}: python3 is ${probe.python ? "" : "not "}on the PATH`,
    );
  }
  for (const [module, imported] of Object.entries(probe.imports)) {
    const should = expected.imports.includes(module);
    if (imported !== should) {
      problems.push(
        `${kind}: import ${module} ${imported ? "works" : "fails"}`,
      );
    }
  }
  if (probe.notebook !== expected.notebook) {
    problems.push(
      `${kind}: the Notebook ${probe.notebook ? "started" : "did not start"}`,
    );
  }
  return problems;
}

const DESCRIPTOR: Record<SnapshotKind, string | undefined> = {
  desktop: undefined,
  tablet: "iPad Pro 11",
  phone: "iPhone 13",
};

type PageYurt = {
  ready: Promise<unknown>;
  exec(
    command: string,
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
};

async function probeKind(
  kind: SnapshotKind,
  url: string,
): Promise<SnapshotProbe> {
  const { chromium, devices } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const name = DESCRIPTOR[kind];
    const context = await browser.newContext(
      name === undefined ? {} : devices[name],
    );
    const page = await context.newPage();
    const logs: string[] = [];
    page.on("console", (message) => logs.push(message.text()));
    await page.goto(`${url}/?start&platform=${kind}`);
    await page.waitForFunction(
      () => (globalThis as { yurt?: unknown }).yurt !== undefined,
      undefined,
      { timeout: 60_000 },
    );
    await page.evaluate(() =>
      (globalThis as unknown as { yurt: PageYurt }).yurt.ready
    );
    const exec = (command: string) =>
      page.evaluate(
        (line) => (globalThis as unknown as { yurt: PageYurt }).yurt.exec(line),
        command,
      );
    const python = (await exec("command -v python3")).code === 0;
    const imports: Record<string, boolean> = {};
    for (const module of PROBED_IMPORTS) {
      imports[module] = python &&
        (await exec(`python3 -c 'import ${module}'`)).code === 0;
    }
    let notebook = false;
    if (kind === "desktop") {
      notebook = await page.waitForFunction(
        () =>
          document.querySelector("[data-testid=notebook-status]")
            ?.textContent === "ready",
        undefined,
        { timeout: 300_000, polling: 250 },
      ).then(() => true, () => false);
    } else {
      // Given the time a desktop's start takes after its shell, so a
      // late start shows.
      notebook = await page.waitForFunction(
        () =>
          document.querySelector("[data-testid=notebook-status]")
            ?.textContent === "ready",
        undefined,
        { timeout: 30_000, polling: 250 },
      ).then(() => true, () => false);
    }
    // After the Notebook's start, so its kernel shows.
    const ps = await exec("ps -o pid,user,args");
    const meminfo = (await exec("cat /proc/meminfo")).stdout;
    const df = (await exec("df -k")).stdout.trim();
    const line = logs.find((text) => /bytes of kernel memory/.test(text));
    const bytes = line?.match(/(\d+) bytes of kernel memory/)?.[1];
    const memTotal = meminfo.match(/MemTotal:\s+(\d+)/)?.[1];
    return {
      kind,
      restored: line !== undefined &&
        !logs.some((text) => /booting the image instead/.test(text)),
      restoredBytes: bytes === undefined ? null : Number(bytes),
      processes: ps.stdout.trim().split("\n").slice(1).map((row) => row.trim()),
      python,
      imports,
      notebook,
      memTotalKiB: memTotal === undefined ? null : Number(memTotal),
      df,
    };
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const pins = JSON.parse(
    await Deno.readTextFile(join(root, "artifacts/pins.json")),
  );
  const problems = verifySnapshotPins(pins);
  const pinOf = (kind: SnapshotKind): SnapshotPin | undefined => {
    try {
      return parseSnapshotPin(pins[SNAPSHOT_KINDS[kind].pinKey]);
    } catch {
      return undefined;
    }
  };
  if (Deno.args.includes("--files")) {
    const { sha256Hex } = await import("../src/integrity.ts");
    const { snapshotHeaderFacts } = await import("../src/sandbox_snapshot.ts");
    for (const kind of SNAPSHOT_KIND_NAMES) {
      const pin = pinOf(kind);
      if (pin === undefined) continue;
      const path = join(root, "public", SNAPSHOT_KINDS[kind].name);
      const bytes = await Deno.readFile(path).catch(() => undefined);
      if (bytes === undefined) {
        problems.push(`${kind}: no file ${path}`);
        continue;
      }
      if (await sha256Hex(bytes) !== pin.sha256) {
        problems.push(`${kind}: ${path} is not the pinned file`);
      }
      const facts = await snapshotHeaderFacts(new Blob([bytes]).stream());
      if (facts.memoryBytes !== pin.memoryBytes) {
        problems.push(
          `${kind}: the file's memoryBytes ${facts.memoryBytes} is not the pin's ${pin.memoryBytes}`,
        );
      }
      if (JSON.stringify(facts.contents) !== JSON.stringify(pin.contents)) {
        problems.push(`${kind}: the file's contents are not the pin's`);
      }
    }
  }
  if (Deno.args.includes("--live")) {
    const at = Deno.args.indexOf("--kind");
    const only = at < 0 ? undefined : (Deno.args[at + 1] ?? "") as SnapshotKind;
    if (only !== undefined && !SNAPSHOT_KIND_NAMES.includes(only)) {
      console.error(
        `--kind takes one of ${SNAPSHOT_KIND_NAMES.join(", ")}, not ${only}`,
      );
      Deno.exit(2);
    }
    const { ensureBundle } = await import("./serve.ts");
    const { handlePlaygroundRequest } = await import("../src/serve.ts");
    await ensureBundle();
    const server = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      handlePlaygroundRequest,
    );
    try {
      for (const kind of SNAPSHOT_KIND_NAMES) {
        if (only !== undefined && kind !== only) continue;
        const probe = await probeKind(
          kind,
          `http://127.0.0.1:${server.addr.port}`,
        );
        console.log(JSON.stringify(probe));
        problems.push(...verifySnapshotProbe(probe, pinOf(kind)));
      }
    } finally {
      await server.shutdown();
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`snapshot: ${problem}`);
    Deno.exit(1);
  }
  console.log("snapshots verified: " + SNAPSHOT_KIND_NAMES.join(", "));
}
