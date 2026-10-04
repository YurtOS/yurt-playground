# Guest HTTP Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the Datasette-only service-worker bridge into a bridge for
qualified guest web apps, and ship a second app (a stdlib `wsgiref` preview
server) as the #168 demo.

**Architecture:** The bridge keeps its shape: service worker -> owner tab
(`MessagePort`) -> coordinator worker -> `requestGuestHttp` over
`dialSandboxPort`. Everything Datasette-specific (`/apps/datasette/`, port 8001,
`pins.datasette`) becomes a lookup in a small static registry. The coordinator
gains methods/bodies, a cookie jar, a bounded request queue and a shared
supervisor (`GuestApp`) extracted from `DatasetteDemo`.

**Tech Stack:** TypeScript on Deno, service worker + `MessageChannel`,
Playwright (e2e), guest CPython (`wsgiref`).

**Spec:**
[`docs/superpowers/specs/2026-10-03-guest-http-preview-design.md`](../specs/2026-10-03-guest-http-preview-design.md)
(PR #185). Read it first; this plan quotes its numbers and does not repeat its
rationale.

## Global Constraints

- CI gate is `deno fmt --check`, `deno lint`, `deno check '**/*.ts'`,
  `deno test --no-check` with
  `--allow-read --allow-write --allow-env
  --allow-net --allow-run`. Run
  `deno fmt` before every commit.
- Browser tab only; the desktop host is untouched (spec section 2).
- Registry ids: `datasette` (port 8001), `preview` (port 8002). `bridge-sw.js`
  and `_bridge` are reserved under `/apps/`.
- URL shape `/apps/<app>/<session>/`, session is a UUID. The SW script is
  `/apps/bridge-sw.js`, scope `/apps/`; unavailable page
  `/apps/_bridge/unavailable.html`.
- Methods: `GET HEAD POST PUT PATCH DELETE OPTIONS`. Body limit 16 MiB (413).
  Header block limit 64 KiB (431 on the request side).
- Limits: 4 concurrent guest dials per session, 16 global, 64 queued per
  session, 30 s queue wait, 64 MiB buffered per session; cookie jar 50 cookies,
  4 KiB per cookie, 32 KiB total.
- Request header allow-list: accept, accept-language, if-none-match,
  if-modified-since, if-match, if-unmodified-since, range, if-range,
  content-type, x-requested-with, x-csrf-token, x-csrftoken, x-xsrf-token,
  authorization. `Cookie` is injected by the coordinator.
- Response header allow-list: content-type, content-length, content-language,
  cache-control, etag, last-modified, location, content-disposition, vary,
  accept-ranges, content-range, allow, www-authenticate.
- No body rewriting, no streaming, no WebSockets, no new `datasette_*` module
  renames (spec section 8). New shared code goes in new modules.
- Message `type` strings keep their `datasette-*` names; routing is by an added
  `app` field.
- Follow AGENTS.md KISS: no options bags or knobs beyond what a task names.

## Review Focus

1. A page with 20+ parallel subresource requests loads fully (the queue absorbs
   the burst; nothing returns 503 or ECONNREFUSED). Tests: Task 3 (queue), Task
   13 (e2e).
2. A cookie value containing `=`, and two cookies with the same name and
   different `Path`. Test: Task 2.
3. A POST that answers `303` with a relative `Location` and a `Set-Cookie` on
   the same response (login flow): cookie stored, header stripped, redirect
   mapped. Tests: Task 4, Task 13.
4. An empty-body POST (`Content-Length: 0`) and a binary (non-UTF-8) body
   arriving byte-identical. Test: Task 4.
5. `HEAD`, `OPTIONS`, `204` and `304` responses carry no body and do not hang.
   Test: Task 4.
6. Stopping an app while requests are queued rejects them promptly (no 30 s
   hang). Test: Task 9.

---

## Task 1: Registry, ports, per-app qualification

**Files:**

- Create: `src/guest_apps.ts`
- Modify: `src/boot.ts:73,76`, `src/pins.ts` (add accessor, end of file)
- Test: `tests/guest_apps_test.ts`

**Interfaces:**

- Produces:
  - `GUEST_APPS: { datasette: GuestAppDef; preview: GuestAppDef }`
  - `type GuestAppId = "datasette" | "preview"`
  - `interface GuestAppDef { id: GuestAppId; port: number; title: string }`
  - `isGuestAppId(v: unknown): v is GuestAppId`
  - `appPrefix(app: GuestAppId, session: string): string` ->
    `/apps/<app>/<session>/`
  - `appInlineScriptHashes(pins: Pins, app: GuestAppId): string[] | undefined`
    (in `src/pins.ts`; `undefined` means unqualified)

- [ ] **Step 1: Write the failing test**

```ts
// tests/guest_apps_test.ts
import { assertEquals } from "@std/assert";
import { appPrefix, GUEST_APPS, isGuestAppId } from "../src/guest_apps.ts";
import { appInlineScriptHashes, parsePins } from "../src/pins.ts";

Deno.test("registry ids, ports and prefixes", () => {
  assertEquals(GUEST_APPS.datasette.port, 8001);
  assertEquals(GUEST_APPS.preview.port, 8002);
  assertEquals(isGuestAppId("datasette"), true);
  assertEquals(isGuestAppId("preview"), true);
  assertEquals(isGuestAppId("bridge-sw.js"), false);
  assertEquals(isGuestAppId("_bridge"), false);
  assertEquals(
    appPrefix("preview", "11111111-1111-4111-8111-111111111111"),
    "/apps/preview/11111111-1111-4111-8111-111111111111/",
  );
});

Deno.test("preview is always qualified with no inline scripts; datasette follows pins", () => {
  const pins = parsePins({
    kernelWasm: { url: "u", sha256: "a".repeat(64), rev: "r" },
    image: { url: "u", sha256: "b".repeat(64), rev: "c".repeat(40) },
  });
  assertEquals(appInlineScriptHashes(pins, "preview"), []);
  assertEquals(appInlineScriptHashes(pins, "datasette"), undefined);
});
```

Check `parsePin`'s required fields in `src/pins.ts` (around line 40-60) and
adjust the literal if it needs other keys; the point is a pins object with no
`datasette` entry.

- [ ] **Step 2: Run to verify failure**

Run: `deno test --no-check --allow-read tests/guest_apps_test.ts` Expected: FAIL
(module `../src/guest_apps.ts` not found).

- [ ] **Step 3: Implement**

```ts
// src/guest_apps.ts
/** The qualified guest web apps the bridge may serve (spec section 2). The
 * port lives here and in coordinator state only, never in page or SW messages. */
export interface GuestAppDef {
  id: GuestAppId;
  port: number;
  title: string;
}
export type GuestAppId = "datasette" | "preview";
export const GUEST_APPS: Readonly<Record<GuestAppId, GuestAppDef>> = {
  datasette: { id: "datasette", port: 8001, title: "Datasette" },
  preview: { id: "preview", port: 8002, title: "Preview" },
};
export function isGuestAppId(value: unknown): value is GuestAppId {
  return typeof value === "string" &&
    Object.hasOwn(GUEST_APPS, value);
}
export function appPrefix(app: GuestAppId, session: string): string {
  return `/apps/${app}/${session}/`;
}
```

Append to `src/pins.ts`:

```ts
import type { GuestAppId } from "./guest_apps.ts";
/** Inline-script hashes a qualified app's pages may carry; `undefined` means
 * the app is not qualified for this image. The preview server serves the
 * user's own files with no inline scripts, so its list is empty by design. */
export function appInlineScriptHashes(
  pins: Pins,
  app: GuestAppId,
): string[] | undefined {
  if (app === "preview") return [];
  return pins.datasette?.inlineScriptHashes;
}
```

(Put the `import type` with the file's other imports.) In `src/boot.ts` replace
lines 73 and 76:

```ts
  guestPorts: Readonly<Record<GuestAppId, number>>;
...
const BROWSER_GUEST_PORTS: Readonly<Record<GuestAppId, number>> = {
  datasette: GUEST_APPS.datasette.port,
  preview: GUEST_APPS.preview.port,
};
```

and add `import { GUEST_APPS, type GuestAppId } from "./guest_apps.ts";`.

- [ ] **Step 4: Run tests and type check**

Run:
`deno test --no-check --allow-read tests/guest_apps_test.ts tests/datasette_pins_test.ts && deno check src/pins.ts src/guest_apps.ts`
Expected: PASS. (`deno check src/boot.ts` needs the sibling kernel checkout.)

- [ ] **Step 5: Commit**

```bash
deno fmt && git add src/guest_apps.ts src/boot.ts src/pins.ts tests/guest_apps_test.ts
git commit -m "feat: guest app registry, ports and per-app inline-script hashes"
```

---

## Task 2: Cookie jar

**Files:**

- Create: `src/cookie_jar.ts`
- Test: `tests/cookie_jar_test.ts`

**Interfaces:**

- Produces:
  - `type SetCookieOutcome = "stored" | "deleted" | "ignored" | "rejected"`
  - `JAR_LIMITS = { count: 50, cookieBytes: 4096, totalBytes: 32768 }`
  - `class CookieJar { set(raw: string, requestPath: string, now: number): SetCookieOutcome; header(path: string, now: number): string; clear(): void }`
    (`now` is epoch ms; the caller passes `Date.now()`.)

Semantics (spec section 5): host-only (`Domain` ignored), `Secure`/`HttpOnly`/
`SameSite` ignored, RFC 6265 `Path` (default-path from the request path) and
`Max-Age`/`Expires` (`Max-Age` wins). Identity is `(name, path)`. `Max-Age<=0`
or past `Expires` deletes. A cookie over 4 KiB (`name+value`) is `ignored`. A
new cookie over the count or total is `rejected`; replacing an existing cookie
is allowed when the total still fits. `header()` orders longer paths first, then
earliest created.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/cookie_jar_test.ts
import { assertEquals } from "@std/assert";
import { CookieJar, JAR_LIMITS } from "../src/cookie_jar.ts";

const P = "/apps/preview/s/";
const t0 = Date.UTC(2026, 9, 4);

Deno.test("stores, replaces and sends cookies; value may contain '='", () => {
  const jar = new CookieJar();
  assertEquals(
    jar.set("sid=a=b==; HttpOnly; Secure; Domain=x", P + "login", t0),
    "stored",
  );
  assertEquals(jar.header(P + "next", t0), "sid=a=b==");
  jar.set("sid=2", P + "login", t0);
  assertEquals(jar.header(P, t0), "sid=2");
});

Deno.test("default path is the request directory; Path scopes and orders", () => {
  const jar = new CookieJar();
  jar.set("a=1", P + "admin/login", t0); // default path P + "admin"
  jar.set("a=2; Path=" + P, P + "x", t0);
  assertEquals(jar.header(P + "admin/users", t0), "a=1; a=2"); // longer path first
  assertEquals(jar.header(P + "administrator", t0), "a=2"); // not a path match
  assertEquals(jar.header("/apps/preview/other/", t0), "");
});

Deno.test("Max-Age and Expires; Max-Age=0 deletes", () => {
  const jar = new CookieJar();
  jar.set("a=1; Max-Age=10", P, t0);
  assertEquals(jar.header(P, t0 + 9_000), "a=1");
  assertEquals(jar.header(P, t0 + 11_000), "");
  jar.set("b=1", P, t0);
  assertEquals(jar.set("b=; Max-Age=0", P, t0), "deleted");
  assertEquals(jar.header(P, t0), "");
  jar.set("c=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT", P, t0);
  assertEquals(jar.header(P, t0), "");
});

Deno.test("limits: oversize ignored, count and total reject new, replace allowed", () => {
  const jar = new CookieJar();
  assertEquals(
    jar.set("big=" + "x".repeat(JAR_LIMITS.cookieBytes), P, t0),
    "ignored",
  );
  for (let i = 0; i < JAR_LIMITS.count; i++) {
    assertEquals(jar.set(`k${i}=v`, P, t0), "stored");
  }
  assertEquals(jar.set("extra=v", P, t0), "rejected");
  assertEquals(jar.set("k0=w", P, t0), "stored"); // replacement
  jar.clear();
  for (let i = 0; i < 8; i++) {
    assertEquals(jar.set(`t${i}=` + "x".repeat(4000), P, t0), "stored");
  }
  assertEquals(jar.set("t8=" + "x".repeat(4000), P, t0), "rejected"); // > 32 KiB total
});

Deno.test("malformed Set-Cookie is ignored", () => {
  const jar = new CookieJar();
  assertEquals(jar.set("novalue", P, t0), "ignored");
  assertEquals(jar.set("=x", P, t0), "ignored");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `deno test --no-check tests/cookie_jar_test.ts` Expected: FAIL (module not
found).

- [ ] **Step 3: Implement**

```ts
// src/cookie_jar.ts
export type SetCookieOutcome = "stored" | "deleted" | "ignored" | "rejected";
export const JAR_LIMITS = {
  count: 50,
  cookieBytes: 4096,
  totalBytes: 32 * 1024,
} as const;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
interface Cookie {
  name: string;
  value: string;
  path: string;
  expires?: number;
  created: number;
}
const sizeOf = (c: { name: string; value: string }) =>
  c.name.length + c.value.length;
const dir = (requestPath: string) => {
  const p = requestPath.split("?")[0];
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
};
function pathMatch(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}
/** Browsers cannot hold guest cookies for us (`Set-Cookie`/`Cookie` are
 * forbidden header names), so the coordinator keeps one jar per app session. */
export class CookieJar {
  #cookies = new Map<string, Cookie>();
  #seq = 0;
  #purge(now: number) {
    for (const [key, c] of this.#cookies) {
      if (c.expires !== undefined && c.expires <= now) {
        this.#cookies.delete(key);
      }
    }
  }
  set(raw: string, requestPath: string, now: number): SetCookieOutcome {
    const [pair, ...attrs] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) return "ignored";
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!TOKEN.test(name)) return "ignored";
    let path = dir(requestPath);
    let expires: number | undefined;
    let maxAge: number | undefined;
    for (const attr of attrs) {
      const at = attr.indexOf("=");
      const key = (at < 0 ? attr : attr.slice(0, at)).trim().toLowerCase();
      const val = at < 0 ? "" : attr.slice(at + 1).trim();
      if (key === "path" && val.startsWith("/")) path = val;
      else if (key === "max-age" && /^-?\d+$/.test(val)) maxAge = Number(val);
      else if (key === "expires") {
        const ms = Date.parse(val);
        if (!Number.isNaN(ms)) expires = ms;
      }
    }
    if (maxAge !== undefined) expires = now + maxAge * 1000;
    const id = name + "\0" + path;
    if (expires !== undefined && expires <= now) {
      this.#cookies.delete(id);
      return "deleted";
    }
    if (sizeOf({ name, value }) > JAR_LIMITS.cookieBytes) return "ignored";
    this.#purge(now);
    const existing = this.#cookies.get(id);
    let total = sizeOf({ name, value });
    for (const c of this.#cookies.values()) {
      if (c !== existing) total += sizeOf(c);
    }
    const count = this.#cookies.size + (existing ? 0 : 1);
    if (count > JAR_LIMITS.count || total > JAR_LIMITS.totalBytes) {
      return "rejected";
    }
    this.#cookies.set(id, {
      name,
      value,
      path,
      expires,
      created: existing?.created ?? this.#seq++,
    });
    return "stored";
  }
  header(path: string, now: number): string {
    this.#purge(now);
    const requestPath = path.split("?")[0];
    return [...this.#cookies.values()]
      .filter((c) => pathMatch(requestPath, c.path))
      .sort((a, b) => b.path.length - a.path.length || a.created - b.created)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }
  clear() {
    this.#cookies.clear();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `deno test --no-check tests/cookie_jar_test.ts` Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
deno fmt && git add src/cookie_jar.ts tests/cookie_jar_test.ts
git commit -m "feat: bounded per-session cookie jar"
```

---

## Task 3: Request slot queue

**Files:**

- Create: `src/slot_queue.ts`
- Test: `tests/slot_queue_test.ts`

**Interfaces:**

- Consumes: `GuestHttpError` from `src/guest_http.ts` (exists today:
  `new GuestHttpError(message, status = 502)`) and `GUEST_HTTP_TIMEOUT_MS`
  (added in Task 4; until then use a local `30_000` and switch in Task 4).
- Produces:
  - `interface SlotLimits { perSession: number; global: number; maxWaiting: number; waitMs: number }`
  - `SLOT_LIMITS: SlotLimits` =
    `{ perSession: 4, global: 16, maxWaiting: 64, waitMs: 30_000 }`
    - `class ByteBudget { constructor(limit = 64 * 1024 * 1024); take(bytes: number): void; give(bytes: number): void }`
      (`take` throws a 503 `GuestHttpError("session buffer limit")` when the sum
      would exceed `limit`; `give` never goes below zero)
  - `REQUEST_DEADLINE_MS = SLOT_LIMITS.waitMs + GUEST_HTTP_TIMEOUT_MS + 5_000`
    (the end-to-end SW deadline: queue wait + client deadline + slack)
  - `class SlotQueue { constructor(limits?: SlotLimits); acquire(session: string, signal?: AbortSignal): Promise<() => void> }`
    The resolved function releases the slot (idempotent). A full per-session
    queue, an expired wait, or an abort rejects (503 `GuestHttpError`, or the
    abort reason).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/slot_queue_test.ts
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  ByteBudget,
  REQUEST_DEADLINE_MS,
  SLOT_LIMITS,
  SlotQueue,
} from "../src/slot_queue.ts";
import { GUEST_HTTP_TIMEOUT_MS, GuestHttpError } from "../src/guest_http.ts";

const limits = { perSession: 2, global: 3, maxWaiting: 2, waitMs: 50 };
const tick = () => new Promise((r) => setTimeout(r, 0));

Deno.test("grants up to the per-session cap and queues the rest FIFO", async () => {
  const q = new SlotQueue(limits);
  const a = await q.acquire("s1");
  const b = await q.acquire("s1");
  const order: string[] = [];
  const c = q.acquire("s1").then((r) => (order.push("c"), r));
  const d = q.acquire("s1").then((r) => (order.push("d"), r));
  await tick();
  assertEquals(order, []);
  a();
  const rc = await c;
  assertEquals(order, ["c"]);
  b();
  const rd = await d;
  assertEquals(order, ["c", "d"]);
  rc();
  rd();
});

Deno.test("global cap is shared; a blocked session does not block another", async () => {
  const q = new SlotQueue(limits);
  const s1a = await q.acquire("s1");
  const s1b = await q.acquire("s1");
  const s2a = await q.acquire("s2"); // global is now 3
  const s1c = q.acquire("s1");
  const s2b = q.acquire("s2");
  s2a();
  const got = await s2b; // freed global slot goes to s2, not blocked s1
  got();
  s1a();
  (await s1c)();
  s1b();
});

Deno.test("release is idempotent", async () => {
  const q = new SlotQueue({ ...limits, perSession: 1 });
  const a = await q.acquire("s");
  a();
  a();
  const b = await q.acquire("s");
  const c = q.acquire("s");
  await tick();
  b();
  (await c)();
});

Deno.test("full queue and expired wait are 503", async () => {
  const q = new SlotQueue(limits);
  const held = [await q.acquire("s"), await q.acquire("s")];
  const w1 = q.acquire("s");
  const w2 = q.acquire("s");
  const full = await assertRejects(() => q.acquire("s"), GuestHttpError);
  assertEquals((full as GuestHttpError).status, 503);
  const timeout = await assertRejects(() => w1, GuestHttpError);
  assertEquals((timeout as GuestHttpError).status, 503);
  await assertRejects(() => w2, GuestHttpError);
  held.forEach((r) => r());
});

Deno.test("ByteBudget rejects over the limit and frees on give", () => {
  const b = new ByteBudget(100);
  b.take(60);
  assertThrows(() => b.take(41), GuestHttpError, "buffer limit");
  b.take(40);
  b.give(60);
  b.take(60);
  b.give(1_000); // never negative
  b.take(100);
});

Deno.test("end-to-end deadline covers queue wait plus client deadline", () => {
  assertEquals(
    REQUEST_DEADLINE_MS >= SLOT_LIMITS.waitMs + GUEST_HTTP_TIMEOUT_MS,
    true,
  );
});

Deno.test("abort removes a waiter and frees its queue position", async () => {
  const q = new SlotQueue({ ...limits, perSession: 1, waitMs: 5000 });
  const held = await q.acquire("s");
  const ctl = new AbortController();
  const waiting = q.acquire("s", ctl.signal);
  ctl.abort(new Error("gone"));
  await assertRejects(() => waiting, Error, "gone");
  held();
  (await q.acquire("s"))();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `deno test --no-check tests/slot_queue_test.ts` Expected: FAIL (module not
found).

- [ ] **Step 3: Implement**

```ts
// src/slot_queue.ts
import { GUEST_HTTP_TIMEOUT_MS, GuestHttpError } from "./guest_http.ts";
/** Per-session cap on buffered request plus response bytes. Reserved before a
 * request is queued, so queued uploads count, and released on completion or
 * cancellation. */
export class ByteBudget {
  #used = 0;
  constructor(private readonly limit = 64 * 1024 * 1024) {}
  take(bytes: number) {
    if (this.#used + bytes > this.limit) {
      throw new GuestHttpError("session buffer limit", 503);
    }
    this.#used += bytes;
  }
  give(bytes: number) {
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
/** End-to-end deadline the SW applies to one request: queue wait, then the
 * client's own deadline, plus slack. A shorter SW deadline would 504 requests
 * that waited in the queue and then ran normally. */
export const REQUEST_DEADLINE_MS = SLOT_LIMITS.waitMs +
  GUEST_HTTP_TIMEOUT_MS + 5_000;
interface Waiter {
  session: string;
  grant(release: () => void): void;
}
/** Bounds concurrent guest dials. A page load fires many parallel
 * subresource requests, so excess requests wait here instead of failing; the
 * dial cap stays under a single-threaded guest server's listen backlog. */
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
  #pump() {
    for (let i = 0; i < this.#waiting.length;) {
      const waiter = this.#waiting[i];
      if (this.#free(waiter.session)) {
        this.#waiting.splice(i, 1);
        waiter.grant(this.#take(waiter.session));
      } else i++;
    }
  }
  acquire(session: string, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    const queued = this.#waiting.filter((w) => w.session === session).length;
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
```

- [ ] **Step 4: Run tests**

Run: `deno test --no-check tests/slot_queue_test.ts` Expected: PASS (5 tests, no
leaked timers).

- [ ] **Step 5: Commit**

```bash
deno fmt && git add src/slot_queue.ts tests/slot_queue_test.ts
git commit -m "feat: bounded FIFO slot queue for guest requests"
```

---

## Task 4: `guest_http.ts` - app, methods, bodies, headers, cookies

**Files:**

- Modify: `src/guest_http.ts`; mechanical caller fixes in `src/datasette.ts`,
  `src/datasette_protocol.ts`, `src/datasette_routes.ts`
- Test: `tests/guest_http_test.ts` (update + add)

**Interfaces:**

- Consumes: `GuestAppId`, `isGuestAppId`, `appPrefix` from `src/guest_apps.ts`.
- Produces (all exported from `src/guest_http.ts`):
  - `type GuestMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"`
  - `GUEST_METHODS: ReadonlySet<string>`
    - `GuestHttpOptions` gains `app: GuestAppId`, `body?: ArrayBuffer`,
      `referrer?: string` (a guest path inside the prefix), `cookie?: string`,
      and `onBuffer?: (bytes: number) => void`, called with the length of each
      response body chunk before it is buffered, so the caller can enforce the
      shared per-session budget; a throw aborts the request
  - `export const GUEST_HTTP_TIMEOUT_MS = 30_000` replaces the two `30_000`
    literals in `requestGuestHttp` (`timeoutMs ?? 30_000` and
    `Math.min(timeout, 30_000)`); the deadline starts when the request is
    dialed, i.e. after any queue wait
  - `GuestHttpReply` gains `setCookies?: string[]` (coordinator-only: raw
    `Set-Cookie` values from the response head; never forwarded)
  - `validateGuestPath(app: GuestAppId, session, prefix, path, port?)`

- [ ] **Step 1: Mechanical signature change (keeps the suite green)**

`validateGuestPath` becomes `(app, session, prefix, path, port = 8001)`. In the
body replace the prefix check:

```ts
if (
  !isGuestAppId(app) || !UUID.test(session) ||
  prefix !== appPrefix(app, session)
) {
  fail("invalid session prefix");
}
```

Fix every caller to pass `"datasette"` for now (Tasks 6-9 replace these with the
real app):

Run: `grep -rn "validateGuestPath(" src tests`

Expected callers: `src/guest_http.ts` (inside `requestGuestHttp`: use
`options.app`), `src/datasette.ts` (`start`, `#ready`),
`src/datasette_protocol.ts` (`parseGuestRequest`), `src/datasette_routes.ts`
(`respond`), and any tests. Add `app: "datasette"` to `options()` in
`tests/guest_http_test.ts` and to the option literals in `src/datasette.ts`
(`#probe` callers and `request`).

Run:
`deno test --no-check --allow-read --allow-net tests/guest_http_test.ts tests/datasette_test.ts tests/datasette_routes_test.ts tests/datasette_protocol_test.ts`
Expected: PASS (behavior unchanged).

- [ ] **Step 2: Commit the mechanical change**

```bash
deno fmt && git commit -am "refactor: validateGuestPath takes the app id"
```

- [ ] **Step 3: Write the failing tests (append to `tests/guest_http_test.ts`)**

Uses the file's existing `connection(wire)` helper and `options()`.

```ts
Deno.test("POST sends an exact binary body with Content-Length, Origin and mapped Referer", async () => {
  const c = connection("HTTP/1.1 204 No Content\r\n\r\n");
  const body = new Uint8Array([0xff, 0x00, 0xfe, 0x80]).buffer; // not UTF-8
  await requestGuestHttp(
    async () => c.conn,
    options({
      method: "POST",
      path: prefix + "form",
      body,
      referrer: prefix + "page?x=1",
      headers: [["Content-Type", "application/octet-stream"], [
        "X-CSRF-Token",
        "t",
      ], ["Cookie", "evil=1"]],
      cookie: "sid=1",
    }),
  );
  const wire = c.written();
  assertStringIncludes(wire, "POST " + prefix + "form HTTP/1.1\r\n");
  assertStringIncludes(wire, "Content-Length: 4\r\n");
  assertStringIncludes(wire, "Origin: http://127.0.0.1:8001\r\n");
  assertStringIncludes(
    wire,
    `Referer: http://127.0.0.1:8001${prefix}page?x=1\r\n`,
  );
  assertStringIncludes(wire, "X-CSRF-Token: t\r\n");
  assertStringIncludes(wire, "Cookie: sid=1\r\n"); // the jar's, not the caller's header
  assertEquals(wire.includes("evil=1"), false);
});

Deno.test("empty-body POST sends Content-Length: 0; GET sends no Origin or Referer", async () => {
  const post = connection("HTTP/1.1 204 No Content\r\n\r\n");
  await requestGuestHttp(async () => post.conn, options({ method: "POST" }));
  assertStringIncludes(post.written(), "Content-Length: 0\r\n");
  const get = connection("HTTP/1.1 204 No Content\r\n\r\n");
  await requestGuestHttp(async () => get.conn, options({ referrer: prefix }));
  assertEquals(/Origin:|Referer:/.test(get.written()), false);
});

Deno.test("request bytes after the head are the body, unmodified", async () => {
  const bytes = new Uint8Array([0, 1, 2, 255]);
  let wire = new Uint8Array();
  const conn: GuestConnection = {
    write: async (b) => {
      wire = b;
    },
    read: (() => {
      let sent = false;
      return async () => {
        if (sent) return new Uint8Array();
        sent = true;
        return enc.encode("HTTP/1.1 204 No Content\r\n\r\n");
      };
    })(),
    close: async () => {},
  };
  await requestGuestHttp(
    async () => conn,
    options({ method: "PUT", body: bytes.buffer }),
  );
  assertEquals([...wire.slice(-4)], [0, 1, 2, 255]);
});

Deno.test("body over 16 MiB is 413; body on GET is 400; unknown method is 405", async () => {
  const never = async () => {
    throw new Error("must not dial");
  };
  const big = new ArrayBuffer(16 * 1024 * 1024 + 1);
  await assertRejects(
    () => requestGuestHttp(never, options({ method: "POST", body: big })),
    GuestHttpError,
    "16 MiB",
  );
  await assertRejects(
    () => requestGuestHttp(never, options({ body: new ArrayBuffer(1) })),
    GuestHttpError,
    "body",
  );
  // deno-lint-ignore no-explicit-any
  await assertRejects(
    () => requestGuestHttp(never, options({ method: "TRACE" as any })),
    GuestHttpError,
    "method",
  );
});

Deno.test("request head over 64 KiB is 431 and never dials", async () => {
  let dialed = false;
  const err = await assertRejects(
    () =>
      requestGuestHttp(async () => {
        dialed = true;
        return connection("").conn;
      }, options({ cookie: "a=" + "x".repeat(64 * 1024) })),
    GuestHttpError,
  );
  assertEquals((err as GuestHttpError).status, 431);
  assertEquals(dialed, false);
});

Deno.test("Set-Cookie is collected and stripped; trailer Set-Cookie is dropped; 303 maps Location", async () => {
  const c = connection(
    `HTTP/1.1 303 See Other\r\nSet-Cookie: sid=1; Path=${prefix}\r\nSet-Cookie: b=2\r\nLocation: ${prefix}home\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nSet-Cookie: trailer=1\r\n\r\n`,
  );
  const reply = await requestGuestHttp(
    async () => c.conn,
    options({ method: "POST" }),
  );
  assertEquals(reply.setCookies, [`sid=1; Path=${prefix}`, "b=2"]);
  assertEquals(new Headers(reply.headers).get("set-cookie"), null);
  assertEquals(new Headers(reply.headers).get("location"), prefix + "home");
});

Deno.test("onBuffer sees every response chunk and can abort the request", async () => {
  const wire = "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n0123456789";
  const seen: number[] = [];
  await requestGuestHttp(
    async () => connection(wire, 4).conn,
    options({ onBuffer: (n) => seen.push(n) }),
  );
  assertEquals(seen.reduce((a, b) => a + b, 0), 10);
  await assertRejects(
    () =>
      requestGuestHttp(
        async () => connection(wire).conn,
        options({
          onBuffer: () => {
            throw new GuestHttpError("session buffer limit", 503);
          },
        }),
      ),
    GuestHttpError,
    "buffer limit",
  );
});

Deno.test("HEAD, OPTIONS 204 and 304 carry no body and do not hang", async () => {
  for (
    const [method, wire] of [
      ["HEAD", "HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n"],
      ["OPTIONS", "HTTP/1.1 204 No Content\r\nAllow: GET\r\n\r\n"],
      ["GET", "HTTP/1.1 304 Not Modified\r\n\r\n"],
    ] as const
  ) {
    const reply = await requestGuestHttp(
      async () => connection(wire).conn,
      options({ method }),
    );
    assertEquals(reply.body.byteLength, 0);
  }
});
```

Also delete or rewrite the existing test that asserts
`"guest cookies unsupported"` (`grep -n "cookie" tests/guest_http_test.ts`); the
new Set-Cookie test replaces it.

- [ ] **Step 4: Run to verify failure**

Run: `deno test --no-check tests/guest_http_test.ts` Expected: FAIL (new tests).

- [ ] **Step 5: Implement in `src/guest_http.ts`**

Types:

```ts
export type GuestMethod =
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS";
export const GUEST_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
export interface GuestHttpReply {
  status: number;
  headers: HeaderPairs;
  body: ArrayBuffer;
  /** Raw Set-Cookie values from the response head. Consumed by the cookie
   * jar in the coordinator; never forwarded to the browser. */
  setCookies?: string[];
}
export interface GuestHttpOptions {
  app: GuestAppId;
  session: string;
  prefix: string;
  method: GuestMethod;
  path: string;
  port?: number;
  headers: HeaderPairs;
  body?: ArrayBuffer;
  /** Guest path of the page that issued an unsafe request, if inside the prefix. */
  referrer?: string;
  /** The jar's `Cookie` header value for this request. */
  cookie?: string;
  signal: AbortSignal;
  timeoutMs?: number;
}
```

Replace `ALLOWED`:

```ts
const ALLOWED = new Set([
  "accept",
  "accept-language",
  "if-none-match",
  "if-modified-since",
  "if-match",
  "if-unmodified-since",
  "range",
  "if-range",
  "content-type",
  "x-requested-with",
  "x-csrf-token",
  "x-csrftoken",
  "x-xsrf-token",
  "authorization",
]);
```

In `requestGuestHttp`, replace the method check and request construction. Before
the `dial` (so a 431 never connects):

```ts
if (!GUEST_METHODS.has(options.method)) {
  throw new GuestHttpError("unsupported method", 405);
}
const body = new Uint8Array(options.body ?? new ArrayBuffer(0));
if (body.length > BODY_LIMIT) {
  throw new GuestHttpError("request body exceeds 16 MiB", 413);
}
if (body.length && !BODY_METHODS.has(options.method) && options.method !== "DELETE") {
  throw new GuestHttpError("request body not allowed for this method", 400);
}
...(existing header filtering into requestHeaders)...
const extra: HeaderPairs = [];
if (!SAFE.has(options.method)) {
  extra.push(["Origin", origin(options.port)]);
  if (options.referrer !== undefined) {
    validateGuestPath(options.app, options.session, options.prefix, options.referrer, options.port);
    extra.push(["Referer", origin(options.port) + options.referrer]);
  }
}
if (options.cookie) extra.push(["Cookie", options.cookie]);
if (BODY_METHODS.has(options.method) || body.length) {
  extra.push(["Content-Length", String(body.length)]);
}
const head = new TextEncoder().encode(
  `${options.method} ${options.path} HTTP/1.1\r\nHost: 127.0.0.1:${options.port ?? 8001}\r\nConnection: close\r\nAccept-Encoding: identity\r\n` +
    [...requestHeaders, ...extra].map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n",
);
if (head.length > HEADER_LIMIT) {
  throw new GuestHttpError("request headers exceed 64 KiB", 431);
}
const wire = new Uint8Array(head.length + body.length);
wire.set(head);
wire.set(body, head.length);
```

(An empty-body `DELETE` is allowed; a non-empty body on `GET/HEAD/OPTIONS` is
the 400. `validateGuestPath(options.app, ...)` replaces the `"datasette"`
literal from Step 1.) Then `await race(conn.write(wire));` replaces the old
write. Drop the old inline `request` string.

Buffering: in the body-reading `append` helper, call
`options.onBuffer?.(bytes.length)` before pushing each chunk (the existing 16
MiB check stays).

Response side: delete the `if (k === "set-cookie") fail(...)` line and the
`|| k === "set-cookie"` in the trailer check (trailer `Set-Cookie` is now simply
ignored). After the header-parse loop:

```ts
const setCookies = headers.filter(([k]) => k === "set-cookie").map(([, v]) =>
  v
);
```

Add `k !== "set-cookie"` to the `headers = headers.filter(...)` that removes
hop-by-hop headers, and return
`{ status, headers, body: body.buffer, setCookies }`. `bodyless` stays
`options.method === "HEAD" || status === 204 || status === 304`.

- [ ] **Step 6: Run tests and type check**

Run:
`deno test --no-check --allow-read --allow-net tests/guest_http_test.ts tests/datasette_test.ts && deno check src/guest_http.ts`
Expected: PASS. `deno check` will flag `GuestMethod` consumers that narrow to
`"GET" | "HEAD"` (`datasette_protocol.ts`, `datasette_routes.ts`,
`datasette.ts`'s `DemoRequest`): leave their behavior, widen types only where
the compiler requires; Tasks 6-9 own the real changes.

- [ ] **Step 7: Commit**

```bash
deno fmt && git add -A && git commit -m "feat: guest HTTP methods, bodies, header allow-list, Origin/Referer, cookie plumbing"
```

---

## Task 5: Response policy

**Files:**

- Modify: `src/datasette_policy.ts`
- Test: `tests/datasette_policy_test.ts` (update + add)

**Interfaces:**

- Consumes: `GuestHttpReply`, `GuestMethod`.
- Produces:
  - `guestResponse(reply, method, hashes, onDrop?: (header: string) => void): Response`
    - response headers are an allow-list (constraint list above); `onDrop` is
      called for each header on the explicit drop list actually present
      (Refresh, Link, Service-Worker-Allowed, Clear-Site-Data, Report-To,
      Reporting-Endpoints, NEL, Permissions-Policy, Origin-Agent-Cluster,
      Speculation-Rules, `Access-Control-*`, Set-Cookie). Other headers (`Date`,
      `Server`, ...) are dropped silently.
    - the document CSP, `X-Content-Type-Options: nosniff` and COOP/COEP/CORP are
      set on **every** response, not only `text/html`.
  - `guestDocumentPolicy(hashes)` ends with
    `; sandbox allow-scripts allow-same-origin allow-forms allow-downloads`.
  - `bridgeErrorResponse(status, message, method, hashes, title)`: heading is
    `${title} unavailable`; a 405 sets
    `Allow: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`.

- [ ] **Step 1: Write the failing tests**

```ts
Deno.test("response headers are an allow-list; explicit drops are reported", () => {
  const dropped: string[] = [];
  const res = guestResponse(
    {
      status: 200,
      headers: [
        ["content-type", "text/plain"],
        ["etag", "x"],
        ["date", "d"],
        ["server", "s"],
        ["refresh", "0;url=/"],
        ["clear-site-data", '"cache"'],
        ["access-control-allow-origin", "*"],
        ["service-worker-allowed", "/"],
        ["content-security-policy", "default-src *"],
        ["x-frame-options", "ALLOW"],
      ],
      body: new ArrayBuffer(0),
    },
    "GET",
    [],
    (h) => dropped.push(h),
  );
  assertEquals(res.headers.get("etag"), "x");
  for (
    const h of [
      "date",
      "server",
      "refresh",
      "clear-site-data",
      "access-control-allow-origin",
      "service-worker-allowed",
      "x-frame-options",
    ]
  ) {
    assertEquals(res.headers.get(h), null, h);
  }
  assertEquals(dropped.sort(), [
    "access-control-allow-origin",
    "clear-site-data",
    "refresh",
    "service-worker-allowed",
  ]);
  assertStringIncludes(
    res.headers.get("content-security-policy")!,
    "script-src 'self'",
  );
});

Deno.test("CSP, nosniff and isolation headers apply to non-HTML responses", () => {
  for (
    const type of [
      "image/svg+xml",
      "application/xhtml+xml",
      "text/javascript",
      "application/json",
    ]
  ) {
    const res = guestResponse(
      {
        status: 200,
        headers: [["content-type", type]],
        body: new ArrayBuffer(0),
      },
      "GET",
      [],
    );
    assertStringIncludes(
      res.headers.get("content-security-policy")!,
      "sandbox allow-scripts allow-same-origin allow-forms allow-downloads",
    );
    assertEquals(res.headers.get("x-content-type-options"), "nosniff");
    assertEquals(
      res.headers.get("cross-origin-resource-policy"),
      "same-origin",
    );
  }
});

Deno.test("error page names the app", async () => {
  const res = bridgeErrorResponse(503, "down", "GET", [], "Preview");
  assertStringIncludes(await res.text(), "Preview unavailable");
});
```

Update the existing assertions in this file for the new `title` argument, the
`sandbox` suffix, and the removal of `text/html`-only CSP.

- [ ] **Step 2: Run to verify failure**

Run: `deno test --no-check tests/datasette_policy_test.ts` Expected: FAIL.

- [ ] **Step 3: Implement**

In `guestDocumentPolicy` append to the template string:
`; sandbox allow-scripts allow-same-origin allow-forms allow-downloads` (the
iframe's exact flags; without `allow-same-origin` the document turns opaque and
leaves SW control).

Replace `guestResponse`:

```ts
const ALLOWED_RESPONSE = new Set([
  "content-type",
  "content-length",
  "content-language",
  "cache-control",
  "etag",
  "last-modified",
  "location",
  "content-disposition",
  "vary",
  "accept-ranges",
  "content-range",
  "allow",
  "www-authenticate",
]);
const REPORTED_DROPS = new Set([
  "refresh",
  "link",
  "service-worker-allowed",
  "clear-site-data",
  "report-to",
  "reporting-endpoints",
  "nel",
  "permissions-policy",
  "origin-agent-cluster",
  "speculation-rules",
  "set-cookie",
]);
export function guestResponse(
  reply: GuestHttpReply,
  method: GuestMethod,
  hashes: string[],
  onDrop?: (header: string) => void,
): Response {
  const headers = new Headers();
  for (const [name, value] of reply.headers) {
    const key = name.toLowerCase();
    if (ALLOWED_RESPONSE.has(key)) headers.append(key, value);
    else if (REPORTED_DROPS.has(key) || key.startsWith("access-control-")) {
      onDrop?.(key);
    }
  }
  headers.set("Content-Security-Policy", guestDocumentPolicy(hashes));
  headers.set("X-Content-Type-Options", "nosniff");
  isolation(headers);
  const body = method === "HEAD" || reply.status === 204 || reply.status === 304
    ? null
    : reply.body;
  return new Response(body, { status: reply.status, headers });
}
```

`bridgeErrorResponse` gains a final `title: string` parameter used in the
`<title>` and `<h1>` (`${escape(title)} unavailable`), and the 405 `Allow` value
becomes the full method list. Update its callers in `datasette_routes.ts` to
pass `"Datasette"` for now (Task 7 passes the real title).

- [ ] **Step 4: Run tests**

Run:
`deno test --no-check --allow-read tests/datasette_policy_test.ts tests/datasette_routes_test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
deno fmt && git add -A && git commit -m "feat: allow-list guest response headers; CSP and nosniff on every response"
```

---

## Task 6: Protocol messages carry `app`, methods and bodies

**Files:**

- Modify: `src/datasette_protocol.ts`
- Test: `tests/datasette_protocol_test.ts` (update + add)

**Interfaces:**

- Consumes: Task 1 (`GuestAppId`, `isGuestAppId`, `appPrefix`), Task 4
  (`GUEST_METHODS`, `validateGuestPath(app, ...)`).
- Produces (message shapes):
  - `GuestRequest { type: "datasette-http"; app: GuestAppId; session; requestId; method: GuestMethod; path; headers; body?: ArrayBuffer; referrer?: string }`
  - `LifecycleMessage { type: "datasette-start" | "datasette-stop" | "datasette-reset"; app: GuestAppId; requestId }`
  - `LifecycleReply { type: "datasette-state"; app: GuestAppId; requestId?; snapshot }`
  - `OwnerMessage` register variant additionally has `app: GuestAppId`; its
    `prefix` must equal `appPrefix(app, session)` and `hashes` may be empty.
    - `GuestReply` error `code` accepts `[403, 405, 413, 431, 502, 503, 504]`.
- **Envelope rules (every later task follows these):**
  - Messages that start or select an app carry `app`: `datasette-http`
    (request), lifecycle messages, `datasette-state`, `datasette-register`,
    `guest-app-qualification`.
  - Messages that belong to an in-flight request or a bound session are
    correlated by `session` + `requestId` only and carry **no** `app`:
    `datasette-response`, `datasette-error`, `datasette-abort`,
    `datasette-registered`, `datasette-ping`, `datasette-pong`,
    `datasette-find-owner`, `datasette-unregister`. A session UUID is unique
    across apps, so this is unambiguous.
  - Consumers therefore filter replies by `session` (as today) and filter
    `datasette-state` / qualification by `app`. The coordinator resolves an
    abort by asking every app to abort `(session, requestId)`; apps that do not
    own it ignore it.

- [ ] **Step 1: Write the failing tests**

```ts
Deno.test("request parsing: app, all methods, body and referrer", () => {
  const base = {
    type: "datasette-http",
    app: "preview",
    session,
    requestId: "r",
    path: `/apps/preview/${session}/x`,
    headers: [],
  };
  assert(
    parseGuestRequest({
      ...base,
      method: "POST",
      body: new ArrayBuffer(3),
      referrer: `/apps/preview/${session}/p`,
    }),
  );
  assertEquals(parseGuestRequest({ ...base, method: "TRACE" }), undefined);
  assertEquals(
    parseGuestRequest({ ...base, app: "nope", method: "GET" }),
    undefined,
  );
  assertEquals(
    parseGuestRequest({ ...base, app: "datasette", method: "GET" }),
    undefined,
  ); // path is under /apps/preview/
  assertEquals(
    parseGuestRequest({ ...base, method: "POST", body: "text" }),
    undefined,
  );
  assertEquals(
    parseGuestRequest({ ...base, method: "POST", referrer: "/elsewhere" }),
    undefined,
  );
  assertEquals(
    parseGuestRequest({
      ...base,
      method: "POST",
      body: new ArrayBuffer(16 * 1024 * 1024 + 1),
    }),
    undefined,
  );
});

Deno.test("lifecycle and owner messages require a valid app; empty hash list registers", () => {
  assertEquals(
    parseLifecycleMessage({ type: "datasette-start", requestId: "r" }),
    undefined,
  );
  assert(
    parseLifecycleMessage({
      type: "datasette-start",
      app: "preview",
      requestId: "r",
    }),
  );
  assert(
    parseOwnerMessage({
      type: "datasette-register",
      app: "preview",
      session,
      nonce: "n",
      prefix: `/apps/preview/${session}/`,
      hashes: [],
    }),
  );
  assertEquals(
    parseOwnerMessage({
      type: "datasette-register",
      app: "preview",
      session,
      nonce: "n",
      prefix: `/apps/datasette/${session}/`,
      hashes: [],
    }),
    undefined,
  );
});
```

(`session` and imports as in the existing file.)

- [ ] **Step 2: Run to verify failure**

Run: `deno test --no-check --allow-read tests/datasette_protocol_test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `GuestRequest`, `LifecycleMessage`, `LifecycleReply`, `OwnerMessage` per the
  interfaces above (add `app` to `OwnerMessage` as optional; required and
  validated for `datasette-register`).
- `parseGuestRequest`: require `isGuestAppId(v.app)`,
  `GUEST_METHODS.has(v.method)`,
  `v.body === undefined || (v.body instanceof ArrayBuffer && v.body.byteLength <= 16 * 1024 * 1024)`,
  `v.referrer === undefined || typeof v.referrer === "string"`, then inside the
  existing `try`:
  `validateGuestPath(v.app, v.session, appPrefix(v.app, v.session), v.path)`
  and, when `referrer` is set, the same call with `v.referrer`.
- `parseLifecycleMessage`: add `isGuestAppId(v.app)`.
- `parseOwnerMessage` register branch:
  `isGuestAppId(v.app) &&
  v.prefix === appPrefix(v.app, v.session) && Array.isArray(v.hashes) &&
  v.hashes.every(<hash regex>)`
  (drop the `!v.hashes.length` rejection).
- `parseGuestReply`: error codes `[403, 405, 413, 431, 502, 503, 504]`.

- [ ] **Step 4: Fix the compile fallout**

Run:
`deno check src/datasette_protocol.ts src/datasette_page.ts src/datasette.ts src/datasette_routes.ts`
`datasette.ts`, `datasette_page.ts` and `datasette_routes.ts` construct these
messages; add `app: "datasette"` at each construction site for now (Tasks 7-11
replace the literal with the real app). Run the whole fast suite:
`deno test --no-check --allow-read --allow-write --allow-env --allow-net tests/datasette_*_test.ts tests/guest_http_test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
deno fmt && git add -A && git commit -m "feat: protocol messages carry app, methods, bodies and referrer"
```

---

## Task 7: Service-worker routes - methods, bodies, referrer check, top-level refusal

**Files:**

- Modify: `src/datasette_routes.ts` (`respond`, owner prefix handling),
  `src/datasette_service_worker.ts` (fetch filter, message handler)
- Test: `tests/datasette_routes_test.ts` (update + add)

**Interfaces:**

- Consumes: Tasks 1, 4, 5, 6.
- Produces: `DatasetteRoutes.respond(request): Promise<Response>` now handles
  all registry apps. `RouteDependencies` gains `log?: (message: string) => void`
  (default `console.warn`).

Behavior to implement in `respond` (order matters):

1. Parse `^/apps/([a-z0-9-]+)/([0-9a-f-]{36})/` from the URL; `isGuestAppId`
   else 503 "route unavailable".
2. Method not in `GUEST_METHODS` -> 405. `Upgrade` header -> 502.
3. `request.destination === "document"` -> 403 via `bridgeErrorResponse` ("Open
   this page inside the preview panel; opening it in a new tab is not
   supported.") (the app frame's own navigations are `"iframe"`).
4. Unsafe method (not GET/HEAD/OPTIONS): `new URL(request.referrer)` must parse
   and `.origin === this.deps.origin`, else 403 (including an empty referrer).
5. Body (non-GET/HEAD): `const blob = await request.blob()`;
   `blob.size > 16 MiB` -> 413; `body = await blob.arrayBuffer()`.
6. Mapped referrer: for unsafe methods, if the referrer pathname starts with the
   app prefix, `referrer = pathname + search`, else omitted.
7. Header allow-list: the request-side names from Global Constraints (minus
   `cookie`), read with `request.headers.get`.
8. `owner.port.postMessage({ type: "datasette-http", app, session, requestId,
   method, path, headers, body, referrer }, body ? [body] : [])`.
9. `guestResponse(reply, method, owner.hashes, onDrop)` where `onDrop` logs
   `"dropped guest response header <name>"` once per `(session, name)` (keep a
   `Set<string>` keyed `session + ":" + name`, cleared in `#drop`).
10. Deadline: replace `this.deps.requestTimeoutMs ?? 30_000` with
    `this.deps.requestTimeoutMs ?? REQUEST_DEADLINE_MS` (imported from
    `src/slot_queue.ts`: queue wait + client deadline + slack). The coordinator
    queues first and the client deadline only starts at dial, so a request that
    waited 20 s and ran 15 s must succeed.
11. Error pages use `bridgeErrorResponse(..., GUEST_APPS[app].title)`.

Owner registration stays keyed by session; `owner.prefix` and `hashes` come from
the (now app-aware) register message.

- [ ] **Step 1: Write the failing tests**

Read the existing `tests/datasette_routes_test.ts` first and reuse its
owner/`MessageChannel` fixtures. Add tests with these assertions (each builds a
`Request` for `https://playground.test/apps/preview/<session>/...` with the
fixture's `origin`, registers an owner for `preview`, and inspects what arrives
on the owner port or the returned `Response`):

```ts
Deno.test("POST is forwarded with body, mapped referrer and allow-listed headers only", async () => {
  // registered owner for app "preview"; answer every datasette-http with 204
  const res = await routes.respond(
    new Request(`${origin}${prefix}form`, {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
      headers: {
        "content-type": "application/octet-stream",
        cookie: "no",
        "x-csrf-token": "t",
        "x-secret": "no",
      },
      referrer: `${origin}${prefix}page?x=1`,
    }),
  );
  assertEquals(res.status, 204);
  const forwarded = received[0];
  assertEquals(forwarded.app, "preview");
  assertEquals(forwarded.method, "POST");
  assertEquals(new Uint8Array(forwarded.body), new Uint8Array([1, 2, 3]));
  assertEquals(forwarded.referrer, `${prefix}page?x=1`);
  assertEquals(
    forwarded.headers.map(([k]: string[]) => k.toLowerCase()).sort(),
    ["content-type", "x-csrf-token"],
  );
});

Deno.test("cross-site, empty and invalid referrers on unsafe methods are 403; GET is unaffected", async () => {
  for (const referrer of ["https://evil.test/", "", "about:client"]) {
    const res = await routes.respond(
      new Request(`${origin}${prefix}form`, {
        method: "POST",
        body: "x",
        referrer,
      }),
    );
    assertEquals(res.status, 403, referrer);
  }
  assertEquals(
    (await routes.respond(
      new Request(`${origin}${prefix}x`, { referrer: "https://evil.test/" }),
    )).status,
    204,
  );
});

Deno.test("a stripped referrer (no-referrer policy) cannot POST", async () => {
  const res = await routes.respond(
    new Request(`${origin}${prefix}form`, {
      method: "POST",
      body: "x",
      referrerPolicy: "no-referrer",
    }),
  );
  assertEquals(res.status, 403);
});

Deno.test("body over 16 MiB is 413 before forwarding", async () => {
  const res = await routes.respond(
    new Request(`${origin}${prefix}form`, {
      method: "POST",
      body: new Uint8Array(16 * 1024 * 1024 + 1),
      referrer: `${origin}${prefix}`,
    }),
  );
  assertEquals(res.status, 413);
  assertEquals(received.length, 0);
});

Deno.test("top-level document navigations are refused with an explanatory page", async () => {
  // Request.destination is read-only; build a stand-in object with the Request
  // fields respond() reads, or use Object.defineProperty(req, "destination", { value: "document" }).
  const res = await routes.respond(documentRequest(`${origin}${prefix}`));
  assertEquals(res.status, 403);
  assertStringIncludes(await res.text(), "preview panel");
});

Deno.test("guest response headers are filtered and drops are logged once per name", async () => {
  // owner answers with refresh + date headers twice
  await routes.respond(get());
  await routes.respond(get());
  assertEquals(logged.filter((m) => m.includes("refresh")).length, 1);
  assertEquals(logged.some((m) => m.includes("date")), false);
});
```

```ts
Deno.test("the SW deadline covers queue wait plus execution, and still fires", async () => {
  // Scaled stand-in for "waited 20 s in the queue, ran 15 s": the owner answers
  // after 200 ms against a 300 ms route deadline -> success, not 504.
  const slowOk = makeRoutes({ requestTimeoutMs: 300, ownerDelayMs: 200 });
  assertEquals((await slowOk.respond(get())).status, 204);
  // An owner slower than the deadline is a 504 through the same route.
  const tooSlow = makeRoutes({ requestTimeoutMs: 300, ownerDelayMs: 600 });
  assertEquals((await tooSlow.respond(get())).status, 504);
  // The production default is the shared constant, never a bare 30 s.
  assertEquals(defaultRequestTimeoutMs(), REQUEST_DEADLINE_MS);
});
```

(`documentRequest`, `get`, `received`, `logged`, `makeRoutes` and
`defaultRequestTimeoutMs` are small local helpers in the test file; write them
against the existing fixture. `makeRoutes` builds a `DatasetteRoutes` with a
registered owner that answers `datasette-http` after `ownerDelayMs`;
`defaultRequestTimeoutMs` reads the constant the route uses when
`requestTimeoutMs` is omitted, for example by exporting it from
`datasette_routes.ts` as
`export const DEFAULT_REQUEST_TIMEOUT_MS =
REQUEST_DEADLINE_MS` and asserting
that.)

- [ ] **Step 2: Run to verify failure**

Run: `deno test --no-check --allow-read tests/datasette_routes_test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `respond` per the list above, and update the SW**

`src/datasette_service_worker.ts`:

```ts
const RESERVED = new Set(["/apps/bridge-sw.js"]);
worker.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== worker.location.origin ||
    !url.pathname.startsWith("/apps/") ||
    RESERVED.has(url.pathname) ||
    url.pathname.startsWith("/apps/_bridge/")
  ) return;
  ...unchanged respondWith...
});
```

The `datasette-register` branch in the message handler is unchanged (the parsed
message already carries `app`).

- [ ] **Step 4: Run tests**

Run:
`deno test --no-check --allow-read --allow-net tests/datasette_routes_test.ts tests/datasette_protocol_test.ts tests/datasette_policy_test.ts`
Expected: PASS. Also
`deno check src/datasette_routes.ts src/datasette_service_worker.ts`.

- [ ] **Step 5: Commit**

```bash
deno fmt && git add -A && git commit -m "feat: SW bridge handles all methods, bodies, referrer check and top-level refusal"
```

---

## Task 8: Extract the shared supervisor (`GuestApp`)

**Files:**

- Create: `src/guest_app.ts` (moved from `src/datasette.ts`)
- Modify: `src/datasette.ts` (keeps the Datasette spec, `attachDatasette`
  becomes generic in Task 9), `tests/datasette_test.ts`
- Test: `tests/datasette_test.ts` (keep green), `tests/guest_app_test.ts` (new,
  spec-driven cases)

**Interfaces:**

- Produces (`src/guest_app.ts`):

```ts
export interface GuestAppContext {
  /** Runs a finite guest command; throws on a non-zero exit. */
  finite(
    line: string,
    stdin?: Uint8Array,
    timeoutMs?: number,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Fetches a static asset from the page bundle (cached, 30 s timeout, cancellable). */
  asset(name: string): Promise<Uint8Array>;
}
export interface GuestAppSpec {
  id: GuestAppId;
  title: string;
  /** Guest directory holding server.pid and server.log; prepare() must create it. */
  dir: string;
  /** Runs before every start. */
  prepare(ctx: GuestAppContext): Promise<void>;
  /** Restores the sample state after a stop (Reset). */
  reset(ctx: GuestAppContext): Promise<void>;
  /** `exec ...` line for the resident; the supervisor adds the pid and log plumbing. */
  spawnLine(prefix: string, port: number): string;
  readyPath(prefix: string): string;
  isReady(reply: GuestHttpReply): boolean;
}
export interface GuestAppDependencies {
  uuid(): string;
  now(): number;
  servicePort: number;
  delay(ms: number, signal?: AbortSignal): Promise<void>;
  spawn(line: string): Promise<ResidentHandle>;
  finite(
    line: string,
    stdin?: Uint8Array,
    timeoutMs?: number,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  asset(name: string, signal: AbortSignal): Promise<Uint8Array>;
  request(options: GuestHttpOptions): Promise<GuestHttpReply>;
  portBusy(): Promise<boolean>;
  changed(snapshot: DatasetteSnapshot): void;
}
export class GuestApp {
  constructor(readonly spec: GuestAppSpec, readonly deps: GuestAppDependencies);
  readonly snapshot: DatasetteSnapshot;
  start(): Promise<DatasetteSnapshot>;
  stop(): Promise<DatasetteSnapshot>;
  reset(): Promise<DatasetteSnapshot>;
  request(r: GuestAppRequest): Promise<GuestHttpReply>; // Task 9 adds queue + jar
  abort(session: string, requestId: string): void;
}
```

`datasette.ts` exports `datasetteSpec: GuestAppSpec`, `DATASETTE_DIR`,
`DATASETTE_DB`, `DATASETTE_QUERY` (unchanged names).

This is a behavior-preserving move. The existing `tests/datasette_test.ts`
(timing, stuck/failed states, reset, readiness) is the safety net; do not weaken
it.

- [ ] **Step 1: Move the class**

```bash
git mv src/datasette.ts src/guest_app.ts   # then recreate a smaller src/datasette.ts
```

In `src/guest_app.ts`, apply these replacements (all are in the code read when
this plan was written; line numbers are from `datasette.ts` at `cc85324`):

| Where                                                                                         | Replace                                                                             | With                                                                                                                                                              |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| class and deps names                                                                          | `DatasetteDemo`, `DatasetteDependencies`                                            | `GuestApp`, `GuestAppDependencies`; constructor `(readonly spec: GuestAppSpec, readonly deps: GuestAppDependencies)`                                              |
| `deps.seedSource(signal)` in `#seed`                                                          | `#seed(startup?)`                                                                   | `#asset(name, startup?)` calling `this.deps.asset(name, signal)` with the same 30 s timeout + `#cancellable`                                                      |
| `start()` prefix                                                                              | `` `/apps/datasette/${session}/` ``                                                 | `appPrefix(this.spec.id, session)`; `validateGuestPath(this.spec.id, session, prefix, prefix)`                                                                    |
| `start()` setup block (seed download, `cat > datasette_seed.py`, `python3 datasette_seed.py`) | the three `#finite` calls                                                           | `await this.spec.prepare(this.#ctx(controller.signal))`                                                                                                           |
| `start()` spawn line                                                                          | `exec python3 -m datasette serve ...`                                               | `` `echo $$ > ${quote(this.spec.dir + "/server.pid")} && ${this.spec.spawnLine(prefix, this.deps.servicePort)} > ${quote(this.spec.dir + "/server.log")} 2>&1` `` |
| before `deps.spawn`                                                                           | (new)                                                                               | `if (await this.deps.portBusy()) throw new Error(\`port ${this.deps.servicePort} is in use\`);`                                                                   |
| `DATASETTE_DIR + "/server.pid"` / `server.log` (5 places)                                     |                                                                                     | `this.spec.dir + ...`                                                                                                                                             |
| `reset()` seed replace + `--reset` run                                                        | the `#seed`, `cat >`, `python3 ... --reset` calls                                   | `await this.spec.reset(this.#ctx())`                                                                                                                              |
| `#ready`                                                                                      | path `prefix + "orders.json?sql=SELECT+1+AS+ready&_shape=array"` and the JSON check | `this.spec.readyPath(prefix)` and `this.spec.isReady(response)`; keep the redirect loop                                                                           |
| `#ready` error                                                                                | `"Datasette readiness timed out after 240 seconds"`                                 | `` `${this.spec.title} readiness timed out after 240 seconds` ``                                                                                                  |
| `request()` errors                                                                            | `"Datasette owner is stopped"`                                                      | `` `${this.spec.title} owner is stopped` ``                                                                                                                       |
| `#probe`/`request` option literals                                                            | `app: "datasette"` (Task 4/6)                                                       | `app: this.spec.id`                                                                                                                                               |

Add:

```ts
#ctx(startup?: AbortSignal): GuestAppContext {
  return {
    finite: (line, stdin, timeoutMs) => this.#finite(line, stdin, timeoutMs),
    asset: (name) => this.#asset(name, startup),
  };
}
```

`handleDatasetteMessage` / `attachDatasette` stay in `datasette.ts` for now,
temporarily constructing
`new GuestApp(datasetteSpec, { ...,
asset: (name, signal) => cachedFetch(name, signal), portBusy: async () => false })`
(Task 9 implements `portBusy` and the multi-app attach).

- [ ] **Step 2: Recreate `src/datasette.ts`**

```ts
import type { GuestAppSpec } from "./guest_app.ts";
export const DATASETTE_DIR = "/home/user/demos/datasette";
export const DATASETTE_DB = DATASETTE_DIR + "/orders.db";
export const DATASETTE_QUERY = "...unchanged...";
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
const install = (ctx: GuestAppContextLike) => async () => {/* see below */};

export const datasetteSpec: GuestAppSpec = {
  id: "datasette",
  title: "Datasette",
  dir: DATASETTE_DIR,
  async prepare(ctx) {
    await installSeed(ctx);
    await ctx.finite(
      `exec python3 ${quote(DATASETTE_DIR + "/datasette_seed.py")}`,
    );
  },
  async reset(ctx) {
    await installSeed(ctx);
    await ctx.finite(
      `exec python3 ${quote(DATASETTE_DIR + "/datasette_seed.py")} --reset`,
    );
  },
  spawnLine: (prefix, port) =>
    `exec python3 -m datasette serve ${
      quote(DATASETTE_DB)
    } --host 127.0.0.1 --port ${port} --setting base_url ${
      quote(prefix)
    } --setting default_cache_ttl 0`,
  readyPath: (prefix) =>
    prefix + "orders.json?sql=SELECT+1+AS+ready&_shape=array",
  isReady(reply) {
    /* the existing 200 + application/json + [{ready:1}] check */
  },
};
async function installSeed(ctx: GuestAppContext) {
  await ctx.finite(
    `mkdir -p ${quote(DATASETTE_DIR)} && exec sh -c ${
      quote(`cat > ${DATASETTE_DIR}/datasette_seed.py`)
    }`,
    await ctx.asset("datasette_seed.py"),
  );
}
```

(`GuestAppContext` imported from `guest_app.ts`; drop the placeholder
`GuestAppContextLike` line.)

- [ ] **Step 3: Update `tests/datasette_test.ts`**

Construct `new GuestApp(datasetteSpec, deps)`; replace `seedSource` with
`asset: async () => seedBytes` and add `portBusy: async () => false` to the
fixture's `deps`. Keep every existing assertion. Add to
`tests/guest_app_test.ts` one spec-driven test with a tiny fake spec proving
`prepare` runs before spawn, `spawnLine` output is wrapped with the pid/log
plumbing, and `portBusy: true` fails the start with a message containing
`in use` without calling `spawn`.

- [ ] **Step 4: Run tests**

Run:
`deno test --no-check --allow-read --allow-write --allow-env --allow-net tests/datasette_test.ts tests/guest_app_test.ts tests/datasette_fallback_test.ts tests/datasette_seed_test.ts`
Expected: PASS with unchanged assertions;
`deno check src/guest_app.ts src/datasette.ts`.

- [ ] **Step 5: Commit**

```bash
deno fmt && git add -A && git commit -m "refactor: extract GuestApp supervisor and datasette spec from DatasetteDemo"
```

---

## Task 9: Coordinator request path - queue, jar, port ownership, multi-app

**Files:**

- Modify: `src/guest_app.ts` (`request`, `stop`/`reset`/exit clear the jar),
  `src/datasette.ts` -> `attachGuestApps`/`handleGuestAppMessage` (keep the
  file; rename the exported functions), `src/coordinator_worker.ts`,
  `src/page.ts` is Task 11
- Test: `tests/guest_app_test.ts`, `tests/datasette_fallback_test.ts` (if it
  covers `handleDatasetteMessage`)

**Interfaces:**

- Consumes: Tasks 1-8.
- Produces:
  - `GuestApp.request(r)`: acquires a slot (`SlotQueue`), computes
    `cookie = jar.header(r.path, Date.now())`, calls
    `deps.request({...r,
    cookie})`, then for each `reply.setCookies` calls
    `jar.set(raw, r.path,
    Date.now())` (logging `rejected`) and returns the
    reply **without** `setCookies`. `GuestAppDependencies` gains
    `queue: SlotQueue`. The jar is cleared on stop, reset and resident exit.
    Request path: `DemoRequest` gains `body?: ArrayBuffer`, `referrer?: string`,
    method widened to `GuestMethod`.
  - `attachGuestApps(session, pins, options): Map<GuestAppId, GuestApp>`
    creating one `GuestApp` per registry app qualified for these pins
    (`appInlineScriptHashes(pins, id) !== undefined`), all sharing one
    `SlotQueue`. `portBusy` implementation:

