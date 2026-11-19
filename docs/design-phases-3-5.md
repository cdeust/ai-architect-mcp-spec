# Design — Phases 3-5: post-specs implementation loop

Status: proposed. Classification: **High** (adds 3 deployable-adjacent stage groups, a new
trust seam — first branch push/PR in the pipeline — and touches >20 files transitively via the
state split). Full Moves 1-8 discipline applied; ADR-worthy decisions marked.

## 0. Overview

Phases 3-5 are one seam: a **post-specs loop** that turns validated specs into a reviewed,
gated PR. It sits entirely between `self_check` and `complete`, is **opt-in per run** (a
human gate), and reuses the pipeline's only execution primitives (`call_pipeline_tool`,
`spawn_subagents`, `ask_user`) — no new action kind.

```
... self_check (unchanged: PRD-vs-graph validate, multi-judge) ...
        │  finalize() now STOPS at a payload, not remember/done
        ▼
  implementation_gate  ──ask_user────────────── "PRD only" ──────────┐
        │ "Implement" (or the offered explicit policy exception)     │
        ▼                                                            │
  pre_impl_grounding   (Phase 3 PRE: get_impact × N affected symbols)│
        ▼                                                            │
  implementation        spawn_subagents(engineer, isolation:worktree)│
        ▼                                                            │
  post_impl_verification (Phase 3 POST: index_codebase→detect_changes│
        │                 →verify_semantic_diff→check_security_gates)│
        ▼                                                            │
  testing               spawn_subagents(test-engineer)               │
        ▼                                                            │
  review ──FAIL, retries<CAP──┐  spawn_subagents(code-reviewer)      │
        │ PASS or cap exhausted (degrade)                            │
        │◄─────────────────────┘                                    │
        ▼                                                            │
  pr_gate               ──ask_user───────────────────── "No" ────────┤
        │ "Push + open PR"                                           │
        ▼                                                            │
  pr_creation            spawn_subagents(branch push + gh pr create) │
        ▼                                                            │
  finalize  ◄─────────────────────────────────────────────────────────┘
   (relocated remember-phase.ts: call_cortex_tool[remember] → done → current_step="complete")
```

Every non-gate step degrades to `finalize` on failure rather than aborting the whole run —
the PRD deliverables from `self_check` are never lost because of a downstream implementation
failure (§ Failure policy).

## 1. AP tool split — pre vs post implementation

| Tool | Stage | Placement | Justification |
|---|---|---|---|
| `get_impact` | 3c | **PRE** — `pre_impl_grounding` | Read-only, symbol-scoped, works on the graph that already exists (`state.codebase_graph_path`). Its job (blast radius: callers/importers/users/implementors) is exactly the Move 4 artifact the engineer needs *before* writing code, and it is what `stage-5.affected_symbols.json` (`state.affected_symbols_path`) already names — the claimed-affected set from spec generation. Running it post-impl would answer "what would this have broken" too late. |
| `detect_changes` | 3e | **POST** — `post_impl_verification` | Structurally requires a diff (`diff_text` or `base_ref`/`head_ref`) — cannot run before code exists. Produces the `changed_symbols` list every other post-impl tool consumes. |
| `verify_semantic_diff` | 9 | **POST** — `post_impl_verification` | Requires two indexed graphs (`before_graph_path`, `after_graph_path`); the "after" graph does not exist until the engineer's worktree is re-indexed. Regression detection is definitionally a diff operation. |
| `check_security_gates` | 8 | **POST** — `post_impl_verification` | Its own schema *requires* `changed_symbols` (from `detect_changes`). Doc explicitly places it "between the coding agent's implementation (stage 7) and semantic-diff verification (stage 9)." |
| `extract_finding` / `refine_finding` / `start_verification` / `append_clarification` / `finalize_verification` / `abort_verification` | 1-2 | **NOT WIRED** | Refused (Move-2 seam naming + refusal-conditions "abstraction without a second concrete use case"). These model a *finding-intake-plus-clarification-session* lifecycle with their own state machine (`stage-2.session.json`, alternation invariant, sha256-sealed transcript). prd-gen already owns clarification (`handlers/clarification.ts`) and intake (`feature_description` at `start_pipeline`). Wiring AP's finding session in parallel would create two competing state machines for the same concern (a coupling/cohesion defect, not a Coase boundary). **If** a future entry mode "PRD triggered by an AP finding" is wanted, that is a distinct ADR (a Phase 0 alternative front door), not part of this loop — no caller today, no second use case identified. |

