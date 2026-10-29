import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  type ArchiveCache,
  browserTrustedRepos,
  CACHE_ROOT,
  type Catalog,
  type Fetcher,
  fetchWithProgress,
  INSTALL_RUN_CEILING_MS,
  INSTALL_STALL_MS,
  installPackage,
  installScript,
  InstallStalled,
  latestRelease,
  loadCatalog,
  markInstalled,
  onlyStaged,
  PACKAGE_REPO_URL,
  type PackageFile,
  type PackageHost,
  type PackageVersion,
  parseIndex,
  parsePackageFile,
  plannedInstalls,
  resolveSet,
  SetNotOffered,
  sha256Hex,
  sizeRefusal,
  type StagedFile,
  STAGING_DIR,
  stalledSandboxWhy,
  TABLET_MAX_BYTES,
} from "../src/packages.ts";

const SUBJECT =
  "https://github.com/YurtOS/yurt-packages/.github/workflows/release.yml@refs/heads/main";
const ISSUER = "https://token.actions.githubusercontent.com";

const TRUSTED = `# written at image build time
[[repo]]
id              = "official"
url             = "https://api.github.com/repos/YurtOS/yurt-packages/contents/"
priority        = 0
signing_subject = "${SUBJECT}"
signing_issuer  = "${ISSUER}"

[[repo]]
id = "other"
url = "https://example.test/repo/"
signing_subject = "someone"
signing_issuer = "somewhere"
`;

function version(
  v: string,
  build: string,
  extra: Partial<PackageVersion> = {},
): PackageVersion {
  return {
    version: v,
    build,
    url: `artifacts/x/${v}/x-${v}-${build}.yurtpkg`,
    sha256: "",
    size: 1,
    depends: [],
    yanked: false,
    ...extra,
  };
}

Deno.test("the list shows the highest version, then build, never yanked", () => {
  const file: PackageFile = {
    name: "x",
    versions: [
      version("1.2.0", "yurt_3"),
      version("1.10.0", "yurt_0"),
      version("1.10.0", "yurt_2"),
      version("1.10.0", "yurt_9", { yanked: true }),
      version("1.9.9", "yurt_7"),
    ],
  };
  const picked = latestRelease(file)!;
  assertEquals([picked.version, picked.build], ["1.10.0", "yurt_2"]);
  // A pre-release sorts below its release, whatever its build (semver).
  const pre = latestRelease({
    name: "x",
    versions: [
      version("2.0.0-rc.2", "yurt_5"),
      version("2.0.0", "yurt_1"),
      version("2.0.0-rc.10", "yurt_9"),
    ],
  })!;
  assertEquals(pre.version, "2.0.0");
  const rc = latestRelease({
    name: "x",
    versions: [
      version("2.0.0-rc.2", "yurt_5"),
      version("2.0.0-rc.10", "yurt_0"),
      version("2.0.0-beta", "yurt_9"),
    ],
  })!;
  assertEquals(rc.version, "2.0.0-rc.10");
  assertEquals(
    latestRelease({
      name: "y",
      versions: [version("1.0.0", "yurt_0", { yanked: true })],
    }),
    undefined,
  );
});

Deno.test("the install's trust config is the image's identity, pointed at the copy", () => {
  const derived = browserTrustedRepos(TRUSTED, "file:///var/cache/x/repo/");
  assertEquals(derived.id, "official");
  assertEquals(
    derived.toml,
    [
      "[[repo]]",
      'id = "official"',
      'url = "file:///var/cache/x/repo/"',
      "priority = 0",
      `signing_subject = "${SUBJECT}"`,
      `signing_issuer = "${ISSUER}"`,
      "",
    ].join("\n"),
  );
  assertThrows(
    () =>
      browserTrustedRepos(
        '[[repo]]\nid = "o"\nurl = "https://example.test/"\n',
        "file:///x/",
      ),
    Error,
    "does not trust YurtOS/yurt-packages",
  );
  assertThrows(
    () =>
      browserTrustedRepos(
        '[[repo]]\nid = "o"\nurl = "https://x/YurtOS/yurt-packages/"\nsigning_issuer = "i"\n',
        "file:///x/",
      ),
    Error,
    "no signing_subject",
  );
  assertThrows(
    () => browserTrustedRepos("[[repo]]\nurl = [1, 2]\n", "file:///x/"),
    Error,
    "cannot read",
  );
  assertThrows(
    () => browserTrustedRepos('[[repo]]\nid = "a\\U0001F600"\n', "file:///x/"),
    Error,
    "cannot read",
  );
});

Deno.test("paths the repository names stay inside the staged copy", () => {
  const enc = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  for (
    const url of [
      "../etc/passwd",
      "/etc/passwd",
      "packages/../../x.json",
      "file:///etc/passwd",
      "packages//x.json",
      "packages/%2e%2e/x.json",
      "packages/x.json#a",
      "packages/x.json?a",
      "a:b/x.json",
      "packages/.\t./x.json",
      "packages/x .json",
    ]
  ) {
    assertThrows(
      () =>
        parseIndex(enc({
          schema: 1,
          index_version: 1,
          packages: { x: { sha256: "", size: 1, url } },
        })),
      Error,
      "unsupported path",
    );
  }
  assertThrows(
    () =>
      parseIndex(enc({
        schema: 1,
        index_version: 1,
        packages: { "x;rm": { sha256: "", size: 1, url: "packages/x.json" } },
      })),
    Error,
    "bad package name",
  );
});

Deno.test("a tablet refuses what a desktop browser installs", () => {
  assertEquals(sizeRefusal(TABLET_MAX_BYTES, true), undefined);
  assertEquals(
    sizeRefusal(TABLET_MAX_BYTES + 1, true)?.includes("tablet"),
    true,
  );
  assertEquals(sizeRefusal(40 * 1024 * 1024, false), undefined);
  assertEquals(
    sizeRefusal(1024 * 1024 * 1024, false)?.includes("desktop app"),
    true,
  );
});

Deno.test("pkg update runs unless pkg's cache holds this index; the copy is removed", () => {
  const script = installScript("zsh", "official");
  const lines = script.split("\n");
  assertEquals(
    lines[0],
    `cleanup() { sudo rm -rf '${STAGING_DIR}'; rm -f "$err"; }`,
  );
  assertEquals(lines[1], "trap cleanup EXIT");
  assertEquals(
    lines.filter((line) => line.includes("sudo pkg --etc-root")),
    [
      `  sudo pkg --etc-root '${STAGING_DIR}/etc' --cache-root '${CACHE_ROOT}' update || exit 1`,
      `sudo pkg --etc-root '${STAGING_DIR}/etc' --cache-root '${CACHE_ROOT}' install 'zsh' 2>"$err"`,
      // Once more, after an update, when pkg says the signer changed.
      `  sudo pkg --etc-root '${STAGING_DIR}/etc' --cache-root '${CACHE_ROOT}' update || exit 1`,
      `  sudo pkg --etc-root '${STAGING_DIR}/etc' --cache-root '${CACHE_ROOT}' install 'zsh'`,
    ],
  );
  assertEquals(
    lines.includes(
      `if ! sudo cmp -s '${CACHE_ROOT}/official/current/index.json' '${STAGING_DIR}/repo/index.json'; then`,
    ),
    true,
  );
});

