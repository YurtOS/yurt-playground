import { assert, assertEquals, assertRejects } from "@std/assert";
import { canonicalTreeTar } from "../scripts/canonical-tree-tar.ts";

async function withTempDir<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "canonical-tree-tar-" });
  try {
    return await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("canonical tree tar is stable and includes normalized entries", async () => {
  await withTempDir(async (root) => {
    await Deno.mkdir(`${root}/pkg`);
    await Deno.writeTextFile(`${root}/pkg/value.py`, "1+1\n");
    const first = await canonicalTreeTar(root);
    const second = await canonicalTreeTar(root);
    assertEquals(first, second);
    assert(first.length % 512 === 0);
    assert(first.includes(118)); // the `v` in value.py
  });
});

Deno.test("canonical tree tar uses the deterministic USTAR prefix split", async () => {
  await withTempDir(async (root) => {
    const prefix = "a".repeat(70);
    const name = "b".repeat(40);
    await Deno.mkdir(`${root}/${prefix}`, { recursive: true });
    await Deno.writeTextFile(`${root}/${prefix}/${name}`, "x");
    const tar = await canonicalTreeTar(root);
    const encoded = new TextDecoder().decode(tar);
    assert(encoded.includes(prefix));
    assert(encoded.includes(name));
  });
});

Deno.test("canonical tree tar preserves symlinks and rejects long targets", async () => {
  await withTempDir(async (root) => {
    await Deno.writeTextFile(`${root}/target`, "x");
    await Deno.symlink("target", `${root}/link`);
    const tar = await canonicalTreeTar(root);
    assertEquals(tar[156], 50);
    await Deno.remove(`${root}/link`);
    await Deno.symlink("x".repeat(101), `${root}/link`);
    await assertRejects(
      () => canonicalTreeTar(root),
      Error,
      "target",
    );
  });
});