`index_codebase` (3a) is re-invoked once more in `post_impl_verification`, on the engineer's
worktree, to produce the "after" graph `verify_semantic_diff`/`check_security_gates` need —
this is not a new tool, it is a second call to the already-wired one.

## 2. New stages, transitions, state

### 2.1 State split (prerequisite, PR 3a)

`types/state.ts` is 677 lines, already over the 500-line hard cap (§4.1) before any new field.
Piling 6 new state groups onto it compounds the debt and mixes two cohesions (PRD-generation
state vs post-specs state) in one flat namespace — a Move-1 cohesion defect. Required split,
import-path-transparent (`types/state.ts` becomes `types/state/index.ts`, a barrel — **zero**
call-site changes across the 13 current importers, so this alone is Low-reversibility-neutral):

```
types/state/
  pipeline-step.ts      PipelineStepSchema (extended, see 2.2)
  bounded-io.ts          MAX_RESPONSE_CHARS / MAX_CLARIFICATION_TURNS / MAX_PIPELINE_ERRORS
  section-status.ts      SectionStatusSchema
  verification-plan.ts   VerificationPlanSnapshotSchema
  core-state.ts           today's PRD-generation fields (run_id … retry_policy), unchanged
  post-specs-state.ts    NEW — PostSpecsStateSchema (below)
  helpers.ts             touch / appendError / newPipelineState
  index.ts                composes PipelineStateSchema = core shape + { post_specs }
```

`PostSpecsStateSchema` (nested under `state.post_specs`, nullable, default null — every
existing test/consumer that never touches post-specs is unaffected):

```ts
{
  decision: z.enum(["pending","implement","prd_only"]).default("pending"),
  impact_queries: { done: boolean; index: number; results: unknown[] },  // bounded cursor, see 3
  implementation: { branch, worktree_path, changed_files, raw_report } | null,
  verification: { detect_changes, verify_semantic_diff, check_security_gates,
                   gates_passed: boolean } | null,
  testing: { raw_report } | null,
  review: { verdict: "pass"|"fail", findings: string[], attempt: number } | null,
  pr: { pushed: boolean, url: string | null } | null,
  retry_count: number,   // review-loop counter, capped (§3)
}
```
Every AP payload stored as `z.record(z.string(), z.unknown())` (opaque passthrough), matching
`codebase_grounding`/`prd_validation` precedent — orchestration never parses AP shapes.

### 2.2 `PipelineStepSchema` additions

`implementation_gate`, `pre_impl_grounding`, `implementation`, `post_impl_verification`,
`testing`, `review`, `pr_gate`, `pr_creation`, `finalize` — inserted between `self_check` and
`complete`. `self_check`'s `finalize()` stops calling `emitRememberOrDone`; it instead sets
`pending_completion` (unchanged shape/purpose) and advances to `implementation_gate`. The
`remember-phase.ts` module (Phase C: `call_cortex_tool[remember]` → `done` → `complete`)
relocates unchanged to a new `handlers/finalize.ts`, now the **only** step that reaches
`complete` — matching the mission's explicit migration requirement.

## 3. Action sequencing

- **`implementation_gate`**: `ask_user` (2 options: "Implement" / "PRD only"). Answer sets
  `post_specs.decision`; `"prd_only"` jumps straight to `finalize` (today's exact behavior —
  zero regression for PRD-only callers).
- **`pre_impl_grounding`**: one `call_pipeline_tool[get_impact]` per symbol from
  `state.affected_symbols_path`, cursor-driven via `post_specs.impact_queries.index` (one
  round trip per symbol — `NextAction` is one action per turn). **Cap = 10 symbols,
  provisional, no source — marked "to measure"**, same convention as `MAX_ATTEMPTS` (§
  section-generation-constants.ts, "provisional anchor pending calibration"). No graph or
  empty sidecar → skip (emit_message, advance).
- **`implementation`**: one `spawn_subagents` (purpose `"implement"` — new enum value,
  additive), `subagent_type: "engineer"`, `isolation: "worktree"` — the schema's own
  documented, previously-unexercised value (§ `subagent-client.ts:59`); the engineer creates
  its own worktree/branch per `worktree-protocol.md`, exactly as this session's own contract.
  Prompt embeds the spec files + `pre_impl_grounding` blast-radius summary.
