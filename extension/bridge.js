// Yurt browser bridge: a CDP browser endpoint over chrome.debugger.
// A page (externally_connectable) opens a Port and sends CDP messages as a
// browser-level DevTools client would ({id, method, params, sessionId?}).
// Browser-level methods are answered here; a page's session is a tab this
// bridge opened and attached with chrome.debugger.

const DEFAULT_CONTEXT = "yurt-default";

/** Where a script may send a tab: the web, or a blank page. Never this
 *  extension's own pages (which run with its powers), chrome://,
 *  devtools:, file: or another extension. */
function navigable(url) {
  if (url === undefined || url === "about:blank") return true;
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
/** The most tabs one connection may open at once. */
const MAX_TABS = 16;

// A page may drive this browser only after a person allowed it in this
// extension's own window (approve.html): any script on the site's origin can
// reach the extension, so the page's own gate is not the boundary.
//
// An approval belongs to the one top-level document that asked (Chrome's
// sender.documentId, frameId 0), not to its tab: the playground runs
// JupyterLite in a frame of the same tab and origin, and a frame is never
// covered (it is refused without a window). A reload is a new document, so
// an old approval simply does not apply, and a late answer only ever
// reaches the document that asked. The page asks while it sets Playwright
// up (Yurt.approve), so a script's connection never waits on a person.
// Answers are kept in chrome.storage.session, which outlives this service
// worker's idle stops.
const APPROVED = "approvedDocuments";
const DENIED = "deniedDocuments";
/** Answers kept, newest last: a document id is never reused. */
const KEEP = 64;

// One update at a time: each reads a list and writes it back, and two at
// once would lose one of them.
let updates = Promise.resolve();
async function documentsUnder(key) {
  await updates;
  const stored = await chrome.storage.session.get(key);
  return stored[key] ?? [];
}
function remember(key, documentId) {
  const next = updates.then(async () => {
    const stored = await chrome.storage.session.get(key);
    const ids = (stored[key] ?? []).filter((id) => id !== documentId);
    ids.push(documentId);
    await chrome.storage.session.set({ [key]: ids.slice(-KEEP) });
  }).catch(() => {});
  updates = next;
  return next;
}

/** One question per document at a time, shared by every connection. */
const asking = new Map(); // documentId -> Promise<boolean>
const answers = new Map(); // ask id -> resolve(boolean)

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.yurtApproval === undefined) {
    return;
  }
  // approve.js also pings while it waits, which keeps this worker alive.
  if (message.yurtApproval !== "keepalive") {
    answers.get(message.yurtApproval)?.(message.allowed === true);
    answers.delete(message.yurtApproval);
  }
  respond(true);
});

/** Whether a person allows the document `sender` names. A frame, or a
 *  sender without a document id, is a no without asking. */
async function approve(sender) {
  const documentId = sender?.documentId;
  if (sender?.frameId !== 0 || typeof documentId !== "string") return false;
  // Only the playground's own page sets Playwright up: never JupyterLite's
  // pages (./jupyter/...), which render notebook output on the same origin.
  let page;
  try {
    page = new URL(sender.url);
  } catch {
    return false;
  }
  if (page.pathname !== "/" && page.pathname !== "/index.html") return false;
  if ((await documentsUnder(APPROVED)).includes(documentId)) return true;
  if ((await documentsUnder(DENIED)).includes(documentId)) return false;
  const pending = asking.get(documentId);
  if (pending !== undefined) return await pending;
  // The window names the page that asks, not just the site.
  const origin = sender.url ?? sender.origin ?? "";
  const question = (async () => {
    // Random: a window left from before a worker restart cannot answer a
    // newer question.
    const ask = crypto.randomUUID();
    const answer = new Promise((resolve) => answers.set(ask, resolve));
    // No window, no question: a no (and nothing waits on it).
    let popup;
    try {
      popup = await chrome.windows.create({
        url: chrome.runtime.getURL(
          `approve.html?ask=${ask}&origin=${encodeURIComponent(origin)}`,
        ),
        type: "popup",
        width: 480,
        height: 300,
      });
    } catch (error) {
      answers.delete(ask);
      console.warn(`[yurt bridge] could not ask: ${error?.message ?? error}`);
      return false;
    }
    // Closing the window without an answer is a no. approve.js closes it
    // only after its answer was delivered.
    const closed = (id) => {
      if (id === popup.id) answers.get(ask)?.(false);
    };
    chrome.windows.onRemoved.addListener(closed);
    const allowed = await answer;
    chrome.windows.onRemoved.removeListener(closed);
    answers.delete(ask);
    await remember(allowed ? APPROVED : DENIED, documentId);
    return allowed;
  })().catch(() => false);
  asking.set(documentId, question);
  try {
    return await question;
  } finally {
    asking.delete(documentId);
  }
}

