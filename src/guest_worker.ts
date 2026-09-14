/**
 * The only Worker the page will create for the coordinator.
 *
 * WorkerHost asks for its bootstrap by source path (`./worker_bootstrap.ts`
 * relative to the coordinator bundle); the page serves the bundled
 * `/worker_bootstrap.js` instead. The request crosses the coordinator
 * boundary, so it is matched, not trusted: only a same-origin URL whose
 * final path segment is the bootstrap resolves, and everything else is
 * refused. Chrome starts a nested guest only as a module Worker from a
 * classic parent.
 */
export const GUEST_WORKER_PATH = "/worker_bootstrap.js";

export class GuestWorkerRefused extends Error {
  constructor(requested: string) {
    super(`refused to start a guest worker at ${JSON.stringify(requested)}`);
    this.name = "GuestWorkerRefused";
  }
}

export function guestWorkerStart(
  scriptURL: string | URL,
  origin: string,
): [string, WorkerOptions] {
  const requested = String(scriptURL);
  let url: URL;
  try {
    url = new URL(requested, `${origin}/`);
  } catch {
    throw new GuestWorkerRefused(requested);
  }
  const name = url.pathname.split("/").pop() ?? "";
  if (
    url.origin !== origin ||
    !/^worker_bootstrap\.(ts|js)$/.test(name)
  ) {
    throw new GuestWorkerRefused(requested);
  }
  return [new URL(GUEST_WORKER_PATH, origin).href, { type: "module" }];
}