- **`post_impl_verification`**: 4 sequential `call_pipeline_tool` round trips —
  `index_codebase`(worktree) → `detect_changes` → `verify_semantic_diff` →
  `check_security_gates`. Results merge into `post_specs.verification`.
- **`testing`**: one `spawn_subagents` (purpose `"test"`, `subagent_type: "test-engineer"`,
  `isolation: "none"` — same branch, checked out by name, no second worktree).
- **`review`**: one `spawn_subagents` (purpose `"review"`, `subagent_type: "code-reviewer"`)
  fed the verification + testing verdicts as gate inputs. FAIL → increment `retry_count`,
  loop to `implementation` with findings in the prompt (mirrors the section-generation retry
  pattern) **iff** `retry_count < REVIEW_RETRY_CAP`. **Cap = 3, provisional (mirrors
  `MAX_ATTEMPTS`), no source — to measure.** Cap exhausted → degrade, do not abort (§4).
  **Loop-guard placement lesson (Phase 2, git-historian bug)**: the retry re-spawn check must
  be evaluated *before* any "already done" idempotency guard, or it reproduces the exact
  infinite re-spawn bug caught in Phase 2.
- **`pr_gate`**: `ask_user` — **mandatory, non-skippable, always fires when reached**
  regardless of review verdict. This is the trust-seam gate (§ refusal-conditions:
  "no push without an explicit human gate"; this session's own lesson: PR is opened, never
  self-merged).
- **`pr_creation`**: one `spawn_subagents` (purpose `"pr"`, same branch, `isolation:"none"`)
  instructing the engineer to push and run `gh pr create`, returning the PR URL as
  `raw_text`. **No new action kind.** Refused `run_command`: it would let a pure reducer's
  emitted string drive an arbitrary host subprocess — a materially larger, less reviewable
  security surface than delegating to an agent whose tool calls are logged per-turn (§7.2,
  "reflection for control flow" default-refuse). `spawn_subagents` is the uniform "ask an
  agent, get text back" contract already used for every other execution step; extending it
  costs zero new schema surface beyond the additive `purpose` enum values.
- **`finalize`**: unchanged relocated Phase C logic; `remember` content extended to include
  implementation/verification/PR outcome.

## 4. Failure policy per stage

| Stage | No-op condition | Failure | Policy |
|---|---|---|---|
| `pre_impl_grounding` | no graph / empty sidecar | `get_impact` tool error | **degrade** — `appendError(upstream_failure)`, continue with partial/no grounding |
| `implementation` | — | engineer subagent error/empty | **abort to `finalize`** — `structural`/`upstream_failure`; nothing to verify without code |
| `post_impl_verification` | no codebase | any AP call fails | **degrade** — record failure, set `gates_passed=false` (fail-closed on the boolean, not on the run), continue to `testing`/`review` with the failure surfaced to the reviewer |
| `testing` | — | test-engineer error | **degrade** — surfaced to `review` as a finding, not a run-abort |
| `review` | — | reviewer error | **degrade to advisory** after `retry_count` cap — proceed to `pr_gate` with `verdict:"fail"` visible to the human |
| `pr_gate` | — | — | gate always fires; "no" is a valid terminal path, not a failure |
| `pr_creation` | user declined at `pr_gate` | push/`gh pr create` error | **degrade** — `appendError(upstream_failure)`, `pr.pushed=false`, still reach `finalize` |

No stage's failure blocks `finalize`/`remember`/`done` — mirrors the existing rule that a
`remember` failure never blocks completion (`remember-phase.ts`).

## 5. PR breakdown (each independently testable/mergeable)

1. **3a — state split.** Pure refactor: `types/state.ts` → `types/state/*`, barrel-preserved
   import path. Zero behavior change. Full existing suite must stay green — this is the proof
   the split is transparent.
2. **3b — pre-impl AP wiring.** `pre_impl_grounding` step + `get_impact` cursor loop +
   `PostSpecsStateSchema.impact_queries`. Terminates at `implementation_gate` → `"prd_only"`
   short-circuit only (no `implementation` step yet) — ships a dead-ended gate, testable in
   isolation.
