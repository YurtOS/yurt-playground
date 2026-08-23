import { assert, assertEquals } from "@std/assert";
import { bootAshSession, typeCommand } from "./ash_harness.ts";

type Phase = {
  phase: string;
  elapsed_ms: number;
};

type RunRecord = {
  label: string;
  total_ms: number;
  phases: Phase[];
  connection_file: string;
};

const PHASES = ["ssl", "zmq", "ipykernel-import", "initialize"] as const;
const CONNECTION_FILE = "/tmp/yurt-jupyter-k.json";
const PYTHON_COMMAND =
  `python3 -c 'import json, time; t=time.monotonic(); import ssl; print(json.dumps({"phase":"ssl","elapsed_ms":round((time.monotonic()-t)*1000)}), flush=True); t=time.monotonic(); import zmq; print(json.dumps({"phase":"zmq","elapsed_ms":round((time.monotonic()-t)*1000)}), flush=True); t=time.monotonic(); from ipykernel.kernelapp import IPKernelApp; print(json.dumps({"phase":"ipykernel-import","elapsed_ms":round((time.monotonic()-t)*1000)}), flush=True); t=time.monotonic(); app=IPKernelApp.instance(); app.initialize(["-f", "${CONNECTION_FILE}"]); print(json.dumps({"phase":"initialize","elapsed_ms":round((time.monotonic()-t)*1000)}), flush=True); app.kernel.do_shutdown(False); raise SystemExit(0)'`;

function argumentValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function nonNegativeInt(value: string | undefined, flag: string): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error(`${flag} requires a non-negative integer`);
  }
  return Number(value);
}

function parsePhaseOutput(output: string): Phase[] {
  const phases: Phase[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as Partial<Phase>;
      if (
        typeof value.phase !== "string" ||
        typeof value.elapsed_ms !== "number"
      ) continue;
      phases.push({ phase: value.phase, elapsed_ms: value.elapsed_ms });
    } catch {
      // Shell output may contain prompts or other non-JSON lines.
    }
  }
  assertEquals(phases.map((phase) => phase.phase), [...PHASES]);
  assert(phases.every((phase) => Number.isFinite(phase.elapsed_ms)));
  return phases;
}

async function runOnce(
  label: string,
  session: NonNullable<Awaited<ReturnType<typeof bootAshSession>>>,
): Promise<RunRecord> {
  const started = performance.now();
  const output = await typeCommand(session.term, PYTHON_COMMAND, 240_000);
  await typeCommand(
    session.term,
    `python3 -c 'import json; d=json.load(open("${CONNECTION_FILE}")); assert all(k in d for k in ["shell_port", "iopub_port", "stdin_port", "control_port", "hb_port"])'`,
    10_000,
  );
  const phases = parsePhaseOutput(output);
  return {
    label,
    total_ms: Math.round(performance.now() - started),
    phases,
    connection_file: CONNECTION_FILE,
  };
}

function flattenResults(values: unknown[]): RunRecord[] {
  const records: RunRecord[] = [];
  for (const value of values) {
    if (Array.isArray(value)) records.push(...value as RunRecord[]);
    else records.push(value as RunRecord);
  }
  return records;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(paths: string[]): void {
  if (paths.length === 0) throw new Error("--summarize requires result files");
  const values = flattenResults(paths.map((path) => {
    const parsed = JSON.parse(Deno.readTextFileSync(path)) as unknown;
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(`malformed benchmark result: ${path}`);
    }
    return parsed;
  }));
  if (values.length === 0) throw new Error("no benchmark records");
  for (const phase of [...PHASES, "total_ms"] as const) {
    const samples = values.map((record) =>
      phase === "total_ms"
        ? record.total_ms
        : record.phases.find((item) => item.phase === phase)?.elapsed_ms
    );
    if (samples.some((sample) => typeof sample !== "number")) {
      throw new Error(`missing ${phase} sample`);
    }
    const numbers = samples as number[];
    console.log(
      `${phase}: median=${median(numbers)} max=${Math.max(...numbers)}`,
    );
  }
}

async function measure(args: string[]): Promise<void> {
  const label = argumentValue(args, "--run-label") ?? "run";
  const warmRunsArg = argumentValue(args, "--warm-runs");
  const warmupRunsArg = argumentValue(args, "--warmup-runs");
  const warmRuns = warmRunsArg === undefined
    ? 0
    : nonNegativeInt(warmRunsArg, "--warm-runs");
  const warmupRuns = warmupRunsArg === undefined
    ? 0
    : nonNegativeInt(warmupRunsArg, "--warmup-runs");
  if (warmRuns > 0 && warmupRunsArg === undefined) {
    throw new Error("--warm-runs requires distinct --warmup-runs");
  }
  const outputPath = argumentValue(args, "--json-out");
  const session = await bootAshSession({ requireArtifacts: true });
  if (session === undefined) {
    throw new Error("playground artifacts unavailable");
  }
  try {
    for (let index = 0; index < warmupRuns; index++) {
      await runOnce(`warmup-${index + 1}`, session);
    }
    const count = warmRuns > 0 ? warmRuns : 1;
    const records: RunRecord[] = [];
    for (let index = 0; index < count; index++) {
      records.push(
        await runOnce(count === 1 ? label : `${label}-${index + 1}`, session),
      );
    }
    if (outputPath === undefined) {
      console.log(JSON.stringify(count === 1 ? records[0] : records));
    } else {
      await Deno.writeTextFile(
        outputPath,
        JSON.stringify(count === 1 ? records[0] : records, null, 2),
      );
    }
  } finally {
    session.stop();
  }
}

if (import.meta.main) {
  const args = Deno.args;
  if (args.includes("--summarize")) {
    const index = args.indexOf("--summarize");
    summarize(args.slice(index + 1));
  } else if (args.includes("--single-run") || args.includes("--warm-runs")) {
    await measure(args);
  } else {
    throw new Error("use --single-run, --warm-runs, or --summarize");
  }
}
