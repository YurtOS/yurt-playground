/**
 * PREVIEW ONLY (iOS reservation diagnosis): counts the shared
 * `WebAssembly.Memory` reservations this realm constructs and how many its
 * heap still holds, and publishes them on a BroadcastChannel the page reads
 * (`globalThis.__memStats()`).
 */
export const MEM_CENSUS_CHANNEL = "yurt-mem-census";
const MIB = 1024 * 1024;

type Census = {
  realm: string;
  made: number;
  madeMiB: number;
  live: number;
  liveMiB: number;
  peakLiveMiB: number;
  failed: number;
  lastFailure: string;
  sizes: Record<string, number>;
  /** Large (>= 1 MiB) ArrayBuffer-backed allocations made explicitly. */
  bufMade: number;
  bufMadeMiB: number;
  bufLive: number;
  bufLiveMiB: number;
  bufPeakLiveMiB: number;
  bufFailed: number;
  failures: string[];
};

/** Which hooks to install: `?census=` on the page, `census=` in a Worker's
 *  name. Absent: all of them (`mem,ta,tabuf,ab,sab,slice`); `none`: none. */
export const CENSUS_ALL = "mem,ta,tabuf,ab,sab,slice";
export function censusFlags(spec: string | null | undefined): Set<string> {
  if (spec === null || spec === undefined || spec === "") {
    spec = CENSUS_ALL;
  }
  return new Set(spec.split(",").map((f) => f.trim()).filter(Boolean));
}
/** The `census=` part of a Worker name such as `kmem=512;census=mem`. */
export function censusOfName(name: string | undefined): string | undefined {
  return /(?:^|;)census=([^;]*)/.exec(name ?? "")?.[1];
}

