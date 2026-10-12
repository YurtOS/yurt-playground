import { assertEquals, assertThrows } from "@std/assert";
import {
  type SyncHandleYurtDevice,
  YurtMountError,
} from "@yurt/kernel-host-interface-js";
import { mountGuestRoot } from "../src/boot.ts";

function fakeDevice() {
  const device = { closed: 0, close: () => void device.closed++ };
  return device;
}

function kernelThatThrows(error: Error) {
  return {
    mountYurtDevice: (): number => {
      throw error;
    },
  };
}

Deno.test("mountGuestRoot mounts the device and closes nothing", () => {
  const device = fakeDevice();
  const refusal = mountGuestRoot(
    { mountYurtDevice: () => 10 },
    device as unknown as SyncHandleYurtDevice,
  );
  assertEquals(refusal, undefined);
  assertEquals(device.closed, 0);
});

Deno.test("a mount that failed before the install falls back, handles closed", () => {
  const device = fakeDevice();
  const refusal = mountGuestRoot(
    kernelThatThrows(
      new YurtMountError("open_tree /proc failed: rc=-1", false),
    ),
    device as unknown as SyncHandleYurtDevice,
  );
  assertEquals(
    refusal,
    "mounting browser storage failed: open_tree /proc failed: rc=-1",
  );
  assertEquals(device.closed, 1);
});

Deno.test("a mount that failed after the install fails the boot", () => {
  const device = fakeDevice();
  assertThrows(
    () =>
      mountGuestRoot(
        kernelThatThrows(new YurtMountError("move_mount onto /proc", true)),
        device as unknown as SyncHandleYurtDevice,
      ),
    Error,
    "half mounted",
  );
  assertEquals(device.closed, 0);
});
