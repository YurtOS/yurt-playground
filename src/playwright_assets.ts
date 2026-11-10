// What the site serves for the Playwright demo (src/playwright_demo.ts):
// playwright-core as an npm-style tarball, packed from the playground's own
// pinned copy (deno.json), and the Yurt browser bridge extension (extension/)
// as a zip to load unpacked. The build writes both into dist/; the dev
// server makes them on first request.
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

export const PLAYWRIGHT_CORE_TGZ = "playwright-core.tgz";
export const BRIDGE_EXTENSION_ZIP = "yurt-browser-bridge.zip";

/** The version deno.json pins (`npm:playwright@X`); playwright-core is
 *  the same version. */
export async function pinnedPlaywrightVersion(): Promise<string> {
  const deno = JSON.parse(await Deno.readTextFile(join(root, "deno.json")));
  const match = String(deno.imports.playwright).match(/@(\d+\.\d+\.\d+)$/);
  if (match === null) throw new Error("deno.json pins no playwright version");
  return match[1];
}

async function run(cmd: string, args: string[], cwd: string) {
  const { success, stdout, stderr } = await new Deno.Command(cmd, {
    args,
    cwd,
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
  await Deno.stat(join(dir, "playwright-core/package.json")).catch(() => {
    throw new Error(
      `no playwright-core ${version} in ${dir}: run deno install`,
    );
  });
  return await run("tar", [
    "-czf",
    "-",
    "-s",
    "/^playwright-core/package/",
    "playwright-core",
  ], dir).catch(() =>
    // GNU tar has no -s: --transform does the same.
    run("tar", [
      "-czf",
      "-",
      "--transform",
      "s,^playwright-core,package,",
      "playwright-core",
    ], dir)
  );
}

/** extension/ zipped, to load unpacked from chrome://extensions. */
export async function bridgeExtensionZip(): Promise<Uint8Array> {
  return await run("zip", ["-q", "-r", "-", "."], join(root, "extension"));
}