    ```ts
    portBusy: async () => {
      try {
        const c = await session.dialSandboxPort(port);
        await c.close();
        return true; // someone is listening: refuse to start
      } catch (e) {
        if (/rc=-111\b/.test(String(e))) return false; // ECONNREFUSED: free
        throw e; // any other error fails the start
      }
    },
    ```
    - `handleGuestAppMessage(apps, value, send): Promise<boolean>` routes
      lifecycle and `datasette-http` messages by `msg.app`, and aborts by
      session (see below); `datasette-state` replies carry `app`; the HTTP reply
      path forwards `body` as before.
  - Coordinator posts
    `{ type: "guest-app-qualification", apps:
    Partial<Record<GuestAppId, string[]>> }`
    (replacing `datasette-qualification`) built from `appInlineScriptHashes`.

- [ ] **Step 1: Write the failing tests (in `tests/guest_app_test.ts`)**

```ts
Deno.test("Set-Cookie is stored in the jar, stripped from the reply and replayed", async () => {
  // fixture: deps.request records options and returns, first a reply with
  // setCookies ["sid=1; Path=<prefix>"], then a plain 200.
  const first = await app.request(req("POST", prefix + "login"));
  assertEquals(first.setCookies, undefined);
  await app.request(req("GET", prefix + "home"));
  assertEquals(seen[1].cookie, "sid=1");
  assertEquals(seen[0].cookie, undefined);
});

Deno.test("the jar dies with the session: stop clears it", async () => {
  await app.stop();
  await startAgain();
  await app.request(req("GET", prefix + "home"));
  assertEquals(seen.at(-1)!.cookie, undefined);
});

Deno.test("bursts queue instead of failing: 20 parallel requests all complete with at most 4 in flight", async () => {
  let inflight = 0, peak = 0;
  // deps.request increments inflight, awaits a macrotask, decrements; peak tracked
  const replies = await Promise.all(
    Array.from({ length: 20 }, (_, i) => app.request(req("GET", prefix + i))),
  );
  assertEquals(replies.length, 20);
  assertEquals(peak <= 4, true);
});

Deno.test("stopping while requests are queued rejects them promptly", async () => {
  // hold 4 slots open, queue 3 more, then app.stop()
  await assertRejects(() => queued[0], GuestHttpError);
  // resolves well under the 30 s queue wait (the supervisor's per-request abort fires)
});

Deno.test("full request/reply/abort path through handleGuestAppMessage with two apps", async () => {
  // apps = Map { datasette -> GuestApp A, preview -> GuestApp B }, both running
  // with different sessions; `send` collects replies.
  await handleGuestAppMessage(
    apps,
    httpRequest("preview", sessionB, "r1", "GET", prefixB + "x"),
    send,
  );
  const reply = sent.find((m) => m.type === "datasette-response")!;
  assertEquals([reply.session, reply.requestId, "app" in reply], [
    sessionB,
    "r1",
    false,
  ]);
  // abort carries no app and still reaches the owning app's in-flight request:
  const pending = handleGuestAppMessage(
    apps,
    httpRequest("preview", sessionB, "r2", "GET", prefixB + "slow"),
    send,
  );
  await handleGuestAppMessage(apps, {
    type: "datasette-abort",
    session: sessionB,
    requestId: "r2",
  }, send);
  await pending;
  assertEquals(sent.at(-1)!.type, "datasette-error");
  // an abort for A's session never touches B's request:
  assertEquals(bControllerAborted, false);
});

Deno.test("port ownership: busy port fails start; ECONNREFUSED is free", async () => {
  // covered in Task 8's test for the dep; here unit-test the attach helper's
  // error classification by extracting it as `classifyDial(error): "free" | "throw"`
});
```

For the last test, extract the `rc=-111` check as an exported pure helper
`isConnRefused(error: unknown): boolean` in `src/datasette.ts` and test it with
`new Error("dialSandboxPort connect: rc=-111")` (true), `rc=-110` (false),
`new Error("x")` (false).

- [ ] **Step 2: Run to verify failure**

Run:
`deno test --no-check --allow-read --allow-write --allow-env --allow-net tests/guest_app_test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`GuestApp.request`:

```ts
async request(r: GuestAppRequest): Promise<GuestHttpReply> {
  if (this.#snapshot.state !== "running" || r.session !== this.#snapshot.session) {
    throw new GuestHttpError(`${this.spec.title} owner is stopped`, 503);
  }
  const key = r.session + ":" + r.requestId;
  if (this.#requests.has(key)) throw new GuestHttpError("duplicate request", 502);
  const controller = new AbortController();
  this.#requests.set(key, controller);
  try {
    const release = await this.deps.queue.acquire(r.session, controller.signal);
    try {
      const cookie = this.#jar.header(r.path, Date.now()) || undefined;
      const { setCookies, ...reply } = await this.#probe({
        ...r, app: this.spec.id, prefix: this.#snapshot.prefix!,
        signal: controller.signal, cookie,
      });
      for (const raw of setCookies ?? []) {
        if (this.#jar.set(raw, r.path, Date.now()) === "rejected") {
          console.warn(`${this.spec.title}: cookie jar full, Set-Cookie rejected`);
        }
      }
      return reply;
    } finally {
      release();
    }
  } finally {
    if (this.#requests.get(key) === controller) this.#requests.delete(key);
  }
}
```

`#jar = new CookieJar()`; call `this.#jar.clear()` in `stop()`, `reset()` and
`#exit`. `#cancelRequests()` already aborts every controller, which also rejects
queued waiters (the abort listener in `SlotQueue.acquire`).

The 64 MiB per-session buffered-bytes cap uses `ByteBudget` (Task 3), one per
`GuestApp` session (create a fresh `#budget = new ByteBudget()` in `start()`).
Reserve **before** queueing so queued uploads count:

```ts
const reserved = { bytes: 0 };
const take = (n: number) => { this.#budget.take(n); reserved.bytes += n; };
try {
  take(r.body?.byteLength ?? 0);                 // before acquire()
  const release = await this.deps.queue.acquire(r.session, controller.signal);
  try {
    ... await this.#probe({ ..., onBuffer: take }) ...   // response chunks
  } finally { release(); }
} finally {
  this.#budget.give(reserved.bytes);              // success, error or abort
  ...
}
```

A request cancelled while queued (stop, abort, queue timeout) therefore gives
its bytes back through the same `finally`. Tests: (a) with a 100-byte budget,
queued bodies past the cap are rejected 503 immediately while earlier ones are
still waiting; (b) aborting a queued request frees its reservation (a following
request fits); (c) a response whose chunks exceed the remaining budget fails 503
and leaves the budget empty; (d) the budget is empty after every request
settles. Note the SW holds a request body (blob) before forwarding; the 16 MiB
per-request limit bounds that side.

`attachGuestApps` / `handleGuestAppMessage` follow the interface above; the
coordinator (`coordinator_worker.ts`) changes:

- `let datasette: DatasetteDemo` ->
  `let apps: Map<GuestAppId, GuestApp> | undefined`.
- `FromWorker`: replace `datasette-qualification` with the new
  `guest-app-qualification` message.
- Post it where `datasette-qualification` is posted today, with
  `Object.fromEntries(Object.keys(GUEST_APPS).flatMap((id) => { const h = pins && appInlineScriptHashes(pins, id); return h ? [[id, h]] : []; }))`
  (empty object on desktop).
- `handleDatasetteMessage(datasette, msg, post)` ->
  `handleGuestAppMessage(apps, msg, post)`.
- `GuestReply` stays without `app` (envelope rules, Task 6); `LifecycleReply`
  carries it. `handleGuestAppMessage` resolves `datasette-abort` by calling
  `app.abort(session, requestId)` on every app (a no-op where the request is not
  owned).

- [ ] **Step 4: Run tests**

Run:
`deno test --no-check --allow-read --allow-write --allow-env --allow-net tests/guest_app_test.ts tests/datasette_test.ts tests/datasette_fallback_test.ts`
and `deno check src/coordinator_worker.ts` (needs the kernel checkout).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
deno fmt && git add -A && git commit -m "feat: coordinator queue, cookie jar, port ownership check and multi-app dispatch"
```

---

## Task 10: The preview app (guest `wsgiref` server)

**Files:**

- Create: `public/demo/preview_server.py` (guest script, served by the page
  bundle like `datasette_seed.py`), `src/preview.ts` (the spec),
  `public/demo/preview_index.html`
- Modify: `src/datasette.ts`'s `attachGuestApps` (register `previewSpec`),
  `scripts/build-static.ts:42` list (add the two demo files)
- Test: `tests/preview_spec_test.ts`, `tests/preview_server_test.ts`

**Interfaces:**

- Produces:
  - `previewSpec: GuestAppSpec` in `src/preview.ts`: `id: "preview"`,
    `dir = "/home/user/demos/preview"`, served files live in `${dir}/site/`.
  - guest server `python3 preview_server.py <port> <prefix> <site-dir>`.

Server contract (`public/demo/preview_server.py`, stdlib only):

- WSGI app over `wsgiref.simple_server.make_server("127.0.0.1", port, app)`.
- A wrapper sets `environ["SCRIPT_NAME"] = prefix.rstrip("/")` and strips the
  prefix from `PATH_INFO` (so the app builds prefixed URLs from `SCRIPT_NAME`).
- `GET /__ready` -> `200`, body `yurt-preview-ready` (the readiness marker only
  this app produces; path is `prefix + "__ready"`).
- Static files under `site/`: `.html .css .js .mjs .wasm .svg .json .txt` with
  correct `Content-Type` (`mimetypes` plus `.mjs` -> `text/javascript`, `.wasm`
  -> `application/wasm`); path traversal (`..`, absolute) -> 404; directory ->
  `index.html`.
- `GET /form` renders a form posting to `SCRIPT_NAME + "/form"` with a hidden
  `csrf` field, and sets `Set-Cookie: yurt_csrf=<same token>; Path=<prefix>`
  (double-submit token). `POST /form` (urlencoded `name=...&csrf=...`) answers
  `403` unless the `csrf` field equals the `yurt_csrf` cookie, otherwise sets
  `Set-Cookie: yurt_name=<value>; Path=<prefix>`, and answers `303` with
  `Location: SCRIPT_NAME + "/"` (relative-safe). The index page shows the
  cookie-backed greeting.
- The server logs one line per request to stdout (`method path status`) so
  requests appear in `server.log`.
- Single-threaded (`wsgiref` default), listen backlog default.

- [ ] **Step 1: Write the failing tests**

`tests/preview_server_test.ts` runs the script with the host's `python3` (skip
with a clear message if absent; CI has python) on a free port with a temp
`site/`, and uses `fetch`:

```ts
// readiness marker, static types, traversal, POST login flow, SCRIPT_NAME links
Deno.test("preview server contract", async () => {
  const { port, stop, base } = await startPreview({
    "index.html": "<h1>hi</h1>",
    "app.mjs": "export {}",
    "x.wasm": "\0asm",
  });
  try {
    assertEquals(
      await (await fetch(base + "__ready")).text(),
      "yurt-preview-ready",
    );
    assertEquals(
      (await fetch(base + "app.mjs")).headers.get("content-type")?.startsWith(
        "text/javascript",
      ),
      true,
    );
    assertEquals(
      (await fetch(base + "x.wasm")).headers.get("content-type"),
      "application/wasm",
    );
    assertEquals((await fetch(base + "..%2f..%2fetc/passwd")).status, 404);
    // Host Deno fetch has no cookie jar: capture the CSRF cookie and replay it.
    const form = await fetch(base + "form");
    const csrfCookie = form.headers.get("set-cookie")!.split(";")[0]; // yurt_csrf=<token>
    const token = csrfFrom(await form.text());
    assertEquals(csrfCookie, "yurt_csrf=" + token);
    const post = await fetch(base + "form", {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: csrfCookie,
      },
      body: "name=Ada&csrf=" + token,
    });
    assertEquals(post.status, 303);
    // Enforcement: the same field without the cookie, or with a wrong token, is 403.
    const noCookie = await fetch(base + "form", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "name=Ada&csrf=" + token,
    });
    assertEquals(noCookie.status, 403);
    await noCookie.body?.cancel();
    assertEquals(post.headers.get("location"), PREFIX); // SCRIPT_NAME-based, inside the prefix
    assertEquals(
      post.headers.get("set-cookie")?.includes("yurt_name=Ada"),
      true,
    );
  } finally {
    await stop();
  }
});
```

`tests/preview_spec_test.ts`: `previewSpec.spawnLine(prefix, 8002)` contains the
port and prefix (shell-quoted), `readyPath(prefix) === prefix + "__ready"`,
`isReady` is true only for `200` + body `yurt-preview-ready`, `prepare` writes
the server script (always) and the default `site/index.html` and `site/app.js`
**only when absent** (a second `prepare` does not overwrite an edited file), and
`reset` restores both defaults. With a fake `ctx` recording `finite`/`asset`
calls, assert the installed set is exactly `preview_server.py`,
`preview_index.html` -> `site/index.html` and `preview_app.js` -> `site/app.js`,
so the index's `<script src="app.js">` has a file to load.

- [ ] **Step 2: Run to verify failure**

Run:
`deno test --no-check --allow-read --allow-write --allow-env --allow-net --allow-run tests/preview_server_test.ts tests/preview_spec_test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Write `public/demo/preview_server.py` to the contract above (about 100 lines;
use `wsgiref.simple_server` with a `WSGIRequestHandler` subclass whose
`log_message` writes `"%s %s %s"` to stdout and flushes). `src/preview.ts`
follows `datasetteSpec`'s shape: `prepare` runs `mkdir -p ${dir}/site`, installs
the script via `ctx.asset("preview_server.py")`, and installs `site/index.html`
from `ctx.asset("preview_index.html")` and `site/app.js` from
`ctx.asset("preview_app.js")`, each only if `[ -e <target> ]` fails (one
`finite` per file, so an edited file survives a restart); `reset` rewrites both
unconditionally;
`spawnLine = exec python3 ${dir}/preview_server.py <port> <prefix> ${dir}/site`;
`isReady` as above. `public/demo/preview_index.html` references an external
`app.js` (no inline scripts) and includes the cookie greeting and a link to
`form`. Add both demo files to the `scripts/build-static.ts` copy list
(`"demo/preview_server.py"`, `"demo/preview_index.html"`,
`"demo/preview_app.js"`).

