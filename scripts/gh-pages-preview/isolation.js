// Cross-origin isolation for a GitHub Pages preview, which cannot send the
// COOP/COEP headers the sandbox's shared memory needs. Only a preview build
// (scripts/build-static.ts --gh-pages-preview) carries this file; every page
// of that build loads it first, as a classic script, before anything else
// runs. It registers isolation-sw.js, which adds the headers to the site's
// responses, and reloads once so the page comes back through it.
(() => {
  const RELOADED = "yurt-preview-isolation-reloaded";
  if (self.crossOriginIsolated) {
    sessionStorage.removeItem(RELOADED);
    return;
  }
  if (!("serviceWorker" in navigator)) return;
  const worker = new URL("isolation-sw.js", document.currentScript.src);
  const controller = navigator.serviceWorker.controller;
  if (controller !== null && controller.scriptURL === worker.href) {
    // Served through it and still not isolated: reloading again would loop.
    // The page says it is not isolated in its own way.
    console.error("preview isolation: the service worker did not isolate");
    return;
  }
  if (sessionStorage.getItem(RELOADED) !== null) {
    sessionStorage.removeItem(RELOADED);
    console.error("preview isolation: still not isolated after a reload");
    return;
  }
  // Nothing after this script runs: the page would see no isolation and
  // send itself to unsupported.html before the reload.
  self.stop();
  // Reloaded either way: a worker that cannot register leaves the flag set,
  // so the next load gives up and the page says it is not isolated.
  const reload = () => {
    sessionStorage.setItem(RELOADED, "1");
    location.reload();
  };
  // Another worker holding this page's scope (an older preview build's
  // JupyterLite one) would keep answering it: it goes first.
  const foreign = controller === null
    ? Promise.resolve()
    : navigator.serviceWorker.getRegistration().then((r) => r?.unregister());
  foreign
    .then(() => navigator.serviceWorker.register(worker))
    .then(() => navigator.serviceWorker.ready)
    .then(reload, (error) => {
      console.error("preview isolation: cannot register the worker", error);
      reload();
    });
})();
