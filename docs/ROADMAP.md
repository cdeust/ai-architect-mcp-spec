# Roadmap

**Version at time of writing:** 0.6.1 · **Written:** 2026-07-27 · **Horizon:** through July 2027
· **Reviewed:** at each minor release, and whenever an item below completes.

This document states what the project intends to do, and what it deliberately will not do, for
at least the next year. It is a direction, not a commitment: items may slip, reorder, or be
dropped when measurement says they should be. When that happens the reason is recorded here
rather than the item quietly disappearing.

The four goals below are in priority order, set by the maintainer on 2026-07-27.

---

## 1. Phase 4: calibration and closed loops

**Why first.** Every constant this pipeline uses to decide something (judge weights,
`MAX_ATTEMPTS`, KPI gate thresholds) is either calibrated against committed data or it is a
guess wearing a number. Phase 4 is the work that closes that gap, and it gates the honesty of
everything downstream.

Full pre-registration, power calculations, and audit lineage live in
[docs/PHASE_4_PLAN.md](PHASE_4_PLAN.md). Summary of intended sequence (ordered per Deming, so
that no item calibrates against a distribution a later item is about to shift):

| Order | Item | Intent |
|---|---|---|
| 1 | 4.3 plan-mismatch fire-rate | Measurement only, no dependencies |
| 2 | 4.1 per-judge reliability calibration | Per-judge weights from oracle-scored outcomes |
| 3 | 4.4 strategy-effectiveness closed feedback loop | Retrieval strategy selection driven by measured effectiveness |
| 4 | 4.2 `MAX_ATTEMPTS` calibration | Retry cap set from the closed-loop retry distribution |
| 5 | 4.5 KPI gate threshold tuning | Gate thresholds from stable post-4.2 distributions |

Four cross-cutting prerequisites apply to every item and are not optional: pre-registration
before data collection (CC-1), the analysis script and its data committed alongside each
constant (CC-2), forced exploration in any closed loop so it cannot lock onto its own early
bias (CC-3), and control charts before any threshold update (CC-4).

**Done means:** no constant in the changed paths ships without a citation, a committed analysis
script, and the data it was computed from. Where data is still thin, gates stay
`hold_provisional` rather than being locked at a convenient value.

## 2. OpenSSF Best Practices: gold as far as one maintainer can take it, plus hardening

**Status:** the **passing** and **silver** badges were both earned on 2026-07-27, each at 100%
of its criteria (passing 67 of 67; silver 55 of 55: 41 met, 9 not applicable, 5
unmet-with-reason). Gold stands at 30% and is blocked on `contributors_unassociated` and
`two_person_review`, which need a second person rather than better engineering.

Every passing and silver criterion is answered in
[`.bestpractices.json`](../.bestpractices.json) at the repository root, which bestpractices.dev
reads directly from the default branch (`RepoJsonDetective`), so the answers live in version
control next to the evidence they cite rather than only in a web form. Five silver criteria are
answered `Unmet` with their reasons (`dco`, `bus_factor`, `internationalization`,
`version_tags_signed`, `hardening`); all are SHOULD or SUGGESTED, and no MUST is unmet at either
level. That file is kept honest by the same gate as the README: its test-count claims are
checked by `scripts/check-doc-claims.mjs` on every push.

Gold criteria that a single-maintainer project can meet, taken from the badge project's own
`criteria/criteria.yml` (level 2), in no fixed order:

- `copyright_per_file`, `license_per_file`: per-file copyright and SPDX headers.
- `test_statement_coverage90` and `test_branch_coverage80`: the coverage gate in
  `vitest.config.mts` is currently set at 80% statements (the silver floor) with no branch gate.
  Measured on 2026-07-27: 81.14% statements, 74.06% branches. Gold needs 90% and 80%
  respectively, so both are real work, not a threshold edit. Enforced as gates that fail the
  run, never as numbers printed for decoration.
- `build_reproducible`: a documented, verifiable path from source to the released artifact.
- `dynamic_analysis` and `dynamic_analysis_enable_assertions`: currently the project's evidence
  is static analysis plus a large test suite; dynamic analysis is not yet part of CI.
