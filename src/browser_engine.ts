/**
 * The browser engine a page runs on. Kernel-free: src/jupyter.ts, which the
 * desktop app's acceptance test loads without the kernel checkout, asks it.
 */

/**
 * Whether this engine is JavaScriptCore (Safari, and every iOS browser).
 * Chromium and Edge also say `AppleWebKit/`, always with a `Chrome/`
 * token; Firefox and Deno say neither. The same test as the kernel's
 * `workerTeardownWaitsOnCompiles`.
 */
export function isJavaScriptCore(
  userAgent: string | undefined = globalThis.navigator?.userAgent,
): boolean {
  if (userAgent === undefined) return false;
  return /AppleWebKit\//.test(userAgent) && !/Chrome\//.test(userAgent);
}
