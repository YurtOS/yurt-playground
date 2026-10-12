/// <reference lib="deno.worker" />
/**
 * The guest Worker's entry (bundled as `/worker_bootstrap.js`): the
 * kernel's bootstrap, served over the port the page hands it instead of
 * the page itself (see `adoptGuestPort`).
 */
import "@yurt/worker-bootstrap";
import { adoptGuestPort } from "./page_worker_bridge.ts";

adoptGuestPort(
  self as unknown as Parameters<typeof adoptGuestPort>[0],
);
