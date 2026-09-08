# Agent guidance for ai-architect-mcp-spec

This is the former body of `CLAUDE.md`, moved here on 2026-09-08 so that it is read on
demand instead of being re-sent to the model on every turn (owner correction: CLAUDE.md
stays nearly empty; the host harness loads what it needs when it needs it). Nothing was
removed except the dangling "Global rules are imported, not restated" sentence, whose
import lines were already removed in an earlier commit — with no lines left to import, the
sentence had nothing to point at.

# ai-architect-mcp-spec

PRD generation and verification MCP (prd-gen). Node.js host-driven pipeline runner.

## Repo-specific constraints

- The tools are a strongly ordered pipeline: start_pipeline then submit_action_result until done; calling them out of order does not error, it leaves the run in a wrong state.
- The host executes each emitted NextAction; the server never runs them itself.
- Verification tools (plan_*_verification, conclude_verification) are a separate stage from generation.

## Etiquette

Conventional commits, staged file-by-file. One PR per concern. A pull request merges when
CI is green and a review verdict is posted on it; the owner does not gate merges by hand.
CI is the authority: it exists to catch regressions and enforce the engineering standards.
