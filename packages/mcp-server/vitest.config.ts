import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const PKG_ROOT = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    name: "@prd-gen/mcp-server",
    root: PKG_ROOT,
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**", "**/.claude/**"],

    // Two suites here (`get-pipeline-state-action-format`, `run-semaphore`)
    // must `await import("../pipeline-tools.js")` inside beforeAll rather than
    // at the top: the module reads PRD_MAX_CONCURRENT_RUNS at init, so the env
    // var has to be set first. That import pulls in the orchestration,
    // validation and verification trees, and the cold TypeScript transform of
    // that graph legitimately exceeds vitest's 10 s default hook timeout when
    // the workspace runs all ~97 files in parallel.
    //
    // This was flaky on `main` before the suite grew — one observed full run
    // failed 5 files, the next passed all 90 — because the default is a
    // wall-clock threshold on an operation whose duration scales with machine
    // load, not a hang. 60 s is far above the loaded-machine cost and still
    // low enough to fail fast on a genuine deadlock.
    //
    // source: measured on this workspace — the failing runs report aggregate
    // transform 201 s / import 242 s across the parallel suite; the same two
    // files complete in well under a second when run alone.
    hookTimeout: 60_000,

    // A home directory per test file: the server writes under `~/.prd-gen/`
    // (see the file).
    setupFiles: ["src/__tests__/home-of-its-own.setup.ts"],
  },
});
