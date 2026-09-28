import { assertEquals } from "@std/assert";
import { bootPlayground } from "../src/boot.ts";
import { ExecutionRegistry } from "../src/executions.ts";
import {
  fetchViaHandler,
  memoryTerm,
  resolvePlaygroundArtifacts,
} from "./ash_harness.ts";
Deno.test({
  name:
    "Datasette guest seed preserves edits and reset preserves foreign files",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const source = await Deno.readTextFile(
      new URL("../public/demo/datasette_seed.py", import.meta.url),
    );
    if (!await resolvePlaygroundArtifacts(true)) {
      throw new Error("guest artifacts required");
    }
    const session = await bootPlayground({
      isolated: true,
      fetchBytes: fetchViaHandler,
      term: memoryTerm(),
      show: () => {},
    });
    try {
      const registry = new ExecutionRegistry(session.process!, session.signal!);
      const probe = source +
        `\nimport sqlite3\nfrom pathlib import Path\ndb = sqlite3.connect(DB_PATH)\nassert db.execute('SELECT COUNT(*) FROM orders').fetchone()[0] == 12\nassert db.execute('SELECT product, SUM(quantity*unit_price_cents) FROM orders GROUP BY product ORDER BY 2 DESC, product').fetchall() == [('Mug',8400),('Notebook',4000),('Pen',2000)]\ndb.execute(\"INSERT INTO orders VALUES (13, '2026-01-07', 'Pen', 10, 100)\")\ndb.commit()\ndb.close()\nseed(False)\ndb = sqlite3.connect(DB_PATH)\nassert db.execute('SELECT COUNT(*) FROM orders').fetchone()[0] == 13\ndb.close()\nsentinel=Path(DB_PATH).parent/'keep.txt'\nsentinel.write_text('keep')\nseed(True)\nassert sentinel.read_text() == 'keep'\ndb = sqlite3.connect(DB_PATH)\nassert db.execute('SELECT COUNT(*) FROM orders').fetchone()[0] == 12\nassert db.execute(\"SELECT SUM(quantity*unit_price_cents) FROM orders WHERE product='Pen'\").fetchone()[0] == 2000\ndb.close()\nprint('SEED_PROBE_OK')\n`;
      const id = await registry.spawn("exec python3 -", {
        stdin: probe,
        timeoutMs: 120000,
      });
      const result = await registry.wait(id);
      assertEquals(
        "code" in result ? result.code : undefined,
        0,
        result.stderr,
      );
      assertEquals(result.stdout.trim(), "SEED_PROBE_OK");
    } finally {
      session.stop();
    }
  },
});