- [ ] **Step 4: Run tests**

Same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
deno fmt && git add -A && git commit -m "feat: wsgiref preview app (guest server, spec, demo files)"
```

---

## Task 11: Page - per-app panels, bridge SW at `/apps/`, migration

**Files:**

- Modify: `src/datasette_page.ts` (generalize `mountDatasette`),
  `src/page.ts:195`, `public/index.html` (new `#preview` section next to
  `#datasette`, line ~701)
- Create: `public/apps/_bridge/unavailable.html` (moved from
  `public/apps/datasette/unavailable.html`)
- Test: `tests/datasette_page_test.ts` (update + add)

**Interfaces:**

- Consumes: Tasks 1, 6, 9 (messages carry `app`; `guest-app-qualification`).
- Produces:
  `mountGuestApp(root, coordinator, browser, app: GuestAppId, ui:
  GuestAppUi): () => void`;
  `mountDatasette` becomes
  `mountGuestApp(root, coordinator, browser, "datasette", datasetteUi)` and
  `mountPreview(root, coordinator, browser)` the preview equivalent.
  `GuestAppUi` =
  `{ markup: string; frameTitle: string; download?: { label, path, filename } }`
  (only Datasette has `download`).

Changes inside the mount (all from the code read at plan time):

1. Prefix/messages (envelope rules, Task 6): outgoing `datasette-http`,
   lifecycle and `datasette-register` messages gain `app`; incoming
   `datasette-state` and `guest-app-qualification` are filtered by `app`.
   Incoming `datasette-response`/`datasette-error` are matched by `session` +
   `requestId` exactly as today (they carry no `app`), and `datasette-abort`
   posts keep `session` + `requestId` only.