/** A repository of one package, served from memory. */
async function fakeRepo(
  archive: Uint8Array,
  extra: Partial<PackageVersion> = {},
) {
  const enc = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  const url = "artifacts/greet/0.1.0/greet-0.1.0-yurt_0.yurtpkg";
  const meta = enc({
    name: "greet",
    versions: [
      version("0.1.0", "yurt_0", {
        url,
        size: archive.byteLength,
        sha256: await sha256Hex(archive),
        ...extra,
      }),
    ],
  });
  const files: Record<string, Uint8Array> = {
    "index.json": enc({
      schema: 1,
      index_version: 4,
      expires_at: "2099-01-01T00:00:00Z",
      packages: {
        greet: {
          sha256: await sha256Hex(meta),
          size: 1,
          url: "packages/greet.json",
        },
      },
    }),
    "index.json.bundle": enc("index bundle"),
    "packages/greet.json": meta,
    [url]: archive,
    [`${url}.bundle`]: enc("archive bundle"),
  };
  return (requested: string) => {
    const bytes = files[requested.slice(PACKAGE_REPO_URL.length)];
    return bytes === undefined
      ? Promise.reject(new Error(`404 ${requested}`))
      : Promise.resolve(bytes);
  };
}

/** The plan run fails at the first archive, as `pkg` does with none
 * staged; the install run gets `install`. */
const PLAN = {
  code: 1,
  stdout: "install greet 0.1.0-yurt_0\n",
  stderr: "Error: failed to fetch archive for greet\n",
};
const INSTALLED = {
  code: 0,
  stdout: "install greet 0.1.0-yurt_0\n",
  stderr: "",
};

function fakeHost(
  ...results: { code: number; stdout: string; stderr: string }[]
) {
  const runs: { files: StagedFile[]; script: string; dir: string }[] = [];
  // Every run stages at the one staging dir.
  const host: PackageHost = {
    readFile: () => Promise.resolve(new TextEncoder().encode(TRUSTED)),
    stageAndRun: (files, script) => {
      runs.push({ files, script, dir: STAGING_DIR });
      return Promise.resolve(results[runs.length - 1]);
    },
  };
  return { host, runs };
}

Deno.test("pkg plans the install; the page stages exactly what it names", async () => {
  const archive = new Uint8Array([1, 2, 3, 4, 5]);
  const fetcher = await fakeRepo(archive);
  const { host, runs } = fakeHost(PLAN, INSTALLED);
  const messages: string[] = [];
  const output = await installPackage("greet", {
    host,
    tablet: false,
    fetcher,
    progress: (m) => messages.push(m),
  });
  assertEquals(output, "install greet 0.1.0-yurt_0");
  assertEquals(runs.length, 2);
  const metadata = [
    "etc/yurt-pkg/trusted-repos.toml",
    "repo/index.json",
    "repo/index.json.bundle",
    "repo/packages/greet.json",
  ];
  const archives = [
    "repo/artifacts/greet/0.1.0/greet-0.1.0-yurt_0.yurtpkg",
    "repo/artifacts/greet/0.1.0/greet-0.1.0-yurt_0.yurtpkg.bundle",
  ];
  for (const [i, { files, script, dir }] of runs.entries()) {
    assertEquals(dir, STAGING_DIR);
    const staged = Object.fromEntries(
      files.map((f) => [f.path.slice(dir.length + 1), f.bytes]),
    );
    assertEquals(
      Object.keys(staged).sort(),
      (i === 0 ? metadata : [...metadata, ...archives]).sort(),
    );
    for (const [path, bytes] of Object.entries(staged)) {
      if (!path.startsWith("repo/")) continue;
      assertEquals(bytes, await fetcher(`${PACKAGE_REPO_URL}${path.slice(5)}`));
    }
    assertEquals(
      new TextDecoder().decode(staged["etc/yurt-pkg/trusted-repos.toml"])
        .includes(`url = "file://${dir}/repo/"`),
      true,
    );
    assertEquals(script, installScript("greet", "official"));
  }
  assertEquals(
    messages.at(-1),
    "greet: verifying and installing (pkg install greet)",
  );
});

/** A host whose guest is watched (src/session_packages.ts): each run
 * beats `beats` times, `everyMs` apart, then answers; with `beats`
 * Infinity it never beats -- a sandbox that stopped answering
 * (yurtos-kernel#4170) -- and answers only after 3 s. */
function watchedHost(
  runs: { beats: number; everyMs: number; result: typeof PLAN }[],
) {
  const aborted: boolean[] = [];
  let n = 0;
  const host: PackageHost = {
    readFile: () => Promise.resolve(new TextEncoder().encode(TRUSTED)),
    observesProgress: true,
    stageAndRun: (_files, _script, watch) => {
      const { beats, everyMs, result } = runs[n++];
      const index = aborted.push(false) - 1;
      return new Promise((resolve, reject) => {
        let settled = false;
        watch?.signal.addEventListener("abort", () => {
          if (settled) return;
          aborted[index] = true;
          clearInterval(timer);
          clearTimeout(late);
          reject(new Error("stopped watching"));
        });
        let beaten = 0;
        // A hung run does answer, much later (3 s), so a broken stall check
        // fails the test rather than hanging it.
        const late = beats === Infinity
          ? setTimeout(() => {
            settled = true;
            clearInterval(timer);
            resolve(result);
          }, 3000)
          : undefined;
        const timer = setInterval(() => {
          if (beats === Infinity) return;
          if (beaten++ < beats) {
            watch?.alive();
            return;
          }
          clearInterval(timer);
          settled = true;
          resolve(result);
        }, everyMs);
      });
    },
  };
  return { host, aborted };
}

Deno.test("an install whose sandbox stops answering fails as stalled, not forever", async () => {
  const fetcher = await fakeRepo(new Uint8Array([1, 2, 3]));
  // The plan answers; the install run hangs with no heartbeat.
  const { host, aborted } = watchedHost([
    { beats: 0, everyMs: 5, result: PLAN },
    { beats: Infinity, everyMs: 5, result: INSTALLED },
  ]);
  const messages: string[] = [];
  const started = Date.now();
  const error = await assertRejects(
    () =>
      installPackage("greet", {
        host,
        tablet: false,
        fetcher,
        progress: (m) => messages.push(m),
        stallMs: 100,
      }),
    InstallStalled,
  );
  // A host that cannot run pkg recover: the sandbox needs a reload.
  assertEquals(
    error.message,
    "greet: the install stopped making progress (the sandbox's pkg did nothing for 0 s); pkg recover was not run (this sandbox cannot run it), so this sandbox may hold a half-installed package: reload the page",
  );
  assertEquals(error.recovered, false);
  // In the guest's run: the retry needs a fresh sandbox.
  assertEquals(error.inSandbox, true);
  // It gave up at the stall, and told the host to stop watching the run.
  assertEquals(Date.now() - started < 2000, true);
  assertEquals(aborted, [false, true]);
  assertEquals(
    messages.at(-1),
    "greet: verifying and installing (pkg install greet)",
  );
});

Deno.test("a download that stops is a stall outside the sandbox, and the install does nothing after it", async () => {
  const archive = new Uint8Array([1, 2, 3]);
  const repo = await fakeRepo(archive);
  // The archive's download sends nothing for 300 ms; the window is 100.
  const fetcher: Fetcher = (url) =>
    url.endsWith(".yurtpkg")
      ? new Promise((resolve) => setTimeout(() => resolve(repo(url)), 300))
      : repo(url);
  const { host, runs } = fakeHost(PLAN, INSTALLED);
  const messages: string[] = [];
  const error = await assertRejects(
    () =>
      installPackage("greet", {
        host,
        tablet: false,
        fetcher,
        progress: (m) => messages.push(m),
        stallMs: 100,
      }),
    InstallStalled,
  );
  assertEquals(error.inSandbox, false);
  assertEquals(
    error.message,
    "greet: the download stopped making progress (nothing arrived for 0 s)",
  );
  const said = messages.length;
  // The download finishes later: nothing is staged, run or said.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assertEquals(runs.length, 1);
  assertEquals(messages.length, said);
});

