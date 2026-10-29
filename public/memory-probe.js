// Measures how much shared WebAssembly memory one tab may reserve (#270).
// The same file runs as the page and as each probe's Worker: a Worker
// holds what it reserved until it is terminated, so each measurement gets
// a fresh one.
const MIB = 1024 * 1024;
const PAGE = 65536;

/** Reserve shared memories of `sizes` MiB (largest first, each until the
 *  engine refuses), keeping them all alive; return what was reserved. */
function reserve(sizes, limit) {
  const held = [];
  const counts = {};
  let total = 0;
  let firstError = "";
  for (const mib of sizes) {
    counts[mib] = 0;
    while (held.length < limit) {
      try {
        held.push(
          new WebAssembly.Memory({
            initial: 1,
            maximum: (mib * MIB) / PAGE,
            shared: true,
          }),
        );
        counts[mib]++;
        total += mib;
      } catch (error) {
        if (!firstError) firstError = String(error);
        break;
      }
    }
  }
  return { totalMiB: total, counts, firstError, held: held.length };
}

if (typeof document === "undefined") {
  self.onmessage = (event) => {
    const { sizes, limit } = event.data;
    self.postMessage(reserve(sizes, limit));
  };
} else {
  const out = document.getElementById("out");
  const lines = [];
  const show = (line) => {
    lines.push(line);
    out.textContent = lines.join("\n");
  };
  const probe = (sizes, limit = 20000) =>
    new Promise((resolve) => {
      const worker = new Worker(new URL(import.meta.url), { type: "module" });
      const timer = setTimeout(() => {
        worker.terminate();
        resolve({ error: "timeout" });
      }, 60000);
      worker.onmessage = (event) => {
        clearTimeout(timer);
        worker.terminate();
        resolve(event.data);
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        worker.terminate();
        resolve({ error: String(event.message) });
      };
      worker.postMessage({ sizes, limit });
    });
  const pause = () => new Promise((r) => setTimeout(r, 1500));
  (async () => {
    show(`userAgent: ${navigator.userAgent}`);
    show(
      `maxTouchPoints: ${navigator.maxTouchPoints} ` +
        `hardwareConcurrency: ${navigator.hardwareConcurrency} ` +
        `crossOriginIsolated: ${self.crossOriginIsolated}`,
    );
    const params = new URLSearchParams(location.search);
    const only = params.get("max");
    const plans = only ? [[Number(only)]] : [
      [4096, 1024, 256, 64, 16, 4, 1],
      [4096],
      [1024],
      [256],
      [128],
      [64],
      [16],
      [4096, 1024, 256, 64, 16, 4, 1],
    ];
    for (const sizes of plans) {
      const r = await probe(sizes);
      show(
        r.error
          ? `[${sizes}] MiB: ${r.error}`
          : `[${sizes}] MiB: ${r.totalMiB} MiB total, counts ` +
            `${JSON.stringify(r.counts)}; refused with: ${r.firstError}`,
      );
      await pause();
    }
    show("done");
    document.title = "Memory probe: done";
  })();
}
