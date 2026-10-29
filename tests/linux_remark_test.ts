import { assertEquals } from "@std/assert";
import { linuxRemark } from "../src/linux_remark.ts";

const release = (name: string, version: string) => ({
  name,
  version,
  build: "yurt_0",
});

Deno.test("the remark names the shell, git and Python, and says what is missing", () => {
  const base = [
    release("ca-certificates", "2026.9.25"),
    release("git", "2.55.0"),
  ];
  // The phone's: the slim image as it boots.
  assertEquals(
    linuxRemark(base),
    "BusyBox shell, git 2.55.0, ca-certificates; no Python, no Jupyter",
  );
  // The tablet's: python alone.
  assertEquals(
    linuxRemark([...base, release("python", "3.14.7")]),
    "BusyBox shell, git 2.55.0, Python 3.14.7, ca-certificates; no Jupyter",
  );
  // The desktop's: the whole set.
  assertEquals(
    linuxRemark([
      ...base,
      release("python", "3.14.7"),
      release("numpy", "2.5.0"),
      release("pyzmq", "26.4.0"),
      release("jupyter-kernel", "0.0.1"),
    ]),
    "BusyBox shell, git 2.55.0, Python 3.14.7, numpy 2.5.0, pyzmq 26.4.0, Jupyter kernel 0.0.1, ca-certificates",
  );
  // Nothing installed, or a list that could not be read.
  assertEquals(linuxRemark([]), "BusyBox shell; no Python, no Jupyter");
  // More than one other package is counted, not listed.
  assertEquals(
    linuxRemark([...base, release("jq", "1.7"), release("xz", "5.6")]),
    "BusyBox shell, git 2.55.0, 3 more packages (pkg list); no Python, no Jupyter",
  );
});
