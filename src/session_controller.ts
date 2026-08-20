export interface PtyTransport {
  write(bytes: Uint8Array): Promise<void>;
  close(): void;
}

export interface JupyterTransport {
  send(message: Uint8Array): Promise<void>;
  subscribe(listener: (message: Uint8Array) => void): () => void;
  close(): void;
}

export interface SessionTransportSet {
  pty: PtyTransport;
  jupyter?: JupyterTransport;
}

export type SessionState =
  | "booting"
  | "ready"
  | "quiescing"
  | "restoring"
  | "failed";

export interface SessionController {
  readonly state: SessionState;
  readonly current: SessionTransportSet;
  quiesce(): Promise<void>;
  commitTransportSwap(next: SessionTransportSet): Promise<void>;
  rollback(): Promise<void>;
}

export function createSessionController(
  initial: SessionTransportSet,
): SessionController {
  let state: SessionState = "ready";
  let current = initial;
  let previous: SessionTransportSet | undefined;

  return {
    get state() {
      return state;
    },
    get current() {
      return current;
    },
    async quiesce() {
      if (state !== "ready") {
        throw new Error(`cannot quiesce session in ${state} state`);
      }
      state = "quiescing";
      previous = current;
      // The controller owns the lifecycle boundary. Callers stop accepting
      // user input before entering restore preparation; transports remain
      // attached until commit or rollback decides their fate.
      await Promise.resolve();
      state = "restoring";
    },
    commitTransportSwap(next) {
      return Promise.resolve().then(() => {
        if (state !== "restoring") {
          throw new Error("transport swap requires a quiesced session");
        }
        const old = current;
        current = next;
        previous = undefined;
        state = "ready";
        closeTransportSet(old, next);
      });
    },
    rollback() {
      return Promise.resolve().then(() => {
        if (state !== "restoring" && state !== "quiescing") {
          throw new Error(`cannot roll back session in ${state} state`);
        }
        if (previous !== undefined) current = previous;
        previous = undefined;
        state = "ready";
      });
    },
  };
}

function closeTransportSet(
  old: SessionTransportSet,
  next: SessionTransportSet,
): void {
  if (old.pty !== next.pty) old.pty.close();
  if (old.jupyter !== undefined && old.jupyter !== next.jupyter) {
    old.jupyter.close();
  }
}
