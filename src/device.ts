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
