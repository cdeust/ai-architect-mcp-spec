import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { TEST_TIMEOUT_MS } from "../../vitest.shared.mts";

const PKG_ROOT = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    testTimeout: TEST_TIMEOUT_MS,
    name: "@prd-gen/benchmark",
    root: PKG_ROOT,
    include: ["src/**/*.test.ts", "calibration/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**", "**/.claude/**"],
  },
});
