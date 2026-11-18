// PREVIEW ONLY: first import of the coordinator bundle (src/mem_census.ts).
import { installMemCensus } from "./mem_census.ts";
installMemCensus("coordinator");

// PREVIEW ONLY: the page's `?kmem=<MiB>` arrives as this Worker's name.
const kmem = /^kmem=(\d+)$/.exec(String(self.name ?? ""));
if (kmem) {
  (globalThis as { __yurtKernelMaximumPages?: number })
    .__yurtKernelMaximumPages = Number(kmem[1]) * 16;
}
