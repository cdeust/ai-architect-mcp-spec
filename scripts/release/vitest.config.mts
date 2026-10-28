import { defineConfig } from "vitest/config";

// Release-tooling test project (issue #29). Kept OUT of packages/ on purpose:
// the .mcpb-checksum verifier is a release/packaging concern, not part of any
// shipped workspace package, and it must not be pulled into the mcp-server
// bundle. Listed in the root vitest.config.mts `projects` array so `pnpm test`
// (the CI gate) runs it alongside the package suites.
export default defineConfig({
  test: {
    name: "release",
    include: ["**/*.test.mjs"],
  },
});