- `code_review_standards`, `small_tasks`, `require_2FA`, `secure_2FA`.
- `security_review`, `hardening`, `hardened_site`, `crypto_used_network`, `crypto_tls12`:
  several of these are likely N/A for a stdio MCP server with no network surface of its own.
  Each will be answered with its justification, not skipped.

**Three gold criteria are blocked and will stay blocked**, and this is stated here so that no
future reader mistakes silence for oversight: `bus_factor` (at least two maintainers),
`contributors_unassociated` (two significant contributors not associated with each other), and
`two_person_review` (half of all changes reviewed by someone other than their author). All
three need a second person. The reasoning, and why the badge is deliberately not displayed
rather than shown as a partial score, is in [SECURITY.md](../SECURITY.md),
[GOVERNANCE.md](../GOVERNANCE.md), and [docs/ASSURANCE-CASE.md](ASSURANCE-CASE.md). Each is
revisited the moment a second maintainer joins, and not before.

## 3. Distribution and adoption

The pipeline works; installing it is still harder than it should be. Intended work:

- A published release of the `.mcpb` artifact, so a user installs rather than builds. The
  staging and start-it smoke check already exist (`scripts/release/stage-mcpb.sh`,
  `scripts/release/smoke-mcpb.sh`, run as a required CI job); what is missing is the released
  artifact itself.
- Listing in the plugin directory, with a name-collision check performed before submission.
- First-run documentation: what a new user runs, what they see, and what a finished PRD looks
  like. [docs/EXAMPLES.md](EXAMPLES.md) is the starting point.

**Done means:** a user who has never seen this repository can install it and complete one PRD
run without reading the source.

## 4. Post-specs implementation loop: close its open questions

Steps 12 to 20 (`implementation_gate` through `pr_creation` and `finalize`) are implemented and
shipped. What remains is the set of questions the design flagged for a human and that shipping
did not answer, listed in [docs/design-phases-3-5.md](design-phases-3-5.md) section 6:

1. Two provisional constants need production telemetry before they can be called calibrated:
   `REVIEW_RETRY_CAP` (currently 3, `packages/orchestration/src/handlers/review.ts`) and the
   `impact_queries` cap. Same status as `MAX_ATTEMPTS`, and the same standard applies (goal 1).
2. `gh pr create` authentication in the subagent sandbox is assumed, not verified.
3. `index_codebase` re-run cost during `post_impl_verification` is unmeasured on large repos and
   currently unbounded; it may need a size or timeout guard.
4. A `review` FAIL currently retries the engineer on the same worktree (incremental fix-up). The
   alternative, a fresh worktree per attempt, has not been tested against it.

**Done means:** each of the four is answered with evidence, and any constant that survives the
answer carries its measurement.

---

## What this project will not do

These are decisions, not gaps waiting to be filled.

1. **It will not write code on its own initiative.** The PRD pipeline produces documents. The
   implementation loop runs only after a human answers "Implement" at `implementation_gate`, and
   nothing is pushed or opened as a pull request without the separate `pr_gate` approval. The
   server emits `spawn_subagents` actions; it does not edit source files or push branches.
2. **It will not judge prose quality.** Hard Output Rules check structural invariants. Whether a
   sentence is persuasive is out of scope, and the multi-judge phase returns verdicts on atomic
   claims rather than on style.
3. **It will not display an OpenSSF badge it has not earned.** No partial-score shield, no
   self-approval routed through a second account to make a review metric go green.
4. **It will not hand-pick KPI gate thresholds.** Gates are calibrated against the frozen
   baseline or they stay `hold_provisional`.
5. **It will not become a general-purpose agent framework.** It is one pipeline with one job.
   Ecosystem composition happens through the MCP boundary, with
   [Cortex](https://github.com/cdeust/Cortex) and
   [ai-architect-mcp-codebase](https://github.com/cdeust/ai-architect-mcp-codebase) as separate projects.
6. **It will not add a second maintainer for the sake of a badge criterion.** The three blocked
   gold criteria stay blocked until a second person genuinely joins the project.

---

## Beyond this horizon

Nothing is planned past July 2027. Items that emerge will be added here with the date they were
added and the reason they were prioritized.