2. SW registration:
   `navigator.serviceWorker.register("/apps/bridge-sw.js",
   { scope: "/apps/" })`.
   **Before** registering, unregister any registration whose `scope` ends with
   `/apps/datasette/` (the old longer scope wins for `/apps/datasette/*` until
   removed):

   ```ts
   for (const r of await navigator.serviceWorker.getRegistrations()) {
     if (new URL(r.scope).pathname === "/apps/datasette/") await r.unregister();
   }
   ```
3. Qualification: handle `guest-app-qualification`;
   `qualified = hashes !==
   undefined` (an empty list is valid);
   `hashes = msg.apps[app] ?? []`.
4. Two panels share one SW registration and one `message` listener per tab. Keep
   per-app owner state inside each mount (they already are closure-local); the
   SW owner map is per session, so the two mounts do not collide. Do not share
   mutable state between mounts.
5. `datasetteControls` stays for Datasette's four buttons; the preview panel has
   Start / Stop / Reset only (`download` hidden). Reuse `datasetteControls` with
   `download` ignored.
6. Preview panel text states the contract plainly: "Serves files from
   `/home/user/demos/preview/site/` (edit them in the terminal, then refresh).
   Inline scripts are blocked; use external `.js` files."
7. Both frames:
   `sandbox="allow-scripts allow-same-origin allow-forms
   allow-downloads"`,
   `title` from `ui.frameTitle`.
