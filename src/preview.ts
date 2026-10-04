import type { GuestAppContext, GuestAppSpec } from "./guest_app.ts";

const DIR = "/home/user/demos/preview";
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const decoder = new TextDecoder();

async function install(ctx: GuestAppContext, defaultsOnly: boolean) {
  await ctx.finite(`mkdir -p ${quote(DIR + "/site")}`);
  await ctx.finite(
    `cat > ${quote(DIR + "/preview_server.py")}`,
    await ctx.asset("preview_server.py"),
  );
  for (
    const [asset, target] of [
      ["preview_index.html", DIR + "/site/index.html"],
      ["preview_app.js", DIR + "/site/app.js"],
    ]
  ) {
    const command = defaultsOnly
      ? `if [ ! -e ${quote(target)} ]; then cat > ${quote(target)}; fi`
      : `cat > ${quote(target)}`;
    await ctx.finite(command, await ctx.asset(asset));
  }
}

export const previewSpec: GuestAppSpec = {
  id: "preview",
  title: "Preview",
  dir: DIR,
  prepare: (ctx) => install(ctx, true),
  reset: (ctx) => install(ctx, false),
  spawnLine: (prefix, port) =>
    `exec python3 ${quote(DIR + "/preview_server.py")} ${port} ${
      quote(prefix)
    } ${quote(DIR + "/site")}`,
  readyPath: (prefix) => prefix + "__ready",
  isReady: (reply) =>
    reply.status === 200 &&
    decoder.decode(reply.body) === "yurt-preview-ready",
};
