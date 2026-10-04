import { GUEST_HTTP_TIMEOUT_MS, GuestHttpError } from "./guest_http.ts";

/** Buffered request and response bytes reserved by one session. */
export class ByteBudget {
  #used = 0;

  constructor(private readonly limit = 64 * 1024 * 1024) {}

  take(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError("invalid byte reservation");
    }
    if (bytes > this.limit - this.#used) {
      throw new GuestHttpError("session buffer limit", 503);
    }
    this.#used += bytes;
  }

  give(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new RangeError("invalid byte release");
    }
    this.#used = Math.max(0, this.#used - bytes);
  }
}

export interface SlotLimits {
  perSession: number;
  global: number;
  maxWaiting: number;
  waitMs: number;
}

export const SLOT_LIMITS: SlotLimits = {
  perSession: 4,
  global: 16,
  maxWaiting: 64,
  waitMs: 30_000,
};

/** Queue wait, client HTTP deadline, then service worker scheduling slack. */
export const REQUEST_DEADLINE_MS = SLOT_LIMITS.waitMs +
  GUEST_HTTP_TIMEOUT_MS + 5_000;

interface Waiter {
  session: string;
  grant(release: () => void): void;
}

/** Bounds concurrent guest dials while preserving FIFO order per session. */
export class SlotQueue {
  #active = new Map<string, number>();
  #total = 0;
  #waiting: Waiter[] = [];

  constructor(private readonly limits: SlotLimits = SLOT_LIMITS) {}

  #free(session: string): boolean {
    return this.#total < this.limits.global &&
      (this.#active.get(session) ?? 0) < this.limits.perSession;
  }

  #take(session: string): () => void {
    this.#total++;
    this.#active.set(session, (this.#active.get(session) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#total--;
      const left = (this.#active.get(session) ?? 1) - 1;
      if (left === 0) this.#active.delete(session);
      else this.#active.set(session, left);
      this.#pump();
    };
  }

  #pump(): void {
    for (let i = 0; i < this.#waiting.length;) {
      const waiter = this.#waiting[i];
      if (this.#free(waiter.session)) {
        this.#waiting.splice(i, 1);
        waiter.grant(this.#take(waiter.session));
      } else {
        i++;
      }
    }
  }

  acquire(session: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason ?? new DOMException("Aborted", "AbortError"),
      );
    }
    const queued =
      this.#waiting.filter((waiter) => waiter.session === session).length;
    if (queued === 0 && this.#free(session)) {
      return Promise.resolve(this.#take(session));
    }
    if (queued >= this.limits.maxWaiting) {
      return Promise.reject(
        new GuestHttpError("too many queued guest requests", 503),
      );
    }
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const waiter: Waiter = {
        session,
        grant: (release) => {
          done();
          resolve(release);
        },
      };
      const drop = (error: unknown) => {
        const at = this.#waiting.indexOf(waiter);
        if (at >= 0) this.#waiting.splice(at, 1);
        done();
        reject(error);
      };
      const onAbort = () =>
        drop(signal!.reason ?? new DOMException("Aborted", "AbortError"));
      const timer = setTimeout(
        () => drop(new GuestHttpError("guest request queue timeout", 503)),
        this.limits.waitMs,
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiting.push(waiter);
    });
  }
}
