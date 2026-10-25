import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  browserTrustedRepos,
  CACHE_ROOT,
  fetchWithProgress,
  installPackage,
  installScript,
  latestRelease,
  loadCatalog,
  PACKAGE_REPO_URL,
  type PackageFile,
  type PackageHost,
  type PackageVersion,
  parseIndex,
  parsePackageFile,
  sha256Hex,
  sizeRefusal,
  type StagedFile,
  STAGING_DIR,
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
  const script = installScript(STAGING_DIR, "zsh", "official");
  const lines = script.split("\n");
  assertEquals(lines[0], `cleanup() { sudo rm -rf '${STAGING_DIR}'; }`);
  assertEquals(lines[1], "trap cleanup EXIT");
  assertEquals(
    lines.filter((line) => line.includes("sudo pkg --etc-root")),
    [
      `  sudo pkg --etc-root '${STAGING_DIR}/etc' --cache-root '${CACHE_ROOT}' update || exit 1`,
      `sudo pkg --etc-root '${STAGING_DIR}/etc' --cache-root '${CACHE_ROOT}' install 'zsh'`,
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
  const host: PackageHost = {
    readFile: () => Promise.resolve(new TextEncoder().encode(TRUSTED)),
    stageAndRun: (files, script, dir) => {
      runs.push({ files, script, dir });
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
    assertEquals(script, installScript(dir, "greet", "official"));
  }
  assertEquals(
    messages.at(-1),
    "greet: verifying and installing (pkg install greet)",
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