3. **3c — post-impl AP wiring.** `post_impl_verification` step (4-call sequence) as a handler
   unit-tested against canned AP responses; not yet reachable from the runner graph (guarded
   behind a feature flag or simply unwired from `HANDLERS` until 4a lands) if 3b/3c must ship
   before 4a is ready.
4. **4a — implementation stage.** `implementation` step, engineer `spawn_subagents` wiring,
   worktree isolation exercised for the first time end-to-end.
5. **4b — testing + review loop.** `testing`, `review`, bounded retry, loop-guard test
   (explicit regression test for the Phase-2 loop-ordering bug, applied to this new loop).
6. **5 — PR stage.** `pr_gate`, `pr_creation`, relocated `finalize.ts`. Only PR in this set
   that touches the trust seam (push/PR) — reviewed with that scrutiny.

Each PR keeps `implementation_gate`'s `"prd_only"` path fully functional, so the existing
674-test baseline and any in-flight PRD-only run are never put at risk mid-rollout.

## 6. Risks / open questions for the human

1. **Unsourced constants** (`impact_queries` cap=10, `REVIEW_RETRY_CAP`=3): both provisional,
   need production telemetry before hardening — same status as `MAX_ATTEMPTS`. Flag for
   follow-up measurement, do not treat as final.
2. **`gh pr create` authentication/authorization** in the engineer subagent's environment is
   assumed, not verified here — confirm the subagent's sandbox is set up for it before 5 ships.
3. **`post_impl_verification`'s `index_codebase` re-run cost** on large repos is unmeasured;
   may need a size/timeout guard — currently unbounded.
4. **Finding-intake tools left unwired** (§1) — confirm no other in-flight requirement expects
   AP's stage-1/2 session tools; if one exists, it needs its own ADR, not a retrofit here.
5. **`review` loop retries re-spawn the engineer on the *same* worktree** — confirm this is
   desired (incremental fix-up) vs a fresh worktree per attempt (clean-room retry); the design
   above assumes same-worktree continuation, unverified against engineer-agent conventions.

## 7. Verification tiering & monoculture limits

Follow-up to commit 60cb9a4's budget-gated haiku panel (§0 above): the panel itself, even
reduced to 1-2 judges/claim under haiku/low, is still N invocations of ONE underlying model
queried under different persona system prompts (`judge-selector.ts`'s `PANELS`: dijkstra,
liskov, mendeleev, ...). This is persona diversity, not model independence — the DeepMind
"virtual agent economies" paper (arXiv:2602.11865) names exactly this failure mode
**Cognitive Monoculture**: when every agent in a system shares one vendor's pretraining corpus
and alignment lineage, their errors correlate — a systematic blind spot in the underlying model
resurfaces under every persona wearing it, so an apparent "N independent verifiers" signal can
be one data point read N times. Measured evidence for the risk being real, not hypothetical:
in e2e run run_mrlqa0aj_u2rh15, both the `liskov` and `architect` judges independently scored
the same ports/adapters architecture claim PASS with the IDENTICAL 0.60 confidence and the same
caveat text — consistent with one underlying judgment surfacing twice under two persona labels,
not two independent readings.

