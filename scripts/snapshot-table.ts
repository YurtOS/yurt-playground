#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * snapshot-table.ts -- the README's table of the sandbox snapshots in use
 * (src/snapshot_pin.ts SNAPSHOT_KINDS), made from artifacts/pins.json
 * so it cannot go stale: kind, the device that restores it, release, file
 * size, kernel memory, the renderer's measured peak while restoring it
 * (the RAM it needs; scripts/measure-boot.ts), and what is in that Linux.
 *
 * Usage: deno run -A scripts/snapshot-table.ts          rewrite README.md
 *        deno run -A scripts/snapshot-table.ts --check  exit 1 on drift
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSnapshotPin, type SnapshotPin } from "../src/pins.ts";
import {
  SNAPSHOT_KIND_NAMES,
  SNAPSHOT_KINDS,
} from "../src/sandbox_snapshot.ts";

export const TABLE_START =
  "<!-- snapshot-table:start (scripts/snapshot-table.ts) -->";
export const TABLE_END = "<!-- snapshot-table:end -->";

const DEVICE = {
  desktop: "desktop browser (Mac, PC): `?platform=desktop`",
  tablet: "tablet (iPad): `?platform=tablet`",
  phone: "phone (iPhone): `?platform=phone`",
  go: "desktop browser that chose Go: `?platform=desktop&env=go`",
};

const MIB = 1024 * 1024;

/** The table for `pins` (pins.json as written). */
export function snapshotTable(pins: Record<string, unknown>): string {
  const rows = SNAPSHOT_KIND_NAMES.map((kind) => {
    const { pinKey } = SNAPSHOT_KINDS[kind];
    const entry = pins[pinKey];
    let pin: SnapshotPin | undefined;
    try {
      pin = entry === undefined ? undefined : parseSnapshotPin(entry);
    } catch {
      pin = undefined;
    }
    if (pin === undefined) {
      return `| ${kind} | ${
        DEVICE[kind]
      } | not pinned: boots the image | | | | |`;
    }
    const mb = (pin.size / 1e6).toFixed(1);
    const memory = pin.memoryBytes === undefined
      ? "?"
      : `${(pin.memoryBytes / MIB).toFixed(1)} MiB`;
    const peak = pin.restorePeakMiB === undefined
      ? "?"
      : `${pin.restorePeakMiB} MiB`;
    return `| ${kind} | ${
      DEVICE[kind]
    } | \`${pin.release}\` | ${mb} MB in ${pin.parts.length} parts | ${memory} | ${peak} | ${
      pin.contents?.remark ?? "?"
    } |`;
  });
  return [
    TABLE_START,
    // Kept as generated: the formatter would align the columns.
    "<!-- deno-fmt-ignore-start -->",
    "",
    `Train \`${pins.train}\`. Generated from artifacts/pins.json; \`deno run -A scripts/snapshot-table.ts\` rewrites it.`,
    "",
    "The desktop's holds the Python set and starts the Notebook, the tablet's the interpreter alone, the phone's no Python; Go's, which a desktop browser restores when Go is chosen, holds the go package and its standard library already compiled, and no Python. A snapshot is sealed with no process in it, so nothing runs or is imported until a restore starts the shell (and, on a desktop, Jupyter). `deno run -A scripts/verify-snapshots.ts [--files] [--live]` checks each against its kind.",
    "",
    "| Kind | Restored by | Release | Download | Kernel memory | RAM to restore (peak) | This Linux |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "<!-- deno-fmt-ignore-end -->",
    TABLE_END,
  ].join("\n");
}

/** `readme` with its table replaced by `table`; throws without markers. */
export function withTable(readme: string, table: string): string {
  const start = readme.indexOf(TABLE_START);
  const end = readme.indexOf(TABLE_END);
  if (start < 0 || end < start) {
    throw new Error("README.md has no snapshot-table markers");
  }
  return readme.slice(0, start) + table + readme.slice(end + TABLE_END.length);
}

if (import.meta.main) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const pins = JSON.parse(
    await Deno.readTextFile(join(root, "artifacts/pins.json")),
  );
  const path = join(root, "README.md");
  const readme = await Deno.readTextFile(path);
  const updated = withTable(readme, snapshotTable(pins));
  if (Deno.args.includes("--check")) {
    if (updated !== readme) {
      console.error(
        "README.md's snapshot table is stale: run deno run -A scripts/snapshot-table.ts",
      );
      Deno.exit(1);
    }
  } else if (updated !== readme) {
    await Deno.writeTextFile(path, updated);
  }
}
