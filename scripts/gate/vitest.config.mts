import { defineConfig } from "vitest/config";

// The delivery gate's own tests (scripts/gate). Outside packages/, like the
// release tooling: the gate is not part of any shipped package. Listed in
// the root vitest.config.mts so `pnpm test` runs it.
export default defineConfig({
  test: {
    name: "gate",
    include: ["**/*.test.mjs"],
  },
});
