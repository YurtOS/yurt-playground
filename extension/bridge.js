// Yurt browser bridge: a CDP browser endpoint over chrome.debugger.
// A page (externally_connectable) opens a Port and sends CDP messages as a
// browser-level DevTools client would ({id, method, params, sessionId?}).
// Browser-level methods are answered here; a page's session is a tab this
// bridge opened and attached with chrome.debugger.

const DEFAULT_CONTEXT = "yurt-default";

chrome.runtime.onConnectExternal.addListener((port) => {
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
    send({ method, params, sessionId: source.sessionId ?? root });
  };
  const onDetach = (source) => {
    const root = byTab.get(source.tabId);
    if (root === undefined) return;
    const s = sessions.get(root);
    sessions.delete(root);
    byTab.delete(source.tabId);
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
          active: true,
        });
        const { targetId } = await attachTab(tab.id);
        if (params?.url && params.url !== "about:blank") {
          await chrome.debugger.sendCommand(
            { tabId: tab.id },
            "Page.navigate",
            { url: params.url },
          );
        }
        return reply(id, undefined, { targetId });
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