8. `public/index.html`: add

   ```html
   <section
     class="pane"
     id="preview"
     aria-label="Preview"
     data-testid="preview"
     hidden
   >
   </section>
   ```

   and in `src/page.ts` after the existing call:
   `mountPreview(byId("preview"), worker, desktop === undefined);`

- [ ] **Step 1: Write the failing tests**

In `tests/datasette_page_test.ts` (read its existing harness first; it bundles
the page against a fake coordinator): assert (a) the mount registers
`/apps/bridge-sw.js` with scope `/apps/` and unregisters a pre-existing
`/apps/datasette/` registration first; (b) a `guest-app-qualification` message
with `apps: { preview: [] }` un-hides the preview panel and leaves the Datasette
panel hidden; (c) a `datasette-state` message for `app: "preview"` does not
change the Datasette panel; (d) Start posts
`{ type: "datasette-start", app:
"preview", requestId }`; (e) the iframe `src`
is `/apps/preview/<session>/`.

- [ ] **Step 2: Run to verify failure**

Run:
`deno test --no-check --allow-read --allow-write --allow-env --allow-net --allow-run tests/datasette_page_test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** per the numbered list.
      `git mv
  public/apps/datasette/unavailable.html public/apps/_bridge/unavailable.html`
      (create the directory).

- [ ] **Step 4: Run tests**

Same command. Expected: PASS. `deno check src/datasette_page.ts src/page.ts`.

- [ ] **Step 5: Commit**

```bash
deno fmt && git add -A && git commit -m "feat: per-app preview panels and bridge service worker at /apps/"
```

---

## Task 12: Build, serve and CI migration

**Files:**

- Modify: `scripts/serve.ts:68-73`, `scripts/build-static.ts:42-44,150`,
  `src/serve.ts:238-256`, `.gitignore:50`, `deno.json:27,49,77`
- Test: `tests/build_static_test.ts`, `tests/serve_test.ts`, `tests/csp_test.ts`
  (update the hard-coded paths)

**Interfaces:**

- Consumes: Tasks 7, 11 (SW at `/apps/bridge-sw.js`, page at
  `/apps/_bridge/unavailable.html`).
- Produces: bundle output `public/apps/bridge-sw.js`; `_redirects` rule
  `/apps/:app/:session/* /apps/_bridge/unavailable.html 200`.

- [ ] **Step 1: Update the tests first**

Run: `grep -rn "apps/datasette" tests src scripts deno.json .gitignore` In
`tests/build_static_test.ts`, `tests/serve_test.ts` and `tests/csp_test.ts`
change expectations to the new paths: `apps/bridge-sw.js`,
`apps/_bridge/unavailable.html`, and the `_redirects` line above. Add to
`tests/serve_test.ts`: `/apps/preview/<uuid>/x` (no SW) is served the
unavailable page with the isolation headers; `/apps/bridge-sw.js` is **not**
swallowed by the fallback.

- [ ] **Step 2: Run to verify failure**

Run:
`deno test --no-check --allow-read --allow-write --allow-env --allow-net --allow-run tests/build_static_test.ts tests/serve_test.ts tests/csp_test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `scripts/serve.ts`: `mkdir public/apps` (not `public/apps/datasette`), bundle
  to `public/apps/bridge-sw.js`.
- `scripts/build-static.ts`: copy list entries become `"apps/bridge-sw.js"` and
  `"apps/_bridge/unavailable.html"`; `_redirects` rule as above.
- `src/serve.ts`: fallback condition becomes
  `pathname.startsWith("/apps/") && pathname !== "/apps/bridge-sw.js" && pathname !== "/apps/_bridge/unavailable.html"`,
  reading `apps/_bridge/unavailable.html`, CSP path
  `/apps/_bridge/unavailable.html`.
- `.gitignore:50`: `public/apps/bridge-sw.js`.
- `deno.json` exclusions at lines 27, 49, 77: replace
  `public/apps/datasette/service-worker.js` with `public/apps/bridge-sw.js`.
- Remove the stale generated `public/apps/datasette/` directory locally
  (`rm -rf public/apps/datasette`; it is gitignored).

- [ ] **Step 4: Run tests and the full static gates**

Run:
`deno test --no-check --allow-read --allow-write --allow-env --allow-net --allow-run tests/build_static_test.ts tests/serve_test.ts tests/csp_test.ts && deno fmt --check && deno lint`
Expected: PASS. (`deno check '**/*.ts'` needs the kernel checkout.)

