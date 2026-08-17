/** Chrome starts a nested guest only as a module Worker from a classic parent. */
export function guestWorkerStart(
  scriptURL: string | URL,
  origin: string,
): [string, WorkerOptions] {
  const href = String(scriptURL);
  const url = href.includes("worker_bootstrap")
    ? new URL("/worker_bootstrap.ts", origin).href
    : href;
  return [url, { type: "module" }];
}
