import { defineConfig } from "vitest/config";

// Vitest v4 root config with explicit projects list. Replaces the legacy
// `vitest.workspace.ts` (which v4 no longer auto-discovers). Listing the
// projects explicitly also prevents glob-based discovery from reaching
// into `.claude/worktrees/agent-*/packages/*/vitest.config.ts` when an
// orchestrator agent is running.
export default defineConfig({
  test: {
    projects: [
      "./packages/benchmark/vitest.config.ts",
      "./packages/core/vitest.config.ts",
      "./packages/ecosystem-adapters/vitest.config.ts",
      "./packages/meta-prompting/vitest.config.ts",
      "./packages/mcp-server/vitest.config.ts",
      "./packages/orchestration/vitest.config.ts",
      "./packages/strategy/vitest.config.ts",
      "./packages/validation/vitest.config.ts",
      "./packages/verification/vitest.config.ts",
      "./scripts/release/vitest.config.mts",
    ],

    // Statement coverage is a gate, not a dashboard: `pnpm test:coverage`
    // fails below the threshold rather than printing a number nobody reads.
    //
    // source: OpenSSF Best Practices silver criterion `test_statement_coverage80`
    // — "MUST have FLOSS automated test suite that provides at least 80%
    // statement coverage". The floor is theirs; the exclusions below are ours
    // and each states why.
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "**/__tests__/**",
        "**/*.d.ts",
        // Process entry points, not logic. Excluded because they are covered
        // where it actually matters and v8 cannot see it from in-process unit
        // tests:
        //
        //   mcp-server/src/index.ts — the server bootstrap. It IS executed
        //   end-to-end by `scripts/release/smoke-mcpb.sh`, which starts the
        //   built artifact and speaks MCP to it over stdio; that runs in a
        //   separate process, so nothing it covers appears here. Counting it
        //   as uncovered would misreport the one path with the strongest test.
        "packages/mcp-server/src/index.ts",
      ],
      reporter: ["text-summary", "json-summary"],
      thresholds: {
        statements: 80,
      },
    },
  },
});