- [ ] **Step 5: Commit**

```bash
deno fmt && git add -A && git commit -m "build: move the bridge SW and unavailable page to /apps/"
```

---

## Task 13: End-to-end acceptance

**Files:**

- Create: `tests/preview_e2e.ts`
- Modify: `tests/datasette_e2e.ts` (lines 13 and 48 only),
  `tests/datasette_bridge_e2e.ts`, `tests/guest_http_e2e.ts`,
  `tests/fixtures/guest_http_worker.ts`, `.github/workflows/ci.yml` (add
  `tests/preview_e2e.ts` wherever `tests/datasette_e2e.ts` runs)
- Test: the e2e files themselves

**Interfaces:**

- Consumes: everything above; requires `YURT_KERNEL_ROOT` and the playground
  image (see `tests/datasette_e2e.ts` header for the setup it assumes).

- [ ] **Step 1: Keep Datasette e2e green**

In `tests/datasette_e2e.ts` replace the two reads of
`pins.datasette!.inlineScriptHashes` (lines 13 and 48) with
`appInlineScriptHashes(pins, "datasette")!`; the `/apps/datasette/` frame URL
matches stay. In `tests/datasette_bridge_e2e.ts`, `tests/guest_http_e2e.ts` and
`tests/fixtures/guest_http_worker.ts` update the hard-coded path/port/message
fields (`app`, `/apps/bridge-sw.js`). Run
`deno test --no-check ... tests/datasette_e2e.ts`; expected PASS with no
assertion changes.

