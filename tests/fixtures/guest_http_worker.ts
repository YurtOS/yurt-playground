/// <reference lib="deno.worker" />
import {
  bootPlayground,
  type BrowserPlaygroundSession,
  fetchPlaygroundBytes,
  type ResidentHandle,
} from "../../src/boot.ts";
import { ExecutionRegistry } from "../../src/executions.ts";
import { requestGuestHttp } from "../../src/guest_http.ts";
import {
  parseGuestAbort,
  parseGuestRequest,
} from "../../src/datasette_protocol.ts";
import { installCoordinatorWorkerProxy } from "../../src/page_worker_bridge.ts";
installCoordinatorWorkerProxy();
const sessionId = "44444444-4444-4444-8444-444444444444",
  prefix = `/apps/datasette/${sessionId}/`;
let guest: BrowserPlaygroundSession, registry: ExecutionRegistry;
let resident: ResidentHandle | undefined;
const pending = new Map<string, AbortController>();
const python = `
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
ROOT=Path('/home/user/demo_http')
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  path=self.path.split('?',1)[0]
  if path.endswith('asset.js'):
   data=b'document.body.dataset.asset="loaded"'; kind='text/javascript'
  else:
   data=('<html><body><h1>'+ROOT.joinpath('value').read_text()+'</h1><script src="${prefix}asset.js"></script></body></html>').encode(); kind='text/html'
  self.send_response(200);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
HTTPServer(('127.0.0.1',8001),Handler).serve_forever()
`;
async function finite(line: string, stdin?: string) {
  const id = await registry.spawn(line, { stdin, timeoutMs: 120000 });
  const r = await registry.wait(id);
  if (!("code" in r) || r.code !== 0) throw new Error(JSON.stringify(r));
  return r;
}
function state(state: string) {
  self.postMessage({
    type: "datasette-state",
    app: "datasette",
    snapshot: { state, session: sessionId, prefix },
  });
}
self.onmessage = async (e) => {
  try {
    const m = e.data;
    if (m.type === "boot") {
      const term = {
        cols: 80,
        rows: 24,
        write: () => {},
        onData: () => {},
        onResize: () => {},
      };
      guest = await bootPlayground({
        isolated: true,
        fetchBytes: fetchPlaygroundBytes,
        term,
        show: (text) => self.postMessage({ type: "progress", text }),
      });
      registry = new ExecutionRegistry(guest.process!, guest.signal!);
      await finite(
        "mkdir -p /home/user/demo_http && exec sh -c 'cat > /home/user/demo_http/server.py'",
        python,
      );
      await finite("printf original > /home/user/demo_http/value");
      self.postMessage({
        type: "guest-app-qualification",
        apps: { datasette: ["sha256-" + "A".repeat(43) + "="] },
      });
      return;
    }
    if (m.type === "datasette-start") {
      state("starting");
      resident = await guest.spawn(
        "exec python3 /home/user/demo_http/server.py > /home/user/demo_http/log 2>&1",
      );
      const deadline = performance.now() + 240000;
      let ready = false;
      while (performance.now() < deadline) {
        try {
          const r = await requestGuestHttp(
            () => Promise.resolve(guest.dialSandboxPort(8001)),
            {
              app: "datasette",
              session: sessionId,
              prefix,
              path: prefix,
              method: "GET",
              headers: [],
              timeoutMs: 30000,
              signal: new AbortController().signal,
            },
          );
          if (r.status === 200) {
            ready = true;
            break;
          }
        } catch {
          // Retry while the guest interpreter imports its server modules.
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!ready) throw new Error("real guest server not ready");
      state("running");
      return;
    }
    if (m.type === "datasette-stop" || m.type === "datasette-reset") {
      for (const c of pending.values()) c.abort();
      if (resident) {
        await resident.signalPid(15);
        await resident.exited;
        resident = undefined;
      }
      state("stopped");
      return;
    }
    if (m.type === "test-log") {
      const result = await finite("exec tail -c 8192 /home/user/demo_http/log");
      self.postMessage({ type: "log", text: result.stdout });
      return;
    }
    if (m.type === "test-edit") {
      await finite("printf changed > /home/user/demo_http/value");
      self.postMessage({ type: "edited" });
      return;
    }
    const abort = parseGuestAbort(m);
    if (abort) {
      pending.get(abort.requestId)?.abort();
      return;
    }
    const request = parseGuestRequest(m);
    if (request) {
      const controller = new AbortController();
      pending.set(request.requestId, controller);
      try {
        const reply = await requestGuestHttp(
          () => Promise.resolve(guest.dialSandboxPort(8001)),
          { ...request, app: "datasette", prefix, signal: controller.signal },
        );
        self.postMessage({
          ...reply,
          type: "datasette-response",
          session: sessionId,
          requestId: request.requestId,
        }, [reply.body]);
      } catch (error) {
        self.postMessage({
          type: "datasette-error",
          session: sessionId,
          requestId: request.requestId,
          code: 502,
          message: String(error),
        });
      } finally {
        pending.delete(request.requestId);
      }
    }
  } catch (error) {
    self.postMessage({ type: "test-error", message: String(error) });
  }
};
