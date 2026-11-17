/**
 * The one script an HTML output's frame runs (output_frame.ts): it reports
 * the document's height to the page whenever it changes, so the frame fits
 * its content. The frame's own policy and the page's admit it by its hash
 * (src/csp.ts holds it as a literal, which tests/csp_test.ts checks against
 * this string), so it must stay one fixed string.
 */
export const OUTPUT_FRAME_SIZER =
  'new ResizeObserver(() => parent.postMessage({ yurtOutputHeight: document.documentElement.getBoundingClientRect().height }, "*")).observe(document.documentElement);';
