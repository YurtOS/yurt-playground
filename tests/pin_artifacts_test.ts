import { assertEquals, assertRejects } from "@std/assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PinResolutionError,
  type Pins,
  resolveArtifacts,
} from "../src/pins.ts";

const here = dirname(fileURLToPath(import.meta.url));

function pinsFor(kernelSha: string, imageSha: string): Pins {
  return {
    kernelWasm: {
      repo: "YurtOS/yurtos-kernel",
      rev: "abc",
      build: "scripts/build-kernel-wasm.sh",
      path: "target/kernel-wasm/release/yurt_kernel.wasm",
      sha256: kernelSha,
    },
    image: {
      repo: "YurtOS/yurt-ports",
      rev: "def",
      build: "ports/playground-image/scripts/package.sh",
      path: "ports/playground-image/build/dist/playground.yurtimg",
      sha256: imageSha,
    },
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "playground-pins-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("resolveArtifacts accepts matching blobs already in artifacts/", async () => {
  await withTempDir(async (dir) => {
    const artifactsDir = join(dir, "artifacts");
    await Deno.mkdir(artifactsDir);
    const kernel = new TextEncoder().encode("kernel-bytes");
    const image = new TextEncoder().encode("image-bytes");
    await Deno.writeFile(join(artifactsDir, "yurt_kernel.wasm"), kernel);
    await Deno.writeFile(join(artifactsDir, "playground.yurtimg"), image);
    const resolved = await resolveArtifacts({
      artifactsDir,
      pins: pinsFor(await sha256Hex(kernel), await sha256Hex(image)),
    });
    assertEquals(
      resolved.kernelWasmPath,
      join(artifactsDir, "yurt_kernel.wasm"),
    );
    assertEquals(resolved.imagePath, join(artifactsDir, "playground.yurtimg"));
    assertEquals(resolved.source, "artifacts");
  });
});

Deno.test("resolveArtifacts rejects a hash mismatch in artifacts/", async () => {
  await withTempDir(async (dir) => {
    const artifactsDir = join(dir, "artifacts");
    await Deno.mkdir(artifactsDir);
    await Deno.writeFile(
      join(artifactsDir, "yurt_kernel.wasm"),
      new TextEncoder().encode("kernel-bytes"),
    );
    await Deno.writeFile(
      join(artifactsDir, "playground.yurtimg"),
      new TextEncoder().encode("image-bytes"),
    );
    const err = await assertRejects(
      () =>
        resolveArtifacts({
          artifactsDir,
          pins: pinsFor("0".repeat(64), "1".repeat(64)),
        }),
      PinResolutionError,
    ) as PinResolutionError;
    assertEquals(err.exitCode, 1);
  });
});

Deno.test("resolveArtifacts copies from sibling checkouts and verifies", async () => {
  await withTempDir(async (dir) => {
    const artifactsDir = join(dir, "artifacts");
    const kernelRoot = join(dir, "kernel");
    const portsRoot = join(dir, "ports");
    const kernelSrc = join(
      kernelRoot,
      "target/kernel-wasm/release/yurt_kernel.wasm",
    );
    const imageSrc = join(
      portsRoot,
      "ports/playground-image/build/dist/playground.yurtimg",
    );
    await Deno.mkdir(dirname(kernelSrc), { recursive: true });
    await Deno.mkdir(dirname(imageSrc), { recursive: true });
    const kernel = new TextEncoder().encode("sibling-kernel");
    const image = new TextEncoder().encode("sibling-image");
    await Deno.writeFile(kernelSrc, kernel);
    await Deno.writeFile(imageSrc, image);

    const resolved = await resolveArtifacts({
      artifactsDir,
      pins: pinsFor(await sha256Hex(kernel), await sha256Hex(image)),
      kernelRoot,
      portsRoot,
    });
    assertEquals(resolved.source, "siblings");
    assertEquals(
      await Deno.readFile(resolved.kernelWasmPath),
      kernel,
    );
    assertEquals(await Deno.readFile(resolved.imagePath), image);
  });
});

Deno.test("resolveArtifacts fetches from pin URLs when siblings are absent", async () => {
  await withTempDir(async (dir) => {
    const artifactsDir = join(dir, "artifacts");
    const kernel = new TextEncoder().encode("url-kernel");
    const image = new TextEncoder().encode("url-image");
    const resolved = await resolveArtifacts({
      artifactsDir,
      pins: pinsFor(await sha256Hex(kernel), await sha256Hex(image)),
      kernelUrl: "https://example.test/yurt_kernel.wasm",
      imageUrl: "https://example.test/playground.yurtimg",
      fetchBytes: (url: string) => {
        if (url.endsWith("yurt_kernel.wasm")) return Promise.resolve(kernel);
        if (url.endsWith("playground.yurtimg")) return Promise.resolve(image);
        return Promise.reject(new Error(`unexpected url ${url}`));
      },
    });
    assertEquals(resolved.source, "urls");
    assertEquals(await Deno.readFile(resolved.kernelWasmPath), kernel);
    assertEquals(await Deno.readFile(resolved.imagePath), image);
  });
});

Deno.test("resolveArtifacts exits 2 when nothing matches the pin", async () => {
  await withTempDir(async (dir) => {
    const err = await assertRejects(
      () =>
        resolveArtifacts({
          artifactsDir: join(dir, "artifacts"),
          pins: pinsFor("0".repeat(64), "1".repeat(64)),
        }),
      PinResolutionError,
    ) as PinResolutionError;
    assertEquals(err.exitCode, 2);
    assertEquals(
      err.message.includes("artifacts/") &&
        err.message.includes("YURT_KERNEL_ROOT") &&
        err.message.includes("PLAYGROUND_KERNEL_WASM_URL"),
      true,
    );
  });
});

Deno.test("checked-in pins.json has the required pin fields", () => {
  const pins = JSON.parse(
    Deno.readTextFileSync(join(here, "../artifacts/pins.json")),
  ) as Pins;
  for (const pin of [pins.kernelWasm, pins.image]) {
    assertEquals(typeof pin.repo, "string");
    assertEquals(typeof pin.rev, "string");
    assertEquals(pin.rev.length, 40);
    assertEquals(typeof pin.build, "string");
    assertEquals(typeof pin.path, "string");
    assertEquals(/^[0-9a-f]{64}$/.test(pin.sha256), true);
  }
});