- [ ] **Step 2: Write `tests/preview_e2e.ts`**

Model it on `tests/datasette_e2e.ts` (same server/browser/CSP-watch/external-
request guards). Scenario, each an `assertEquals`/locator wait:

1. Start the sandbox, click **Start preview**, wait for `#preview iframe`.
2. Frame shows the default index; a request for `app.mjs` returns
   `text/javascript` and the page's script ran (proves `nosniff` does not break
   the guest MIME table); `x.wasm` fetch returns `application/wasm`.
3. **Burst:** the served `burst.html` page loads 24 small images/scripts in
   parallel; all 24 load (Review Focus 1). Create it in the guest from the
   terminal in step 6 or ship it as a second default file.
4. **POST + cookie + redirect:** submit the form; the iframe lands back on the
   prefixed index showing the cookie-backed greeting (Review Focus 3); reload
   and the greeting persists (jar replayed `Cookie`); `document.cookie` in the
   frame does not contain `yurt_name` (HttpOnly to the page).
5. **Cross-site referrer:**
   `fetch(prefix + "form", { method: "POST", body: "x",
   referrerPolicy: "no-referrer" })`
   from the frame returns `403`.
6. **Edit a served file:** from the terminal run
   `echo '<h1>edited</h1>' > /home/user/demos/preview/site/index.html`, reload
   the frame, see `edited`.
