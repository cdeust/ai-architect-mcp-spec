# Integration testing

The `pnpm test` suite is hermetic by default — no network access, no
filesystem dependencies beyond the workspace, and no external processes.
This document explains how the MCP protocol contract with each ecosystem
service is verified, and how a live Cortex round-trip (not yet wired)
would be added.

---

## Why the protocol contract needs its own tests

The MCP protocol is a contract between this project and three other
ecosystem services (`ai-architect-mcp-codebase`, `Cortex`, `zetetic-team-subagents`).
Mocked unit tests prove the protocol matches what THIS project expects;
they do not, by themselves, prove a live counterparty sends what this
project expects.

## `ai-architect-mcp-codebase` schema-contract test

**File:** `packages/ecosystem-adapters/src/__tests__/ai-architect-codebase.integration.test.ts`

**Status:** unconditional — runs in every `pnpm test`, no env var or live
binary required. It replaced an earlier version of this file that spawned
the real Rust binary and skipped in CI whenever it was absent (skipping is
equivalent to never running, so the earlier version proved nothing in CI).

**What it proves:**

- `IndexCodebaseRequestSchema` accepts the request shape
  `handleInputAnalysis` constructs.
- `IndexCodebaseResponseSchema` parses the live server's
  `{ graph_path, symbols_indexed, files_parsed, duration_ms }` shape, and
  rejects a response missing `graph_path` loudly (a future server-side
  rename must not silently pass).
- `AiArchitectCodebaseClient.indexCodebase` delegates to the stdio
  transport's `callTool` with the validated request.

**What it does NOT prove (consciously deferred):**

- That the live Rust server actually emits the schema-conformant shape
  today. The schema is the contract; if the server drifts, this test keeps
  passing while production breaks. Mitigation: the schema is paired with a
  source comment in `contracts/codebase.ts` naming the live binary as the
  source of truth, verified against it at authoring time.
- Performance, memory, or behaviour at scale.
- Failure-mode handling beyond malformed/missing `graph_path`.
- Any tool other than `index_codebase`.

If you need to prove the live binary itself still matches the pinned
schema, build it from the companion repo and drive `index_codebase`
manually over stdio:

```bash
git clone https://github.com/cdeust/ai-architect-mcp-codebase.git
cd ai-architect-mcp-codebase
cargo build --release
# First build: ~5 minutes (compiles LadybugDB C++ core).
# Resulting binary: target/release/ai-architect-mcp-codebase
```

---

## Live `Cortex` test (planned, not yet wired)

**Status:** No live Cortex integration test exists in the suite today.
The `call_cortex_tool` action shape is exercised through the canned
dispatcher in smoke + KPI tests, but no test spawns a real Cortex MCP.

**Why:** Cortex requires PostgreSQL + pgvector + a running Cortex MCP
server (Python `uvx` + native dependencies). Standing that up in CI
adds significant complexity for marginal additional coverage — the
`tool_result` shape is already structurally tested and the canned
dispatcher returns the canonical Cortex response shape.

If you want to prove the Cortex contract end-to-end:

1. Install Cortex per its README (`claude plugin install cortex` +
   `cortex-doctor` to verify).
2. Run the ai-architect-mcp-spec MCP server with Cortex registered in your
   `.mcp.json`.
3. Drive a real `/generate-prd` session — the section-generation step
   calls `cortex.recall` for each section. Inspect the returned
   `tool_result.data` shape against the parser in
   `packages/orchestration/src/handlers/section-generation.ts:summarizeRecall`.

A proper integration test would spawn a Cortex MCP via stdio, populate
it with seed memories, and assert the recall response. Tracked as a
follow-up item; PRs welcome.

---

## CI policy

**Hermetic suite (always runs):** `pnpm test` — the full vitest workspace,
including the `ai-architect-mcp-codebase` schema-contract test above.
Mandatory pass on every PR; no live binary or env var required.

**Live-binary round-trip:** not run in CI today. Standing up the Rust
binary (~5 minutes cold, LadybugDB C++ core compile) in CI for marginal
additional coverage over the schema-contract test hasn't been justified.
Run it manually per the previous section when you need to prove the live
binary itself, not just the pinned schema.

**Roadmap:** add a separate `integration.yml` workflow that runs the live
binary round-trip nightly against the latest `ai-architect-mcp-codebase`
release tag. Tracked as follow-up. PRs welcome.

---

## Adding a new integration test

Prefer an **unconditional schema-contract pin** (see the
`ai-architect-mcp-codebase` test above) over a `describe.skipIf`-gated live
test: a skipped test that never runs in CI proves nothing, and a schema
pin still fails loudly the moment the wire contract drifts.

If the contract genuinely cannot be pinned without a live dependency (as
with the planned Cortex test), gate it behind an env var and keep these
conventions:

- **Skip by default.** Never let an integration test fail when the
  dependency isn't installed. The hermetic suite is the contract for
  contributors who don't have the full ecosystem set up.
- **Document the env var in this file.** If you add `AIPRD_FOO_BIN`,
  add a section here describing how to obtain a `foo` binary.
- **Pin a fixture.** Use a small, real artifact in this repo as the
  default test input. Don't depend on absolute paths outside the repo.
- **Time-bound the test.** Cap each `it` at a generous-but-finite
  timeout (10–60s). Hung tests block the whole suite.
- **Document failure modes.** Add a table describing likely causes.
  Operators diagnosing failures need to distinguish "my setup is wrong"
  from "the upstream contract changed."
