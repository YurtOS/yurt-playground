/**
 * Page half of the continuous-snapshot demo (public/snapshot.html): a
 * terminal on the demo's guest, a status line that says whether this run
 * booted or was restored, a seal ticker, and a reset control. The kernel
 * and the seal loop run in `snapshot_worker.ts`; guest Workers are created
 * here on the coordinator's behalf, as on the main page.
 */
import { attachGuestWorkerFactory } from "./page_worker_bridge.ts";
import { createPlaygroundTerminal } from "./terminal.ts";
import { RESTORE_MARKER } from "./snapshot_store.ts";
import type {
  SnapshotDemoFromWorker,
  SnapshotDemoToWorker,
} from "./snapshot_worker.ts";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`snapshot page: no #${id}`);
  return found as T;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString();
}

/**
 * What a driver (tests/snapshot_e2e.ts) can read off the page: everything
 * the guest wrote this run, how the run began, and the seal count. Mirrors
 * the main page's `window.yurt` in spirit: the page's own state, read-only.
 */
export type SnapshotDemoDriver = {
  output(): string;
  began(): "booting" | "booted" | "restored" | "failed";
  seals(): number;
};

declare global {
  var yurtSnapshotDemo: SnapshotDemoDriver | undefined;
}

export function startSnapshotDemo(): void {
  const status = element<HTMLElement>("status");
  const seals = element<HTMLElement>("seals");
  const reset = element<HTMLButtonElement>("reset");
  const term = createPlaygroundTerminal(element("terminal"));

  if (globalThis.crossOriginIsolated !== true) {
    status.textContent =
      "this page needs cross-origin isolation (COOP/COEP headers)";
    return;
  }

  const worker = new Worker("/snapshot.bundle.js");
  attachGuestWorkerFactory(worker);
  const send = (message: SnapshotDemoToWorker) => worker.postMessage(message);

  let sealCount = 0;
  let began: ReturnType<SnapshotDemoDriver["began"]> = "booting";
  const output: string[] = [];
  const decoder = new TextDecoder();
  globalThis.yurtSnapshotDemo = {
    output: () => output.join(""),
    began: () => began,
    seals: () => sealCount,
  };
  worker.onmessage = (event: MessageEvent<SnapshotDemoFromWorker>) => {
    const msg = event.data;
    switch (msg.type) {
      case "status":
        status.textContent = msg.text;
        break;
      case "out": {
        const bytes = new Uint8Array(msg.bytes);
        output.push(decoder.decode(bytes, { stream: true }));
        term.write(bytes);
        break;
      }
      case "booted":
        began = "booted";
        status.textContent = "booted fresh — no stored image";
        break;
      case "restored":
        began = "restored";
        status.textContent = `restored from the image sealed at ${
          clock(msg.sealedAt)
        } (${megabytes(msg.bytes)}); the guest continues where it was`;
        output.push(`\r\n${RESTORE_MARKER}\r\n`);
        term.write(`\r\n\x1b[33m${RESTORE_MARKER}\x1b[0m\r\n`);
        break;
      case "sealed":
        sealCount++;
        seals.textContent = `seal #${sealCount} at ${clock(msg.sealedAt)}: ${
          megabytes(msg.bytes)
        } in ${msg.ms} ms — close the tab whenever you like`;
        break;
      case "error":
        began = "failed";
        status.textContent = `error: ${msg.message}`;
        break;
    }
  };
  worker.onerror = (event) => {
    status.textContent = event.message || "coordinator worker failed";
  };

  term.onData((text) => send({ type: "in", text }));
  term.onResize((size) => send({ type: "resize", ...size }));
  reset.onclick = () => send({ type: "reset" });

  status.textContent = "starting";
  send({
    type: "start",
    cols: term.cols,
    rows: term.rows,
    isolated: globalThis.crossOriginIsolated === true,
  });
}

startSnapshotDemo();
