import { assertEquals } from "@std/assert";
import { datasetteControls } from "../src/datasette_page.ts";
Deno.test("Datasette controls remain hidden until browser qualification", () => {
  assertEquals(datasetteControls(false, "stopped"), {
    hidden: true,
    start: false,
    stop: false,
    reset: false,
    download: false,
  });
  assertEquals(datasetteControls(true, "starting"), {
    hidden: false,
    start: false,
    stop: true,
    reset: false,
    download: false,
  });
  assertEquals(datasetteControls(true, "running"), {
    hidden: false,
    start: false,
    stop: true,
    reset: true,
    download: true,
  });
  assertEquals(datasetteControls(true, "stuck"), {
    hidden: false,
    start: false,
    stop: false,
    reset: false,
    download: false,
  });
});
