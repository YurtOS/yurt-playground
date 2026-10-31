# Terminal `pkg` in the browser: a page-run package relay

## Goal

`sudo pkg update` and `sudo pkg install NAME`, typed into the browser
playground's terminal, work as they do on the desktop app. Installs from the
terminal and from the Packages panel are visible to each other.

## Today

- The guest's `pkg` fetches with ureq + rustls over real sockets (yurt-pkg
  `crates/yurt-pkg-repo/src/fetch.rs`, `HttpFetcher`). The image's
  `/etc/yurt-pkg/trusted-repos.toml` names one repository, id `official`, at
  `https://raw.githubusercontent.com/YurtOS/yurt-packages/main/`. The guest in a
  tab has no DNS and no network, so `pkg update` fails with
  `HTTP request failed for …/index.json`.
- Every in-tab install goes through `installPackage` (`src/packages.ts`):
  - the Packages panel (`servePackages`, a package name);
  - the Python sets, from pinned releases and the Cache API archive cache;
  - `?snapshot=capture`;
  - the Suspend/Resume kernel (`notebook_kernel_worker.ts`).

  `installPackage` works like this. The page `fetch()`es the index, the metadata
  and the archives. It stages them as a `file://` copy of the repository under
  `STAGING_DIR`, with a `trusted-repos.toml` that it derives from the guest's
  own (`browserTrustedRepos`). Then it runs
  `sudo pkg --etc-root <staging>/etc --cache-root /var/cache/yurt-pkg/browser-repos …`
  (`installScript`). The installed state (`/var/lib/yurt-pkg`) is the default
  one, so it is already shared with the terminal. The repository cache is not.
- In the terminal, `pkg install NAME` for a package the panel installed fails
  with `no repository cache available; run pkg update`. The cause is in yurt-pkg
  `crates/pkg/src/main.rs`: `install` loads the repository universe before it
  reads the installed state. `pkg search` and `pkg info` say the same, and
  rightly: they query the index.
- One of AGENTS.md's locked decisions is "no guest egress".

## Decision being relaxed

The user approved one narrow exception to "no guest egress". The page fetches on
the guest's behalf, but only under these conditions:

- `GET` requests only.
- Only files under `PACKAGE_REPO_URL`
  (`https://raw.githubusercontent.com/YurtOS/yurt-packages/main/`). That is a
  subset of the `PACKAGE_SOURCES` that the CSP `connect-src` already allows.
- Bounded sizes, connection counts and timeouts.
- Through the browser's `fetch`, under the page's CSP.

Guests still get no socket to anywhere else, no DNS and no host TCP. PR 2
rewrites the AGENTS.md bullet to say exactly this.

## Design

### Mechanism: a loopback HTTP relay in the coordinator worker

The coordinator worker owns the terminal sandbox's `KernelHostInterface` (`mk`),
and it already makes raw kernel calls as the host (`boot.ts`). The relay is a
small HTTP/1.1 server that the host runs on the sandbox's own loopback
interface. It uses the socket calls that `dialSandboxPort` uses (kernel
`sandbox_port.ts`), on the listening side, as the kernel's `port_pingpong` test
does as `KERNEL_PID`.