7. Requests appear in the guest log: terminal
   `tail -n 5 /home/user/demos/preview/server.log` contains `GET`.
8. **Lifecycle:** Stop; the port is released (Start again succeeds); Reset
   restores the default index; a failing start (occupy 8002 with
   `python3 -m http.server 8002 &` first) surfaces the "in use" error in the
   page while the terminal stays usable.
9. **Top-level refusal:** `page.goto(server.url + prefix)` in a fresh tab shows
   the explanatory page (not the guest app).
10. **Migration:** a persistent context pre-registers an SW at scope
    `/apps/datasette/` (a stub script served from the test server), then loads
    the playground; assert `getRegistrations()` has no `/apps/datasette/` scope
    and has `/apps/`.

- [ ] **Step 3: Run**

Run:
`deno test --no-check --allow-read --allow-write --allow-env --allow-net --allow-run tests/preview_e2e.ts tests/datasette_e2e.ts`
Expected: PASS. If the pre-check dial or `rc=-111` classification misbehaves in
step 8, record the real error text from the guest dial in a comment on
`isConnRefused` and fix the regex (the plan assumes `connect: rc=-111`, per the
kernel's `sandbox_port.ts`; a refusal reported on first read instead of connect
would need a one-byte read probe).

- [ ] **Step 4: Commit**

```bash
deno fmt && git add -A && git commit -m "test: preview e2e and datasette e2e on the generalized bridge"
```

---

## Task 14: Spec and docs reconciliation

**Files:**

- Modify: `docs/superpowers/specs/2026-10-03-guest-http-preview-design.md`,
  `public/demo/README.md`

- [ ] **Step 1:** Update the spec where the plan made concrete choices:
  - Section 8 / pins: per-app qualification is
    `appInlineScriptHashes(pins, app)`; the preview app's empty list lives in
    the registry accessor, not in `artifacts/pins.json`; the validator keeps
    requiring a non-empty list for Datasette. Remove the claim that the pins
    validator must accept empty lists.
  - Section 3: cookie replacement is allowed when the total still fits (not
    unconditionally).
  - Registry: ids `datasette` / `preview`, ports 8001 / 8002.
- [ ] **Step 2:** Add a `public/demo/README.md` section describing the preview
      panel, where files live, the inline-script rule, and that cookies are
      invisible to page JavaScript.
- [ ] **Step 3:** Run `deno fmt --check`, commit:

```bash
git add -A && git commit -m "docs: reconcile spec with the implementation plan; document the preview panel"
```

---

## Self-review

**Spec coverage:** addressing and reserved paths (Tasks 1, 7, 11, 12); registry
and supervisor (1, 8, 9); port ownership (8, 9); methods/bodies/413/limits/
queue (3, 4, 7, 9); header allow-lists (4, 5, 7); cross-site check (7);
Origin/Referer synthesis (4); redirects (existing + Task 4 test); cookies (2, 4,
9); response policy and CSP on all responses (5); top-level refusal (7, 13);
ranges (pass through via the allow-list, Task 5); migration inventory (4, 6, 8,
9, 11, 12, 13, including `scripts/datasette-qualified.ts`,
`tests/datasette_pins_test.ts` and `src/pins.ts`, which only change in Task 1
and stay compatible because Datasette's validator is untouched); SW
migration/unregister (11, 13); known limits (14). **Gap to confirm during Task
1:** `scripts/datasette-qualified.ts` reads `pins.datasette` directly; it keeps
working unchanged, so no edit is planned.

**Placeholder scan:** Tasks 7, 8, 9 and 11 describe edits to existing large
files as precise replacement lists rather than whole-file listings; each lists
the exact symbols and strings and has a test that fails first. The test bodies
in Tasks 7, 9 and 11 are written against fixtures in files the implementer must
read first (stated in each step).

**Type consistency:** `GuestAppId`/`appPrefix` (Task 1) are the only way
prefixes are built after Task 4; `GuestMethod`/`GUEST_METHODS` (Task 4) feed
Tasks 6-7; `GuestHttpReply.setCookies?` (Task 4) is consumed only in Task 9;
`SlotQueue.acquire` (Task 3) is called only in `GuestApp.request` (Task 9);
`GuestAppSpec`/`GuestAppContext` (Task 8) are implemented by `datasetteSpec`
(Task 8) and `previewSpec` (Task 10); message `type` names stay `datasette-*`
with an added `app` (Tasks 6, 7, 9, 11).
