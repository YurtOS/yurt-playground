import { interruptKernel } from "./jupyter.ts";
import type { JupyterTransport } from "./jupyter_transport.ts";

export type CellInterruptReply = {
  type: "cell-error";
  id: string;
  message: string;
};

/** Turn either interrupt failure into the response that settles its cell. */
export async function requestCellInterrupt(
  transport: JupyterTransport | undefined,
  id: string,
  post: (reply: CellInterruptReply) => void,
): Promise<void> {
  if (transport === undefined) {
    post({ type: "cell-error", id, message: "Jupyter is not ready" });
    return;
  }
  try {
    await interruptKernel(transport);
  } catch (error) {
    post({
      type: "cell-error",
      id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
