/**
 * Which kind of device the page runs on. A phone or tablet tab has too
 * little memory for Python and Jupyter: a tablet gets the shell only; a
 * phone gets no Start unless `?start-anyway`, and then no Python, and the
 * Notebook and JupyterLab pages boot nothing on a phone.
 *
 * iPadOS Safari reports a Mac, at any width (a 13" iPad in landscape is
 * wider than many laptops). An iPad reports 5 touch points, a Mac 0
 * (1 under DevTools touch emulation), so more than one identifies it (#195).
 * iPhone Safari's "Request Desktop Website" sends the same Mac UA and touch
 * points, and lays out at 980 px; its screen still says phone. iOS reports
 * the portrait screen in either orientation: at most 440 px on an iPhone,
 * at least 744 on an iPad (#214).
 * Android Chrome's "Desktop site" sends a Linux desktop UA with
 * `userAgentData.mobile` false and lays out at 980 px, but its screen and
 * coarse pointer stay the phone's. Chrome's own phone/tablet line is a
 * smallest screen side of 600 dp (#216). An Android tablet in "Desktop
 * site", which Chrome turns on by default on large tablets, sends the same
 * override with a tablet's screen. Its `navigator.platform` is Chrome's
 * reduced Android value, "Linux armv81", whatever the UA override; Chrome
 * on a Linux PC or a Chromebook reports "Linux x86_64" (#217).
 */
export function deviceClass(): "phone" | "tablet" | "desktop" {
  const uaData = (navigator as { userAgentData?: { mobile?: boolean } })
    .userAgentData;
  const ua = navigator.userAgent;
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) {
    return Math.min(screen.width, screen.height) < 600 ? "phone" : "tablet";
  }
  if (/iPad/.test(ua)) return "tablet";
  if (uaData?.mobile === true || /iPhone|iPod|Android.*Mobile/i.test(ua)) {
    return "phone";
  }
  const coarse = matchMedia("(pointer: coarse)").matches;
  if (coarse && Math.min(screen.width, screen.height) < 600) return "phone";
  if (
    /Android|Silk/i.test(ua) ||
    navigator.platform === "Linux armv81" ||
    (coarse && innerWidth < 900)
  ) return "tablet";
  return "desktop";
}

/** Which kind of page this is: what it starts (the shell only on a phone
 * or tablet, Jupyter on a desktop) and which snapshot it restores
 * (src/sandbox_snapshot.ts SNAPSHOT_KINDS). `?platform=` says it in the
 * URL: the page writes its device's there when there is none, and a hand
 * written one overrides the device -- as far as the device can run it. */
export type Platform = "phone" | "tablet" | "desktop";

const PLATFORM_ALIASES: Record<string, Platform> = {
  phone: "phone",
  iphone: "phone",
  tablet: "tablet",
  ipad: "tablet",
  desktop: "desktop",
  mac: "desktop",
};

/** How much a platform asks of the device's memory. */
const PLATFORM_SIZE: Record<Platform, number> = {
  phone: 0,
  tablet: 1,
  desktop: 2,
};

/** `?platform=`'s value as a platform (case aside), or undefined. */
export function parsePlatform(value: string | null): Platform | undefined {
  return value === null ? undefined : PLATFORM_ALIASES[value.toLowerCase()];
}

/** The platform a page on `device` runs as, given `?platform=` (`asked`):
 *
 * - none: the device's own, and the URL gains it (`redirect`);
 * - one the device can run (its own, or a smaller one: a desktop trying
 *   the phone's snapshot): that one;
 * - a bigger one than the device (the desktop's on a phone) or a value
 *   that is no platform: the device's own, with a `note` saying so. An
 *   asked platform is never written away from the URL.
 */
export function choosePlatform(
  device: Platform,
  asked: string | null,
): { platform: Platform; redirect: boolean; note?: string } {
  if (asked === null) return { platform: device, redirect: true };
  const platform = parsePlatform(asked);
  if (platform === undefined) {
    return {
      platform: device,
      redirect: false,
      note:
        `?platform=${asked} is not phone, tablet or desktop (or iphone, ipad, mac): this page runs as this ${device}`,
    };
  }
  if (PLATFORM_SIZE[platform] > PLATFORM_SIZE[device]) {
    return {
      platform: device,
      redirect: false,
      note:
        `This ${device} has too little memory for the ${platform} page, so it runs the ${device}'s instead`,
    };
  }
  return { platform, redirect: false };
}

/** `href` with `?platform=<platform>` added, every other parameter and the
 * fragment kept. */
export function withPlatform(href: string, platform: Platform): string {
  const url = new URL(href);
  url.searchParams.set("platform", platform);
  return url.href;
}
