import {
  type DatasetteSnapshot,
  type DatasetteState,
  parseGuestAbort,
  parseGuestReply,
  parseGuestRequest,
  parseOwnerMessage,
} from "./datasette_protocol.ts";
import { DATASETTE_QUERY } from "./datasette.ts";
export function datasetteControls(qualified: boolean, state: DatasetteState) {
  return {
    hidden: !qualified,
    start: qualified && ["stopped", "failed"].includes(state),
    stop: qualified && ["starting", "running"].includes(state),
    reset: qualified && ["stopped", "failed", "running"].includes(state),
    download: qualified && state === "running",
  };
}
/** The uncontrolled root page owns one sandbox and one worker channel. */
export function mountDatasette(
  root: HTMLElement,
  coordinator: Worker,
  browser: boolean,
): () => void {
  root.hidden = true;
  if (!browser) return () => {};
  root.innerHTML =
    `<h2>Explore a SQLite database</h2><p>Browse twelve sample orders, filter tables, and run read-only SQL. Changes in the terminal appear after refresh.</p><div><button data-action="start">Start Datasette</button> <button data-action="stop">Stop</button> <button data-action="reset">Reset sample</button> <button data-action="download">Download revenue JSON</button></div><p role="status" data-status></p><pre data-log hidden></pre><details><summary>Revenue by product</summary><pre data-query></pre><p>Expected: Mug 8400, Notebook 4000, Pen 2000 cents.</p><p>Database: <code>/home/user/demos/datasette/orders.db</code></p></details><div data-preview></div>`;
  root.querySelector("[data-query]")!.textContent = DATASETTE_QUERY;
  const status = root.querySelector<HTMLElement>("[data-status]")!;
  const log = root.querySelector<HTMLElement>("[data-log]")!;
  const preview = root.querySelector<HTMLElement>("[data-preview]")!;
  const buttons = Object.fromEntries(
    ["start", "stop", "reset", "download"].map(
      (
        a,
      ) => [a, root.querySelector<HTMLButtonElement>(`[data-action="${a}"]`)!],
    ),
  );
  let qualified = false,
    hashes: string[] = [],
    snapshot: DatasetteSnapshot = { state: "stopped" };
  let registration: ServiceWorkerRegistration | undefined,
    port: MessagePort | undefined;
  let boundSession: string | undefined,
    nonce = "",
    pongAt = 0,
    disposed = false;
  let binding: Promise<void> | undefined;
  const relays = new Map<string, MessagePort>();
  const downloads = new Map<string, { session: string; timer: number }>();
  const render = () => {
    const controls = datasetteControls(qualified, snapshot.state);
    root.hidden = controls.hidden;
    for (const action of ["start", "stop", "reset", "download"] as const) {
      buttons[action].disabled = !controls[action];
    }
    status.textContent = snapshot.error ?? snapshot.state;
    log.hidden = !snapshot.logTail;
    log.textContent = snapshot.logTail ?? "";
  };
  const cancelRelays = () => {
    for (const [requestId] of relays) {
      coordinator.postMessage({
        type: "datasette-abort",
        session: boundSession,
        requestId,
      });
    }
    relays.clear();
  };
  const unbind = () => {
    if (boundSession) {
      registration?.active?.postMessage({
        type: "datasette-unregister",
        session: boundSession,
        nonce: crypto.randomUUID(),
      });
    }
    cancelRelays();
    port?.close();
    port = undefined;
    boundSession = undefined;
    preview.replaceChildren();
    for (const [requestId, item] of downloads) {
      clearTimeout(item.timer);
      coordinator.postMessage({
        type: "datasette-abort",
        requestId,
        session: item.session,
      });
    }
    downloads.clear();
  };
  const bind = async (recoveryNonce?: string, target?: ServiceWorker) => {
    if (!snapshot.session || !snapshot.prefix || snapshot.state !== "running") {
      return;
    }
    const session = snapshot.session, prefix = snapshot.prefix;
    if (!registration) {
      registration = await navigator.serviceWorker.register(
        "/apps/datasette/service-worker.js",
        { scope: "/apps/datasette/" },
      );
      if (!registration.active) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("preview worker activation timed out")),
            10000,
          );
          const poll = () => {
            if (registration?.active) {
              clearTimeout(timer);
              resolve();
            } else if (!disposed) setTimeout(poll, 50);
            else {
              clearTimeout(timer);
              reject(new Error("preview disposed"));
            }
          };
          poll();
        });
      }
    }
    if (
      disposed || snapshot.session !== session || snapshot.state !== "running"
    ) return;
    cancelRelays();
    port?.close();
    const channel = new MessageChannel();
    port = channel.port1;
    boundSession = session;
    nonce = recoveryNonce ?? crypto.randomUUID();
    const current = port;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        current.close();
        reject(new Error("preview owner handshake timed out"));
      }, 5000);
      current.onmessage = (e) => {
        if (port !== current || snapshot.session !== session) return;
        const owner = parseOwnerMessage(e.data);
        if (
          owner?.type === "datasette-registered" && owner.session === session &&
          owner.nonce === nonce
        ) {
          clearTimeout(timer);
          pongAt = performance.now();
          resolve();
          return;
        }
        const request = parseGuestRequest(e.data);
        if (request && request.session === session) {
          relays.set(request.requestId, current);
          coordinator.postMessage(request);
          return;
        }
        const abort = parseGuestAbort(e.data);
        if (abort && abort.session === session) {
          relays.delete(abort.requestId);
          coordinator.postMessage(abort);
        }
      };
      current.start();
      (target ?? registration!.active)!.postMessage({
        type: "datasette-register",
        app: "datasette",
        session,
        prefix,
        hashes,
        nonce,
      }, [channel.port2]);
    });
    if (snapshot.session !== session || disposed) return;
    if (!preview.firstChild) {
      const frame = document.createElement("iframe");
      frame.title = "Datasette database browser";
      frame.setAttribute(
        "sandbox",
        "allow-scripts allow-same-origin allow-forms allow-downloads",
      );
      frame.style.cssText = "width:100%;height:650px;border:1px solid #888";
      frame.src = prefix;
      preview.append(frame);
    }
  };
  const ensureBound = () => {
    if (binding) return;
    binding = bind().catch((e) => {
      status.textContent = String(e);
    }).finally(() => binding = undefined);
  };
  const ownerMessage = (e: MessageEvent) => {
    const msg = parseOwnerMessage(e.data);
    if (
      !msg || msg.session !== snapshot.session ||
      e.source !== registration?.active
    ) return;
    if (msg.type === "datasette-pong" && msg.nonce === nonce) {
      pongAt = performance.now();
    }
    if (msg.type === "datasette-find-owner") {
      void bind(msg.nonce, e.source as ServiceWorker).catch((e) =>
        status.textContent = String(e)
      );
    }
  };
  navigator.serviceWorker.addEventListener("message", ownerMessage);
  const heartbeat = setInterval(() => {
    if (snapshot.state !== "running") return;
    if (!port || performance.now() - pongAt > 5000) {
      ensureBound();
      return;
    }
    registration?.active?.postMessage({
      type: "datasette-ping",
      session: snapshot.session,
      nonce,
    });
  }, 2000);
  const receive = (e: MessageEvent) => {
    const msg = e.data;
    if (msg?.type === "guest-app-qualification") {
      const appHashes = msg.apps?.datasette;
      qualified = appHashes instanceof Array &&
        appHashes.every((h: unknown) =>
          typeof h === "string" && /^sha256-[A-Za-z0-9+/]{43}=$/.test(h)
        );
      hashes = qualified ? [...appHashes] : [];
      render();
      return;
    }
    if (
      msg?.type === "datasette-state" && msg.app === "datasette" &&
      msg.snapshot &&
      ["stopped", "starting", "running", "stopping", "failed", "stuck"]
        .includes(msg.snapshot.state)
    ) {
      const previous = snapshot.session;
      snapshot = msg.snapshot;
      if (snapshot.state !== "running" || previous !== snapshot.session) {
        unbind();
      }
      render();
      if (snapshot.state === "running" && boundSession !== snapshot.session) {
        ensureBound();
      }
      return;
    }
    const reply = parseGuestReply(msg);
    if (!reply) return;
    const relay = relays.get(reply.requestId);
    if (relay && reply.session === boundSession) {
      relays.delete(reply.requestId);
      relay.postMessage(
        reply,
        reply.type === "datasette-response" ? [reply.body] : [],
      );
      return;
    }
    const download = downloads.get(reply.requestId);
    if (!download || download.session !== reply.session) return;
    clearTimeout(download.timer);
    downloads.delete(reply.requestId);
    if (reply.type === "datasette-error" || reply.status !== 200) {
      status.textContent = reply.type === "datasette-error"
        ? reply.message
        : `download failed (${reply.status})`;
      return;
    }
    const url = URL.createObjectURL(
      new Blob([reply.body], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "revenue-by-product.json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  coordinator.addEventListener("message", receive);
  const click = (e: Event) => {
    const action = (e.target as HTMLElement).closest<HTMLButtonElement>(
      "button[data-action]",
    )?.dataset.action;
    if (!action || buttons[action]?.disabled) return;
    const requestId = crypto.randomUUID();
    if (action === "download") {
      if (!snapshot.session || !snapshot.prefix) return;
      const session = snapshot.session;
      const timer = setTimeout(() => {
        downloads.delete(requestId);
        coordinator.postMessage({
          type: "datasette-abort",
          session,
          requestId,
        });
        status.textContent = "download timed out";
      }, 30000);
      downloads.set(requestId, { session, timer });
      coordinator.postMessage({
        type: "datasette-http",
        app: "datasette",
        session,
        requestId,
        method: "GET",
        path: snapshot.prefix + "orders.json?sql=" +
          encodeURIComponent(DATASETTE_QUERY) + "&_shape=array",
        headers: [],
      });
    } else {
      if (action === "stop" || action === "reset") unbind();
      coordinator.postMessage({
        type: `datasette-${action}`,
        app: "datasette",
        requestId,
      });
    }
  };
  root.addEventListener("click", click);
  render();
  const failed = () => {
    qualified = false;
    unbind();
    render();
  };
  coordinator.addEventListener("error", failed);
  const dispose = () => {
    disposed = true;
    clearInterval(heartbeat);
    unbind();
    coordinator.removeEventListener("message", receive);
    coordinator.removeEventListener("error", failed);
    navigator.serviceWorker.removeEventListener("message", ownerMessage);
    root.removeEventListener("click", click);
  };
  globalThis.addEventListener("pagehide", dispose, { once: true });
  return dispose;
}
