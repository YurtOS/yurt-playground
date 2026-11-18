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
  if (navigator.serviceWorker.controller !== null) {
    // Served through a worker and still not isolated: reloading again would
    // loop. The page says it is not isolated in its own way.
    console.error("preview isolation: the service worker did not isolate");
    return;
  }
  if (sessionStorage.getItem(RELOADED) !== null) {
    sessionStorage.removeItem(RELOADED);
    console.error("preview isolation: still no service worker after a reload");
    return;
  }
  const script = document.currentScript.src;
  // Nothing after this script runs: the page would see no isolation and
  // send itself to unsupported.html before the reload.
  self.stop();
  navigator.serviceWorker.register(new URL("isolation-sw.js", script))
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      sessionStorage.setItem(RELOADED, "1");
      location.reload();
    }, (error) => {
      console.error("preview isolation: cannot register the worker", error);
    });
})();
