/**
 * Test-only instrumentation for tests/memory_budget_e2e.ts: what the page,
 * the coordinator Worker and every Worker under them allocate, and a
 * simulated iOS cap on shared `WebAssembly.Memory` reservations.
 *
 * {@link allocationCensus} runs first in every realm: in the page through
 * `addInitScript`, in each Worker prepended to its script by a route
 * ({@link censusSource}). It counts, per realm, the buffers of 1 MiB or more
 * made by the `ArrayBuffer`, `SharedArrayBuffer` and typed-array
 * constructors (a view on an existing buffer allocates nothing and is not
 * counted) and by `slice`, and every shared memory's maximum, which an
 * engine reserves whole up front.
 *
 * The counters live in one SharedArrayBuffer the page makes and hands to
 * each Worker it, or a Worker, starts: as the first message, which the
 * census in the Worker takes before the Worker's own listeners see it. So a
 * reservation in any realm is checked synchronously against the tab's total,
 * as iOS WebKit checks it against the one WebContent process's cap of about
 * 4 GiB (src/guest_memory_reservation.ts): a shared memory that would take
 * the live total past {@link CensusConfig.capBytes} is refused with the
 * engine's RangeError.
 *
 * A reservation stays live until its realm collects the memory (a WeakRef,
 * swept on every reservation and by a FinalizationRegistry) or the Worker
 * that made it is terminated. Before refusing, the census runs a full GC
 * when the browser exposes one (`--js-flags=--expose-gc`) and sweeps again,
 * as JavaScriptCore collects before it refuses a memory. A memory another
 * realm still holds after its maker dropped it counts as released: the
 * total can only under-count such a memory, never invent one.
 */

/** What every realm's census is started with. */
export type CensusConfig = {
  /** The simulated cap on live shared-memory reservations. */
  capBytes: number;
  /** The smallest buffer counted as a large allocation. */
  bigBytes: number;
};

/** One realm kind's counters, as {@link CensusReading} reports them. */
export type RealmTotals = {
  realms: number;
  /** Large buffers made, and their bytes. */
  bigCount: number;
  bigBytes: number;
  /** The largest single large buffer. */
  bigMaxBytes: number;
  /** Shared memories made, and the maximum bytes still reserved. */
  memories: number;
  liveReservedBytes: number;
};

/** What `globalThis.__yurtCensus.read()` answers in the page. */
export type CensusReading = {
  liveReservedBytes: number;
  /** The most reserved at once while no reservation probe ran. */
  peakReservedBytes: number;
  /** Reservations refused at the cap, the probe's own left out; each is
   *  logged as a `[census] simulated iOS cap` warning in its realm. */
  refused: number;
  /** Per realm kind: page, coordinator, guest, probe, other. */
  kinds: Record<string, RealmTotals>;
};

/** Realm kinds, by the script a Worker runs. */
export const REALM_KINDS = [
  "page",
  "coordinator",
  "guest",
  "probe",
  "other",
] as const;

/**
 * The census, installed in the realm it runs in. Self-contained: it is
 * also serialized with `toString()` into each Worker's script.
 */