1. **Start** (`src/pkg_relay.ts`, `startPkgRelay(mk, { tablet, onFetch })`).
   This runs in `startPlayground`, for an image boot and for a restored snapshot
   alike, before the login shell starts.
   - It opens a `SOCK_STREAM | SOCK_NONBLOCK` socket as `KERNEL_PID`, binds it
     to `127.0.0.1:7417` (`PKG_RELAY_PORT`) and listens with a backlog of 16. A
     failure throws, so the boot fails loudly. No guest process exists yet, and
     `seal()` closes the listener (see Stop), so the port is free on a restored
     snapshot too.
   - It makes sure that `/etc/yurt-pkg/trusted-repos.toml` points the
     YurtOS/yurt-packages entry at `http://127.0.0.1:7417/`. Only that entry's
     `url` changes, along with a comment line that says why. Every other table,
     and the entry's id, priority, signing subject and issuer, stays verbatim.
     The step is idempotent: a file that already names the relay is left alone,
     which covers a restored snapshot that was sealed after the rewrite. The
     file stays root's, mode 0644.
   - `browserTrustedRepos` (the staged installs' lookup) learns to recognize an
     entry whose `url` is the relay's, as well as one with the
     `YurtOS/yurt-packages` path segments. The staged copy still gets its own
     `file://` URL, so staged installs are otherwise unchanged. PR 2 includes a
     test that runs the staged path against a rewritten system file.
2. **Accept loop.** It polls `SYS_SOCKET_ACCEPT` on the nonblocking listener
   every 100 ms, which adds at most 100 ms to each connection (about 0.5-1 s
   over a `pkg update`). At most 16 connections are open at once (pkg opens up
   to 8, `MAX_CONCURRENT_FETCHES`), and one more is closed at once. An accepted
   socket does not inherit `O_NONBLOCK` (`inherit_listener_options`), so every
   `SYS_SOCKET_RECV` passes `MSG_DONTWAIT` and every `SYS_SOCKET_SEND`
   `MSG_DONTWAIT | MSG_NOSIGNAL` in the request's flags word (recv refuses
   `MSG_NOSIGNAL` with `EOPNOTSUPP`). Without them, a call as `KERNEL_PID` would
   park, which a synchronous host call cannot wait on, or would queue `SIGPIPE`
   on the kernel's own thread. When I/O would block, the relay retries with a
   backoff that doubles from 1 ms to 50 ms and goes back to 1 ms after any
   progress. (A 4 ms start held a 10 MiB archive to about 6 MB/s, because the
   loopback buffer is 64 KiB.) It never spins on a bare `setTimeout(0)`.
3. **One request per connection**, answered with `Connection: close` and a
   `Content-Length`, never chunked:
   - It reads the head: at most 8 KiB, within 10 s. Otherwise it closes without
     answering.
   - It answers 405 to any method other than `GET`. It answers 400 to a request
     with a body (`Content-Length` other than 0, or `Transfer-Encoding`).
   - The target must be an origin-form path with no query and no fragment.
     Without its leading `/`, the path must pass `checkRelative` (no `..`, `%`,
     `?`, `#`, `:`, space or control character) and be at most 512 bytes.
     Otherwise the answer is 403.
   - The upstream URL is `new URL(path, PACKAGE_REPO_URL)`. The relay asserts
     that it starts with `PACKAGE_REPO_URL` (403 otherwise), as a guard in the
     code on top of the CSP.
   - The fetch is
     `fetch(upstream, { cache: "no-cache", redirect: "error",
     credentials: "omit", signal })`,
     with none of the guest's headers, so it stays a CORS simple request.
     (`raw.githubusercontent.com` answers a preflight with 403 and exposes no
     `ETag`.) `signal` aborts after 30 s without a byte.
   - Upstream 404 passes through as 404. Any other non-OK status, a redirect, a
     network or CSP error, a stall or an oversized body becomes 502, with a
     one-line `text/plain` reason when no header has been sent yet. Only a
     streamed archive can fail after its header has been sent, and then the
     relay closes the connection early instead, and pkg reports a short body.
   - **The index and its signature** (`index.json`, `index.json.bundle`, at most
     4 MiB each) are the only files pkg asks for conditionally (`update.rs`;
     metadata and archives go with `etag: None`). The relay buffers these two
     and answers with `ETag: "sha256-<hex of the body>"`. When the request's
     `If-None-Match` equals that value, it answers 304 with no body instead. See
     "Rollback protection" below.
   - **Package metadata and signature bundles** (every path that does not end in
     `.yurtpkg`) are buffered too, under a 4 MiB cap, and sent with the length
     of the bytes the relay holds. GitHub serves these gzip-compressed.
     `fetch()` hands over the decoded body, but the `Content-Length` it exposes
     is the compressed size, so the upstream header is never forwarded for them.
   - **Archives** (`*.yurtpkg`, which GitHub serves uncompressed) are streamed
     as they arrive, under the upstream `Content-Length`, a CORS-safelisted
     response header. The relay counts what it forwards. If the body runs past
     that length, or ends short of it, the relay closes the connection without
     finishing the body, and pkg reports a short or failed body. An archive with
     no `Content-Length` gets a 502 rather than being held whole. Streaming
     keeps pkg's 60 s ureq budget close to the desktop's, and keeps only one
     chunk in the page's memory.
   - **Size caps.** Each response is capped at `INSTALL_MAX_BYTES`, and at
     `TABLET_MAX_BYTES` on a tablet; a 502 says which limit it hit. On a tablet,
     the total across one terminal install is not capped. The panel keeps its
     own per-install estimate (`sizeRefusal`), and a terminal user who passes it
     meets the same out-of-memory risk as #200. This is documented, not
     enforced.
