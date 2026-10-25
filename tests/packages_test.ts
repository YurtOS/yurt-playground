import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  browserTrustedRepos,
  CACHE_ROOT,
  installClosure,
  installPackage,
  installScript,
  latestRelease,
  PACKAGE_REPO_URL,
  type PackageFile,
  type PackageHost,
  type PackageVersion,
  parseIndex,
  parsePackageFile,
  type RepoIndex,
  satisfies,
  sha256Hex,
  sizeRefusal,
  type StagedFile,
  STAGING_ROOT,
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

Deno.test("the release pkg picks: highest version, then build, never yanked", () => {
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

Deno.test("requirements read as the semver crate reads them", () => {
  const cases: [string, string, boolean][] = [
    ["6.5.0", "^6.5", true],
    ["6.9.1", "^6.5", true],
    ["7.0.0", "^6.5", false],
    ["6.4.9", "^6.5", false],
    ["0.2.9", "^0.2.3", true],
    ["0.3.0", "^0.2.3", false],
    ["0.0.4", "^0.0.3", false],
    ["1.2.9", "~1.2.3", true],
    ["1.3.0", "~1.2.3", false],
    ["1.9.0", "~1", true],
    ["1.2.3", "=1.2.3", true],
    ["1.2.4", "=1.2.3", false],
    ["1.2.7", "=1.2", true],
    ["1.3.0", ">1.2", true],
    ["1.2.9", ">1.2", false],
    ["1.2.9", "<=1.2", true],
    ["1.3.0", "<=1.2", false],
    ["2.0.0", ">=1.5, <2", false],
    ["1.7.0", ">=1.5, <2", true],
    ["9.9.9", "*", true],
    ["1.4.0", "1.*", true],
    ["2.0.0", "1.*", false],
    ["2.0.0", "2", true],
    ["2.0.0-rc.1", "^2.0.0", false],
  ];
  for (const [version, req, want] of cases) {
    assertEquals(satisfies(version, req), want, `${version} ${req}`);
  }
});

Deno.test("a dependency's release meets its requirement, not merely the latest", async () => {
  const files: Record<string, PackageFile> = {
    app: {
      name: "app",
      versions: [version("1.0.0", "yurt_0", {
        depends: [{ name: "lib", req: "^1.2" }],
      })],
    },
    lib: {
      name: "lib",
      versions: [version("1.4.0", "yurt_0"), version("2.0.0", "yurt_0")],
    },
  };
  const index = {
    schema: 1,
    index_version: 1,
    expires_at: "",
    packages: {
      app: { sha256: "", size: 1, url: "packages/app.json" },
      lib: { sha256: "", size: 1, url: "packages/lib.json" },
    },
  } satisfies RepoIndex;
  const closure = await installClosure(
    index,
    "app",
    (name) => Promise.resolve(files[name]),
  );
  assertEquals(
    closure.map((r) => `${r.name} ${r.version}`).sort(),
    ["app 1.0.0", "lib 1.4.0"],
  );
  files.app.versions[0].depends[0].req = "^3";
  await assertRejects(
    () => installClosure(index, "app", (name) => Promise.resolve(files[name])),
    Error,
    "lib has no release that is not yanked and meets ^3",
  );
});

Deno.test("an install stages the package and its dependencies, transitively", async () => {
  const files: Record<string, PackageFile> = {
    zsh: {
      name: "zsh",
      versions: [version("5.9.0", "yurt_1", {
        depends: [{ name: "ncurses", req: "^6.5" }],
      })],
    },
    ncurses: {
      name: "ncurses",
      versions: [version("6.5.0", "yurt_0", {
        depends: [{ name: "zlib", req: "^1" }],
      })],
    },
    zlib: { name: "zlib", versions: [version("1.3.1", "yurt_0")] },
    unrelated: { name: "unrelated", versions: [version("1.0.0", "yurt_0")] },
  };
  const index = {
    schema: 1,
    index_version: 1,
    expires_at: "",
    packages: Object.fromEntries(
      Object.keys(files).map((name) => [
        name,
        { sha256: "", size: 1, url: `packages/${name}.json` },
      ]),
    ),
  } satisfies RepoIndex;
  const closure = await installClosure(
    index,
    "zsh",
    (name) => Promise.resolve(files[name]),
  );
  assertEquals(closure.map((r) => r.name).sort(), ["ncurses", "zlib", "zsh"]);
  await assertRejects(
    () => installClosure(index, "nope", (name) => Promise.resolve(files[name])),
    Error,
    "no package named nope",
  );
  delete (index.packages as Record<string, unknown>).zlib;
  await assertRejects(
    () => installClosure(index, "zsh", (name) => Promise.resolve(files[name])),
    Error,
    "depends on zlib, which the repository does not publish",
  );
});

Deno.test("the install's trust config is the image's identity, pointed at the copy", () => {
  const derived = browserTrustedRepos(TRUSTED, "file:///var/cache/x/repo/");
  assertEquals(
    derived,
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
    assertThrows(
      () =>
        parsePackageFile(
          enc({ name: "x", versions: [version("1.0.0", "yurt_0", { url })] }),
        ),
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

Deno.test("pkg update runs once per index version; the copy is removed", () => {
  const script = installScript(`${STAGING_ROOT}/t`, "zsh", 17);
  const lines = script.split("\n");
  assertEquals(lines[0], `cleanup() { rm -rf '${STAGING_ROOT}/t'; }`);
  assertEquals(lines[1], "trap cleanup EXIT");
  assertEquals(
    lines.filter((line) => line.includes("pkg --etc-root")),
    [
      `  pkg --etc-root '${STAGING_ROOT}/t/etc' --cache-root '${CACHE_ROOT}' update || exit 1`,
      `pkg --etc-root '${STAGING_ROOT}/t/etc' --cache-root '${CACHE_ROOT}' install 'zsh'`,
    ],
  );
  assertEquals(
    lines.some((line) => line.includes("!= '17' ]; then")),
    true,
  );
});

/** A repository of one package, served from memory. */
async function fakeRepo(archive: Uint8Array) {
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

function fakeHost(
  result = { code: 0, stdout: "install greet 0.1.0-yurt_0\n", stderr: "" },
) {
  const runs: { files: StagedFile[]; script: string }[] = [];
  const host: PackageHost = {
    readFile: () => Promise.resolve(new TextEncoder().encode(TRUSTED)),
    stageAndRun: (files, script) => {
      runs.push({ files, script });
      return Promise.resolve(result);
    },
  };
  return { host, runs };
}

Deno.test("an install hands the guest the repository's files, unchanged, under one copy", async () => {
  const archive = new Uint8Array([1, 2, 3, 4, 5]);
  const fetcher = await fakeRepo(archive);
  const { host, runs } = fakeHost();
  const messages: string[] = [];
  const output = await installPackage("greet", {
    host,
    tablet: false,
    fetcher,
    progress: (m) => messages.push(m),
  });
  assertEquals(output, "install greet 0.1.0-yurt_0");
  assertEquals(runs.length, 1);
  const [{ files, script }] = runs;
  const dir = files[0].path.slice(0, files[0].path.indexOf("/repo/"));
  assertEquals(dir.startsWith(`${STAGING_ROOT}/`), true);
  const staged = Object.fromEntries(
    files.map((f) => [f.path.slice(dir.length + 1), f.bytes]),
  );
  assertEquals(Object.keys(staged).sort(), [
    "etc/yurt-pkg/trusted-repos.toml",
    "repo/artifacts/greet/0.1.0/greet-0.1.0-yurt_0.yurtpkg",
    "repo/artifacts/greet/0.1.0/greet-0.1.0-yurt_0.yurtpkg.bundle",
    "repo/index.json",
    "repo/index.json.bundle",
    "repo/packages/greet.json",
  ]);
  for (const [path, bytes] of Object.entries(staged)) {
    if (!path.startsWith("repo/")) continue;
    assertEquals(bytes, await fetcher(`${PACKAGE_REPO_URL}${path.slice(5)}`));
  }
  assertEquals(
    new TextDecoder().decode(staged["etc/yurt-pkg/trusted-repos.toml"])
      .includes(`url = "file://${dir}/repo/"`),
    true,
  );
  assertEquals(script, installScript(dir, "greet", 4));
  assertEquals(
    messages.at(-1),
    "greet: verifying and installing (pkg install greet)",
  );
});

Deno.test("a download that does not match the index is never handed over", async () => {
  const fetcher = await fakeRepo(new Uint8Array([1, 2, 3]));
  const corrupt = (url: string) =>
    url.endsWith(".yurtpkg")
      ? Promise.resolve(new Uint8Array([9, 9, 9]))
      : fetcher(url);
  const { host, runs } = fakeHost();
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
  assertEquals(runs.length, 0);
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
