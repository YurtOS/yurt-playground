import { kernelImportMap } from "../scripts/serve.ts";
/** Bundle test-only browser entries against the same pinned host as the site. */
export async function bundleFixture(
  entry: string,
  classic = false,
): Promise<Uint8Array<ArrayBuffer>> {
  const repo = new URL("../", import.meta.url);
  const dir = await Deno.makeTempDir({ prefix: "datasette-fixture-" });
  try {
    const config = JSON.parse(
      await Deno.readTextFile(new URL("deno.json", repo)),
    );
    const { imports } = kernelImportMap(
      Deno.env.get("YURT_KERNEL_ROOT") ?? "../yurtos-kernel",
    );
    const map = dir + "/imports.json", out = dir + "/entry.js";
    await Deno.writeTextFile(
      map,
      JSON.stringify({ imports: { ...config.imports, ...imports } }),
    );
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "bundle",
        "--import-map=" + map,
        new URL(entry, repo).pathname,
        "-o",
        out,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (result.code) throw new Error(new TextDecoder().decode(result.stderr));
    const source = await Deno.readTextFile(out);
    return new TextEncoder().encode(
      classic
        ? source.replaceAll("import.meta.url", "self.location.href")
        : source,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
