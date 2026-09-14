import type { Page } from "playwright";

/**
 * Chromium reports every Content Security Policy refusal on the console.
 * Collect them so a browser run fails on a policy that is too tight instead
 * of silently losing a stylesheet or a worker.
 */
export function watchCspViolations(page: Page): () => void {
  const violations: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/Content Security Policy/i.test(text)) violations.push(text);
  });
  return () => {
    if (violations.length > 0) {
      throw new Error(
        `CSP violations on ${page.url()}:\n${violations.join("\n")}`,
      );
    }
  };
}
