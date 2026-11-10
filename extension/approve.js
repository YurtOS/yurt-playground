// The approval window bridge.js opens: the one thing in the path that only
// a person can do. Page and guest code cannot reach this page.
const params = new URLSearchParams(location.search);
document.getElementById("origin").textContent = params.get("origin") ?? "?";
const answer = (allowed) => {
  chrome.runtime.sendMessage({ yurtApproval: params.get("ask"), allowed });
  globalThis.close();
};
document.getElementById("allow").addEventListener("click", () => answer(true));
document.getElementById("deny").addEventListener("click", () => answer(false));
