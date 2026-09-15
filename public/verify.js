// The "check the bytes" card on the home page: fetch integrity.json, fetch
// each file it names the way the sandbox does, hash it here in the browser,
// and show whether the bytes match. Everything is same-origin; the page's
// Content Security Policy allows nothing else.
//
// This file is served as-is, not bundled, so it cannot import
// src/image_parts.ts; the parts reassembly below mirrors partsFetch there.
const button = document.getElementById("verify-files");
const results = document.getElementById("verify-results");
const commitLine = document.getElementById("verify-commit");

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// The image is published in parts (Cloudflare Pages' 25 MiB file cap) and
// hashed whole, so fetch the parts manifest and lay them end to end, the way
// the sandbox's loader does.
async function fetchParts(name) {
  const manifestResponse = await fetch(`./${name}.parts.json`);
  if (!manifestResponse.ok) {
    throw new Error(
      `fetch ${name}.parts.json failed: ${manifestResponse.status}`,
    );
  }
  const manifest = await manifestResponse.json();
  const bytes = new Uint8Array(manifest.size);
  let offset = 0;
  for (const part of manifest.parts) {
    const response = await fetch(`./${part}`);
    if (!response.ok) {
      throw new Error(`fetch ${part} failed: ${response.status}`);
    }
    const chunk = new Uint8Array(await response.arrayBuffer());
    if (offset + chunk.byteLength > bytes.byteLength) {
      throw new Error(`${name} parts exceed the manifest size`);
    }
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== bytes.byteLength) {
    throw new Error(
      `${name} parts add up to ${offset}, not ${bytes.byteLength}`,
    );
  }
  return bytes;
}

async function fetchBytes(name) {
  if (name.endsWith(".yurtimg")) return await fetchParts(name);
  const response = await fetch(`./${name}`);
  if (!response.ok) throw new Error(`fetch ${name} failed: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

// integrity.json comes from the same build as the files it describes. The
// kernel and the image also have a hash that does not: artifacts/pins.json
// records the sha256 each was published with in its release, so those two
// rows are checked against the pin as well.
async function publishedPins() {
  try {
    const response = await fetch("./pins.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`fetch pins.json failed: ${response.status}`);
    }
    const pins = await response.json();
    const kernel = pins.kernelWasm?.sha256;
    const image = pins.image?.sha256;
    if (typeof kernel !== "string" || typeof image !== "string") {
      throw new Error("pins.json is missing required release hashes");
    }
    return {
      "yurt_kernel.wasm": kernel,
      "playground.yurtimg": image,
    };
  } catch {
    return null;
  }
}

function row(name, expected, actual, pinned) {
  const tr = document.createElement("tr");
  const ok = expected === actual && (pinned === undefined || pinned === actual);
  tr.className = ok ? "ok" : "bad";
  const cells = [
    ok ? "✓" : "✗",
    name,
    actual ? `${actual.slice(0, 8)}…` : "(fetch failed)",
    // Whether the release pin (artifacts/pins.json) agrees too.
    pinned === undefined ? "" : pinned === actual ? "pin ✓" : "pin ✗",
  ];
  for (const text of cells) {
    const td = document.createElement("td");
    td.textContent = text;
    tr.append(td);
  }
  return tr;
}

async function verify() {
  button.disabled = true;
  results.replaceChildren();
  results.hidden = false;
  commitLine.textContent = "";
  const summary = document.createElement("p");
  summary.dataset.testid = "verify-summary";
  summary.textContent = "fetching integrity.json…";
  results.append(summary);
  // The desktop app runs the sandbox natively, outside the tab; its bundle
  // carries no kernel wasm or image for the page to hash.
  const desktop = await fetch("./desktop.json")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (desktop?.native === true) {
    summary.textContent =
      "This is the desktop app: the sandbox runs natively on this machine, " +
      "not in the tab, so there are no in-tab bytes to check.";
    button.disabled = false;
    return;
  }
  try {
    const manifest = await (await fetch("./integrity.json", {
      cache: "no-store",
    })).json();
    if (manifest.commit) {
      const link = document.createElement("a");
      link.href =
        `https://github.com/YurtOS/yurt-playground/commit/${manifest.commit}`;
      link.textContent = manifest.commit.slice(0, 12);
      commitLine.append("Built from commit ", link, ".");
    } else {
      commitLine.textContent = "Local build; no commit recorded.";
    }
    const pins = await publishedPins();
    const table = document.createElement("table");
    results.append(table);
    const names = Object.keys(manifest.files);
    let matched = 0;
    for (const name of names) {
      summary.textContent = `hashing ${name}…`;
      let actual = null;
      try {
        actual = await sha256Hex(await fetchBytes(name));
      } catch {
        // The row says so.
      }
      const pinRequired = name === "yurt_kernel.wasm" ||
        name === "playground.yurtimg";
      const pinned = pinRequired ? pins?.[name] ?? null : undefined;
      if (
        actual === manifest.files[name] &&
        (pinned === undefined || pinned === actual)
      ) {
        matched += 1;
      }
      table.append(row(name, manifest.files[name], actual, pinned));
    }
    summary.textContent = `${matched} of ${names.length} files match.`;
    summary.className = matched === names.length ? "ok" : "bad";
  } catch (error) {
    summary.textContent = `could not verify: ${error.message}`;
    summary.className = "bad";
  } finally {
    button.disabled = false;
  }
}

button.addEventListener("click", () => {
  verify();
});
