// The approval window bridge.js opens: the one thing in the path that only
// a person can do. Page and guest code cannot reach this page.
const params = new URLSearchParams(location.search);
document.getElementById("origin").textContent = params.get("origin") ?? "?";
// While a person reads this, keep the extension's service worker (which is
// waiting for the answer) from being stopped as idle.
const keepalive = setInterval(
  () =>
    chrome.runtime.sendMessage({ yurtApproval: "keepalive" }).catch(() => {}),
  10_000,
);
const answer = async (allowed) => {
  clearInterval(keepalive);
  // Delivered first, then closed: a close the worker sees first is a no.
  try {
    await chrome.runtime.sendMessage({
      yurtApproval: params.get("ask"),
      allowed,
    });
  } catch {
    // The bridge restarted and its question is gone; the page asks again
    // on reload.
  }
  globalThis.close();
};
// The buttons wake a moment after the window is seen, so a click meant for
// the page under it cannot land on Allow.
const wake = () =>
  setTimeout(() => {
    for (const id of ["allow", "deny"]) {
      document.getElementById(id).disabled = false;
    }
  }, 1000);
// From when the window has the focus, not from when it loaded.
if (document.hasFocus()) wake();
else globalThis.addEventListener("focus", wake, { once: true });
document.getElementById("allow").addEventListener("click", () => answer(true));
document.getElementById("deny").addEventListener("click", () => answer(false));
