# Local Agent Feasibility (#140, phase 0)

## Question

Can a small instruction model run in the playground tab through WebGPU, beside a
running sandbox and Jupyter, and emit a closed action schema reliably enough to
drive `window.yurt`? This records the measurements behind the agent pane's model
and runtime choices. The measurement page and its Chrome and Safari drivers
lived in commits `85697ec` and `c9a0b4f` of PR #143; they were removed from the
change once these results were written down.

## Setup

- Apple M4, 32 GB; Chrome 153 (headless, Metal WebGPU) and Safari 26.6.2 (driven
  through `safaridriver`).
- `@litert-lm/core@0.17.1`, default `GPU_ARTISAN` backend, `maxNumTokens` 4096,
  default sampler.
- Gemma 4 E2B and E4B `-it-web.litertlm`, pinned by Hugging Face commit and
  sha256, served from the page's own origin on localhost: download times measure
  the cache write, not a network.
- The model ran in a classic worker of the page (LiteRT-LM loads its glue with
  `importScripts`); weights streamed into Cache Storage and were handed to the
  engine as a disk-backed `Blob`.

## Results

|                                                   | Chrome · E2B        | Chrome · E4B        | Safari · E2B              |
| ------------------------------------------------- | ------------------- | ------------------- | ------------------------- |
| Wasm build the loader picked                      | relaxed-SIMD + JSPI | relaxed-SIMD + JSPI | compat asyncify (no JSPI) |
| Download                                          | 2.01 GB             | 2.97 GB             | 2.01 GB                   |
| Cold load (fetch → Cache Storage → engine)        | 7.2 s               | 9.5 s               | 19.7 s                    |
| Load from cached weights                          | 1.6 s               | 2.0 s               | 6.7 s                     |
| Engine create (weights + compile)                 | 1.1 s               | 1.5–1.7 s           | 11.3 s cold / 2.5 s       |
| Prefill                                           | ~1,400 tok/s        | ~390 tok/s          | ~1,550 tok/s              |
| Decode                                            | ~55 tok/s           | ~28 tok/s           | ~51 tok/s                 |
| Time to first token, 3.4k-token prompt            | 2.4 s               | 8.6 s               | 2.1 s                     |
| Peak footprint, page renderer (incl. sandbox)     | 4.05 GB             | 4.61 GB             | not measured              |
| Peak footprint, GPU process                       | 1.87 GB             | 3.38 GB             | not measured              |
| Action schema, JSON prompt: strict / sensible (8) | 7/8 / 7/8           | 8/8 / 8/8           | 6/8 / 8/8                 |
| Action schema, native tool calls: valid (8)       | 7/8                 | 7/8                 | 7/8                       |
| Map step, 120-line log: precision / recall        | malformed JSON      | 1.0 / 1.0           | 1.0 / 1.0                 |
| Map step, 300-line log (3.4k tokens)              | 1.0 / 0.53          | 1.0 / 1.0           | 1.0 / 1.0                 |
| Two-step tool loop through `window.yurt`          | correct             | correct             | correct                   |
| Sandbox shell / Jupyter ready, beside the model   | 4 s / 36 s          | 4 s / 36 s          | 3 s / 27 s                |

Limits of these numbers:

- Speed and quality rows ran before the sandbox booted; only the tool loop ran
  beside it, with the guest mostly idle.
- Each quality figure is one generation with the default sampler over one
  synthetic log (the 120-line log is a prefix of the 300-line one: 5 and 17
  errors).
- Footprints are macOS `phys_footprint_peak` per process.
  `performance.measureUserAgentSpecificMemory` does not see GPU buffers (it put
  E4B below E2B).
- "Cached" covers the weights only; the wasm and the worker bundle are fetched
  again on each load (the dev server sends no cache headers).

## Findings

1. **E4B is the default; E2B is not ruled out.** Chrome's E2B lost half the
   facts in the map step, identically in three runs; Safari's E2B was exact. The
   difference follows the browser and wasm build, not only the model. Settling
   it needs a greedy sampler, several seeds, and the compat build forced in
   Chrome.
2. **Hosting the weights is blocked only by our CSP** (`connect-src 'self'`). A
   CORS-mode `fetch` answered with `Access-Control-Allow-Origin: *` passes COEP
   `require-corp`, so no CORP header is needed. Options: same-origin parts
   (Cloudflare Pages caps a file at 25 MiB: ~120 parts), or our own R2 origin
   added to `connect-src`. Open decision.
3. **Only `GPU_ARTISAN` is usable.** It streams the weights; every other backend
   first copies the whole model into wasm memory. Passing `Backend.GPU` failed
   with `Unsupported backend: 2`.
4. **Native tool calls** need the wrapped `{type: "function", function}` form:
   bare declarations made Gemma 4's chat template throw
   (`Failed to apply template: undefined value (in template:80)`), although the
   library's types accept both. They were no more reliable than the JSON prompt,
   so the agent uses JSON.
5. **Offline, the model works and the sandbox does not.** With the model loaded,
   generation continues without a network, but every new guest process fails
   (`kernel_spawn_process failed: rc=-5`): each one fetches
   `/worker_bootstrap.js`. A reload offline would fail earlier still (wasm and
   worker bundle uncached). This is a playground-wide gap: #140 phase 3.
6. **Safari could not store E4B** in the automated session ("Failed writing data
   to the file system"); not yet tried in an ordinary window.
7. LiteRT-LM is single-threaded (no pthreads build) and needs no CSP beyond the
   existing `'wasm-unsafe-eval'`.

## Not measured

Firefox; a real network download; in-browser sha256 of the weights
(`crypto.subtle.digest` cannot stream 3 GB); GPU device loss; generation while
the guest is busy.
