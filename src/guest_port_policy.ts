/**
 * Whether a guest Worker gets a port straight to its coordinator, or has
 * its messages relayed through the page (`src/page_worker_bridge.ts`).
 *
 * The direct port keeps a guest's shared `WebAssembly.Memory` out of the
 * page's heap. That fixed Chromium (100/100 `yurt.exec` against 57-60). On
 * Safari it only helps once each process reserves less than the whole
 * sandbox budget (yurtos-kernel#2996): with 1 GiB reservations it measured
 * worse than the relay (5-7/100 against 59/100). So on JavaScriptCore the
 * port is direct only when the bundled kernel honours a per-process
 * reservation (yurtos-kernel#3115, marked by its `guestMemoryMaximumPages`
 * export) AND this playground sets one for the engine (#179's
 * `playgroundHostState`). Anything else on JavaScriptCore keeps the relay.
 */
import * as kernelHostInterface from "@yurt/kernel-host-interface-js";

/** JavaScriptCore: `AppleWebKit/` without `Chrome/` (Safari and every iOS
 *  browser), the kernel's `workerTeardownWaitsOnCompiles` test. */
function isJavaScriptCore(userAgent: string | undefined): boolean {
  if (userAgent === undefined) return false;
  return /AppleWebKit\//.test(userAgent) && !/Chrome\//.test(userAgent);
}

export function directGuestPort(options: {
  userAgent?: string;
  kernel?: Record<string, unknown>;
  /** The per-process reservation this playground passes the kernel, if
   *  any. Nothing on this branch sets one; #179 does. */
  reservationBytes?: number;
} = {}): boolean {
  const userAgent = "userAgent" in options
    ? options.userAgent
    : globalThis.navigator?.userAgent;
  if (!isJavaScriptCore(userAgent)) return true;
  const kernel = options.kernel ??
    (kernelHostInterface as unknown as Record<string, unknown>);
  return typeof kernel.guestMemoryMaximumPages === "function" &&
    options.reservationBytes !== undefined;
}
