// The relay as a Cloudflare Worker (relay/wrangler.toml). JavaScript, not
// TypeScript, only because `cloudflare:sockets` exists on Workers alone and
// the repository's `deno check` would refuse the import; wrangler bundles
// relay.ts from here.
//
// Workers' connect() cannot reach Cloudflare's own addresses (sites behind
// Cloudflare): those connects fail as refused. Fastly-hosted PyPI and
// GitHub are reachable.
import { connect } from "cloudflare:sockets";
import { createRelay } from "./relay.ts";

/** A name's A records through DNS over HTTPS (Workers have no resolver
 * API). */
async function resolve(name) {
  const response = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${
      encodeURIComponent(name)
    }&type=A`,
    { headers: { accept: "application/dns-json" } },
  );
  if (!response.ok) throw new Error(`DoH ${response.status}`);
  const answer = await response.json();
  return (answer.Answer ?? []).filter((record) => record.type === 1)
    .map((record) => record.data);
}

async function connectTcp(ip, port) {
  const socket = connect({ hostname: ip, port });
  await socket.opened;
  return {
    readable: socket.readable,
    writable: socket.writable,
    close: () => socket.close(),
  };
}

function upgrade() {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  return {
    socket: server,
    response: new Response(null, { status: 101, webSocket: client }),
  };
}

let relay;

export default {
  fetch(request, env) {
    relay ??= createRelay({
      secret: env.RELAY_SECRET,
      allowedOrigins: env.RELAY_ORIGINS.split(",").map((o) => o.trim()),
      resolve,
      connect: connectTcp,
      upgrade,
    });
    return relay.handle(request);
  },
};
