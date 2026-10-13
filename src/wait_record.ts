/**
 * The kernel's own record of how a process ended, read where the host
 * reaps the processes it started (yurt-playground#204).
 *
 * The kernel host interface hands the page two lossy forms of it:
 * `runStartAsync()` folds a signal death into 128+n, and
 * `reapHostChild().status` is the signal number or the exit code, so exit
 * 9 and SIGKILL are the same 9. The `yurt_wait_result_v2` record that
 * `kernel_wait` writes keeps them apart -- pid, exit code, signal and
 * flags (i32 LE each), then two u64 CPU times -- and the private
 * `SYS_WAIT` method returns it to any caller, the host (pid 0) included.
 */
import type { WaitStatus } from "./executions.ts";

/** Bytes in a `yurt_wait_result_v2` record. */
export const WAIT_RECORD_LEN = 32;
/** The record's flags bit for `WCOREDUMP`. */
const WAIT_FLAG_CORE = 1;

/** The wait status in a `yurt_wait_result_v2` record. */
export function decodeWaitRecord(record: Uint8Array): WaitStatus {
  if (record.byteLength < WAIT_RECORD_LEN) {
    throw new Error(`a wait record is ${record.byteLength} bytes, not 32`);
  }
  const view = new DataView(record.buffer, record.byteOffset, WAIT_RECORD_LEN);
  const code = view.getInt32(4, true);
  const signal = view.getInt32(8, true);
  const flags = view.getInt32(12, true);
  if (signal > 0) {
    return { code: null, signal, coreDumped: (flags & WAIT_FLAG_CORE) !== 0 };
  }
  return { code, signal: null, coreDumped: false };
}

/** The `SYS_WAIT` request: this child, without blocking (WNOHANG). */
export function waitRequest(pid: number): Uint8Array {
  const request = new Uint8Array(8);
  const view = new DataView(request.buffer);
  view.setUint32(0, pid, true);
  view.setUint32(4, 1, true);
  return request;
}
