# Contributing to AI Architect MCP Spec

Thanks for considering a contribution. This project's quality bar comes from
[`rules/coding-standards.md`](https://github.com/cdeust/zetetic-team-subagents/blob/main/rules/coding-standards.md)
(the zetetic standard) — every change goes through the same audit cycle that
shaped Phase 3 and Phase 4.

---

## What this project is

A stateless reducer (`step(state, result?) → next_state, action`) packaged as
an MCP server, with multi-judge verification, deterministic Hard Output Rules
validation, and research-evidence-backed strategy selection. Ten workspace
packages with strict Clean Architecture layering. See [README](README.md) for
the architecture diagram.

---

## Dev setup

**Prerequisites:** Node.js 20.x or 22.x, pnpm v10+ (`corepack enable && corepack prepare pnpm@10`).

```bash
git clone https://github.com/cdeust/ai-architect-mcp-spec.git
cd ai-architect-mcp-spec
pnpm install --frozen-lockfile
pnpm build              # builds all 9 buildable packages
pnpm test               # runs the full test suite (currently 258 tests + 2 integration skipped)
```

The `pnpm verify` script runs install + build + test together — same as CI.

---

## Branching + workflow

- `main` is the integration branch. PRs land here.
- Branch naming: `feature/<short-slug>`, `fix/<short-slug>`, `docs/<short-slug>`, `refactor/<short-slug>`.
- One concern per PR. A bug fix doesn't need surrounding cleanup; a refactor doesn't add features.
- Conventional commit messages preferred but not enforced.

---

## The audit cycle (mandatory for non-trivial changes)

Every non-trivial change goes through a cross-audit before it lands. The
process is automated — agents do the audits — but the discipline is real:

1. **Engineering team review.** Spawn `code-reviewer`, `architect`, `test-engineer`,
   `refactorer`, `security-auditor` (when relevant). Each produces a ranked
   finding list against `rules/coding-standards.md`.
2. **Genius team review.** Spawn the relevant reasoning patterns from
   [zetetic-team-subagents](https://github.com/cdeust/zetetic-team-subagents):
   `feynman` (integrity), `curie` (measurement), `popper` (falsifiability),
   `dijkstra` (correctness), and others depending on the change shape.
3. **Address findings.** CRIT and HIGH must be closed before merge. MEDs may
   be deferred with explicit follow-up tasks.
4. **Re-run the cycle** if any structural change was made in step 3.

The Phase 3+4 audit cycle is documented in [`docs/PHASE_4_PLAN.md`](docs/PHASE_4_PLAN.md)
and the cross-audit findings are visible in commit history. Every PR
description should reference which audits ran and what was found.

---

## Coding standards (excerpt)

Full text in [`rules/coding-standards.md`](https://github.com/cdeust/zetetic-team-subagents/blob/main/rules/coding-standards.md). Key load-bearing rules:

- **§2.2 Layer dependency:** `core ← validation/verification/strategy/meta-prompting ← orchestration ← mcp-server`. Inner layers MUST NOT import outward. Layer violations block merge.
- **§3.2 No `any`:** in production code. `as any` requires an ADR.
- **§4.1 File ≤500 lines.** §4.2 Function ≤50 lines. Test files exempt from §4.1, not §4.2.
- **§7 Local reasoning:** prefer explicit dispatch tables over reflection; the next reader should understand the function from its signature + body alone.
- **§8 Source discipline:** every numeric constant ≥3 significant digits requires `// source: <citation | benchmark | measured | provisional heuristic>`. The pre-commit hook from
  [zetetic-team-subagents](https://github.com/cdeust/zetetic-team-subagents) enforces this.

---

## Testing

**The policy, stated plainly: every change that adds or alters externally
observable behaviour must arrive with tests for that behaviour, in the same
pull request.** A bug fix carries a regression test that fails on the pre-fix
code. A new function carries contract tests for its postconditions. A new error
path carries a test asserting the observable effect of taking it, including the
signal it emits — not only a downstream side effect. Changes that alter no
behaviour (formatting, comments, documentation) are exempt, and saying so in the
PR description is enough.

This is checked during review, and a PR that adds behaviour without tests is
sent back rather than merged with a follow-up promise.

- **Contract tests, not implementation mirrors.** Assertions go on observable
  postconditions, not on the formula the function uses to compute its output.
  See `packages/benchmark/src/__tests__/pipeline-kpis.test.ts` for examples.
- **Mutation survival check.** When adding a test, ask: "what mutation would
  this test fail to catch?" If the answer is "any non-trivial one," the test
  is too weak.
- **Coverage by package:**
  - `core` / `validation` / `meta-prompting`: contract tests for every public
    surface.
  - `verification`: invariant tests on consensus distribution.
  - `orchestration`: per-handler injection tests + smoke harness for full runs.
  - `benchmark`: KPI gate tests + golden-fixture HOR scoring.
  - `ecosystem-adapters`: unconditional schema-contract pin against the
    live `ai-architect-mcp-codebase` wire shapes (see
    `docs/INTEGRATION-TESTING.md`).

---

## What NOT to do

- Don't add `// TODO` without an issue reference.
- Don't add backwards-compatibility shims for code paths nobody uses. If it's
  built, it must be called.
- Don't introduce a new abstraction with one implementation. Three concrete
  uses before extracting.
- Don't catch errors "just in case." Either name the failure mode or let it
  propagate.
- Don't add a test that mirrors the implementation. The implementation is
  what we're testing — the test must independently verify the contract.

---

## Code of Conduct

This project follows [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Same
standard applies to issues, PRs, and review discussion as to the project's
own audit cycle: cite, disagree on merits, and acknowledge what you can't
verify.

---

## Reporting security issues

See [`SECURITY.md`](SECURITY.md). Don't open public issues for security
concerns; use the disclosure channel documented there.

---

## License

MIT. Contributions are licensed under the same.
