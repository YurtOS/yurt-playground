// src/device.ts
function deviceClass() {
  const uaData = navigator.userAgentData;
  const ua = navigator.userAgent;
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) {
    return Math.min(screen.width, screen.height) < 600 ? "phone" : "tablet";
  }
  if (/iPad/.test(ua)) return "tablet";
  if (uaData?.mobile === true || /iPhone|iPod|Android.*Mobile/i.test(ua)) {
    return "phone";
  }
  const coarse = matchMedia("(pointer: coarse)").matches;
  if (coarse && Math.min(screen.width, screen.height) < 600) return "phone";
  if (/Android|Silk/i.test(ua) || navigator.platform === "Linux armv81" || coarse && innerWidth < 900) return "tablet";
  return "desktop";
}

// src/notebook.ts
var PYTHON_MISSING_TEXT = "Python isn't installed in this sandbox yet";
var PYTHON_INSTALL = {
  available: false,
  reason: "Python packages are not published yet"
};

// src/bridge_status.ts
var BRIDGE_STATUS_ID = "yurt-bridge-status";
function describeBridgeState(state) {
  switch (state.state) {
    case "booting":
      return state.text === "" ? "Yurt sandbox: the shell is up" : `Yurt sandbox: ${state.text}`;
    case "ready":
      return void 0;
    case "error":
      return `Yurt sandbox: ${state.text}`;
    case "python-missing":
      return state.error !== void 0 ? `Yurt sandbox: installing Python failed: ${state.error}. Restart the kernel to try again.` : `${PYTHON_MISSING_TEXT}, so this notebook has no kernel. ${PYTHON_INSTALL.reason}; the shell on the home page runs without it.`;
  }
}
var STYLE = [
  "position: fixed",
  "left: 12px",
  "bottom: 12px",
  "z-index: 10000",
  "max-width: min(560px, calc(100vw - 24px))",
  "margin: 0",
  "padding: 8px 12px",
  "border-radius: 6px",
  "background: #1f2430",
  "color: #e6e1d7",
  "font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  "white-space: pre-wrap"
].join("; ");
function showBridgeState(doc, state) {
  let line = doc.getElementById(BRIDGE_STATUS_ID);
  const text = describeBridgeState(state);
  if (line === null) {
    if (text === void 0) return;
    line = doc.createElement("p");
    line.id = BRIDGE_STATUS_ID;
    line.dataset.testid = BRIDGE_STATUS_ID;
    line.style.cssText = STYLE;
    doc.body.append(line);
  }
  const failed = line.dataset.state === "error" || line.dataset.state === "python-missing";
  if (failed && state.state === "booting") return;
  line.dataset.state = state.state;
  if (state.state === "error" || state.state === "python-missing") {
    line.setAttribute("role", "alert");
  } else {
    line.removeAttribute("role");
  }
  line.hidden = text === void 0;
  line.textContent = text ?? "";
}
var PHONE_REFUSAL = "the Notebook and JupyterLab do not run on phones: a phone tab has too little memory for Python. Use a desktop browser, the desktop app or the command line; the home page runs the shell here.";
function refuseOnPhone(doc, device = deviceClass()) {
  if (device !== "phone") return;
  showBridgeState(doc, {
    state: "error",
    text: PHONE_REFUSAL
  });
  throw new Error(PHONE_REFUSAL);
}

// src/memory_refused.ts
var MEMORY_REFUSED_BANNER_ID = "memory-refused";
var MEMORY_REFUSED_RELOAD_ID = "memory-refused-reload";
var MEMORY_REFUSED_TEXT = "The browser ran out of memory for new processes. Reload the page to continue.";
var MOUNTED_BANNER_STYLE = [
  "position: fixed",
  "top: 0",
  "left: 0",
  "right: 0",
  "z-index: 10000",
  "margin: 0",
  "padding: 12px 14px",
  "border-left: 3px solid #e08a7a",
  "background: #1c212a",
  "color: #e6e1d7",
  "font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
].join("; ");
function mountMemoryRefusedBanner(doc, reload = () => location.reload()) {
  const existing = doc.getElementById(MEMORY_REFUSED_BANNER_ID);
  if (existing !== null) {
    existing.hidden = false;
    return existing;
  }
  const banner = doc.createElement("p");
  banner.id = MEMORY_REFUSED_BANNER_ID;
  banner.dataset.testid = MEMORY_REFUSED_BANNER_ID;
  banner.setAttribute("role", "alert");
  banner.style.cssText = MOUNTED_BANNER_STYLE;
  banner.textContent = `${MEMORY_REFUSED_TEXT} `;
  const button = doc.createElement("button");
  button.type = "button";
  button.id = MEMORY_REFUSED_RELOAD_ID;
  button.dataset.testid = MEMORY_REFUSED_RELOAD_ID;
  button.textContent = "Reload";
  button.addEventListener("click", () => reload());
  banner.append(button);
  doc.body.prepend(banner);
  return banner;
}

// src/guest_worker.ts
var GUEST_WORKER_PATH = "./worker_bootstrap.js";
var GuestWorkerRefused = class extends Error {
  constructor(requested) {
    super(`refused to start a guest worker at ${JSON.stringify(requested)}`);
    this.name = "GuestWorkerRefused";
  }
};
function guestWorkerStart(scriptURL, site) {
  const requested = String(scriptURL);
  const origin = new URL(site).origin;
  let url;
  try {
    url = new URL(requested, site);
  } catch {
    throw new GuestWorkerRefused(requested);
  }
  const name = url.pathname.split("/").pop() ?? "";
  if (url.origin !== origin || !/^worker_bootstrap\.(ts|js)$/.test(name)) {
    throw new GuestWorkerRefused(requested);
  }
  return [
    new URL(GUEST_WORKER_PATH, site).href,
    {
      type: "module"
    }
  ];
}

