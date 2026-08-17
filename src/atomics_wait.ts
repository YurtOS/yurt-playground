/**
 * WorkerHost's spawn handshake calls Atomics.wait on the coordinator.
 * That is legal in Deno and inside a Worker, and throws on the browser
 * window thread. Guest Workers created from the page do evaluate; nested
 * module Workers created from another Worker do not. So the playground
 * keeps the kernel on the page and spins for the ready signal instead.
 */
export function installMainThreadAtomicsWait(): void {
  const orig = Atomics.wait.bind(Atomics) as (
    typedArray: Int32Array,
    index: number,
    value: number,
    timeout?: number,
  ) => "ok" | "not-equal" | "timed-out";
  Atomics.wait = ((
    typedArray: Int32Array,
    index: number,
    value: number,
    timeout?: number,
  ) => {
    try {
      return orig(typedArray, index, value, timeout);
    } catch {
      return spinWait(typedArray, index, value, timeout);
    }
  }) as typeof Atomics.wait;
}

export function spinWait(
  typedArray: Int32Array,
  index: number,
  value: number,
  timeout?: number,
): "ok" | "not-equal" | "timed-out" {
  if (Atomics.load(typedArray, index) !== value) return "not-equal";
  const deadline = performance.now() + (timeout ?? Number.POSITIVE_INFINITY);
  while (Atomics.load(typedArray, index) === value) {
    if (performance.now() >= deadline) return "timed-out";
  }
  return "ok";
}
