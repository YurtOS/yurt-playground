# Security policy

The playground runs untrusted code on purpose: a Linux kernel compiled to
WebAssembly, a BusyBox shell and CPython, inside a browser tab or — in the
desktop app and the `yurt` CLI — on your machine. What holds that in place is
the boundary between the guest and its host, so reports about that boundary are
the ones we most want to hear about.

## Reporting a vulnerability

Please report privately, not in a public issue:

- **Preferred:**
  [open a private security advisory](https://github.com/YurtOS/yurt-playground/security/advisories/new)
  on this repository. It is visible only to you and the maintainers.
- If that form is unavailable to you, open a public issue that says only that
  you have a report and how to reach you — no details — and we will take it from
  there.

Please include what you would need yourself: the version (the page footer, or
`yurt --version`), the platform, and the smallest reproduction you have. A proof
of concept that demonstrates the boundary being crossed is worth more than a
description of one, and we will not ask you to weaponize it further.

We aim to acknowledge a report within three working days and to tell you our
assessment — including if we think it is not a vulnerability, and why — within
ten. If a fix is warranted we will agree a disclosure date with you, and credit
you in the advisory unless you would rather we did not.

## What is in scope

- **Guest escape:** guest code reaching the host's filesystem, network or
  processes beyond what the sandbox grants it — in the tab, in the desktop app,
  or through `yurt run`/`yurt exec`.
- **The desktop app's local API** (`/api/*`, bound to `127.0.0.1` and guarded by
  a per-run bearer token): anything that lets another program or another web
  page on the machine drive a sandbox it was not given the token for.
- **The hosted page:** anything that escapes the page's Content-Security-Policy
  or cross-origin isolation, or that lets another site read or drive the sandbox
  in a visitor's tab.
- **Supply chain:** the released artifacts (installers, the CLI packages, the
  kernel wasm and image) not matching what this repository builds.

## What is not

- The guest having no network in the tab, `pip install` failing there, and the
  sandbox being resettable by a reload: those are the design, described on the
  page.
- Denial of service _inside_ a guest — a guest that spins its own CPU or fills
  its own memory is doing what a sandbox is for. A guest that takes down the
  host is in scope.
- Findings from automated scanners without a reproduction on a running
  playground.

## Supported versions

The latest release. The playground ships as one train — page, kernel wasm,
image, desktop app and CLI built together and pinned in `artifacts/pins.json` —
so fixes land in the next train rather than in patches to an older one.
