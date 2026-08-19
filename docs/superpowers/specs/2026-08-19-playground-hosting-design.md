# Playground Hosting Design

## Goal

Publish the browser Yurt playground from this repository with the response
headers required for cross-origin isolation, while retaining a reproducible
local build and CI verification path.

## Constraints

- The browser page must receive `Cross-Origin-Opener-Policy: same-origin`.
- The browser page must receive `Cross-Origin-Embedder-Policy: require-corp`.
- Static assets must be built from the git-pinned kernel and playground image.
- Generated bundles and binary artifacts remain deployment outputs; they are
  not committed to git.
- CI must build every port required by the pinned playground image, including
  `busybox`, `cpython`, `libcxx`, and `libzmq`.
- GitHub Pages is not suitable for the runtime because it cannot configure the
  required response headers.

## Design

GitHub Actions will build a self-contained `dist/` directory. The build will
materialize the pinned kernel and image, bundle the page and workers using the
existing Deno script, copy the static page and verified artifacts into
`dist/`, and write a Cloudflare Pages `_headers` file. Cloudflare Pages will
deploy `dist/` on pushes to `main` through its deployment action using a
repository secret for authentication.

The deployment workflow will run the same formatting, lint, type-check, and
test gates as CI before publishing. The workflow will have least-privilege
contents access and will fail before deployment if artifact hashes or the
required isolation configuration are invalid.

The repository README will explain that the public runtime is Cloudflare Pages
despite the GitHub-owned source and workflow, and will document the required
repository secrets and the resulting URL configuration. A small generated
build test will verify that `dist/index.html`, the bundles, both binary
artifacts, and `_headers` are present with the expected header rules.

## Non-goals

- Do not move kernel, port, package, or Jupyter ownership into this repository.
- Do not add a native runtime or a websocket transport.
- Do not pretend that a plain `github.io` Pages site can run the isolated
  playground.

## Acceptance criteria

1. A clean workflow checkout can build the pinned image and static bundle.
2. The built output contains the page, worker bundles, kernel wasm, and image.
3. Cloudflare Pages receives COOP, COEP, and CORP headers for all playground
   responses.
4. Existing local and CI gates remain green.