chrome.runtime.onConnectExternal.addListener((port) => {
  const sender = port.sender;
  // Checked on a connection's first CDP message (asking, if the page did
  // not ask at setup); until then only Yurt.ping and Yurt.approve.
  let allowed;
  const sessions = new Map(); // sessionId -> { tabId, targetId }
  // A child session (an iframe or worker chrome.debugger auto-attached on a
  // tab) -> that tab, so its commands go to the right debuggee.
  const childTab = new Map();
  const byTab = new Map(); // tabId -> sessionId (root)
  let seq = 0;
  const send = (msg) => {
    try {
      port.postMessage(msg);
    } catch {
      // The page went away; its onDisconnect cleans up.
    }
  };
  const reply = (id, sessionId, result) => send({ id, sessionId, result });
  const fail = (id, sessionId, message) =>
    send({ id, sessionId, error: { code: -32000, message } });

  const targetInfo = async (tabId, targetId) => {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    return {
      targetId,
      type: "page",
      title: tab?.title ?? "",
      url: tab?.url ?? "about:blank",
      attached: true,
      canAccessOpener: false,
      browserContextId: DEFAULT_CONTEXT,
    };
  };

  const attachTab = async (tabId) => {
    await chrome.debugger.attach({ tabId }, "1.3");
    const targets = await chrome.debugger.getTargets();
    const targetId = targets.find((t) => t.tabId === tabId)?.id;
    const sessionId = `yurt-${tabId}-${++seq}`;
    sessions.set(sessionId, { tabId, targetId });
    byTab.set(tabId, sessionId);
    send({
      method: "Target.attachedToTarget",
      params: {
        sessionId,
        targetInfo: await targetInfo(tabId, targetId),
        waitingForDebugger: false,
      },
    });
    return { sessionId, targetId };
  };

  const onEvent = (source, method, params) => {
    const root = byTab.get(source.tabId);
    if (root === undefined) return;
    if (method === "Target.attachedToTarget" && params?.sessionId) {
      childTab.set(params.sessionId, source.tabId);
    }
    if (method === "Target.detachedFromTarget" && params?.sessionId) {
      childTab.delete(params.sessionId);
    }
    send({ method, params, sessionId: source.sessionId ?? root });
  };
  const onDetach = (source) => {
    const root = byTab.get(source.tabId);
    if (root === undefined) return;
    const s = sessions.get(root);
    sessions.delete(root);
    byTab.delete(source.tabId);
    // The tab's child sessions go with it.
    for (const [child, tab] of childTab) {
      if (tab === source.tabId) childTab.delete(child);
    }
    send({
      method: "Target.detachedFromTarget",
      params: { sessionId: root, targetId: s?.targetId },
    });
  };
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(onDetach);
  // Second layer: a controlled tab that reaches anything but the web or a
  // blank page (a link, a redirect, script) is let go and closed.
  const onTabUpdated = (tabId, change) => {
    if (change.url === undefined || navigable(change.url)) return;
    const root = byTab.get(tabId);
    if (root === undefined) return;
    void chrome.debugger.detach({ tabId }).catch(() => {});
    void chrome.tabs.remove(tabId).catch(() => {});
    onDetach({ tabId });
  };
  chrome.tabs.onUpdated.addListener(onTabUpdated);

  const browserMethod = async (id, method, params) => {
    switch (method) {
      case "Browser.getVersion":
        return reply(id, undefined, {
          protocolVersion: "1.3",
          product: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? "Chrome",
          revision: "",
          userAgent: navigator.userAgent,
          jsVersion: "",
        });
      case "Target.setAutoAttach":
        return reply(id, undefined, {});
      case "Target.setDiscoverTargets":
      case "Browser.setDownloadBehavior":
      case "Target.disposeBrowserContext":
      case "Browser.close": // never closes the user's browser
        return reply(id, undefined, {});
      case "Target.getBrowserContexts":
        return reply(id, undefined, { browserContextIds: [] });
      case "Target.getTargets":
        return reply(id, undefined, {
          targetInfos: await Promise.all(
            [...sessions.values()].map((s) => targetInfo(s.tabId, s.targetId)),
          ),
        });
      case "Target.createTarget": {
        if (!navigable(params?.url)) {
          return fail(id, undefined, `the bridge does not open ${params.url}`);
        }
        if (sessions.size >= MAX_TABS) {
          return fail(id, undefined, `a script may keep ${MAX_TABS} tabs open`);
        }
        const tab = await chrome.tabs.create({
          url: "about:blank",
          // In the background: the playground tab, which relays every
          // message, keeps the focus (and its timers unthrottled).
          active: false,
        });
        try {
          const { targetId } = await attachTab(tab.id);
          if (params?.url && params.url !== "about:blank") {
            await chrome.debugger.sendCommand(
              { tabId: tab.id },
              "Page.navigate",
              { url: params.url },
            );
          }
          return reply(id, undefined, { targetId });
        } catch (error) {
          // No orphan: the tab this call opened goes with its failure, and
          // a session already announced is announced gone (an explicit
          // detach fires no onDetach).
          const root = byTab.get(tab.id);
          if (root !== undefined) {
            const target = sessions.get(root)?.targetId;
            sessions.delete(root);
            byTab.delete(tab.id);
            send({
              method: "Target.detachedFromTarget",
              params: { sessionId: root, targetId: target },
            });
          }
          await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
          await chrome.tabs.remove(tab.id).catch(() => {});
          throw error;
        }
      }
      case "Target.closeTarget": {
        const s = [...sessions.values()].find((x) =>
          x.targetId === params?.targetId
        );
        if (s) await chrome.tabs.remove(s.tabId).catch(() => {});
        return reply(id, undefined, { success: !!s });
      }
      case "Target.getTargetInfo": {
        if (params?.targetId === undefined) {
          return reply(id, undefined, {
            targetInfo: {
              targetId: "yurt-browser",
              type: "browser",
              title: "",
              url: "",
              attached: true,
              canAccessOpener: false,
            },
          });
        }
        const s = [...sessions.values()].find((x) =>
          x.targetId === params?.targetId
        );
        return s
          ? reply(id, undefined, {
            targetInfo: await targetInfo(s.tabId, s.targetId),
          })
          : fail(id, undefined, "no such target");
      }
      case "Target.createBrowserContext":
        return fail(
          id,
          undefined,
          "the Yurt bridge drives tabs in this browser's own profile only (no new contexts)",
        );
      default:
        return fail(
          id,
          undefined,
          `the Yurt bridge does not support ${method}`,
        );
    }
  };

  port.onMessage.addListener(async (msg) => {
    const { id, method, params, sessionId } = msg;
    // The page's check that this is the bridge, before any approval.
    if (method === "Yurt.ping") return reply(id, undefined, { yurt: true });
    // The page's question at setup: the person answers before any script.
    if (method === "Yurt.approve") {
      const yes = await approve(sender);
      return reply(id, undefined, { allowed: yes });
    }
    allowed ??= approve(sender);
    if (!(await allowed)) {
      fail(id, sessionId, "not allowed: the Yurt browser bridge was denied");
      // Our own disconnect fires no onDisconnect here: drop the listeners.
      chrome.debugger.onEvent.removeListener(onEvent);
      chrome.debugger.onDetach.removeListener(onDetach);
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
      port.disconnect();
      return;
    }
    try {
      if (sessionId === undefined) {
        return await browserMethod(id, method, params);
      }
      // A tab's own session, or a child one (an iframe, a worker) that
      // chrome.debugger reported on that tab.
      const root = sessions.get(sessionId);
      const childOf = childTab.get(sessionId);
      if (root === undefined && childOf === undefined) {
        return fail(id, sessionId, `no session ${sessionId}`);
      }
      const target = root !== undefined
        ? { tabId: root.tabId }
        : { tabId: childOf, sessionId };
      // A tab goes to the web or a blank page only (history entries could
      // hold anything: not offered).
      if (method === "Page.navigateToHistoryEntry") {
        return fail(id, sessionId, "the bridge does not navigate history");
      }
      if (method === "Page.navigate" && !navigable(params?.url)) {
        return fail(id, sessionId, `the bridge does not open ${params?.url}`);
      }
      const result = await chrome.debugger.sendCommand(
        target,
        method,
        params ?? {},
      );
      reply(id, sessionId, result ?? {});
    } catch (error) {
      fail(id, sessionId, String(error?.message ?? error));
    }
  });
  // A script that ends leaves the tabs it opened (the demo's point is to
  // see them); only the debugger lets go of them.
  port.onDisconnect.addListener(async () => {
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onDetach);
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
    for (const { tabId } of sessions.values()) {
      await chrome.debugger.detach({ tabId }).catch(() => {});
    }
  });
});
