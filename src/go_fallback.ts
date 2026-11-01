/**
 * Go's page without Go's snapshot: when the pinned one cannot be restored
 * (the live index now offers another go build, a download that failed),
 * the page boots the slim image instead, which has no go. Rather than
 * leave a bare shell where the start screen promised Go, the coordinator
 * installs the go package with the guest's pkg, as the Python page
 * installs its set, and says so in the terminal: that sandbox has no warm
 * build cache, so its first build compiles the standard library.
 */

/** Exit 0 when `go` is on the login user's PATH. */
export const GO_PROBE_LINE = "exec /bin/sh -c 'command -v go >/dev/null'";

/** What the terminal says before the install. */
export const GO_FALLBACK_NOTE =
  "[Go's sandbox could not be restored, so this is a fresh one: installing go with pkg. " +
  "Its first go build compiles the standard library, about 10 minutes in a tab; later builds take seconds.]";

/** Install go unless the sandbox has it: "present" (Go's snapshot was
 * restored), "installed", or "failed" -- said in the terminal with what
 * to type instead, never thrown: the shell stays usable either way. */
export async function ensureGo(deps: {
  /** Whether go is on the PATH; undefined when that cannot be told. */
  probe(): Promise<boolean | undefined>;
  install(): Promise<void>;
  say(text: string): void;
}): Promise<"present" | "installed" | "failed"> {
  if (await deps.probe() !== false) return "present";
  deps.say(GO_FALLBACK_NOTE);
  try {
    await deps.install();
  } catch (error) {
    deps.say(
      `[installing go failed: ${
        error instanceof Error ? error.message : String(error)
      }; sudo pkg install go tries again]`,
    );
    return "failed";
  }
  deps.say("[go is installed]");
  return "installed";
}