**Two changes ship together to attack this from both ends** (packages/verification/src/
claim-tier.ts, mechanical-verdict.ts; packages/orchestration/src/handlers/
self-check-verify-budget.ts's `diversity_models`):

1. **Claim tiering** — a claim whose OWN TEXT names a deterministically executable
   verification method (grep/diff/`time`/kcov/exit-status/absence-of-pattern/a named gate — see
   claim-tier.ts's `MECHANICAL_METHOD_MARKERS`) never needed a judge's semantic reading in the
   first place; a rule-checkable claim asked a judge to answer SPEC-COMPLETE-or-not on a
   question a script answers at implementation time. These claims (classified "mechanical")
   skip the panel entirely — self-check.ts synthesizes the verdict directly
   (mechanical-verdict.ts's `RULE_TIER_JUDGE`, `{kind:"rule",name:"rule-tier"}`). Calibrated
   against run_mrlqa0aj_u2rh15's real 29 claims (16 AC + 12 FR + 1 ARCH): 7 of 16 acceptance
   criteria (AC-010..016) name an explicit method and classify mechanical; the other 22 claims
   (including AC-008 — the one claim the real panel actually caught a FAIL on) classify
   subjective and still get judged. Invocation count on that calibration fixture: 30 → 23
   (post-60cb9a4 reduced/budgeted baseline vs post-tiering), zero of which were spent asking an
   LLM to confirm a grep result.
2. **Model-diversity slots** — for the 22 remaining subjective claims, persona diversity alone
   doesn't close the monoculture gap. `VerifyBudgetConfig.diversity_models` (default
   `["haiku", "sonnet"]`) gives "architecture"-typed claims (judge-selector.ts's highest-stakes
   panel, `architecture_judges_per_claim` judges by default — 2) one judge per model in the
   list, cycling by slot index — so that panel spans distinct personas AND distinct underlying
   models, not personas alone. Standard subjective claims keep 1 judge under
   `diversity_models[0]`; diversifying every claim would undo the invocation-count win §0 and
   this section both exist for. `JudgeVerdict.model` (core/domain/agent.ts) now records which
   model actually judged each claim, and `10-verification-report.md`'s per-claim table renders
   it, so a "PASS, 2 judges, 1 model" run is now visually distinguishable from a "PASS, 2
   judges, 2 models" run.

**Honest limit (do not overclaim):** every entry in the default `diversity_models` list is a
Claude-family model — cycling between them mitigates INTRA-family blind spots only; two
Claude-family models can still share a systematic misreading the same claim triggers in both.
This is NOT cross-vendor independence, and nothing in this design claims otherwise. The field
type is `string`, not a Claude-model enum, specifically so a host with cross-vendor judge
routing (a non-Claude model reachable through its own `subagent_type`) can close that gap
WITHOUT a schema change — but closing it is out of scope here; it requires host-side routing
this repo does not own. The monoculture risk for standard (non-architecture) subjective claims
is UNCHANGED by this PR (they still get 1 judge, 1 model) — the mitigation is deliberately
scoped to the highest-stakes panel, not applied uniformly, because uniform diversification would
double the subjective-claim invocation count and defeat the budget-gate rationale of 60cb9a4.

source: arXiv:2602.11865 (DeepMind, "virtual agent economies," Cognitive Monoculture threat
class); e2e run run_mrlqa0aj_u2rh15 (2026-07-15, liskov/architect duplicate-confidence
observation); commit 60cb9a4 (budget-gated haiku panel, the baseline this section reduces
further).

### 7.1 Host-side external judge executor (closes the cross-vendor gap noted above)

The "non-Claude model reachable through its own `subagent_type`" gap named in §7's honest-limit
paragraph is now closed on the host side: `scripts/external-judge/` (judge.mjs + calibrate.mjs)
is a zero-dependency Node executor the host runs when a `spawn_subagents` invocation's `model`
field names a non-Anthropic model. It POSTs the judge prompt to an OpenAI-compatible
chat.completions endpoint (Gemini via AI Studio, Mistral via La Plateforme — both free-tier
targets) and returns a `JudgeVerdict`-shaped JSON object, or an explicit
`{status:"skipped", reason:"no credentials"}` when no API key is configured — it never
fabricates a verdict. This repo (`packages/`) is unchanged by this addition: the executor is
purely a host-invoked subprocess, not a new pipeline action kind or a `packages/verification`
dependency.

**Admission gate**: a judge model earns a `diversity_models` slot only after
`scripts/external-judge/calibrate.mjs` (a) reaches ≥0.7 agreement against 10 claims with
recorded ground-truth verdicts from run_mrlqa0aj_u2rh15's real jury, AND (b) actually returns
`FAIL` on claim AC-008 — the run's one deliberate contradiction discriminator (§7's
liskov/architect duplicate-confidence observation and the AC-008 FAIL are the same fixture run).
Condition (b) exists because condition (a) alone is gameable: 7 of the 10 ground-truth claims
are `PASS`, so an always-PASS judge clears the 0.7 bar while adding zero verification value.

Full usage, provider setup (Gemini/Mistral free-tier key acquisition), the Mistral ~2 req/min
client-side throttle, and the free-tier data-privacy caveat are in
`scripts/external-judge/README.md`. Honest limit carried over from §7: cross-vendor ≠ perfect
statistical independence (shared training-data provenance, correlated RLHF-era blind spots are
still possible) — it breaks the single-family ceiling, it does not certify true independence.

source: scripts/external-judge/ (this commit); fixtures/ground-truth.json provenance field
(verbatim transcription of run_mrlqa0aj_u2rh15's 10-verification-report.md jury table).
