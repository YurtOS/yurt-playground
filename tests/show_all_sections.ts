/**
 * For a scene that drives several of the home page's sections at once (the
 * terminal and the Python cell): every section shown, as without the sidebar's
 * script. The sidebar itself has its own scene in tests/agent_e2e.ts.
 */
import type { Page } from "playwright";

export async function showAllSections(page: Page): Promise<Page> {
  await page.addInitScript(() => {
    addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = ".views > .view-off { position: static; " +
        "height: auto; overflow: visible; visibility: visible; }";
      document.head.append(style);
    });
  });
  return page;
}