export function allocationCensus(config: CensusConfig): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (scope.__yurtCensus !== undefined) return;
  const KINDS = ["page", "coordinator", "guest", "probe", "other"];
  const PAGE_BYTES = 65536;
  const KIB = 1024;
  const capPages = Math.floor(config.capBytes / PAGE_BYTES);
  // Int32 header, then one 8-int slot per realm.
  const H_NEXT = 0, H_LIVE = 1, H_PEAK = 2, H_REFUSED = 3, H_PROBES = 4;
  const SLOTS = 16, STRIDE = 8, MAX_REALMS = 1000;
  const S_KIND = 0, S_LIVE = 1, S_BIG = 2, S_BIG_KIB = 3, S_MEMS = 4;
  const S_BIG_MAX_KIB = 5;
  const NativeSAB = SharedArrayBuffer;
  const isPage = typeof (globalThis as { document?: unknown }).document ===
    "object";
  if (isPage && globalThis !== (globalThis as { top?: unknown }).top) return;

  let shared: Int32Array | undefined;
  let slot = -1;
  // What this realm did before its slot arrived.
  const early = { live: 0, big: 0, bigKiB: 0, bigMaxKiB: 0, mems: 0 };
  const at = (field: number) => SLOTS + slot * STRIDE + field;
  const add = (field: number, n: number) => {
    if (shared === undefined) {
      if (field === S_LIVE) early.live += n;
      if (field === S_BIG) early.big += n;
      if (field === S_BIG_KIB) early.bigKiB += n;
      if (field === S_MEMS) early.mems += n;
      return;
    }
    Atomics.add(shared, at(field), n);
  };
  const raiseMax = (field: number, n: number) => {
    if (shared === undefined) {
      early.bigMaxKiB = Math.max(early.bigMaxKiB, n);
      return;
    }
    let seen = Atomics.load(shared, at(field));
    while (n > seen) {
      const was = Atomics.compareExchange(shared, at(field), seen, n);
      if (was === seen) break;
      seen = was;
    }
  };
  const attach = (buffer: SharedArrayBuffer, index: number) => {
    shared = new Int32Array(buffer);
    slot = index;
    add(S_LIVE, early.live);
    Atomics.add(shared, H_LIVE, early.live);
    add(S_BIG, early.big);
    add(S_BIG_KIB, early.bigKiB);
    add(S_MEMS, early.mems);
    raiseMax(S_BIG_MAX_KIB, early.bigMaxKiB);
    notePeak();
  };
  // The peak leaves out the reservation probe's lifetime: the probe
  // reserves up to the cap on purpose, to measure it.
  const notePeak = () => {
    if (shared === undefined || Atomics.load(shared, H_PROBES) > 0) return;
    const live = Atomics.load(shared, H_LIVE);
    let peak = Atomics.load(shared, H_PEAK);
    while (live > peak) {
      const was = Atomics.compareExchange(shared, H_PEAK, peak, live);
      if (was === peak) break;
      peak = was;
    }
  };

  // Large allocations.
  const noteBytes = (bytes: number) => {
    if (bytes < config.bigBytes) return;
    const kib = Math.ceil(bytes / KIB);
    add(S_BIG, 1);
    add(S_BIG_KIB, kib);
    raiseMax(S_BIG_MAX_KIB, kib);
  };
  const isBuffer = (value: unknown) => {
    const tag = Object.prototype.toString.call(value);
    return tag === "[object ArrayBuffer]" ||
      tag === "[object SharedArrayBuffer]";
  };
  const counted = <T extends abstract new (...args: never[]) => unknown>(
    Native: T,
    allocates: (args: unknown[]) => boolean,
  ): T => {
    const proxy: T = new Proxy(Native, {
      construct(target, args, newTarget) {
        const made = Reflect.construct(
          target,
          args,
          newTarget === proxy ? target : newTarget,
        ) as { byteLength: number };
        if (allocates(args)) noteBytes(made.byteLength);
        return made;
      },
    });
    return proxy;
  };
  for (const name of ["ArrayBuffer", "SharedArrayBuffer"]) {
    const Native = scope[name] as new (n: number) => ArrayBuffer;
    const proto = Native.prototype as { slice: (...a: number[]) => unknown };
    const slice = proto.slice;
    proto.slice = function (this: ArrayBuffer, ...args: number[]) {
      const made = slice.apply(this, args) as ArrayBuffer;
      noteBytes(made.byteLength);
      return made;
    };
    scope[name] = counted(Native, () => true);
  }
  const typedNames = [
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
  ];
  const TypedArray = Object.getPrototypeOf(Uint8Array) as {
    prototype: { slice: (...a: number[]) => unknown };
  };
  const typedSlice = TypedArray.prototype.slice;
  TypedArray.prototype.slice = function (
    this: Uint8Array,
    ...args: number[]
  ) {
    const made = typedSlice.apply(this, args) as Uint8Array;
    noteBytes(made.byteLength);
    return made;
  };
  for (const name of typedNames) {
    const Native = scope[name] as new (n: number) => Uint8Array;
    if (Native === undefined) continue;
    // `new Uint8Array(buffer, ...)` is a view; any other argument copies or
    // allocates.
    scope[name] = counted(Native, (args) => !isBuffer(args[0]));
  }

  // Shared memory reservations, with the simulated cap.
  const NativeMemory = WebAssembly.Memory;
  const held: { ref: WeakRef<object>; pages: number }[] = [];
  const release = (pages: number) => {
    add(S_LIVE, -pages);
    if (shared !== undefined) Atomics.sub(shared, H_LIVE, pages);
  };
  const sweep = () => {
    for (let i = held.length - 1; i >= 0; i--) {
      if (held[i].ref.deref() === undefined) {
        release(held[i].pages);
        held.splice(i, 1);
      }
    }
  };
  const collected = new FinalizationRegistry(() => sweep());
  const liveNow = () =>
    shared === undefined ? early.live : Atomics.load(shared, H_LIVE);
  const gc = (globalThis as { gc?: () => void }).gc;
  const Memory = function (
    this: unknown,
    descriptor: WebAssembly.MemoryDescriptor,
  ) {
    if (new.target === undefined) {
      throw new TypeError("WebAssembly.Memory must be called with new");
    }
    if (descriptor?.shared !== true) {
      return Reflect.construct(NativeMemory, [descriptor], new.target);
    }
    const pages = Number(descriptor.maximum ?? descriptor.initial);
    sweep();
    if (liveNow() + pages > capPages && gc !== undefined) {
      gc();
      sweep();
    }
    if (liveNow() + pages > capPages) {
      // The probe measures the cap by reaching it: its refusal is its answer.
      const probe = shared !== undefined && shared[at(S_KIND)] === 3;
      if (shared !== undefined && !probe) Atomics.add(shared, H_REFUSED, 1);
      const why = `simulated iOS cap: ${pages * PAGE_BYTES / 2 ** 20} MiB ` +
        `asked with ${liveNow() * PAGE_BYTES / 2 ** 20} MiB live in ` +
        `${slot < 0 ? "?" : KINDS[shared![at(S_KIND)]]}`;
      if (!probe) console.warn(`[census] ${why}`);
      throw new RangeError(`WebAssembly.Memory(): ${why}`);
    }
    const memory = Reflect.construct(
      NativeMemory,
      [descriptor],
      new.target,
    ) as WebAssembly.Memory;
    add(S_MEMS, 1);
    add(S_LIVE, pages);
    if (shared !== undefined) Atomics.add(shared, H_LIVE, pages);
    notePeak();
    held.push({ ref: new WeakRef(memory), pages });
    collected.register(memory, null);
    return memory;
  } as unknown as typeof WebAssembly.Memory;
  Memory.prototype = NativeMemory.prototype;
  (WebAssembly as { Memory: unknown }).Memory = Memory;

  // Hand the counters to every Worker this realm starts, and release what a
  // Worker reserved when it is terminated.
  const NativeWorker = scope.Worker as typeof Worker | undefined;
  const kindOf = (url: string) => {
    const name = new URL(url, String(globalThis.location)).pathname
      .split("/").pop() ?? "";
    if (name === "coordinator.bundle.js") return 1;
    if (/^worker_bootstrap\.(js|ts)$/.test(name)) return 2;
    if (name === "memory-probe.js") return 3;
    return 4;
  };
  if (NativeWorker !== undefined) {
    scope.Worker = class extends NativeWorker {
      #slot = -1;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        // Only a script served with the census in front can take the
        // counters; any other Worker would read them as its own message.
        const kind = kindOf(String(url));
        if (shared === undefined || kind === 4) return;
        const index = Atomics.add(shared, H_NEXT, 1);
        if (index >= MAX_REALMS) throw new Error("census: too many realms");
        Atomics.store(shared, SLOTS + index * STRIDE + S_KIND, kind);
        this.#slot = index;
        if (kind === 3) Atomics.add(shared, H_PROBES, 1);
        super.postMessage({ __yurtCensus: shared.buffer, slot: index });
      }
      override terminate() {
        super.terminate();
        if (shared === undefined || this.#slot < 0) return;
        const base = SLOTS + this.#slot * STRIDE;
        Atomics.sub(shared, H_LIVE, Atomics.exchange(shared, base + S_LIVE, 0));
        if (Atomics.load(shared, base + S_KIND) === 3) {
          Atomics.sub(shared, H_PROBES, 1);
        }
        this.#slot = -1;
      }
    };
  }

  if (isPage) {
    shared = new Int32Array(
      new NativeSAB((SLOTS + MAX_REALMS * STRIDE) * 4),
    );
    shared[H_NEXT] = 1;
    attach(shared.buffer as SharedArrayBuffer, 0);
  } else {
    globalThis.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as { __yurtCensus?: SharedArrayBuffer } | null;
      if (data?.__yurtCensus === undefined || shared !== undefined) return;
      event.stopImmediatePropagation();
      attach(data.__yurtCensus, (data as { slot: number }).slot);
    });
  }

  scope.__yurtCensus = {
    read(): unknown {
      const view = shared!;
      const kinds: Record<string, Record<string, number>> = {};
      for (const kind of KINDS) {
        kinds[kind] = {
          realms: 0,
          bigCount: 0,
          bigBytes: 0,
          bigMaxBytes: 0,
          memories: 0,
          liveReservedBytes: 0,
        };
      }
      const count = Math.min(Atomics.load(view, H_NEXT), MAX_REALMS);
      for (let i = 0; i < count; i++) {
        const base = SLOTS + i * STRIDE;
        const totals = kinds[KINDS[Atomics.load(view, base + S_KIND)]];
        totals.realms++;
        totals.bigCount += Atomics.load(view, base + S_BIG);
        totals.bigBytes += Atomics.load(view, base + S_BIG_KIB) * KIB;
        totals.bigMaxBytes = Math.max(
          totals.bigMaxBytes,
          Atomics.load(view, base + S_BIG_MAX_KIB) * KIB,
        );
        totals.memories += Atomics.load(view, base + S_MEMS);
        totals.liveReservedBytes += Atomics.load(view, base + S_LIVE) *
          PAGE_BYTES;
      }
      return {
        liveReservedBytes: Atomics.load(view, H_LIVE) * PAGE_BYTES,
        peakReservedBytes: Atomics.load(view, H_PEAK) * PAGE_BYTES,
        refused: Atomics.load(view, H_REFUSED),
        kinds,
      };
    },
  };
}

/** {@link allocationCensus} as a script to put before a Worker's own. */
export function censusSource(config: CensusConfig): string {
  return `(${allocationCensus.toString()})(${JSON.stringify(config)});\n`;
}