export function installMemCensus(
  realm: string,
  flags: Set<string> = censusFlags(undefined),
): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (scope.__memCensus) return;
  (scope as Record<string, unknown>).__memCensusFlags = [...flags].join(",");
  const Original = WebAssembly.Memory;
  const census: Census = {
    realm,
    made: 0,
    madeMiB: 0,
    live: 0,
    liveMiB: 0,
    peakLiveMiB: 0,
    failed: 0,
    lastFailure: "",
    sizes: {},
    bufMade: 0,
    bufMadeMiB: 0,
    bufLive: 0,
    bufLiveMiB: 0,
    bufPeakLiveMiB: 0,
    bufFailed: 0,
    failures: [],
  };
  scope.__memCensus = census;
  const noteFailure = (what: string, error: unknown) => {
    const stack = (error instanceof Error && error.stack) ||
      new Error().stack || "";
    census.failures.push(
      `${new Date().toISOString().slice(11, 19)} ${what}: ${String(error)} ` +
        `[mem live ${census.live}/${census.liveMiB} MiB, buf live ` +
        `${census.bufLive}/${census.bufLiveMiB} MiB] ` +
        stack.split("\n").slice(0, 8).join(" | "),
    );
    if (census.failures.length > 12) census.failures.shift();
  };
  const bufRegistry = new FinalizationRegistry((mib: number) => {
    census.bufLive--;
    census.bufLiveMiB -= mib;
  });
  const BIG = 1024 * 1024;
  /** Count a typed array's bytes without touching `.buffer`. */
  const noteBytes = (bytes: number) => {
    if (bytes < BIG) return;
    const mib = Math.round(bytes / MIB);
    census.bufMade++;
    census.bufMadeMiB += mib;
  };
  const noteBuffer = (buffer: ArrayBufferLike, what: string) => {
    const bytes = buffer.byteLength;
    if (bytes < BIG) return;
    const mib = Math.round(bytes / MIB);
    census.bufMade++;
    census.bufMadeMiB += mib;
    census.bufLive++;
    census.bufLiveMiB += mib;
    census.bufPeakLiveMiB = Math.max(census.bufPeakLiveMiB, census.bufLiveMiB);
    try {
      bufRegistry.register(buffer, mib);
    } catch { /* not registrable */ }
    void what;
  };
  const wrapCtor = <T extends object>(
    name: string,
    Ctor: T,
    bufferOf: (value: unknown) => ArrayBufferLike | undefined,
  ): T =>
    new Proxy(Ctor as unknown as (new (...a: unknown[]) => object), {
      construct(target, args, newTarget) {
        let value: object;
        try {
          value = Reflect.construct(target, args, newTarget);
        } catch (error) {
          if (error instanceof RangeError) {
            census.bufFailed++;
            noteFailure(`new ${name}(${String(args[0]).slice(0, 20)})`, error);
            publish();
          }
          throw error;
        }
        // A view over an existing buffer allocates nothing.
        if (
          !(args[0] instanceof ArrayBuffer) &&
          !(typeof SharedArrayBuffer !== "undefined" &&
            args[0] instanceof SharedArrayBuffer)
        ) {
          if (flags.has("tabuf") || name.endsWith("ArrayBuffer")) {
            const buffer = bufferOf(value);
            if (buffer) noteBuffer(buffer, name);
          } else {
            noteBytes((value as Uint8Array).byteLength);
          }
        }
        return value;
      },
    }) as unknown as T;
  for (
    const name of flags.has("ta")
      ? ["Uint8Array", "Int32Array", "Uint32Array", "Float64Array"]
      : []
  ) {
    const Ctor = (globalThis as unknown as Record<string, object>)[name];
    (globalThis as unknown as Record<string, object>)[name] = wrapCtor(
      name,
      Ctor,
      (v) => (v as Uint8Array).buffer,
    );
  }
  if (flags.has("ab")) {
    globalThis.ArrayBuffer = wrapCtor(
      "ArrayBuffer",
      ArrayBuffer,
      (v) => v as ArrayBuffer,
    );
  }
  if (flags.has("sab") && typeof SharedArrayBuffer !== "undefined") {
    globalThis.SharedArrayBuffer = wrapCtor(
      "SharedArrayBuffer",
      SharedArrayBuffer,
      (v) => v as SharedArrayBuffer,
    );
  }
  const TypedArrayProto = Object.getPrototypeOf(Uint8Array.prototype) as {
    slice: (...a: unknown[]) => Uint8Array;
  };
  const originalSlice = TypedArrayProto.slice;
  if (flags.has("slice")) {
    TypedArrayProto.slice = function (this: Uint8Array, ...a: unknown[]) {
      try {
        const out = originalSlice.apply(this, a);
        noteBuffer(out.buffer, "slice");
        return out;
      } catch (error) {
        if (error instanceof RangeError) {
          census.bufFailed++;
          noteFailure(`TypedArray.slice(${this.byteLength} B)`, error);
          publish();
        }
        throw error;
      }
    };
  }
  const abSlice = ArrayBuffer.prototype.slice;
  if (flags.has("slice")) {
    ArrayBuffer.prototype.slice = function (this: ArrayBuffer, ...a) {
      try {
        const out = abSlice.apply(this, a as [number?, number?]);
        noteBuffer(out, "ab.slice");
        return out;
      } catch (error) {
        if (error instanceof RangeError) {
          census.bufFailed++;
          noteFailure(`ArrayBuffer.slice(${this.byteLength} B)`, error);
          publish();
        }
        throw error;
      }
    };
  }
  const registry = new FinalizationRegistry((key: string) => {
    const [kind, mib] = key.split(":");
    census.live--;
    census.liveMiB -= Number(mib);
    census.sizes[`${kind}:${mib}`]--;
  });
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(MEM_CENSUS_CHANNEL);
  } catch { /* no channel: census stays local */ }
  const id = `${realm}-${Math.random().toString(36).slice(2, 8)}`;
  let pending = false;
  const publish = () => {
    if (pending || channel === undefined) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      try {
        channel!.postMessage({
          id,
          ...census,
          sizes: { ...census.sizes },
          failures: [...census.failures],
        });
      } catch { /* closed */ }
    }, 200);
  };
  if (flags.has("mem")) {
    WebAssembly.Memory = new Proxy(Original, {
      construct(target, args, newTarget) {
        const d = (args[0] ?? {}) as WebAssembly.MemoryDescriptor;
        const pages = d.shared ? (d.maximum ?? d.initial) : d.initial;
        const mib = Math.round((pages * 65536) / MIB);
        let memory: WebAssembly.Memory;
        try {
          memory = Reflect.construct(target, args, newTarget);
        } catch (error) {
          census.failed++;
          census.lastFailure = `${d.shared ? "shared" : "plain"} ` +
            `${d.initial}/${d.maximum} pages: ${String(error)} ` +
            `(live ${census.live}, ${census.liveMiB} MiB)`;
          noteFailure(
            `new WebAssembly.Memory(${d.initial}/${d.maximum}${
              d.shared ? " shared" : ""
            })`,
            error,
          );
          publish();
          throw error;
        }
        const key = `${d.shared ? "s" : "p"}:${mib}`;
        census.made++;
        census.madeMiB += mib;
        census.live++;
        census.liveMiB += mib;
        census.peakLiveMiB = Math.max(census.peakLiveMiB, census.liveMiB);
        census.sizes[key] = (census.sizes[key] ?? 0) + 1;
        registry.register(memory, key);
        publish();
        return memory;
      },
    });
  }
  // Report the collections the registry sees too.
  setInterval(publish, 2000);
}

/** The page's view: the latest census per realm, plus its guest Workers. */
export function listenMemCensus(): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  const latest = new Map<string, unknown>();
  const channel = new BroadcastChannel(MEM_CENSUS_CHANNEL);
  channel.onmessage = (event) => {
    const data = event.data as { id: string };
    latest.set(data.id, { ...data, at: Date.now() });
  };
  scope.__memStats = () => ({
    guestWorkers: scope.__yurtGuestWorkers ?? null,
    ports: scope.__yurtGuestPorts ?? null,
    realms: [...latest.values()].filter((r) => {
      const c = r as { realm: string; failed: number; at: number };
      return c.realm === "coordinator" || c.failed > 0 ||
        Date.now() - c.at < 5000;
    }),
  });
}
