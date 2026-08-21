import { assertEquals } from "@std/assert";
import {
  buildKernelLaunchCommand,
  JUPYTER_CONNECTION_FILE,
} from "../src/jupyter.ts";

Deno.test("Jupyter launch uses Python 3 and a guest connection file", () => {
  assertEquals(
    buildKernelLaunchCommand(),
    `python3 -m ipykernel_launcher --ip=127.0.0.1 --transport=tcp ` +
      `--Session.key=yurt --f=${JUPYTER_CONNECTION_FILE}`,
  );
});
