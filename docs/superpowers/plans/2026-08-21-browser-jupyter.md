# Browser Jupyter Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start the unchanged guest ipykernel in the existing sandbox and
execute `1+1` from a browser notebook pane over `dialSandboxPort`.

**Architecture:** The existing ash PTY remains the sole shell/session owner.
The page starts ipykernel through that PTY with fixed loopback ports, then
dials the guest's five ZMQ endpoints through the kernel host interface. A
small Jupyter wire-protocol client handles the ZMTP handshake, HMAC-framed
messages, shell replies, and IOPub status/output messages; no host TCP,
websocket proxy, fake notebook, or JupyterLite is introduced.

**Tech Stack:** Deno TypeScript, browser Web APIs, Yurt
`KernelHostInterface.dialSandboxPort`, Jupyter wire protocol, Playwright.

**Spec:**
`docs/superpowers/specs/2026-08-19-browser-playground-compute-snapshots-design.md`

## Global Constraints

- Keep `yurt-jupyter` unchanged at revision
  `c30f1073c244aab166c67dc3b9b1ff1048def0d4`.
- Use Python 3 via `python3`; retain `PYTHONHOME=/usr/local`.
- Use only `dialSandboxPort` for guest connections; no `Deno.connect`, host
  TCP, guest egress, or websocket proxy.
- Keep ash alive in the same sandbox and VFS.
- Configured artifact failures are test failures, never successful skips.
- Do not expose snapshot controls in this slice; snapshot work follows the
  completed kernel resource contract.

---

### Task 1: Define the Jupyter wire protocol and transport adapter

**Files:**
- Create: `src/jupyter_protocol.ts`
- Create: `src/jupyter_transport.ts`
- Test: `tests/jupyter_protocol_test.ts`
- Test: `tests/jupyter_transport_test.ts`

**Interfaces:**
- `encodeJupyterMessage(message: JupyterMessage, key: string): Uint8Array`
- `decodeJupyterMessage(bytes: Uint8Array, key: string): JupyterMessage`
- `createJupyterTransport(dial: (port: number) => SandboxPortConn, config: JupyterConfig): Promise<JupyterTransport>`
- `JupyterTransport.send(message: JupyterMessage): Promise<void>`
- `JupyterTransport.subscribe(listener: (message: JupyterMessage) => void): () => void`
- `JupyterTransport.close(): Promise<void>`

- [ ] **Step 1: Write the red protocol tests.** Cover the exact multipart
  delimiter, HMAC-SHA256 signature, header/content JSON encoding, binary
  buffers, malformed signatures, and truncated frames.
- [ ] **Step 2: Run the protocol tests and confirm they fail because the
  encoder/decoder does not exist.**
- [ ] **Step 3: Implement the canonical Jupyter message codec.** Preserve
  frame order and reject invalid signatures before exposing a message.
- [ ] **Step 4: Write the red transport test.** Use a deterministic in-memory
  `SandboxPortConn` that exercises the ZMTP greeting, command exchange, short
  reads, and inbound message subscription.
- [ ] **Step 5: Implement the five-port transport adapter.** Dial shell,
  IOPub, stdin, control, and heartbeat ports only through the supplied dialer;
  keep the reader pumps asynchronous and close every connection on failure.
- [ ] **Step 6: Run focused protocol/transport tests and commit.**

### Task 2: Launch the guest kernel without creating a second sandbox

**Files:**
- Modify: `src/boot.ts`
- Modify: `src/session_controller.ts`
- Create: `src/jupyter.ts`
- Test: `tests/jupyter_launch_test.ts`

**Interfaces:**
- `startGuestKernel(session: PlaygroundSession): Promise<JupyterTransport>`
- `executeCell(transport: JupyterTransport, code: string): Promise<JupyterReply>`
- `JupyterReply = { status: "ok" | "error"; stdout: string; display: string; traceback: string[] }`

- [ ] **Step 1: Write the red launch test.** Assert that the existing session
  writes one Python 3 launcher command with fixed ports and connection-file
  path, then returns a transport using the same kernel host instance.
- [ ] **Step 2: Run the launch test and confirm it fails because boot does not
  expose the host/dialer and no Jupyter launcher exists.**
- [ ] **Step 3: Extend the session's internal boot result with the host-bound
  sandbox-port dialer and PTY command runner without changing ash startup.**
- [ ] **Step 4: Launch `python3 -m ipykernel_launcher` in the existing guest
  using `/tmp/yurt-kernel.json`, fixed loopback ports, and the existing
  environment. Wait for the kernel's `kernel_info_reply` instead of treating
  the shell command echo as readiness.
- [ ] **Step 5: Implement `executeCell` using the shell channel and IOPub
  `status`, `execute_input`, `stream`, `execute_reply`, and `error` messages.
  Resolve only after the matching execution reply and drain all output for
  that message id.
- [ ] **Step 6: Run focused launch tests and existing ash/Python tests.**

### Task 3: Add the minimal notebook pane

**Files:**
- Modify: `public/index.html`
- Modify: `src/page.ts`
- Create: `src/notebook.ts`
- Test: `tests/notebook_test.ts`

**Interfaces:**
- `mountNotebook(root: HTMLElement, kernel: JupyterKernelClient): NotebookView`
- `NotebookView.execute(code: string): Promise<JupyterReply>`
- `NotebookView.dispose(): void`

- [ ] **Step 1: Write the red DOM test.** Assert a cell editor, Execute button,
  output region, and visible error/status region exist and that execute renders
  `2` for `1+1`.
- [ ] **Step 2: Run the DOM test and confirm it fails because the notebook
  pane is absent.
- [ ] **Step 3: Add the minimal notebook markup and controller.** Keep all
  behavior in TypeScript, disable Execute while a request is pending, and
  render stdout/display/error output without evaluating code in the browser.
- [ ] **Step 4: Wire page boot to start the notebook after ash reaches ready;
  preserve terminal input and report Jupyter startup failures in the status
  area.
- [ ] **Step 5: Run notebook unit tests and the existing page/layout tests.**

### Task 4: Add the real browser acceptance test

**Files:**
- Create: `tests/playground_e2e.ts`
- Modify: `tests/layout_test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `deno.json`

**Interfaces:**
- Browser test starts `deno task serve`, waits for COOP/COEP isolation and
  pinned artifact readiness, then drives the actual page.

- [ ] **Step 1: Write the red Playwright test.** Boot the page, wait for the
  notebook ready state, enter `1+1`, click Execute, and assert output `2`.
  Also assert ash remains visible and usable after notebook execution.
- [ ] **Step 2: Run it against a clean artifact configuration and confirm it
  fails at the real missing launch/protocol boundary, not by skipping.
- [ ] **Step 3: Add the pinned Playwright dependency and browser provisioning
  to CI, preserving the existing Deno gates and flat artifact download path.
- [ ] **Step 4: Add the browser job after runtime materialization; start the
  COOP/COEP server and run only the configured browser test with
  `PLAYGROUND_REQUIRE_ARTIFACTS=1`.
- [ ] **Step 5: Run the full local Deno gates plus the browser test with the
  pinned image, then commit the acceptance slice.**

### Task 5: Review and handoff

- [ ] Verify the unchanged yurt-jupyter revision and no host-socket imports.
- [ ] Verify the browser test exercises a real guest kernel and standard
  Jupyter reply, not a mock or page-local evaluator.
- [ ] Request review, address findings, and publish the branch as a PR.
- [ ] Do not close yurtos-kernel#2304 until the hosted/browser Worker proof is
  green; record any kernel transport capability gap as a kernel issue/PR.
