/**
 * The page's side of the Packages panel's installs (src/page.ts): each is
 * a `pkg-install` request to the coordinator worker, which runs it
 * (src/coordinator_worker.ts `servePackages`) and answers with
 * `pkg-progress` messages and one `pkg-reply`.
 */

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
 * (every message) and `answer` (this install's own). */
export function packageRequests(send: (req: number, name: string) => void) {
  let nextReq = 1;
  const waiting = new Map<number, {
    progress: (text: string) => void;
    resolve: (output: string) => void;
    reject: (error: Error) => void;
  }>();
  return {
    install(name: string, progress: (text: string) => void): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const req = nextReq++;
        waiting.set(req, {
          progress,
          resolve: (output) => {
            waiting.delete(req);
            resolve(output);
          },
          reject: (error) => {
            waiting.delete(req);
            reject(error);
          },
        });
        send(req, name);
      });
    },
    /** Any message at all from the coordinator. */
    heard() {},
    answer(msg: InstallProgress | InstallReply) {
      const waiter = waiting.get(msg.req);
      if (waiter === undefined) return;
      if (msg.type === "pkg-progress") waiter.progress(msg.text);
      else if (msg.ok) waiter.resolve(msg.value as string);
      else waiter.reject(new Error(msg.error ?? "the install failed"));
    },
  };
}