Deno.test("a slow install that keeps beating is not stalled, however long", async () => {
  const fetcher = await fakeRepo(new Uint8Array([1, 2, 3]));
  // The install run takes ~6x the stall window, beating all along.
  const { host } = watchedHost([
    { beats: 0, everyMs: 5, result: PLAN },
    { beats: 60, everyMs: 10, result: INSTALLED },
  ]);
  const output = await installPackage("greet", {
    host,
    tablet: false,
    fetcher,
    progress: () => {},
    stallMs: 100,
  });
  assertEquals(output, "install greet 0.1.0-yurt_0");
});

Deno.test("a run that beats but never finishes ends at the ceiling", async () => {
  // A pkg alive but blocked keeps the heartbeat going; the ceiling ends it.
  const fetcher = await fakeRepo(new Uint8Array([1, 2, 3]));
  const { host, aborted } = watchedHost([
    { beats: 0, everyMs: 5, result: PLAN },
    { beats: 100, everyMs: 10, result: INSTALLED },
  ]);
  const error = await assertRejects(
    () =>
      installPackage("greet", {
        host,
        tablet: false,
        fetcher,
        progress: () => {},
        stallMs: 100,
        runCeilingMs: 300,
      }),
    InstallStalled,
  );
  assertEquals(error.inSandbox, true);
  assertStringIncludes(
    error.message,
    "greet: the install stopped making progress (the sandbox did not finish it in 0 s)",
  );
  assertEquals(aborted, [false, true]);
});

Deno.test("a host that cannot watch its runs is never called stalled during one", async () => {
  const fetcher = await fakeRepo(new Uint8Array([1, 2, 3]));
  let n = 0;
  const host: PackageHost = {
    readFile: () => Promise.resolve(new TextEncoder().encode(TRUSTED)),
    // No observesProgress: a run longer than the window is no stall.
    stageAndRun: () =>
      new Promise((resolve) =>
        setTimeout(() => resolve(n++ === 0 ? PLAN : INSTALLED), 250)
      ),
  };
  const output = await installPackage("greet", {
    host,
    tablet: false,
    fetcher,
    progress: () => {},
    stallMs: 100,
  });
  assertEquals(output, "install greet 0.1.0-yurt_0");
});

Deno.test("pkg running out of memory (Safari) fails at once, with its own words", async () => {
  // pkg aborts: the Rust runtime's line, exit 134. Not a stall: the reason
  // reaches the page as it is, and the page offers Try again.
  const fetcher = await fakeRepo(new Uint8Array([1, 2, 3]));
  const { host } = fakeHost(PLAN, {
    code: 134,
    stdout: "install greet 0.1.0-yurt_0\n",
    stderr: "memory allocation of 33554432 bytes failed\n",
  });
  await assertRejects(
    () =>
      installPackage("greet", {
        host,
        tablet: false,
        fetcher,
        progress: () => {},
      }),
    Error,
    "pkg install greet failed: memory allocation of 33554432 bytes failed",
  );
});

Deno.test("a plan names only releases the index lists", async () => {
  const fetcher = await fakeRepo(new Uint8Array([1]));
  const { host } = fakeHost({
    ...PLAN,
    stdout: "install greet 9.9.9-yurt_0\n",
  });
  await assertRejects(
    () =>
      installPackage("greet", {
        host,
        tablet: false,
        fetcher,
        progress: () => {},
      }),
    Error,
    "pkg chose greet 9.9.9-yurt_0, which the index does not list",
  );
});

Deno.test("an install with nothing to install downloads nothing", async () => {
  let downloads = 0;
  const repo = await fakeRepo(new Uint8Array([1]));
  const fetcher = (url: string) => {
    if (url.endsWith(".yurtpkg")) downloads++;
    return repo(url);
  };
  const { host, runs } = fakeHost({
    code: 0,
    stdout: "nothing to install\n",
    stderr: "",
  });
  assertEquals(
    await installPackage("greet", {
      host,
      tablet: false,
      fetcher,
      progress: () => {},
    }),
    "nothing to install",
  );
  assertEquals([runs.length, downloads], [1, 0]);
});

Deno.test("a download that does not match the index is never handed over", async () => {
  const fetcher = await fakeRepo(new Uint8Array([1, 2, 3]));
  const corrupt = (url: string) =>
    url.endsWith(".yurtpkg")
      ? Promise.resolve(new Uint8Array([9, 9, 9]))
      : fetcher(url);
  const { host, runs } = fakeHost(PLAN);
  await assertRejects(
    () =>
      installPackage("greet", {
        host,
        tablet: false,
        fetcher: corrupt,
        progress: () => {},
      }),
    Error,
    "does not match its sha256",
  );
  // The plan only: the corrupt archive never reaches the guest.
  assertEquals(runs.length, 1);
});

Deno.test("a refusal from the guest's pkg names its cause, not its summary", async () => {
  const fetcher = await fakeRepo(new Uint8Array([1]));
  const { host } = fakeHost({
    code: 1,
    stdout: "",
    stderr:
      "failed to update official: verification failed: invalid Sigstore bundle\n" +
      "Error: one or more repository updates failed\n",
  });
  await assertRejects(
    () =>
      installPackage("greet", {
        host,
        tablet: false,
        fetcher,
        progress: () => {},
      }),
    Error,
    "pkg install greet failed: failed to update official: verification failed: invalid Sigstore bundle",
  );
});

Deno.test("the cause comes from pkg's errors, not from its other output", async () => {
  const fetcher = await fakeRepo(new Uint8Array([1]));
  const { host } = fakeHost(PLAN, {
    code: 1,
    // pkg's warning says "failed" too, and comes first; a plan line in
    // stdout could name a package "...-error".
    stdout: "install greet 0.1.0-yurt_0\n",
    stderr: "warning: transaction t1 is failed; Repair the cause and run " +
      "pkg recover t1\nError: no space left on device\n",
  });
  await assertRejects(
    () =>
      installPackage("greet", {
        host,
        tablet: false,
        fetcher,
        progress: () => {},
      }),
    Error,
    "pkg install greet failed: Error: no space left on device",
  );
});

