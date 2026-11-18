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
};

export function installMemCensus(realm: string): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (scope.__memCensus) return;
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
  };
  scope.__memCensus = census;
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
        channel!.postMessage({ id, ...census, sizes: { ...census.sizes } });
      } catch { /* closed */ }
    }, 200);
  };
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
