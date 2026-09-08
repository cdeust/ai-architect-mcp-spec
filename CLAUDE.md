# ai-architect-mcp-spec

PRD generation and verification MCP (prd-gen). Node.js host-driven pipeline runner.

This file is deliberately short: the host harness (hooks, skills, agents) loads what it
needs on demand. Everything that used to be here is in `docs/agent-guidance.md`
(repo-specific constraints, etiquette). Read it before any non-trivial change. See
CONTRIBUTING.md for the full dev workflow.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm build     # builds all 9 buildable packages
pnpm test      # full test suite
pnpm verify    # install + build + test, same as CI
```

## Non-negotiables

- The tools are a strongly ordered pipeline: start_pipeline then submit_action_result until
  done; calling them out of order does not error, it leaves the run in a wrong state.
- The host executes each emitted NextAction; the server never runs them itself.
- Verification tools (`plan_*_verification`, `conclude_verification`) are a separate stage
  from generation.