4. **Progress.** `onFetch(path, received, total)` posts to the page. PR 3's
   panel uses it.
5. **Stop.** The relay lives exactly as long as the session's `mk`. `stop()`
   closes every connection and the listener, clears the relay's timers, and
   aborts every fetch in flight. A kernel call that throws in the accept loop
   stops the relay. It is called:
   - in `seal()`, after `prepareSeal` has ended the guest processes and just
     before `sealSandbox`, so a `prepareSeal` that throws leaves the relay up (a
     `sealSandbox` that throws leaves it stopped, which is harmless, because a
     capture ends there);
   - wherever the session's kernel is disposed: `session.dispose()` (which
     `startFresh` calls after a stalled install) stops the relay, then disposes
     `mk` even if that throws;
   - in `startPlayground`'s failure path, once the relay has started.

   A test checks that no relay timer fires after dispose. A sealed snapshot
   therefore holds no host-owned socket, and its restore starts a fresh relay
   (step 1). The rewritten `trusted-repos.toml` stays in the snapshot. That is
   harmless, because a restore runs the relay again, and a relay-less sandbox
   never restores this snapshot (the Suspend/Resume kernel uses its own).

The guest side is unchanged. The image's own `pkg` binary runs with no new flag,
file or variable. It sees an HTTP repository at `http://127.0.0.1:7417/` and
verifies everything as today, against the same signing identity: the index
bundle, every metadata file's sha256 and size, and every archive's Sigstore
bundle. pkg accepts `http://` (`fetch.rs`). It sends `YURT_PKG_GITHUB_TOKEN`
only to `https://` GitHub hosts, so the relay never sees a token. Package and
archive URLs are relative to the repository URL, so they also go through the
relay. The relay is only a transport. A relay that lies can withhold files or
serve stale ones, which is what a network attacker can do on the desktop. It
cannot make pkg accept a file the repository did not sign.

The relay runs only for the coordinator's terminal sandbox, so these are
untouched:

- the desktop app (`bootNativePlayground`, whose guest has the real network);
- the Suspend/Resume kernel's short-lived install sandbox;
- the snapshot demo worker.

### Shared state, and rollback protection

- **Installed state** (`/var/lib/yurt-pkg`) is the default one on every path, so
  `pkg list`, and the resolver's reuse of installed packages, are shared
  already.
- **The terminal** uses the default repository cache,
  `/var/cache/yurt-pkg/repos`. Its one URL is the relay's.
- **The panel's install by name** (PR 3) moves onto the relay. The panel then
  runs the user's own `sudo pkg update && sudo pkg install NAME` with the
  default `--etc-root` and `--cache-root`. It keeps its install queue, its
  heartbeat and stall watch, its run ceiling, and its `sizeRefusal` estimate
  from the catalog. So the panel and the terminal share one cache, and
  `pkg search` works in the terminal after a panel install.
