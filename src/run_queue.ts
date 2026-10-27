/** Calls of `run` one at a time, in the order they were made: each starts
 * once the one before it has settled, whether it resolved or threw. The
 * coordinator's `pkg` runs go through one (src/coordinator_worker.ts):
 * every run stages at the same directory and pkg takes one lock. */
export function runQueue(): <T>(run: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(run: () => Promise<T>) => {
    const next = last.catch(() => {}).then(run);
    last = next;
    return next;
  };
}
