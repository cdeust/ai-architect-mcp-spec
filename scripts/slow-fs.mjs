// Loaded with `node --import` (NODE_OPTIONS) to put a runner starved by sibling
// pipelines into a test: every write through node:fs/promises waits first.
// Nothing in production code changes; only the process under test is slowed.
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const delay = Number(process.env.SLOW_FS_MS ?? 0);
if (Number.isFinite(delay) && delay > 0) {
  const write = fsp.writeFile;
  fsp.writeFile = async (...args) => {
    await new Promise(resolve => setTimeout(resolve, delay));
    return write(...args);
  };
  syncBuiltinESMExports();
}
