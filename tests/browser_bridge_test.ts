import { assertEquals } from "@std/assert";
import {
  BRIDGE_EXTENSION_ID,
  type CdpToWorker,
  createCdpRelay,
  type ExtensionPort,
} from "../src/browser_bridge.ts";
import { BROWSER_PATH, httpReply, versionJson } from "../src/cdp_bridge.ts";

function fakeRuntime() {
  const ports: {
    id: string;
    sent: unknown[];
    onMessage?: (m: unknown) => void;
    onDisconnect?: () => void;
    disconnected: boolean;
  }[] = [];
  return {
    ports,
    runtime: {
      connect(id: string): ExtensionPort {
        const port = {
          id,
          sent: [] as unknown[],
          disconnected: false,
        } as typeof ports[number];
        ports.push(port);
        return {
          postMessage: (m) => port.sent.push(m),
          disconnect: () => port.disconnected = true,
          onMessage: { addListener: (fn) => port.onMessage = fn },
          onDisconnect: { addListener: (fn) => port.onDisconnect = fn },
        };
      },
    },
  };
}

Deno.test("each guest connection is its own Port to the bridge extension", () => {
  const { ports, runtime } = fakeRuntime();
  const posted: CdpToWorker[] = [];
  const relay = createCdpRelay(runtime, (m) => posted.push(m));
  relay.handle({ type: "cdp-open", conn: 7 });
  relay.handle({ type: "cdp-open", conn: 8 });
  assertEquals(ports.map((p) => p.id), [
    BRIDGE_EXTENSION_ID,
    BRIDGE_EXTENSION_ID,
  ]);
  // Guest -> extension: parsed JSON, on that connection's Port.
  relay.handle({
    type: "cdp-message",
    conn: 8,
    text: '{"id":1,"method":"Browser.getVersion"}',
  });
  assertEquals(ports[1].sent, [{ id: 1, method: "Browser.getVersion" }]);
  assertEquals(ports[0].sent, []);
  // Extension -> guest: JSON text, tagged with the connection.
  ports[0].onMessage!({ id: 1, result: {} });
  assertEquals(posted, [{
    type: "cdp-send",
    conn: 7,
    text: '{"id":1,"result":{}}',
  }]);
  // The guest closed: the Port goes; the extension went: the guest is told.
  relay.handle({ type: "cdp-close", conn: 7 });
  assertEquals(ports[0].disconnected, true);
  ports[1].onDisconnect!();
  assertEquals(posted.at(-1), { type: "cdp-close", conn: 8 });
});

Deno.test("a connect the runtime refuses closes the guest's connection", () => {
  const posted: CdpToWorker[] = [];
  const relay = createCdpRelay({
    connect() {
      throw new Error("no such extension");
    },
  }, (m) => posted.push(m));
  relay.handle({ type: "cdp-open", conn: 3 });
  assertEquals(posted, [{ type: "cdp-close", conn: 3 }]);
});

Deno.test("the endpoint answers /json/version and hands /devtools/browser to the WebSocket", () => {
  const version = httpReply("GET", "/json/version", "Chrome (test)")!;
  assertEquals(version.status, 200);
  const body = JSON.parse(version.body);
  assertEquals(body.Browser, "Chrome (test)");
  assertEquals(body.webSocketDebuggerUrl, `ws://127.0.0.1:9222${BROWSER_PATH}`);
  assertEquals(httpReply("GET", "/json/version/", "x")?.status, 200);
  assertEquals(httpReply("GET", BROWSER_PATH, "x"), undefined);
  assertEquals(httpReply("GET", "/devtools/browser/anything", "x"), undefined);
  assertEquals(httpReply("GET", "/json/list", "x")?.status, 404);
  assertEquals(JSON.parse(versionJson("y"))["Protocol-Version"], "1.3");
});
