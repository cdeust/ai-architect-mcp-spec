# Native CI release verification, 2026-10-28

Worktree: `.Codex/worktrees/native-review-ci`, based on main616eb043b7e73ca39f00b3d772e54f8d3b1c5385. No model accounts or native client GUI sessions were invoked for these contract checks.

Using the private `.ci-toolchain/bin` Node22.23.4 and pnpm10.34.9 installation, `pnpm exec vitest run --project release` passed two files and nine tests. The CI E2E contract reads the actual `ci.json` command, verifies its seven stages execute in order, and verifies failure at each stage stops all subsequent commands.

The first run reported Vite warnings for ESM syntax in CommonJS-detected root and release `.ts` configs. Both configs were renamed to `.mts`; the root release-project reference, release comment and ROADMAP filename reference were updated. Byte comparison against HEAD proves all test and coverage settings were preserved. The same nine tests pass without warnings with both the default loader and `--configLoader native`.

Sources for config discovery and ESM loading:
- https://main.vitest.dev/config/
- https://vite.dev/config/

Six native CI workflows pass actionlint, and `git diff --check` passes. The only tracked build-generated change was `mcp-server/index.js`; that file was restored to HEAD, preserving intentional CI edits. No commit or push was made by this worker.

Private test installations remain for the owner to use before publication: `.ci-toolchain`253MiB, root `node_modules`146MiB, ignored package dist directories and package node_modules links, plus tsconfig build metadata. The tracked `packages/mcp-server/dist` tree is preserved. Dispose only after publication verification and minimal evidence preservation.

Native CI source: zetetic-team-subagents commit df381f830ed2cf40b204002a15fe2a695f860dd2. Both Claude workflows use owner-selected claude-opus-5-5; all five unchanged upstream reviewer definitions inherit it. Model reference: https://platform.claude.com/docs/en/models/opus-5-5/overview.
