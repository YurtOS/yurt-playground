import { loadPins } from "../src/pins.ts";
const pins = await loadPins(
  new URL("../artifacts/pins.json", import.meta.url).pathname,
);
if (pins.datasetteDiagnostic) throw new Error(pins.datasetteDiagnostic);
console.log(pins.datasette !== undefined ? "true" : "false");