// src/site_url.ts
function siteUrl(path) {
  return new URL(path, import.meta.url).href;
}

// src/page_worker_bridge.ts
var CREATE_GUEST_WORKER = "yurt-create-guest-worker";
var TERMINATE_GUEST_WORKER = "yurt-terminate";
var GUEST_WORKER_ERROR = "yurt-guest-worker-error";
var GUEST_WORKER_PORT = "yurt-guest-worker-port";
var GUEST_PORT_COUNTS = "__yurtGuestPorts";
function guestPortCounts() {
  const scope = globalThis;
  return scope[GUEST_PORT_COUNTS] ??= {
    direct: 0,
    relay: 0
  };
}
function parseCreateGuestWorkerMessage(data) {
  if (data === null || typeof data !== "object") return void 0;
  const { type, url, direct } = data;
  if (type !== CREATE_GUEST_WORKER || typeof url !== "string") {
    return void 0;
  }
  return {
    type: CREATE_GUEST_WORKER,
    url,
    direct: direct === true
  };
}
function attachGuestWorkerFactory(coordinator) {
  coordinator.addEventListener("message", (event) => {
    const request = parseCreateGuestWorkerMessage(event.data);
    if (request === void 0) return;
    const [guestPort, control] = event.ports;
    if (guestPort === void 0 || control === void 0) return;
    const fail = (message) => control.postMessage({
      type: GUEST_WORKER_ERROR,
      message
    });
    let start;
    try {
      start = guestWorkerStart(request.url, siteUrl("./"));
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      control.close();
      return;
    }
    const guest = new Worker(...start);
    guestPortCounts()[request.direct ? "direct" : "relay"]++;
    let relay;
    if (request.direct) {
      guest.postMessage({
        type: GUEST_WORKER_PORT
      }, [
        guestPort
      ]);
    } else {
      relay = new MessageChannel();
      const page = relay.port1;
      page.onmessage = (event2) => guestPort.postMessage(event2.data, [
        ...event2.ports
      ]);
      guestPort.onmessage = (event2) => page.postMessage(event2.data, [
        ...event2.ports
      ]);
      guest.postMessage({
        type: GUEST_WORKER_PORT
      }, [
        relay.port2
      ]);
    }
    guest.onerror = (event2) => {
      fail(event2.message || "guest worker failed");
    };
    control.onmessage = (controlEvent) => {
      if (controlEvent.data?.type === TERMINATE_GUEST_WORKER) {
        guest.terminate();
        control.close();
        if (relay !== void 0) {
          relay.port1.close();
          guestPort.close();
        }
      }
    };
  });
}

// src/snapshot_bridge.ts
var bridge;
function startSnapshotKernel(workerUrl = siteUrl("./notebook_kernel.bundle.js")) {
  if (bridge !== void 0) return bridge;
  refuseOnPhone(document);
  const worker = new Worker(workerUrl);
  attachGuestWorkerFactory(worker);
  const messageListeners = /* @__PURE__ */ new Set();
  const statusListeners = /* @__PURE__ */ new Set();
  const errorListeners = /* @__PURE__ */ new Set();
  const snapshotListeners = /* @__PURE__ */ new Set();
  let snapshot = {
    state: "booting"
  };
  let pendingCell;
  let resolveReady = () => {
  };
  let rejectReady = () => {
  };
  const arm = () => new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let ready = arm();
  worker.onmessage = (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "status":
        for (const listener of statusListeners) listener(msg.text);
        return;
      case "error":
        for (const listener of statusListeners) listener(msg.message);
        for (const listener of errorListeners) listener(msg.message);
        rejectReady(new Error(msg.message));
        return;
      case "notebook-ready":
      case "jupyter-restarted":
        resolveReady();
        return;
      case "jupyter-message":
        for (const listener of messageListeners) {
          listener(msg.message, msg.channel);
        }
        return;
      case "snapshot":
        snapshot = msg.snapshot;
        for (const listener of snapshotListeners) listener(msg.snapshot);
        return;
      case "pending-cell":
        pendingCell = {
          code: msg.code,
          executionCount: msg.executionCount
        };
        return;
      case "pending-cell-cleared":
        if (!msg.answerable) pendingCell = void 0;
        return;
      case "memory-refused":
        mountMemoryRefusedBanner(document);
        return;
    }
  };
  worker.onerror = (event) => {
    const message = event.message || "notebook kernel worker failed";
    for (const listener of errorListeners) listener(message);
    rejectReady(new Error(message));
  };
  worker.postMessage({
    type: "start",
    isolated: globalThis.crossOriginIsolated === true
  });
  bridge = {
    get ready() {
      return ready;
    },
    get snapshot() {
      return snapshot;
    },
    restart() {
      ready = ready.catch(() => {
      }).then(() => {
        const next = arm();
        worker.postMessage({
          type: "jupyter-restart"
        });
        return next;
      });
      return ready;
    },
    send(message, channel) {
      if (message.header.msg_type === "execute_request") {
        pendingCell = void 0;
      }
      worker.postMessage({
        type: "jupyter-send",
        message,
        channel
      });
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    suspend() {
      worker.postMessage({
        type: "suspend"
      });
    },
    resume() {
      worker.postMessage({
        type: "resume"
      });
    },
    forget() {
      worker.postMessage({
        type: "forget"
      });
    },
    onSnapshot(listener) {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
    get pendingCell() {
      return pendingCell;
    }
  };
  return bridge;
}
export {
  startSnapshotKernel
};
