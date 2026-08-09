# ai-architect-mcp-spec

PRD generation and verification MCP (prd-gen). Node.js host-driven pipeline runner.

Global rules are imported, not restated:

@~/.claude/rules/model-behavior.md
@~/.claude/rules/coding-standards.md

## Repo-specific constraints

- The tools are a strongly ordered pipeline: start_pipeline then submit_action_result until done; calling them out of order does not error, it leaves the run in a wrong state.
- The host executes each emitted NextAction; the server never runs them itself.
- Verification tools (plan_*_verification, conclude_verification) are a separate stage from generation.

## Etiquette

Conventional commits, staged file-by-file. One PR per concern. Do not merge your own PR without the owner's go-ahead.
