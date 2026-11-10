// What the site serves for the Playwright demo (src/playwright_demo.ts):
// playwright-core as an npm-style tarball, packed from the playground's own
// pinned copy (deno.json), and the Yurt browser bridge extension (extension/)
// as a zip to load unpacked. The build writes both into dist/; the dev
// server makes them on first request.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRIDGE_ZIP, PLAYWRIGHT_CORE_TGZ } from "./playwright_setup.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

export { PLAYWRIGHT_CORE_TGZ };
export const BRIDGE_EXTENSION_ZIP = BRIDGE_ZIP;

/** The version deno.json pins (`npm:playwright@X`); playwright-core is
 *  the same version. */
export async function pinnedPlaywrightVersion(): Promise<string> {
  const deno = JSON.parse(await Deno.readTextFile(join(root, "deno.json")));
  const match = String(deno.imports.playwright).match(/@(\d+\.\d+\.\d+)$/);
  if (match === null) throw new Error("deno.json pins no playwright version");
  return match[1];
}

async function run(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
) {
  const { success, stdout, stderr } = await new Deno.Command(cmd, {
    args,
    cwd,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!success) {
    throw new Error(
      `${cmd} ${args.join(" ")}: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return stdout;
}

/** playwright-core as `package/...` in a gzipped tar, the way npm packs it. */
export async function playwrightCoreTarball(): Promise<Uint8Array> {
  const version = await pinnedPlaywrightVersion();
  const dir = join(
    root,
    "node_modules/.deno",
    `playwright-core@${version}`,
    "node_modules",
  );
  // A build that resolved nothing from npm yet (release-desktop's) has no
  // node_modules/.deno: install the deno.json dependencies first.
  const present = () =>
    Deno.stat(join(dir, "playwright-core/package.json")).then(
      () => true,
      () => false,
    );
  if (!(await present())) {
    await run(Deno.execPath(), ["install"], root);
    if (!(await present())) {
      throw new Error(
        `no playwright-core ${version} in ${dir} after deno install`,
      );
    }
  }
  // BSD tar (macOS) renames with -s, GNU tar (Linux) with --transform.
  const rename = Deno.build.os === "darwin"
    ? ["-s", "/^playwright-core/package/"]
    : ["--transform", "s,^playwright-core,package,"];
  return await run("tar", ["-czf", "-", ...rename, "playwright-core"], dir, {
    // BSD tar would add AppleDouble ._ files for extended attributes.
    COPYFILE_DISABLE: "1",
  });
}

/** extension/ zipped, to load unpacked from chrome://extensions. */
export async function bridgeExtensionZip(): Promise<Uint8Array> {
  return await run("zip", ["-q", "-r", "-", "."], join(root, "extension"));
}
