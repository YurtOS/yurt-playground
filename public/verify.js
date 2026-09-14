// The "check the bytes" card on the home page: fetch integrity.json, fetch
// each file it names the way the sandbox does, hash it here in the browser,
// and show whether the bytes match. Everything is same-origin; the page's
// Content Security Policy allows nothing else.
const button = document.getElementById("verify-files");
const results = document.getElementById("verify-results");
const commitLine = document.getElementById("verify-commit");

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function row(name, expected, actual) {
  const tr = document.createElement("tr");
  const ok = expected === actual;
  tr.className = ok ? "ok" : "bad";
  const cells = [
    ok ? "✓" : "✗",
    name,
    actual ? `${actual.slice(0, 12)}…` : "(fetch failed)",
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
    const table = document.createElement("table");
    results.append(table);
    const names = Object.keys(manifest.files);
    let matched = 0;
    for (const name of names) {
      summary.textContent = `hashing ${name}…`;
      let actual = null;
      try {
        const bytes = await (await fetch(`./${name}`)).arrayBuffer();
        actual = await sha256Hex(bytes);
      } catch {
        // The row says so.
      }
      if (actual === manifest.files[name]) matched += 1;
      table.append(row(name, manifest.files[name], actual));
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
