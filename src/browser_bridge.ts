// The page's half of Playwright in the in-tab sandbox: each DevTools
// connection the guest opens (src/cdp_bridge.ts, reached through the
// coordinator as `cdp-*` messages) becomes a Port to the Yurt browser bridge
// extension (extension/), which drives tabs it opens in this browser over
// chrome.debugger. Nothing here understands CDP; it only carries messages.

/** The extension's ID: fixed by the public key in extension/manifest.json. */
export const BRIDGE_EXTENSION_ID = "leelndonobmigkkkogijljomjikkefbe";

/** What the page needs of `chrome.runtime` (present on a page only when an
 *  installed extension lists its origin in `externally_connectable`). */
export type ExtensionPort = {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(fn: (message: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
};
export type ExtensionRuntime = {
  connect(extensionId: string, info?: { name?: string }): ExtensionPort;
};

/** This page's `chrome.runtime`, when an extension offers one. */
export function extensionRuntime(): ExtensionRuntime | undefined {
  const runtime =
    (globalThis as { chrome?: { runtime?: Partial<ExtensionRuntime> } })
      .chrome?.runtime;
  return typeof runtime?.connect === "function"
    ? runtime as ExtensionRuntime
    : undefined;
}

/** Messages between the page and the coordinator for one connection. */
export type CdpFromWorker =
  | { type: "cdp-open"; conn: number }
  | { type: "cdp-message"; conn: number; text: string }
  | { type: "cdp-close"; conn: number };
export type CdpToWorker =
  | { type: "cdp-send"; conn: number; text: string }
  | { type: "cdp-close"; conn: number };

/** Carry connections between the coordinator (`post`) and the extension
 *  (`runtime`); `handle` takes each `cdp-*` message from the coordinator. */
export function createCdpRelay(
  runtime: ExtensionRuntime,
  post: (message: CdpToWorker) => void,
  extensionId = BRIDGE_EXTENSION_ID,
): { handle(message: CdpFromWorker): void } {
  const ports = new Map<number, ExtensionPort>();
  return {
    handle(message) {
      if (message.type === "cdp-open") {
        let port: ExtensionPort;
        try {
          port = runtime.connect(extensionId, { name: "yurt-cdp" });
        } catch {
          post({ type: "cdp-close", conn: message.conn });
          return;
        }
        ports.set(message.conn, port);
        port.onMessage.addListener((reply) =>
          post({
            type: "cdp-send",
            conn: message.conn,
            text: JSON.stringify(reply),
          })
        );
        port.onDisconnect.addListener(() => {
          if (ports.delete(message.conn)) {
            post({ type: "cdp-close", conn: message.conn });
          }
        });
        return;
      }
      const port = ports.get(message.conn);
      if (message.type === "cdp-message") {
        try {
          port?.postMessage(JSON.parse(message.text));
        } catch {
          // Not JSON, or the extension went away: the guest's client
          // times that request out; nothing else to tell it.
        }
        return;
      }
      if (ports.delete(message.conn)) port?.disconnect();
    },
  };
}
