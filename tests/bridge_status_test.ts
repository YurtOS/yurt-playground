import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  BRIDGE_STATUS_ID,
  describeBridgeState,
  PHONE_REFUSAL,
  refuseOnPhone,
  showBridgeState,
} from "../src/bridge_status.ts";
import { PYTHON_INSTALL, PYTHON_MISSING_TEXT } from "../src/notebook.ts";

/** Just enough of `document` for `showBridgeState`. */
function fakeDocument() {
  type Node = {
    id: string;
    hidden: boolean;
    textContent: string;
    dataset: Record<string, string>;
    attributes: Map<string, string>;
    style: { cssText: string };
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
  };
  const body: Node[] = [];
  const doc = {
    getElementById: (id: string) => body.find((n) => n.id === id) ?? null,
    createElement(): Node {
      const node: Node = {
        id: "",
        hidden: false,
        textContent: "",
        dataset: {},
        attributes: new Map(),
        style: { cssText: "" },
        setAttribute(name, value) {
          node.attributes.set(name, value);
        },
        removeAttribute(name) {
          node.attributes.delete(name);
        },
      };
      return node;
    },
    body: {
      append(node: Node) {
        body.push(node);
      },
    },
  };
  return { doc: doc as unknown as Document, body };
}

Deno.test("the Notebook pages show the boot, hide it once the kernel answers, and keep a failure", () => {
  const { doc, body } = fakeDocument();
  // Nothing to show yet, nothing built.
  showBridgeState(doc, { state: "ready" });
  assertEquals(body.length, 0);
  showBridgeState(doc, { state: "booting", text: "starting Jupyter (5 s)" });
  assertEquals(body.length, 1);
  const [line] = body;
  assertEquals(line.id, BRIDGE_STATUS_ID);
  assertEquals(line.hidden, false);
  assertEquals(line.textContent, "Yurt sandbox: starting Jupyter (5 s)");
  // Above JupyterLite's shell, which covers the whole body.
  assert(/position: fixed/.test(line.style.cssText));
  showBridgeState(doc, { state: "ready" });
  assertEquals(line.hidden, true);
  showBridgeState(doc, { state: "error", text: "Jupyter did not start: x" });
  assertEquals(line.hidden, false);
  assertEquals(line.attributes.get("role"), "alert");
  assertEquals(line.textContent, "Yurt sandbox: Jupyter did not start: x");
  // A late progress line does not wipe the failure.
  showBridgeState(doc, { state: "booting", text: "starting Jupyter (10 s)" });
  assertEquals(line.textContent, "Yurt sandbox: Jupyter did not start: x");
  assertEquals(body.length, 1, "one line, found again");
});

Deno.test("an image without python3 says so on the Notebook pages", () => {
  const { doc, body } = fakeDocument();
  showBridgeState(doc, { state: "python-missing" });
  const [line] = body;
  assertEquals(line.dataset.state, "python-missing");
  assertEquals(line.attributes.get("role"), "alert");
  assert(line.textContent.startsWith(PYTHON_MISSING_TEXT));
  assert(line.textContent.includes(PYTHON_INSTALL.reason));
  assertEquals(describeBridgeState({ state: "ready" }), undefined);
});

Deno.test("lite_bridge shows every state the coordinator posts", () => {
  const bridge = Deno.readTextFileSync(
    new URL("../src/lite_bridge.ts", import.meta.url),
  );
  for (
    const shown of [
      /msg\.type === "python-missing"\) \{[^]*?show\(\{ state: "python-missing", error: msg\.error \}\);\s*rejectReady\(/,
      /msg\.type === "error"\) \{[^}]*show\(\{ state: "error", text: msg\.message \}\);/,
      /show\(\{ state: "ready" \}\);\s*resolveReady\(\);/,
      /worker\.onerror = [^}]*show\(\{ state: "error"/,
    ]
  ) {
    assert(shown.test(bridge), `lite_bridge.ts: ${shown}`);
  }
});

Deno.test("the suspend/resume panel keeps a failure instead of clearing it at the next state", () => {
  const plugin = Deno.readTextFileSync(
    new URL("../jupyterlite/yurt-kernel/src/index.ts", import.meta.url),
  );
  assert(
    /if \(error === undefined\) statusLine\.textContent = "";/.test(plugin),
    "render() clears the line only when no failure is shown",
  );
  assert(/b\.onError\?\.\(\(text\) => \{\s*error = text;/.test(plugin));
  const bridge = Deno.readTextFileSync(
    new URL("../src/snapshot_bridge.ts", import.meta.url),
  );
  assert(
    /case "error":[^]*?for \(const listener of errorListeners\) listener\(msg\.message\);/
      .test(bridge),
    "snapshot_bridge.ts reports the worker's errors to onError",
  );
});

Deno.test("a failed Python install says why and how to try again", () => {
  const text = describeBridgeState({
    state: "python-missing",
    error: "pkg install python failed: offline",
  });
  assertEquals(
    text,
    "Yurt sandbox: installing Python failed: pkg install python failed: offline. Restart the kernel to try again.",
  );
});

Deno.test("the Notebook pages boot nothing on a phone, and say why", () => {
  // A desktop or tablet goes on to boot: no line, no throw.
  for (const device of ["desktop", "tablet"] as const) {
    const { doc, body } = fakeDocument();
    refuseOnPhone(doc, device);
    assertEquals(body.length, 0, device);
  }
  const { doc, body } = fakeDocument();
  assertThrows(() => refuseOnPhone(doc, "phone"), Error, PHONE_REFUSAL);
  const [line] = body;
  assertEquals(line.dataset.state, "error");
  assertEquals(line.attributes.get("role"), "alert");
  assertEquals(line.textContent, `Yurt sandbox: ${PHONE_REFUSAL}`);
  assert(/desktop browser/.test(line.textContent));
  assert(/the home page runs the shell here/.test(line.textContent));
});