- **The Python sets, `?snapshot=capture` and the Suspend/Resume kernel** keep
  the staged `file://` copy and its own cache root. They install pinned
  releases, partly from the archive cache that lasts between visits, and gain
  nothing from the network. Each of the two caches therefore keeps a single
  repository URL, so neither flips between URLs (the `UrlOnly` trust change,
  which disables pkg's conditional fetch).

pkg refuses an index whose `index_version` is not newer than its cache's
(`metadata.rs` `validate_against`). On the desktop, a repeated `pkg update`
sends the stored ETag, gets a 304, and reports `official already current`. The
relay cannot forward conditional requests, so it serves as the origin for
validators of the two conditional files. Its strong ETag is the sha256 of the
bytes it serves, and it answers 304 when they match. A repeated update then
behaves as on the desktop. A newer index goes through. An older one, from a CDN
serving a previous commit, is refused, as on the desktop. The protection itself
is untouched: it is pkg's own check, on one cache with one URL. A cache carried
in a Python layer or a snapshot holds the relay's content-hash ETags, which stay
valid across tabs.

### `pkg install` of an installed package with no cache (yurt-pkg)

The fix changes yurt-pkg `install` in `crates/pkg/src/main.rs`:

- `load_install_universe` returns a typed result that tells "no trusted
  repository has a snapshot" apart from its other failures. The other failures
  are a changed signing identity, a stale cache and I/O, and they keep their
  errors.
- When **no** trusted repository has a cache, `install` runs the existing
  resolver against an empty universe. Its reuse rule already accepts an
  installed package that satisfies the spec, along with its installed
  dependencies. If the plan installs nothing, it prints `nothing to install` and
  succeeds. Any resolver error, and any plan that would install something, fails
  with today's `no repository cache available; run pkg update`, not with the
  resolver's own message.
- This path takes the same locks as today, in the same order. The shared
  repository locks are taken and dropped while the universe loads (they are
  taken even when no cache exists). Then the installed-state lock is taken. The
  resolver call runs after the installed-state lock and its transaction
  recovery, as today.
- When a cache exists, behaviour is unchanged, including the errors for a stale
  cache and for an untrusted one.

`pkg search` and `pkg info` keep their error, because they have nothing to
answer from without an index. The fix ships in the next image train's `pkg` pin.
The relay does not depend on it.

## Alternatives considered

- **A kernel "host fetch" service and a wasm32 `RepoFetcher` in pkg.** This
  needs a new kernel ABI, a pkg change and a train. Kernel PRs need Sunny's
  merge. It offers nothing over loopback HTTP.
- **A relay setting in pkg** (keep the `https://` URL and send the transport
  through the relay). The URLs pkg prints would stay the same as on the desktop.
  The cost is a new pkg configuration surface and an image release before
  anything works. It could later replace the `trusted-repos.toml` rewrite
  without changing the relay.
- **`HTTPS_PROXY` / CONNECT, or `/etc/hosts` pointing GitHub at loopback.**
  pkg's TLS would end at the page, which has no certificate for GitHub.
- **A guest daemon reached through `dialSandboxPort`.** This needs a new image
  binary, and the host can listen by itself.
- **Moving every install onto the relay** (the sets would be served from
  `ArchiveCache`). That is a larger refactor of working code for no user gain.
  It is left out.

## Tests

- **Fast tests** (`tests/pkg_relay_test.ts`, with an injected fetcher and a fake
  kernel) cover:
  - the request rules (method, body, path and length refusals) and the
    `PACKAGE_REPO_URL` guard;
  - the error mapping; ETag/304 only for the two index files;
  - buffering of every non-archive file when the fetcher's `Content-Length`
    differs from its body (the gzip case);
  - the archive length check, for a body both short and long; an archive with no
    length; the per-response caps;
  - `stop()` on an idle relay and in the middle of a connection (its fetch is
    aborted, and no kernel call follows); a kernel that throws;
  - the idempotent `trusted-repos.toml` rewrite, a file it cannot read, and
    `browserTrustedRepos` on a rewritten file.
- **Kernel-backed tests** (`tests/pkg_relay_boot_test.ts`, CI's guest shard)
  boot the pinned kernel and image with the relay and a fake upstream:
  - the guest's `wget` reaches the page's listener, eight at a time; a path
    outside the repository is refused without a fetch; the index gets the
    relay's ETag, and a conditional GET with it a 304; the rewritten
    configuration is root's, 0644;
  - a 10 MiB archive passes at no less than half the rate of the same bytes
    through a guest pipe on the same machine (an absolute rate is only asserted
    with `PLAYGROUND_PKG_PERF=1`: CI runners measured 2 MB/s where a developer
    machine does 10);
  - the guest's own `sudo pkg update` gets the repository fixture through the
    relay and refuses its placeholder signature (without the relay it fails with
    "HTTP request failed");
  - with `PLAYGROUND_PKG_LIVE=1`, by hand: update, update again
    (`already
    current`), install, list, against the live repository.
- **Acceptance** (`tests/playground_e2e.ts`, Playwright): the terminal's
  `sudo pkg update` against the fixture; with `PLAYGROUND_PKG_LIVE=1`, update,
  update again and an install that then runs. PR 3: after a panel install the
  terminal's first update is `already current` (one cache).
- Not automated: a snapshot restore followed by `pkg update`. The restore path
  runs the same start (step 1), and the seal stops the relay first.
- Neither image ships a repository cache (checked in both `.yurtimg`s), so a
  first update in a tab always starts from an empty default cache.

## PR plan

All PRs are drafts, reviewed at their head SHA before any merge.

1. **yurt-playground: this spec** (docs only).
2. **yurt-playground: the relay.** `src/pkg_relay.ts`, the start/stop wiring in
   `boot.ts`, the `trusted-repos.toml` rewrite, `browserTrustedRepos`
   recognizing the relay URL, the AGENTS.md locked-decision change, and tests.
   Terminal `pkg` then works. No other repo is needed.
3. **yurt-playground: the panel's install by name through the relay** (stacked
   on 2). `servePackages` gets a relay-backed run. The staged path stays for the
   sets, capture and Suspend/Resume.
4. **yurt-pkg: `install` of installed packages without a cache.** It is
   independent of 2 and 3, has its red test first, and reaches the browser with
   the next train's `pkg` pin.

There is no kernel PR and no yurt-ports PR.

## Risks

- **Guest → host-listener connect** is exercised by no test today. The kernel's
  loopback is one interface for the whole kernel (`net_ifaces[0]`), but this
  path is unproven. If it fails, the fallback is a `listenSandboxPort` next to
  `dialSandboxPort` in the kernel's JS host, which would be a kernel PR for
  Sunny.
- **Kernel-lock contention.** The relay's calls take the global kernel lock
  while pkg works. The backoff keeps them sparse. PR 2 measures idle CPU and
  throughput before choosing the intervals.
- **Any guest process can use the relay, not only pkg.** It can `GET` public
  files under `yurt-packages/main/`, within the caps. Data hidden in a path
  reaches only GitHub's request logs. This is the approved exception, and
  AGENTS.md states it as such.
- **Port squatting.** The kernel has no privileged-port rule. The relay binds
  before the first guest process, and only the session's end closes it. A
  squatter could serve only bytes that pkg verifies.
- **Visible difference from the desktop.** `trusted-repos.toml` and pkg's
  messages show `http://127.0.0.1:7417/`. The commands and their results are the
  same.
- **Large installs can hang the browser sandbox** (yurtos-kernel#4210, Sunny's).
  This predates the relay, and the acceptance tests use a small package.
- **Overlap.** yurt-playground#190 (Sunny, draft, idle since 10-12) rewords the
  same AGENTS.md section, which will need a one-line rebase. No open PR or issue
  in yurt-playground, yurt-pkg, yurt-ports or yurtos-kernel touches pkg fetching
  or the panel's installs.
