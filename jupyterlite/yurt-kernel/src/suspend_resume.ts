/**
 * Whether the site offers the notebook kernel's Suspend/Resume: the
 * `yurt-snapshot` kernelspec (one sealable CPython, sealed mid-cell into
 * IndexedDB), its Suspend/Resume panel, and the suspend-resume.ipynb
 * notebook.
 *
 * OFF since train 2026.10.20: that kernel's checkpoint admission refuses
 * the train's python3-seal.wasm ("its module lacks validated checkpoint
 * support"), yurtos-kernel#3924. The terminal snapshot demo
 * (snapshot.html, primes.wasm) does not depend on this.
 *
 * To turn it back on, set this to true. tests/layout_test.ts then names the
 * page and site-config lines that go with it, and the skipped seal tests
 * (tests/notebook_kernel_test.ts, tests/notebook_snapshot_e2e.ts) run again.
 *
 * Dependency-free: the Deno tests import it as well as the labextension.
 */
export const NOTEBOOK_SUSPEND_RESUME = false;
