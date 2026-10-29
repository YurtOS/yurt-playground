/**
 * The page's side of the Packages panel's installs (src/page.ts): each is
 * a `pkg-install` request to the coordinator worker, which runs it
 * (src/coordinator_worker.ts `servePackages`) and answers with
 * `pkg-progress` messages and one `pkg-reply`.
 *
 * The page keeps its own deadline on that answer. The coordinator gives
 * up on an install that stops making progress (src/packages.ts
 * `INSTALL_STALL_MS`, `INSTALL_RUN_CEILING_MS`) and replies, but those
 * timers run on its own event loop: a coordinator blocked inside the
 * kernel (a kernel deadlock during a large install) runs none of them and
 * never answers. The page stays responsive, so this deadline lives here.
 */

/** How long the coordinator may say nothing at all -- no message of any
 * kind -- while an install waits on it, before the page calls the sandbox
 * unresponsive. A working coordinator is never this quiet: a running
 * install reports progress every few seconds and gives up by itself after
 * `INSTALL_STALL_MS` without any, and one queued behind the Python install
 * waits through that install's own status messages. Five minutes, the
 * coordinator's longest single run (`INSTALL_RUN_CEILING_MS`). */
export const INSTALL_SILENCE_MS = 300_000;

/** What the Packages panel says when the deadline passes. There is no
 * other way back: the coordinator that stopped is the sandbox's. */
export function sandboxStoppedResponding(name: string): string {
  return `The sandbox stopped responding while installing ${name}. ` +
    "Reload the page to start a fresh sandbox.";
}

/** The coordinator stopped answering, or failed: the install ends with
 * this, and so does every later one, without reaching the coordinator. */
export class InstallsStopped extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallsStopped";
  }
}

export type InstallProgress = {
  type: "pkg-progress";
  req: number;
  text: string;
};
export type InstallReply = {
  type: "pkg-reply";
  req: number;
  ok: boolean;
  value?: unknown;
  error?: string;
};

/** The page's installs in flight. `send` posts the request for `name`
 * numbered `req`; the coordinator's messages come back through `heard`
 * (every message) and `answer` (this install's own). An install that
 * hears nothing for `silenceMs` fails, and is forgotten: what the
 * coordinator says about it later is ignored. From then on, and after
 * `failAll`, every install is refused without being sent. */
export function packageRequests(
  send: (req: number, name: string) => void,
  silenceMs = INSTALL_SILENCE_MS,
) {
  let nextReq = 1;
  /** Why installs end without reaching the coordinator, once they do. */
  let stopped: InstallsStopped | undefined;
  const waiting = new Map<number, {
    progress: (text: string) => void;
    resolve: (output: string) => void;
    reject: (error: Error) => void;
    /** Start the silence deadline again. */
    rearm: () => void;
  }>();
  return {
    install(name: string, progress: (text: string) => void): Promise<string> {
      if (stopped !== undefined) return Promise.reject(stopped);
      return new Promise<string>((resolve, reject) => {
        const req = nextReq++;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = () => {
          clearTimeout(timer);
          waiting.delete(req);
        };
        const rearm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            done();
            stopped = new InstallsStopped(sandboxStoppedResponding(name));
            reject(stopped);
          }, silenceMs);
        };
        waiting.set(req, {
          progress,
          resolve: (output) => {
            done();
            resolve(output);
          },
          reject: (error) => {
            done();
            reject(error);
          },
          rearm,
        });
        rearm();
        send(req, name);
      });
    },
    /** The coordinator failed (its worker's `error`): nothing will answer
     * the installs in flight, or any later one. */
    failAll(message: string) {
      stopped = new InstallsStopped(message);
      for (const waiter of waiting.values()) waiter.reject(stopped);
    },
    /** Any message at all from the coordinator: it is still running. */
    heard() {
      for (const waiter of waiting.values()) waiter.rearm();
    },
    answer(msg: InstallProgress | InstallReply) {
      const waiter = waiting.get(msg.req);
      if (waiter === undefined) return;
      if (msg.type === "pkg-progress") waiter.progress(msg.text);
      else if (msg.ok) waiter.resolve(msg.value as string);
      else waiter.reject(new Error(msg.error ?? "the install failed"));
    },
  };
}
