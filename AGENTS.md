# ai-architect-mcp-spec

This project implements the stateless PRD pipeline reducer and its MCP host protocol.
Read `CLAUDE.md`, `docs/agent-guidance.md` and `CONTRIBUTING.md` before changes or reviews.

## Review guidelines

- Preserve the host-driven contract: the server emits NextAction and the host executes it. Keep generation, submission and verification in their documented order.
- Enforce the dependency direction in CONTRIBUTING.md: core is inward of validation/verification/strategy/meta-prompting, then orchestration, then mcp-server. Production TypeScript `any` requires the documented ADR.
- Observable behavior changes must include contract or regression tests in the same PR, including error paths and emitted signals. Apply the project's source-discipline rules to constants and research claims.
