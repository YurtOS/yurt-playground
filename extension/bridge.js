// Yurt browser bridge: a CDP browser endpoint over chrome.debugger.
// A page (externally_connectable) opens a Port and sends CDP messages as a
// browser-level DevTools client would ({id, method, params, sessionId?}).
// Browser-level methods are answered here; a page's session is a tab this
// bridge opened and attached with chrome.debugger.

const DEFAULT_CONTEXT = "yurt-default";

// A page may drive this browser only after a person allowed it in this
// extension's own window (approve.html): any script on the site's origin can
// reach the extension, so the page's own gate is not the boundary. The page
// asks while it sets Playwright up (Yurt.approve), so a script's connection
// never waits on a person. An approval holds for the asking tab until it
// closes or reloads; it is kept in chrome.storage.session, which outlives
// this service worker's idle stops.
const APPROVED = "approvedTabs";
const DENIED = "deniedTabs";

/** The tabs under `key`, once every queued update has landed. */
async function tabsUnder(key) {
  await updates;
  const stored = await chrome.storage.session.get(key);
  return new Set(stored[key] ?? []);
}
const approvedTabs = () => tabsUnder(APPROVED);
// One update at a time: each reads the set and writes it back, and two at
// once (an approval, and the approval window's own tab closing) would lose
// one of them.
let updates = Promise.resolve();
function setTab(key, tabId, present) {
  const next = updates.then(async () => {
    const stored = await chrome.storage.session.get(key);
    const tabs = new Set(stored[key] ?? []);
    if (tabs.has(tabId) === present) return;
    if (present) tabs.add(tabId);
    else tabs.delete(tabId);
    await chrome.storage.session.set({ [key]: [...tabs] });
  }).catch(() => {});
  updates = next;
  return next;
}
const setApproved = (tabId, approved) => setTab(APPROVED, tabId, approved);
// A no is remembered for the tab too, so a script that connects again (a
// hostile one, looping) gets no new window: only a reload asks again.
const setDenied = (tabId, denied) => setTab(DENIED, tabId, denied);
const forget = (tabId) => {
  void setApproved(tabId, false);
  void setDenied(tabId, false);
};
chrome.tabs.onRemoved.addListener(forget);
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading") forget(tabId);
});

/** One question per tab at a time, shared by every connection that asks. */
const asking = new Map(); // tabId -> Promise<boolean>
const answers = new Map(); // ask id -> resolve(boolean)
let nextAsk = 1;

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

/** Whether a person allows the page in tab `tabId` (from `origin`). */
async function approve(tabId, origin) {
  if ((await approvedTabs()).has(tabId)) return true;
  if ((await tabsUnder(DENIED)).has(tabId)) return false;
  const pending = asking.get(tabId);
  if (pending !== undefined) return await pending;
  const question = (async () => {
    const ask = String(nextAsk++);
    const answer = new Promise((resolve) => answers.set(ask, resolve));
    // No window, no question: a no (and nothing waits on it).
    const popup = await chrome.windows.create({
      url: chrome.runtime.getURL(
        `approve.html?ask=${ask}&origin=${encodeURIComponent(origin)}`,
      ),
      type: "popup",
      width: 480,
      height: 300,
    });
    // Closing the window without an answer is a no. approve.js closes it
    // only after its answer was delivered.
    const closed = (id) => {
      if (id === popup.id) answers.get(ask)?.(false);
    };
    chrome.windows.onRemoved.addListener(closed);
    const allowed = await answer;
    chrome.windows.onRemoved.removeListener(closed);
    answers.delete(ask);
    await (allowed ? setApproved(tabId, true) : setDenied(tabId, true));
    return allowed;
  })().catch(() => false);
  asking.set(tabId, question);
  try {
    return await question;
  } finally {
    asking.delete(tabId);
  }
}

chrome.runtime.onConnectExternal.addListener((port) => {
  const tabId = port.sender?.tab?.id;
  const origin = port.sender?.origin ?? port.sender?.url ?? "";
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
          // No orphan: the tab this call opened goes with its failure.
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
      const yes = tabId !== undefined && await approve(tabId, origin);
      return reply(id, undefined, { allowed: yes });
    }
    allowed ??= tabId === undefined
      ? Promise.resolve(false)
      : approve(tabId, origin);
    if (!(await allowed)) {
      fail(id, sessionId, "not allowed: the Yurt browser bridge was denied");
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
  port.onDisconnect.addListener(async () => {
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.debugger.onDetach.removeListener(onDetach);
    for (const { tabId } of sessions.values()) {
      await chrome.debugger.detach({ tabId }).catch(() => {});
    }
  });
});