Deno.test("a download larger than its limit stops before it is held whole", async () => {
  const real = globalThis.fetch;
  let pulled = 0;
  globalThis.fetch = () => {
    pulled = 0;
    return Promise.resolve(
      new Response(
        new ReadableStream({
          pull(controller) {
            pulled++;
            controller.enqueue(new Uint8Array(1024));
            if (pulled === 100) controller.close();
          },
        }),
      ),
    );
  };
  try {
    await assertRejects(
      () => fetchWithProgress("https://example.test/x", 4096),
      Error,
      "larger than 4096 bytes",
    );
    assertEquals(pulled < 10, true, `pulled ${pulled} chunks`);
    const whole = await fetchWithProgress("https://example.test/x", 100 * 1024);
    assertEquals(whole.byteLength, 100 * 1024);
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("a release the page cannot fetch fails only its own install", async () => {
  for (
    const [extra, message] of [
      [{ url: "https://example.test/greet.yurtpkg" }, "unsupported path"],
      [{ url: "artifacts/%2e%2e/x.yurtpkg" }, "unsupported path"],
      [{ size: "big" as unknown as number }, "which the index does not list"],
    ] as const
  ) {
    const fetcher = await fakeRepo(new Uint8Array([1]), extra);
    const { host, runs } = fakeHost(PLAN);
    // The list still loads.
    await loadCatalog(fetcher);
    await assertRejects(
      () =>
        installPackage("greet", {
          host,
          tablet: false,
          fetcher,
          progress: () => {},
        }),
      Error,
      message,
    );
    assertEquals(runs.length, 1);
  }
});

Deno.test("a release the page cannot read is left out of the list, not fatal to it", () => {
  const file = parsePackageFile(
    new TextEncoder().encode(JSON.stringify({
      name: "x",
      versions: [
        null,
        { url: "a.yurtpkg" },
        version("2.0.0", "yurt_0", { size: -1 }),
        version("1.0.0", "yurt_0"),
      ],
    })),
  );
  assertEquals(file.versions.length, 1);
  assertEquals(latestRelease(file)?.version, "1.0.0");
});

Deno.test("the worker writes only inside the staging dir", () => {
  const file = (path: string) => ({ path, bytes: new Uint8Array() });
  assertEquals(onlyStaged([file(`${STAGING_DIR}/repo/index.json`)]), true);
  for (
    const path of [
      "/etc/passwd",
      STAGING_DIR,
      `${STAGING_DIR}-other/x`,
      `${STAGING_DIR}/repo/../../../etc/passwd`,
      `${STAGING_DIR}/./x`,
      `${STAGING_DIR}//x`,
      `${STAGING_DIR}/repo/`,
    ]
  ) {
    assertEquals(
      onlyStaged([file(`${STAGING_DIR}/repo/index.json`), file(path)]),
      false,
      path,
    );
  }
});

/** An {@link ArchiveCache} in memory, recording what it was asked. */
function memoryCache(seed: Record<string, Uint8Array> = {}) {
  const store = new Map(Object.entries(seed));
  const log: string[] = [];
  const cache: ArchiveCache = {
    get: (url) => {
      log.push(`get ${url}`);
      return Promise.resolve(store.get(url));
    },
    put: (url, bytes) => {
      log.push(`put ${url}`);
      store.set(url, bytes);
      return Promise.resolve();
    },
    delete: (url) => {
      log.push(`delete ${url}`);
      store.delete(url);
      return Promise.resolve();
    },
    keepOnly: (keys) => {
      for (const k of [...store.keys()]) if (!keys.includes(k)) store.delete(k);
      return Promise.resolve();
    },
  };
  return { cache, store, log };
}

/** A cache entry's key: the archive's sha256, as the index names it. */
const key = async (archive: Uint8Array) => `sha256:${await sha256Hex(archive)}`;

const GREET_URL =
  `${PACKAGE_REPO_URL}artifacts/greet/0.1.0/greet-0.1.0-yurt_0.yurtpkg`;

Deno.test("a pinned set is one exact `pkg install` and must plan exactly the pinned releases", async () => {
  const archive = new Uint8Array([1, 2, 3]);
  const fetcher = await fakeRepo(archive);
  const pin = {
    name: "greet",
    version: "0.1.0",
    build: "yurt_0",
    sha256: await sha256Hex(archive),
    size: archive.byteLength,
  };
  const { host, runs } = fakeHost(PLAN, INSTALLED);
  const messages: string[] = [];
  await installPackage({ label: "Greet", releases: [pin] }, {
    host,
    tablet: false,
    fetcher,
    progress: (m) => messages.push(m),
  });
  for (const { script } of runs) {
    assertEquals(script, installScript(["greet@0.1.0-yurt_0"], "official"));
  }
  assertEquals(
    messages.at(-1),
    "Greet: verifying and installing (pkg install greet@0.1.0-yurt_0)",
  );
  // The repository's release is not the one this page pins.
  for (const other of [{ sha256: "f".repeat(64) }, { size: 99 }]) {
    const { host: refusing } = fakeHost(PLAN, INSTALLED);
    await assertRejects(
      () =>
        installPackage({ label: "Greet", releases: [{ ...pin, ...other }] }, {
          host: refusing,
          tablet: false,
          fetcher,
          progress: () => {},
        }),
      Error,
      "is not the 0.1.0-yurt_0 this install expects",
    );
  }
  // pkg chose a release (a dependency) the index lists but the page does
  // not pin.
  const enc = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  const libx = enc({ name: "libx", versions: [version("1.0.0", "yurt_0")] });
  const withLibx = async (url: string) => {
    const path = url.slice(PACKAGE_REPO_URL.length);
    if (path === "packages/libx.json") return libx;
    const bytes = await fetcher(url);
    if (path !== "index.json") return bytes;
    const index = JSON.parse(new TextDecoder().decode(bytes));
    index.packages.libx = { sha256: "", size: 1, url: "packages/libx.json" };
    return enc(index);
  };
  const { host: extra } = fakeHost({
    ...PLAN,
    stdout: "install greet 0.1.0-yurt_0\ninstall libx 1.0.0-yurt_0\n",
  });
  await assertRejects(
    () =>
      installPackage({ label: "Greet", releases: [pin] }, {
        host: extra,
        tablet: false,
        fetcher: withLibx,
        progress: () => {},
      }),
    Error,
    "pkg chose libx 1.0.0-yurt_0, which this page does not pin",
  );
});

Deno.test("a cached archive that is still the release is used without a download", async () => {
  const archive = new Uint8Array([4, 5, 6]);
  const repo = await fakeRepo(archive);
  const fetched: string[] = [];
  const fetcher = (url: string) => {
    fetched.push(url);
    return repo(url);
  };
  const { cache, log } = memoryCache({
    [await key(archive)]: archive,
    [`${await key(archive)}.bundle`]: new TextEncoder().encode(
      '"archive bundle"',
    ),
  });
  const { host, runs } = fakeHost(PLAN, INSTALLED);
  await installPackage("greet", {
    host,
    tablet: false,
    fetcher,
    cache,
    progress: () => {},
  });
  assertEquals(fetched.includes(GREET_URL), false);
  assertEquals(fetched.includes(`${GREET_URL}.bundle`), false);
  const staged = runs[1].files.find((f) => f.path.endsWith(".yurtpkg"));
  assertEquals(staged?.bytes, archive);
  assertEquals(log.some((l) => l.startsWith("put")), false);
});

Deno.test("a cached archive that is not the release is dropped and downloaded again", async () => {
  const archive = new Uint8Array([7, 8, 9]);
  const fetcher = await fakeRepo(archive);
  const { cache, store, log } = memoryCache({
    [await key(archive)]: new Uint8Array([0, 0, 0]),
  });
  const { host } = fakeHost(PLAN, INSTALLED);
  await installPackage("greet", {
    host,
    tablet: false,
    fetcher,
    cache,
    progress: () => {},
  });
  assertEquals(log.includes(`delete ${await key(archive)}`), true);
  assertEquals(store.get(await key(archive)), archive);
});

Deno.test("what pkg refused is not kept for the next try", async () => {
  const archive = new Uint8Array([1]);
  const fetcher = await fakeRepo(archive);
  const { cache, store } = memoryCache({
    [await key(archive)]: archive,
    [`${await key(archive)}.bundle`]: new Uint8Array([9]),
  });
  const { host } = fakeHost(PLAN, {
    code: 1,
    stdout: "",
    stderr: "Error: archive signature verification failed for greet\n",
  });
  await assertRejects(
    () =>
      installPackage("greet", {
        host,
        tablet: false,
        fetcher,
        cache,
        progress: () => {},
      }),
    Error,
    "signature",
  );
  assertEquals(store.size, 0);
});

Deno.test("a signature downloaded on a failed try is not kept for the next", async () => {
  const archive = new Uint8Array([2]);
  const fetcher = await fakeRepo(archive);
  const { cache, store } = memoryCache();
  const { host } = fakeHost(PLAN, {
    code: 1,
    stdout: "",
    stderr: "Error: archive signature verification failed for greet\n",
  });
  await assertRejects(
    () =>
      installPackage("greet", {
        host,
        tablet: false,
        fetcher,
        cache,
        progress: () => {},
      }),
    Error,
    "signature",
  );
  assertEquals(store.has(`${await key(archive)}.bundle`), false);
  // The archive matched its sha256, so it may stay.
  assertEquals(store.get(await key(archive)), archive);
});

/** A catalog of these packages' releases, as `version-build` strings
 * (`!` marks a yanked one). */
function catalogOf(releases: Record<string, string[]>): Catalog {
  const metadata = new Map<string, { bytes: Uint8Array; file: PackageFile }>();
  const packages: Record<
    string,
    { sha256: string; size: number; url: string }
  > = {};
  for (const [name, list] of Object.entries(releases)) {
    const versions = list.map((r) => {
      const yanked = r.startsWith("!");
      const [v, b] = r.replace("!", "").split("@");
      return {
        ...version(v, b, {
          sha256: `${name}${v}${b}`.padEnd(64, "0").slice(0, 64),
          size: 10,
        }),
        yanked,
      };
    });
    metadata.set(name, { bytes: new Uint8Array(), file: { name, versions } });
    packages[name] = { sha256: "", size: 0, url: `packages/${name}.json` };
  }
  return {
    index: { schema: 1, index_version: 1, expires_at: "", packages },
    indexBytes: new Uint8Array(),
    indexBundle: new Uint8Array(),
    metadata,
  };
}

const SET = ["python", "numpy", "pyzmq", "jupyter-kernel"];

Deno.test("the newest complete set wins; a partly published newer one is ignored", () => {
  const catalog = catalogOf({
    python: ["3.14.7@yurt_0", "3.14.7@yurt_1", "3.14.8@yurt_2"],
    numpy: ["2.5.0@yurt_0", "2.5.0@yurt_1", "2.5.1@yurt_2"],
    pyzmq: ["26.4.0@yurt_0", "26.4.0@yurt_1", "26.4.0@yurt_2"],
    // Set 2 is not complete: jupyter-kernel's is still to be published.
    "jupyter-kernel": ["0.0.1@yurt_0", "0.0.1@yurt_1"],
  });
  const set = resolveSet(catalog, SET);
  assertEquals(set.map((r) => `${r.name}@${r.version}-${r.build}`), [
    "python@3.14.7-yurt_1",
    "numpy@2.5.0-yurt_1",
    "pyzmq@26.4.0-yurt_1",
    "jupyter-kernel@0.0.1-yurt_1",
  ]);
});

Deno.test("a yanked member takes its set out; no complete set is an error", () => {
  const catalog = catalogOf({
    python: ["3.14.7@yurt_0", "!3.14.7@yurt_1"],
    numpy: ["2.5.0@yurt_0", "2.5.0@yurt_1"],
    pyzmq: ["26.4.0@yurt_0", "26.4.0@yurt_1"],
    "jupyter-kernel": ["0.0.1@yurt_0", "0.0.1@yurt_1"],
  });
  assertEquals(resolveSet(catalog, SET)[0].build, "yurt_0");
  assertThrows(
    () =>
      resolveSet(
        catalogOf({
          python: ["3.14.7@yurt_1"],
          numpy: ["2.5.0@yurt_0"],
          pyzmq: ["26.4.0@yurt_0"],
          "jupyter-kernel": ["0.0.1@yurt_0"],
        }),
        SET,
      ),
    Error,
    "no complete set",
  );
});

Deno.test("a set member the page cannot fetch takes its set out", () => {
  const catalog = catalogOf({
    python: ["3.14.7@yurt_0", "3.14.7@yurt_1"],
    numpy: ["2.5.0@yurt_0", "2.5.0@yurt_1"],
    pyzmq: ["26.4.0@yurt_0", "26.4.0@yurt_1"],
    "jupyter-kernel": ["0.0.1@yurt_0", "0.0.1@yurt_1"],
  });
  catalog.metadata.get("numpy")!.file.versions[1].url =
    "https://elsewhere.example/numpy.yurtpkg";
  const set = resolveSet(catalog, SET);
  assertEquals(set.map((r) => r.build), [
    "yurt_0",
    "yurt_0",
    "yurt_0",
    "yurt_0",
  ]);
  assertEquals(
    set[0].url,
    catalog.metadata.get("python")!.file.versions[0].url,
  );
});

Deno.test("a set's install keeps only its own cache entries", async () => {
  const archive = new Uint8Array([3, 1, 4]);
  const fetcher = await fakeRepo(archive);
  const { cache, store } = memoryCache({
    "sha256:old": new Uint8Array([1]),
    "sha256:old.bundle": new Uint8Array([1]),
  });
  const { host, runs } = fakeHost(PLAN, INSTALLED);
  await installPackage({ label: "Greet", set: ["greet"] }, {
    host,
    tablet: false,
    fetcher,
    cache,
    progress: () => {},
  });
  assertEquals(
    runs[0].script,
    installScript(["greet@0.1.0-yurt_0"], "official"),
  );
  assertEquals(
    [...store.keys()].sort(),
    [await key(archive), `${await key(archive)}.bundle`].sort(),
  );
});

Deno.test("a set's install lets pkg add a dependency outside the set; a pinned list does not", async () => {
  const archive = new Uint8Array([5, 5]);
  const base = await fakeRepo(archive);
  const enc = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  const depArchive = new Uint8Array([6]);
  const depUrl = "artifacts/libx/1.0.0/libx-1.0.0-yurt_0.yurtpkg";
  const libx = enc({
    name: "libx",
    versions: [version("1.0.0", "yurt_0", {
      url: depUrl,
      size: 1,
      sha256: await sha256Hex(depArchive),
    })],
  });
  const fetcher = async (url: string) => {
    const path = url.slice(PACKAGE_REPO_URL.length);
    if (path === "packages/libx.json") return libx;
    if (path === depUrl) return depArchive;
    if (path === `${depUrl}.bundle`) return enc("bundle");
    const bytes = await base(url);
    if (path !== "index.json") return bytes;
    const index = JSON.parse(new TextDecoder().decode(bytes));
    index.packages.libx = { sha256: "", size: 1, url: "packages/libx.json" };
    return enc(index);
  };
  const plan = {
    ...PLAN,
    stdout: "install libx 1.0.0-yurt_0\ninstall greet 0.1.0-yurt_0\n",
  };
  const { host, runs } = fakeHost(plan, INSTALLED);
  const messages: string[] = [];
  await installPackage({ label: "Greet", set: ["greet"] }, {
    host,
    tablet: false,
    fetcher,
    progress: (m) => messages.push(m),
  });
  // The dependency is named, with its size, before anything downloads.
  const also = messages.indexOf("Greet: also installs libx (1 B)");
  assertEquals(
    also > 0 && also < messages.findIndex((m) => m.includes("downloading")),
    true,
  );
  // Its download says it is one, so the line that stays says so too.
  assertEquals(
    messages.some((m) =>
      m.startsWith("Greet: downloading libx (a dependency) ")
    ),
    true,
  );
  assertEquals(
    messages.some((m) => m.startsWith("Greet: downloading greet (")),
    false,
  );
  assertEquals(
    runs[1].files.some((f) => f.path.endsWith("libx-1.0.0-yurt_0.yurtpkg")),
    true,
  );
});

Deno.test("a pinned list that must verify all: others allowed, no plan may skip a pin", async () => {
  const archive = new Uint8Array([5, 5]);
  const base = await fakeRepo(archive);
  const enc = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  const depArchive = new Uint8Array([6]);
  const depUrl = "artifacts/libx/1.0.0/libx-1.0.0-yurt_0.yurtpkg";
  const libx = enc({
    name: "libx",
    versions: [version("1.0.0", "yurt_0", {
      url: depUrl,
      size: 1,
      sha256: await sha256Hex(depArchive),
    })],
  });
  const fetcher = async (url: string) => {
    const path = url.slice(PACKAGE_REPO_URL.length);
    if (path === "packages/libx.json") return libx;
    if (path === depUrl) return depArchive;
    if (path === `${depUrl}.bundle`) return enc("bundle");
    const bytes = await base(url);
    if (path !== "index.json") return bytes;
    const index = JSON.parse(new TextDecoder().decode(bytes));
    index.packages.libx = { sha256: "", size: 1, url: "packages/libx.json" };
    return enc(index);
  };
  const pin = {
    name: "greet",
    version: "0.1.0",
    build: "yurt_0",
    sha256: await sha256Hex(archive),
    size: archive.byteLength,
  };
  const request = {
    label: "Greet",
    releases: [pin],
    othersAllowed: true,
    verifyAll: true,
  };
  const options = (host: PackageHost) => ({
    host,
    tablet: false,
    fetcher,
    progress: () => {},
  });
  // pkg adds a dependency the page does not pin: allowed, and kept in
  // the cache with the pins; the set before is dropped.
  const { host, runs } = fakeHost({
    ...PLAN,
    stdout: "install libx 1.0.0-yurt_0\ninstall greet 0.1.0-yurt_0\n",
  }, INSTALLED);
  const { cache, store } = memoryCache({
    "sha256:old": new Uint8Array([1]),
    "sha256:old.bundle": new Uint8Array([1]),
  });
  await installPackage(request, { ...options(host), cache });
  assertEquals(
    runs[1].files.some((f) => f.path.endsWith("libx-1.0.0-yurt_0.yurtpkg")),
    true,
  );
  assertEquals(
    [...store.keys()].sort(),
    [
      await key(archive),
      `${await key(archive)}.bundle`,
      await key(depArchive),
      `${await key(depArchive)}.bundle`,
    ].sort(),
  );
  // A run that installs nothing verified nothing.
  const { host: done } = fakeHost({
    code: 0,
    stdout: "nothing to install\n",
    stderr: "",
  });
  await assertRejects(
    () => installPackage(request, options(done)),
    Error,
    "Greet: pkg verified nothing: greet@0.1.0-yurt_0 is already installed",
  );
  // A planning run pkg refused names pkg's cause, not the pins.
  const { host: refused } = fakeHost({
    code: 1,
    stdout: "",
    stderr: "Error: index signature verification failed\n",
  });
  await assertRejects(
    () => installPackage(request, options(refused)),
    Error,
    "pkg install Greet failed: Error: index signature verification failed",
  );
  // A plan that leaves a pin out would not verify it.
  const { host: partial } = fakeHost({
    ...PLAN,
    stdout: "install libx 1.0.0-yurt_0\n",
  });
  await assertRejects(
    () => installPackage(request, options(partial)),
    Error,
    "Greet: pkg's plan does not fetch greet@0.1.0-yurt_0, so it would not verify them",
  );
});

Deno.test("a checked catalog refuses metadata the index does not name, and an expired index", async () => {
  const fetcher = await fakeRepo(new Uint8Array([1]));
  // fakeRepo's index names each metadata file's real sha256.
  await loadCatalog(fetcher, PACKAGE_REPO_URL, true, new Date("2026-10-27"));
  const tampered = async (url: string) => {
    const bytes = await fetcher(url);
    if (!url.endsWith("packages/greet.json")) return bytes;
    const file = JSON.parse(new TextDecoder().decode(bytes));
    file.versions[0].sha256 = "0".repeat(64);
    return new TextEncoder().encode(JSON.stringify(file));
  };
  await assertRejects(
    () => loadCatalog(tampered, PACKAGE_REPO_URL, true),
    Error,
    "does not match the index's sha256",
  );
  // Unchecked, as for an install the guest's pkg verifies: accepted.
  await loadCatalog(tampered);
  // fakeRepo's index expires 2099-01-01; 30 days' grace past it, no more.
  await loadCatalog(fetcher, PACKAGE_REPO_URL, true, new Date("2099-01-30"));
  await assertRejects(
    () => loadCatalog(fetcher, PACKAGE_REPO_URL, true, new Date("2099-02-01")),
    Error,
    "expired",
  );
});

Deno.test("markInstalled marks the known packages Installed, disabled, and the rest Install", () => {
  const button = (name: string) => ({
    dataset: { package: name } as { package?: string },
    textContent: "Install" as string | null,
    disabled: false,
  });
  const buttons = [button("git"), button("rtk"), button("numpy")];
  markInstalled(buttons, new Set(["numpy", "git"]), false);
  assertEquals(
    buttons.map((b) => [b.dataset.package, b.textContent, b.disabled]),
    [["git", "Installed", true], ["rtk", "Install", false], [
      "numpy",
      "Installed",
      true,
    ]],
  );
  // While an install runs, none can be clicked; what is installed stays so.
  markInstalled(buttons, new Set(["numpy", "git", "rtk"]), true);
  assertEquals(
    buttons.map((b) => [b.textContent, b.disabled]),
    [["Installed", true], ["Installed", true], ["Installed", true]],
  );
  markInstalled(buttons, new Set(), true);
  assertEquals(buttons.map((b) => [b.textContent, b.disabled]), [
    ["Install", true],
    ["Install", true],
    ["Install", true],
  ]);
});

Deno.test("plannedInstalls is the package and what pkg's plan installed with it", () => {
  assertEquals(
    plannedInstalls(
      "install libx 1.0.0-yurt_0\ninstall greet 0.1.0-yurt_0\n",
      "greet",
    ),
    ["libx", "greet"],
  );
  // Already there: no plan, but it is installed.
  assertEquals(plannedInstalls("nothing to install\n", "greet"), ["greet"]);
  // Only pkg's own plan lines, anchored.
  assertEquals(
    plannedInstalls("will install foo next\n  install bar 1\n", "greet"),
    ["greet"],
  );
});

Deno.test("a set's install says which releases its own index read resolved to", async () => {
  const fetcher = await fakeRepo(new Uint8Array([3, 1, 4]));
  const { host } = fakeHost(PLAN, INSTALLED);
  const resolved: string[][] = [];
  await installPackage({ label: "Greet", set: ["greet"] }, {
    host,
    tablet: false,
    fetcher,
    cache: memoryCache({}).cache,
    progress: () => {},
    resolved: (releases) =>
      resolved.push(releases.map((r) => `${r.name}@${r.version}-${r.build}`)),
  });
  assertEquals(resolved, [["greet@0.1.0-yurt_0"]]);
});

Deno.test("the run ceiling leaves a slowed tab's run room: twenty minutes", () => {
  // Hidden desktop Safari ran Python's install run in 538 s, past the old
  // five minutes, while pkg was still working; the no-progress check
  // stays the fast guard against a sandbox that stopped.
  assertEquals(INSTALL_RUN_CEILING_MS, 20 * 60_000);
  assertEquals(INSTALL_STALL_MS, 60_000);
});

/** `watchedHost`, with pkg's recovery answering `recover` (or hanging). */
function recoveringHost(
  runs: Parameters<typeof watchedHost>[0],
  recover:
    | { code: number; stdout: string; stderr: string }
    | "hang"
    // Beats every `everyMs`, `beats` times (or forever), then answers.
    | { beats: number; everyMs: number; result: typeof PLAN },
) {
  const watched = watchedHost(runs);
  const events: string[] = [];
  const host: PackageHost = {
    ...watched.host,
    stageAndRun: (files, script, watch) => {
      events.push("run");
      watch?.signal.addEventListener("abort", () => events.push("abort"));
      return watched.host.stageAndRun(files, script, watch);
    },
    recover: (watch) => {
      events.push("recover");
      if (recover !== "hang" && "code" in recover) {
        return Promise.resolve(recover);
      }
      return new Promise((resolve, reject) => {
        let beaten = 0;
        const timer = recover === "hang" ? undefined : setInterval(() => {
          if (beaten++ < recover.beats) return watch.alive();
          clearInterval(timer);
          resolve(recover.result);
        }, recover.everyMs);
        watch.signal.addEventListener("abort", () => {
          clearInterval(timer);
          reject(new Error("stopped watching"));
        });
      });
    },
  };
  return { host, events };
}

Deno.test("a run past the ceiling, still beating, runs no recovery: it would wait on pkg's lock", async () => {
  // The run's pkg is alive and holds pkg's lock; pkg recover would wait
  // for it, beating, for another whole ceiling.
  const fetcher = await fakeRepo(new Uint8Array([1, 2, 3]));
  const { host, events } = recoveringHost([
    { beats: 0, everyMs: 5, result: PLAN },
    { beats: 100, everyMs: 10, result: INSTALLED },
  ], { code: 0, stdout: "", stderr: "" });
  const error = await assertRejects(
    () =>
      installPackage("greet", {
        host,
        tablet: false,
        fetcher,
        progress: () => {},
        stallMs: 100,
        runCeilingMs: 300,
      }),
    InstallStalled,
  );
  assertEquals(events.includes("recover"), false);
  assertEquals(error.ceiling, true);
  assertEquals(error.recovered, false);
  assertStringIncludes(error.message, "did not finish it in 0 s");
  assertStringIncludes(error.message, "holds pkg's lock");
  // It says recovery was not run, not that it ran and failed.
  assertStringIncludes(error.message, "pkg recover was not run");
  assertEquals(error.recoveryRan, false);
  assertStringIncludes(stalledSandboxWhy(error), "past its time limit");
  assertStringIncludes(error.message, "reload the page");
});

const HUNG_RUN = [
  { beats: 0, everyMs: 5, result: PLAN },
  { beats: Infinity, everyMs: 5, result: INSTALLED },
];

Deno.test("a sandbox thrown away after the install runs no recovery after a stall", async () => {
  // The Suspend/Resume check's sandbox goes when the check ends: there is
  // nothing to recover, and nothing for a reload to fix.
  const fetcher = await fakeRepo(new Uint8Array([1, 2, 3]));
  const { host, events } = recoveringHost(HUNG_RUN, {
    code: 0,
    stdout: "",
    stderr: "",
  });
  const error = await assertRejects(
    () =>
      installPackage("greet", {
        host,
        tablet: false,
        fetcher,
        progress: () => {},
        stallMs: 100,
        recoverAfterStall: false,
      }),
    InstallStalled,
  );
  assertEquals(events.includes("recover"), false);
  assertEquals(error.recovered, undefined);
  assertEquals(
    error.message,
    "greet: the install stopped making progress (the sandbox's pkg did nothing for 0 s)",
  );
});

Deno.test("a recovery killed by a signal, saying nothing, says so", async () => {
  const fetcher = await fakeRepo(new Uint8Array([1, 2, 3]));
  const { host } = recoveringHost(HUNG_RUN, {
    code: null as unknown as number,
    stdout: "",
    stderr: "",
  });
  const error = await assertRejects(
    () =>
      installPackage("greet", {
        host,
        tablet: false,
        fetcher,
        progress: () => {},
        stallMs: 100,
      }),
    InstallStalled,
  );
  assertEquals(error.recovered, false);
  assertStringIncludes(error.message, "(it was killed by a signal)");
});

Deno.test("after the page gives up on a pkg run, pkg recover runs before the failure is said", async () => {
  const fetcher = await fakeRepo(new Uint8Array([1, 2, 3]));
  const { host, events } = recoveringHost(HUNG_RUN, {
    code: 0,
    stdout: "",
    stderr: "",
  });
  const messages: string[] = [];
  const error = await assertRejects(
    () =>
      installPackage("greet", {
        host,
        tablet: false,
        fetcher,
        progress: (m) => messages.push(m),
        stallMs: 100,
      }),
    InstallStalled,
  );
  // The run is given up on (every run's listener hears it), then pkg
  // recover runs, then the failure is said.
  assertEquals(events.filter((e) => e !== "abort"), ["run", "run", "recover"]);
  assertEquals(events.indexOf("abort") < events.indexOf("recover"), true);
  assertEquals(error.inSandbox, true);
  assertEquals(error.recovered, true);
  assertStringIncludes(error.message, "pkg recover");
  // Recovery speaks for pkg's transactions only: the install itself did
  // not complete.
  assertStringIncludes(error.message, "the install did not complete");
  assertStringIncludes(messages.at(-1)!, "pkg recover");
});

Deno.test("a recovery that fails or stops making progress says the sandbox needs a reload", async () => {
  for (
    const recover of [
      { code: 1, stdout: "", stderr: "recovery incomplete" },
      "hang" as const,
    ]
  ) {
    const fetcher = await fakeRepo(new Uint8Array([1, 2, 3]));
    const { host, events } = recoveringHost(HUNG_RUN, recover);
    const error = await assertRejects(
      () =>
        installPackage("greet", {
          host,
          tablet: false,
          fetcher,
          progress: () => {},
          stallMs: 100,
        }),
      InstallStalled,
    );
    assertEquals(events.at(-1), "recover", JSON.stringify(recover));
    assertEquals(error.recovered, false);
    assertStringIncludes(error.message, "half-installed");
    assertStringIncludes(error.message, "reload the page");
  }
});

Deno.test("a download that stalls runs no recovery: pkg never started", async () => {
  const archive = new Uint8Array([1, 2, 3]);
  const repo = await fakeRepo(archive);
  const fetcher: Fetcher = (url) =>
    url.endsWith(".yurtpkg")
      ? new Promise((resolve) => setTimeout(() => resolve(repo(url)), 300))
      : repo(url);
  const { host, events } = recoveringHost([
    { beats: 0, everyMs: 5, result: PLAN },
  ], { code: 0, stdout: "", stderr: "" });
  const error = await assertRejects(
    () =>
      installPackage("greet", {
        host,
        tablet: false,
        fetcher,
        progress: () => {},
        stallMs: 100,
      }),
    InstallStalled,
  );
  assertEquals(error.inSandbox, false);
  assertEquals(events.includes("recover"), false);
  await new Promise((resolve) => setTimeout(resolve, 400));
});

Deno.test("a sandbox whose stalled install pkg could not recover says a package may be half installed", () => {
  const stall = new InstallStalled("greet", 60_000, true);
  assertStringIncludes(
    stalledSandboxWhy(stall.withRecovery(false, "exit 1")),
    "half installed",
  );
  assertEquals(
    stalledSandboxWhy(stall.withRecovery(false, "cannot", false)),
    "an earlier install stopped part way, so a package may be half installed",
  );
  assertEquals(
    stalledSandboxWhy(stall.withRecovery(true)),
    "an earlier install stopped making progress",
  );
});

Deno.test("a live recovery keeps telling the page it is still going", async () => {
  // The page's own silence deadline (src/install_request.ts) must not fire
  // while pkg recover waits on a lock, beating.
  const fetcher = await fakeRepo(new Uint8Array([1, 2, 3]));
  const { host } = recoveringHost(HUNG_RUN, {
    beats: 20,
    everyMs: 20,
    result: { code: 0, stdout: "", stderr: "" },
  });
  const messages: string[] = [];
  const error = await assertRejects(
    () =>
      installPackage("greet", {
        host,
        tablet: false,
        fetcher,
        progress: (m) => messages.push(m),
        stallMs: 100,
        progressEveryMs: 100,
      }),
    InstallStalled,
  );
  assertEquals(error.recovered, true);
  const ticks = messages.filter((m) =>
    /^greet: running pkg recover after the stopped install \(\d+ s\)$/.test(m)
  );
  assertEquals(ticks.length >= 2, true, JSON.stringify(messages));
});

Deno.test("a recovery that keeps beating past the ceiling is given up on", async () => {
  // A pkg recover alive but blocked keeps the heartbeat going; the run
  // ceiling ends it too. It does answer, much later (3 s): a missing
  // ceiling then says it recovered, rather than hanging the test.
  const fetcher = await fakeRepo(new Uint8Array([1, 2, 3]));
  const { host } = recoveringHost(HUNG_RUN, {
    beats: 300,
    everyMs: 10,
    result: { code: 0, stdout: "", stderr: "" },
  });
  const started = Date.now();
  const error = await assertRejects(
    () =>
      installPackage("greet", {
        host,
        tablet: false,
        fetcher,
        progress: () => {},
        stallMs: 100,
        runCeilingMs: 300,
      }),
    InstallStalled,
  );
  assertEquals(error.recovered, false);
  assertStringIncludes(error.message, "it did not finish in 0 s");
  assertEquals(Date.now() - started < 3000, true);
});

/** The slim image's python, from pkg's installed list: pkg never replaces
 * an installed package, so the set must be the one with this build. */
const SLIM_PYTHON = { name: "python", version: "3.14.7", build: "yurt_0" };

Deno.test("an installed python pins the set to its own build, even with a newer set live", () => {
  const catalog = catalogOf({
    python: ["3.14.7@yurt_0", "3.14.7@yurt_1"],
    numpy: ["2.5.0@yurt_0", "2.5.0@yurt_1"],
    pyzmq: ["26.4.0@yurt_0", "26.4.0@yurt_1"],
    "jupyter-kernel": ["0.0.1@yurt_0", "0.0.1@yurt_1"],
  });
  assertEquals(
    resolveSet(catalog, SET, [SLIM_PYTHON]).map((r) =>
      `${r.name}@${r.version}-${r.build}`
    ),
    [
      "python@3.14.7-yurt_0",
      "numpy@2.5.0-yurt_0",
      "pyzmq@26.4.0-yurt_0",
      "jupyter-kernel@0.0.1-yurt_0",
    ],
  );
  // What is installed outside the set pins nothing; with no python, the
  // newest set, as before.
  for (
    const installed of [
      [],
      [{ name: "git", version: "2.55.0", build: "yurt_0" }],
      undefined,
    ]
  ) {
    assertEquals(
      resolveSet(catalog, SET, installed).map((r) => r.build),
      ["yurt_1", "yurt_1", "yurt_1", "yurt_1"],
    );
  }
});

Deno.test("an installed python with no complete set at its build is a clear failure", () => {
  // Only yurt_1 is live: the set was republished and yurt_0's withdrawn.
  const newer = catalogOf({
    python: ["3.14.7@yurt_1"],
    numpy: ["2.5.0@yurt_0", "2.5.0@yurt_1"],
    pyzmq: ["26.4.0@yurt_1"],
    "jupyter-kernel": ["0.0.1@yurt_1"],
  });
  const error = assertThrows(
    () => resolveSet(newer, SET, [SLIM_PYTHON]),
    SetNotOffered,
  );
  assertStringIncludes(error.message, "python 3.14.7-yurt_0");
  assertStringIncludes(error.message, "installed");
  // The build is live, but not that python's version.
  assertThrows(
    () =>
      resolveSet(
        catalogOf({
          python: ["3.14.8@yurt_0"],
          numpy: ["2.5.0@yurt_0"],
          pyzmq: ["26.4.0@yurt_0"],
          "jupyter-kernel": ["0.0.1@yurt_0"],
        }),
        SET,
        [SLIM_PYTHON],
      ),
    SetNotOffered,
    "python 3.14.7-yurt_0",
  );
  // Two installed members of different builds: no set has both.
  assertThrows(
    () =>
      resolveSet(newer, SET, [SLIM_PYTHON, {
        name: "numpy",
        version: "2.5.0",
        build: "yurt_1",
      }]),
    SetNotOffered,
  );
});

Deno.test("a set's install asks pkg only for what is not installed, and says the whole set", async () => {
  const archive = new Uint8Array([5, 5]);
  const base = await fakeRepo(archive);
  const enc = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  const libx = enc({
    name: "libx",
    versions: [
      version("1.0.0", "yurt_0"),
      version("1.0.0", "yurt_1"),
    ],
  });
  const fetcher = async (url: string) => {
    const path = url.slice(PACKAGE_REPO_URL.length);
    if (path === "packages/libx.json") return libx;
    const bytes = await base(url);
    if (path !== "index.json") return bytes;
    const index = JSON.parse(new TextDecoder().decode(bytes));
    index.packages.libx = { sha256: "", size: 1, url: "packages/libx.json" };
    return enc(index);
  };
  const { host, runs } = fakeHost(PLAN, INSTALLED);
  let resolved: string[] = [];
  await installPackage(
    {
      label: "Set",
      set: ["libx", "greet"],
      installed: [{ name: "libx", version: "1.0.0", build: "yurt_0" }],
    },
    {
      host,
      tablet: false,
      fetcher,
      progress: () => {},
      resolved: (releases) => {
        resolved = releases.map((r) => `${r.name}@${r.version}-${r.build}`);
      },
    },
  );
  assertEquals(
    runs[0].script,
    installScript(["greet@0.1.0-yurt_0"], "official"),
  );
  assertEquals(resolved, ["libx@1.0.0-yurt_0", "greet@0.1.0-yurt_0"]);
});

Deno.test("a verify-all list with nothing to verify is refused before pkg runs, never passed as verified", async () => {
  const fetcher = await fakeRepo(new Uint8Array([1, 2, 3]));
  const { host, runs } = fakeHost(PLAN, INSTALLED);
  await assertRejects(
    () =>
      installPackage({ label: "Seal", releases: [], verifyAll: true }, {
        host,
        tablet: false,
        fetcher,
        progress: () => {},
      }),
    Error,
    "not a package name: []",
  );
  assertEquals(runs.length, 0);
});
