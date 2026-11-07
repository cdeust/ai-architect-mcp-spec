# Phase 4 Plan — Calibration & Closed Loops (revised post-cross-audit)

Living document. Audited by engineering + genius teams (Phase 3+4 cross-audit, 2026-04).
Status: REVISED draft. **Implementation blocked on items marked PRE-REGISTRATION REQUIRED.**

This revision incorporates:
- Popper falsifiability + anti-pattern audit (5 anti-patterns flagged)
- Fermi order-of-magnitude sample-size brackets (5/5 items underpowered)
- Shannon load-bearing-quantity analysis (KPI surface refactored)
- Curie back-action / observer-effect audit (9 named anomalies, 6 mandatory R1-R6)
- Fisher experimental design (RCBD, blocking, power calculations, pre-registration)
- Laplace Bayesian update (MLE → Beta conjugate; N=30 dominance threshold)
- Deming common-cause vs special-cause + sequencing dependencies
- Code-reviewer §8 source discipline
- Test-engineer postcondition adequacy
- DevOps CI integration gaps

---

## Sequencing — REVISED per Deming

```
4.3 (measurement only, no dependencies, run first)
4.1 (reliability calibration)            ─┐
                                          ├─ both must complete before 4.4
                                          ┘
4.4 (strategy wiring — depends on 4.1 for correct consensus confidence)
4.2 (MAX_ATTEMPTS — depends on 4.4 for closed-loop retry behavior)
4.5 (KPI gate calibration — depends on 4.2 + 4.4 for stable distributions)
```

The original sequencing (4.1 ‖ 4.2 ‖ 4.3 → 4.4 → 4.5) was incorrect: 4.2's
MAX_ATTEMPTS calibration runs against an uncalibrated consensus output, and 4.5
calibrates KPI gates on a pipeline whose iteration_count distribution is about
to shift when MAX_ATTEMPTS changes.

---

## Cross-cutting prerequisites (mandatory before any item runs)

### CC-1 — Pre-registration discipline (Fisher Fi-A)

Each item below has a "PRE-REGISTRATION" block specifying:
- Hypothesis (H0 / H1)
- Estimand
- Estimator + sufficient statistic
- Power calculation result
- Decision rule
- Stopping rule
- RNG seed for sampling (committed before any data is collected)

A plan that specifies what data to collect but not how it will be analyzed is
not pre-registered. All five items must complete pre-registration before
implementation.

### CC-2 — Analysis script + data committed alongside each constant (Deming + §8)

Every calibrated constant introduced by Phase 4 must commit with:
1. `// source: benchmark/<script-name>, run <date>, N=<count>` at the use site
2. The analysis script in `packages/benchmark/calibration/`
3. Raw data (or a reproducible benchmark that regenerates it) committed to git

Without these three artifacts, the constant calcifies into knowledge graves.

### CC-3 — Forced exploration (ε-greedy) for any closed loop (Fisher 4.4 + Curie A6)

Any feedback loop that uses its own output to drive future decisions must
include a control arm:
- Mechanism: `ignoreHistory: boolean` flag on the relevant function
- Allocation: deterministic partition (`run_id % 5 === 0` → control; ε=0.20)
- Comparison: control vs treatment on a downstream quality metric, not on
  the loop's own output

### CC-4 — Control charts before threshold updates (Deming)

No constant calibrated by Phase 4 may be updated based on individual
observations. Each calibrated constant must have a control chart (XmR or
P-chart) and may only be revised when:
- A point falls outside 3σ limits, OR
- A run of 8 consecutive points lies on one side of the mean

This prevents the tampering cycle where common-cause variation triggers
constant adjustment.

---

## 4.1 — Per-judge reliability calibration

### Wave E oracle status (2026-04-28) — IMPLEMENTED

Wave E (sub-stream E2, integrated in phase4/wave-e-integration) provides
Ajv/mathjs/tsc/validation-based oracle implementations for the four
externally-grounded claim categories. The oracles are wired into the
held-out subset's ground-truth resolution path via `oracle_resolved_truth`
on `ObservationLogEntrySchema` in `ablation-comparison.ts`. Annotator-
circularity (Curie A2) is broken for claims with external grounding.

| Oracle | Implementation | Grounding |
|---|---|---|
| schemaOracle | Ajv v8 JSON Schema validation | Fully external (deterministic) |
| mathOracle | mathjs `evaluate()` — no eval() | Fully external (deterministic) |
| codeOracle | tsc --noEmit --strict subprocess | Fully external (TypeScript compiler) |
| specOracle | @prd-gen/validation validateSection() | Weakly external (internally-maintained rules) |

The specOracle caveat (weakly internal) is documented in every `oracle_evidence`
string. The stub sentinel-throw tests are replaced by real contract tests
(schema/math/code/spec oracle tests — Wave E E2 migration).

Seal status: PARTIAL (option b chosen — see §4.1 "Held-out partition locking"
for full disposition). The blocking artifact is the claim corpus, not the
oracle implementations.

### PRE-REGISTRATION (mandatory before implementation)

**Hypothesis (two-sided).**
- H0: per-(judge × claim_type) calibrated sensitivity AND specificity each
  lie within ±0.10 of the Beta(7,3) prior mean of 0.70 — i.e. the
  judge-specific posterior is observationally equivalent to the default
  prior at the target effect size.
- H1: at least one of {sensitivity, specificity} for at least one
  (judge × claim_type) cell departs from 0.70 by more than 0.10 (in
  either direction). Target effect size: |Δ| ≥ 0.10 on the
  posterior-mean reliability scale.

**Estimand.** Per-(judge_id, claim_type) sensitivity AND specificity
(NOT a single aggregate reliability):
- sensitivity = P(judge_verdict = PASS | ground_truth = PASS, parse_succeeded)
- specificity = P(judge_verdict = FAIL | ground_truth = FAIL, parse_succeeded)

Parse-failure verdicts (INCONCLUSIVE with `caveats: ["parse_error"]`) are
EXCLUDED from both estimates and tracked on a separate P-chart (Deming:
parse failures are special-cause noise, not part of the reliability
process).

**Estimator.** Beta-Binomial conjugate update applied independently to
each arm:
- Prior (both arms): Beta(7, 3) — mean 0.70, effective sample size 10.
  Source for the prior elicitation: Phase-3 audit baseline reliability
  estimate observed across 9 canned panels (range 0.62–0.78, central
  tendency ≈ 0.70); ESS=10 chosen so the prior is dominated by N≥30
  observations per Laplace L4. The prior is moderately informative
  toward reliability, NOT weak — a uniform prior would be Beta(1,1).
- sens posterior = Beta(7 + TP, 3 + FN)
- spec posterior = Beta(7 + TN, 3 + FP)
- Point estimate per arm: posterior **mode** =
  (α − 1) / (α + β − 2) when α, β > 1 (Laplace L4: MAP, not mean,
  is the correct point estimate; the mean over-shoots toward the prior
  when N is small).

**Sufficient statistic.** Per (judge_id, claim_type) cell, the 4-tuple
(true_positives, false_positives, true_negatives, false_negatives) over
the dual-annotator-consensus calibration set. The sens arm consumes
(TP, FN); the spec arm consumes (TN, FP). The two arms are statistically
independent because they index disjoint subsets of the ground-truth
labels (PASS for sens, FAIL for spec).

**Power calculation (per arm, per cell) — CORRECTED (B-Fermi-2).**

The original N=80 figure was wrong. Correct derivation:

Two-proportion z-test for p₀=0.70 vs p₁=0.80, |Δ|=0.10, α=0.05 (two-sided),
power=0.80:

    p̄ = (p₀ + p₁) / 2 = 0.375 (note: pooled proportion differs from p̄ below)
    
    More precisely:
      p̄ = (0.70 + 0.80) / 2 = 0.75
      pooled_variance_under_H0 = p̄(1-p̄) = 0.75 × 0.25 = 0.1875
      variance_under_H1 = p₀(1-p₀)/2 + p₁(1-p₁)/2 = 0.21/2 + 0.16/2 = 0.185
      
    Formula: N = (z_{α/2} √(2·p̄(1-p̄)) + z_{β} √(p₀(1-p₀)+p₁(1-p₁)))² / Δ²
    
    z_{0.025} = 1.96, z_{0.20} = 0.84, Δ = 0.10
    
    Numerator term A = 1.96 × √(2 × 0.75 × 0.25) = 1.96 × √0.375 = 1.96 × 0.6124 = 1.200
    Numerator term B = 0.84 × √(0.70×0.30 + 0.80×0.20) = 0.84 × √(0.21+0.16) = 0.84 × √0.37 = 0.84 × 0.6083 = 0.511
    
    N = (1.200 + 0.511)² / 0.01 = (1.711)² / 0.01 = 2.928 / 0.01 ≈ **292 per arm**

- **CORRECTED: N ≈ 292 per arm per (judge × claim_type) cell** (was wrongly stated as N=80).
- Hard ceiling N = 400 to bound annotator time.
- Source: Fermi cross-audit B-Fermi-2; two-proportion z-test (Fleiss, Levin, Paik
  2003, "Statistical Methods for Rates and Proportions", 3rd ed., Ch. 4).

**Calibration capacity (RESOURCE-ALLOCATION GATE — B-Fermi-2, REVISED).**
- 11 claim_types × 3 judges/panel × 2 arms × 292 ≈ 19,272 arm-observations.
  Each calibration claim yields ≈ 2 arms (one per consensus class), so
  ≈ 9,636 calibration claims needed per panel.
- This project runs on a Claude Max subscription. Annotators are LLM
  subagents, not paid humans — there is no dollar-cost gate. The binding
  constraints are agent-invocation count and orchestrator wall-clock at
  N parallel. See "§4.1 Open design decision — calibration scope" below
  for the parallel-throughput math; full N=292 calibration is feasible in
  ~1 hour at 60 parallel agent pairs.
- The earlier human-annotator framing (~344 hours at $25/hr) is preserved
  here only as historical context; it is no longer the binding constraint.
- **The actual gate is methodological, not financial:** LLM-annotator
  independence (Curie circularity) must be resolved before calibration runs
  begin — see the design-decision section below for the two acceptable
  resolutions (heterogeneous model families OR externally-grounded held-out
  subset).
- Wall-time for automated judge calls at ~5ms each: ~48 s total (negligible).
- Note: an arm requires N ground-truth observations of the corresponding class.
  A judge facing 50/50 PASS/FAIL claims needs ~584 calibration claims per
  claim_type to fill both arms (292 per arm × 2 arms).
- Total budget per panel: 11 claim_types × ~3 judges × 2 arms × 292 ≈ 19,272
  arm-observations, ≈ 9,636 calibration claims.

**Decision rule (per (judge, claim_type) cell, per arm).**
Persist a calibrated posterior IFF all three hold:
  1. N_arm ≥ 30 for that arm (the dominance threshold derived from
     Beta(7,3): ESS_prior = 10, observed mass exceeds prior mass at
     N ≥ 10; ±0.05 posterior-mean precision is met at N ≥ 30 — Laplace
     L4), AND
  2. The 95% equal-tailed Beta credible interval for that arm
     excludes 0.70, AND
  3. The held-out negative-falsifier check (see Falsifiability below)
     does not regress.

Otherwise the cell-arm is *deferred*: the consensus call falls back to
the next coarser scope:
  - cell-arm with N < 30 → use the judge's global per-arm posterior (if
    that posterior itself crosses the dominance threshold)
  - judge with no arm crossing → fall back to Beta(7, 3) prior

**Stopping rule.** Sampling stops when EITHER:
- every (judge, claim_type, arm) cell reaches N = 130, OR
- the dual-annotator-consensus pool is exhausted.

If exhaustion fires before any cell reaches N = 30, the cell remains on
the prior; this is a documented null result, not a calibration failure.

**RNG seed (frozen).** `seed = 4_010_704` (interpretation: phase 4.1,
sub-stream 4010704). This seed is committed in this pre-registration
block before any sampling begins; all stratified-random partitions over
(claim_type × dual-annotator-class) MUST consume this seed. Re-using a
different seed post-hoc invalidates the run.

**Dual ground-truth procedure (Curie R2 — mandatory).** Each
calibration label requires the following procedure:

1. **Two independent annotators** label the same claim. "Independent"
   here means operationally:
   - Annotators do not see each other's verdicts during labeling.
   - Annotators do not coordinate before labeling (no shared rubric
     interpretation discussion specific to the claim under review;
     the rubric itself is shared and frozen before annotation).
   - Annotators do not see the judge's verdict.
   - Annotators do not see deterministic-validator output for the
     claim.
   - Each annotator records both a verdict ∈ {PASS, FAIL} and a free-
     text rationale; the rationale is stored but not shown to the
     other annotator.
2. **Concordance:** if the two verdicts agree, the consensus label is
   that verdict and the claim enters the calibration pool.
3. **Conflict resolution:** if the two verdicts disagree, a third
   reviewer (distinct from the original two) labels the claim with
   access to both prior rationales. The third reviewer's verdict is
   the consensus label. The claim enters the calibration pool with a
   `conflict_resolved = true` flag.
4. **Drop set:** if even the third reviewer marks the claim as
   ambiguous (verdict = INCONCLUSIVE), the claim is dropped from the
   calibration pool entirely. The drop rate is reported as a
   measurement-quality KPI; a drop rate > 10% triggers rubric review.
5. **Sampling:** the stratified random partition over
   (claim_type × consensus-class) is drawn from the resulting pool
   using the frozen seed above. NOT from the first-N claims of each
   panel (convenience sampling).

This procedure replaces the prior plan's "deterministic validator +
human reviewer" formulation, which double-counted any deterministic-
validator bias as ground truth.

**Schema (Laplace L6 — schema-version snapshot mandatory).**

The persistence layer (downstream wave; not implemented in B1) MUST use
the following schema. A schema-version snapshot is required so audit
replays of historical ConsensusVerdicts can identify which calibration
generation produced the reliability map they saw.

```sql
CREATE TABLE judge_reliability (
  judge_id              TEXT    NOT NULL,
  claim_type            TEXT    NOT NULL,
  sensitivity_alpha     REAL    NOT NULL,
  sensitivity_beta      REAL    NOT NULL,
  specificity_alpha     REAL    NOT NULL,
  specificity_beta      REAL    NOT NULL,
  n_observations        INTEGER NOT NULL,  -- total claims feeding this row
  schema_version        INTEGER NOT NULL,  -- bumped on any column or
                                           -- semantic change
  last_updated          TEXT    NOT NULL,  -- ISO-8601 UTC
  PRIMARY KEY (judge_id, claim_type)
);

CREATE TABLE judge_reliability_schema_history (
  schema_version        INTEGER NOT NULL PRIMARY KEY,
  applied_at            TEXT    NOT NULL,
  description           TEXT    NOT NULL
);
```

Equivalent JSON-file form (one record per (judge_id, claim_type)):
```json
{
  "judge_id":          "string",
  "claim_type":        "string",
  "sensitivity_alpha": 7.0,
  "sensitivity_beta":  3.0,
  "specificity_alpha": 7.0,
  "specificity_beta":  3.0,
  "n_observations":    0,
  "schema_version":    1,
  "last_updated":      "2026-04-27T00:00:00Z"
}
```

`n_observations` is the count of consensus-labeled claims that fed this
row's posterior (TP + FP + TN + FN). Note this is the union over both
arms; per-arm ESS is recoverable as α + β − prior_ESS.

The ConsensusVerdict structure SHALL include a `reliability_schema_version`
field so audit replays bind the verdict to a specific reliability
generation. Bumping `schema_version` invalidates downstream comparisons
across the boundary unless a migration is documented in
`judge_reliability_schema_history`.

**Persistence implementation (Wave B2 delivery).**

The persistence layer is `SqliteReliabilityRepository` at `~/.prd-gen/reliability.db`, separate from `evidence.db` to allow independent backup and schema evolution. The port (`ReliabilityRepository` interface and all types) lives in `packages/core/src/persistence/reliability-repository.ts` with no SQLite import, satisfying DIP (coding-standards §1.5). The SQLite adapter lives in `packages/core/src/persistence/sqlite-reliability-repository.ts`.

Schema-version policy: a `schema_meta` table holds a single `schema_version` integer row (currently `2`, constant `RELIABILITY_SCHEMA_VERSION`). The constructor reads this and throws a human-readable error if it does not match the constant. Auto-migration is out of scope for Wave B — a version mismatch requires manual intervention before the DB can be read. This hard-stop prevents silent corruption from an incompatible schema. **Pre-rename `reliability.db` files (schema_version=1, verdict_direction in ('pass','fail')) must be deleted before first run on Wave B+ code.**

Implementation note: `sqlite-reliability-repository.ts` uses one row per `verdict_direction` (instead of the 4-column-per-row layout in the DDL block above). Both forms encode the same sufficient statistics; the row-per-arm form was chosen for atomic UPSERT and CHECK constraint integrity.

Empty-DB / prior contract: `getReliability(judge, claimType, direction)` returns `null` for unseen cells. Callers must substitute `Beta(BETA_PRIOR_ALPHA=7, BETA_PRIOR_BETA=3)` when they receive `null`. The repository does not embed fallback policy. The `n_observations` field is stored explicitly (redundant with `α + β - 10`) for human-readable diagnostics and control-chart queries (CC-4). WAL mode is on; concurrent writers serialise at the SQLite file lock; each `recordObservation` is an atomic UPSERT, so final state matches sequential application regardless of call ordering. Lamport should review the multi-process scenario if >1 calibration process writes to the same `reliability.db` simultaneously.

**Falsifiability (positive + negative — Popper AP-5).**

- Positive falsifier (H1 evidence): at least one (judge × claim_type)
  cell-arm has its 95% Beta credible interval excluding 0.70 AND at
  least one downstream consensus claim flips verdict between the
  uncalibrated baseline and the calibrated run.

- **Negative falsifier (rejection trigger): held-out 80/20 split.**
  - Before any calibration is run, the dual-annotator-consensus pool
    is partitioned into 80% calibration / 20% held-out test, drawn
    using the frozen RNG seed above. Stratified by claim_type and by
    consensus class so each held-out cell preserves the population
    PASS/FAIL ratio.
  - The held-out 20% set is *sealed*: it does not feed any posterior
    update, no judge sees it during calibration, no human reviewer
    re-labels it during calibration tuning.
  - **Mechanical sealing enforcement (M2)**: the partition is sealed by
    writing `packages/benchmark/calibration/data/heldout-partition.lock.json`
    (schema: `{ rng_seed, partition_hash, partition_size, sealed_at, schema_version: 1 }`).
    `verifyHeldoutPartitionSeal(observed_indices, lockPath)` in
    `packages/benchmark/calibration/calibration-seams.ts` MUST be called
    BEFORE any held-out evaluation. It throws if the lock file is missing,
    if the sha256 of the sorted claim_ids does not match `partition_hash`,
    or if `sealed_at` is in the future. No evaluation may proceed without
    this check passing.
  - **Wave E integration (2026-04-28): PARTIAL SEAL — option (b) chosen.**
    - **Oracle wiring: COMPLETE.** E2's four oracle implementations (schema/Ajv,
      math/mathjs, code/tsc, spec/validation) are ported to
      `packages/benchmark/calibration/{schema,math,code,spec}-oracle.ts` and wired
      into `computeReliabilityComparison` via `oracle_resolved_truth` on
      `ObservationLogEntrySchema`. When an entry carries `oracle_resolved_truth`,
      the calibrated arm uses it as ground truth; the prior arm uses the
      annotator-derived `ground_truth` (baseline). Annotator-circularity (Curie A2)
      is broken for externally-grounded claims.
    - **Seal disposition: option (a) — FULLY SEALED in Wave F3.** The
      pre-registered seed `phase4-section-4.1-rng-2025` is committed in the
      corpus + lock. Wave F3 curated 50 oracle-grounded claims
      (schema=15/math=15/code=13/spec=7) at
      `packages/benchmark/calibration/data/reliability-claim-corpus.json`,
      drew the stratified 20% held-out partition (size=10), and populated
      every v2 lock field at `data/heldout-partition.lock.json`. The
      corpus → oracle drift check (F3.B `validate-corpus.mjs` /
      `__tests__/reliability-corpus-seal.test.ts F3.E.1`) confirms every
      claim's `expected_truth` matches `invokeOracle()`. Re-sealing is
      reproducible via `node packages/benchmark/calibration/scripts/
      seal-reliability-corpus.mjs`. The remaining open work is the
      calibration-data PR that populates `judge-observation-log.jsonl`
      with real judge verdicts on these 50 claims and re-runs
      `computeReliabilityComparison`.
  - After calibration, the calibrated reliability map is evaluated on
    the held-out set against the Beta(7,3) prior baseline using
    consensus accuracy as the metric.
  - **Reject calibration** (revert to Beta(7,3) prior; investigate)
    IFF held-out consensus accuracy under the calibrated map is lower
    than under the prior baseline by any margin that exceeds the 95%
    bootstrap CI of the difference.
  - **Paired bootstrap implementation site (M4 → Wave E E1).** The
    paired-bootstrap accuracy-difference estimator is implemented at
    `packages/benchmark/calibration/paired-bootstrap.ts::pairedBootstrapAccuracyDifference`
    per Efron & Tibshirani (1993) Ch. 16 §16.4. Reproducibility is pinned via
    a deterministic seeded RNG (mulberry32) — the same `(heldout, iterations,
    rngSeed)` triple yields byte-identical CI bounds across platforms.
    Types `HeldoutClaim` and `AccuracyMap` are final. The rejection rule
    (ci95[1] < 0 → revert) is wired into `computeReliabilityComparison`.
  - The held-out set is used at most ONCE per calibration generation;
    re-using it after a tuning iteration constitutes leakage and
    voids the falsifier (Popper AP-5).

**Math layer (this wave, B1).** The pure-stdlib Beta-update primitives
live in `packages/benchmark/calibration/reliability.ts`:
`betaUpdate`, `posteriorMean`, `posteriorMode`, `effectiveSampleSize`,
`dominanceThreshold`, `splitSensitivitySpecificity`, `tallyConfusion`.
No I/O. No verification or orchestration imports. Tests under
`packages/benchmark/calibration/__tests__/reliability.test.ts`.

**Control arm — CC-3 (B-Popper-1).**

4.1 is a closed feedback loop (judge reliability estimates feed the consensus
engine, which drives future calibration runs). Per CC-3, every closed loop must
include a forced-exploration control arm.

Specification:
- **Allocation**: deterministic partition `fnv1a32(run_id) % 5 === 0` → control
  arm (ε = 0.20; 1 in 5 runs is held back). The hash function is FNV-1a 32-bit
  (deterministic, no external deps); the same run_id always maps to the same arm.
- **Control arm behaviour**: ignores `ReliabilityRepository`; uses Beta(7,3)
  prior for ALL (judge × claim_type) cells. This simulates the uncalibrated
  pipeline.
- **Treatment arm behaviour**: uses the persisted posterior from
  `ReliabilityRepository` (the normal path).
- **Comparison metric**: downstream consensus accuracy on the held-out 20% of
  the dual-annotator-consensus pool — NOT the calibration loop's own output.
  Self-referential comparison is forbidden (Curie A6).

Published seam (Wave B delivery):
- `isControlArmRun(runId: string): boolean` — deterministic partition predicate.
- `getReliabilityForRun(runId, judge, claimType, direction, repo)` — returns
  `null` (= use prior) for control-arm runs; delegates to `repo.getReliability`
  for treatment-arm runs.
- Both exported from `packages/benchmark/calibration/observations.ts`.

**AP-3 falsification instrument (Wave D delivery).**
The cross-arm comparison metric for §4.1 is computed by
`computeReliabilityComparison(observationLogPath, lockPath)` in
`packages/benchmark/calibration/ablation-comparison.ts`. It groups
ConsensusVerdicts by control vs treatment arm on the held-out 20% set,
calls `verifyReliabilityHeldoutSeal` BEFORE reading any held-out data
(AP-5 mechanical enforcement), and emits a typed report with per-arm
{n, pass_rate, ci95} plus the difference {delta, ci95_paired_bootstrap,
p_value}. Pre-registration: this function — by name — is the analysis
script for the §4.1 closed-loop falsifier. CC-1 compliance: any change
to its semantics requires bumping the schema_version of the report
output.

Wiring into `consensus.ts` shipped in Wave D (composition root in
`packages/mcp-server/src/pipeline-tools.ts` injects the
`BenchmarkConsensusReliabilityProvider` adapter into `ConsensusConfig`).

source: CC-3 (docs/PHASE_4_PLAN.md §CC-3); B-Popper-1 cross-audit finding;
Wave D AP-3 falsifier instrument naming (Popper final re-audit, 2026-04-28).

---

### §4.1 Open design decision — Externally-grounded held-out subset

**Resolution (commit aa42c42, Option b).** The held-out 20% partition must
contain claims with EXTERNALLY-VERIFIABLE ground truth — not LLM-opinion
ground truth. Without this, the negative falsifier measures "agreement with
annotator-LLM" instead of "agreement with reality" (Curie A2 circularity).

**What counts as externally-verifiable ground truth.**

Each claim in the held-out partition must be assigned to exactly one of the
four ExternalGroundingType categories. The oracle for that category provides
ground truth without any LLM involvement.

**Schema-grounded** (`type: "schema"`). Oracle: Ajv / Zod validator.
Examples:
- "The JSON object `{"name":"Alice","age":30}` is valid against the schema
  `{type:object, required:[name,age], properties:{name:{type:string},age:{type:integer}}}`."
- "The payload `{"id":"abc"}` is INVALID against the schema that requires id
  to be a UUID format string."
- "The array `[1,"two",3]` fails the schema `{type:array, items:{type:integer}}`."

**Math-grounded** (`type: "math"`). Oracle: Python/SymPy.
Examples:
- "The number of distinct 3-element subsets of a 5-element set is 10."
- "The expression (7 + 3) × 4 − 2 evaluates to 38."
- "The intersection of {1,2,3,4} and {2,4,6} is {2,4}."

**Code-grounded** (`type: "code"`). Oracle: `tsc --noEmit --strict`.
Examples:
- "The snippet `const x: number = 'hello'` fails strict TypeScript compilation."
- "The snippet `const y: string = 'world'` compiles without errors."
- "The snippet `function f(a: number, b: string): number { return a + b; }`
  produces a type error under strict mode."

**Spec-grounded** (`type: "spec"`). Oracle: Hard Output Rules validator
in `packages/validation` (`validateSection`).
Examples:
- "A requirements section that contains '- [ ] MUST' items and a Summary
  subsection passes the requirements HOR validator."
- "An overview section missing the mandatory H2 'Goals' subsection fails the
  overview HOR validator."
- "A technical_specification section with an unfenced code block fails the
  spec validator."

**Oracle-unavailable contract (Wave E B3, Popper AP-4).** When an oracle
is unavailable in the calibration environment (e.g., `tsc` not installed
on a CI runner without the TypeScript toolchain), the oracle returns
`OracleUnavailableError` (defined in
`packages/benchmark/calibration/oracle-errors.ts`) and the claim is
excluded from the calibrated arm of the comparison rather than being
scored as false. This preserves the falsifier's interpretability: an
absent oracle does not corrupt the calibrated arm's truth labels with
fabricated verdicts. The catch site in
`packages/mcp-server/src/build-conclude-opts.ts:onObservation` writes
the observation log without `oracle_resolved_truth` (field absent, not
`false`), and a one-shot per-process per-oracle `console.warn` flags
the unavailability so operators can install the missing tool. The
held-out evaluation in `computeReliabilityComparison` then falls
through to the consensus-majority circularity path for those specific
claims — the same path used when `external_grounding` is absent
entirely. Pre-registration: this contract is the canonical resolution
of the AP-4 stub-fabrication concern raised in the Wave E cross-audit.

**Code seam.**
`packages/benchmark/src/calibration/external-oracle.ts` defines:
- `ExternalGroundingType = "schema" | "math" | "code" | "spec"`
- `ExternalOracle = (claim: OracleClaimInput) => Promise<OracleResult>`
- `ORACLE_REGISTRY: Record<ExternalGroundingType, ExternalOracle>` — 4
  stubs throwing `EXTERNAL_ORACLE_NOT_YET_IMPLEMENTED`. Wave D implements.
- `invokeOracle(claim)` — dispatches via ORACLE_REGISTRY.

**Partition lock schema (v2).**
`packages/benchmark/src/calibration/calibration-seams.ts` defines
`HeldoutPartitionLockSchema` (schema_version: 2) which requires:
- `external_grounding_breakdown: Record<ExternalGroundingType, number>`
- `external_grounding_total: number` (must equal `partition_size`)
- `external_grounding_schema_version: 1`

`HELDOUT_PARTITION_LOCK_SCHEMA_VERSION = 2`. C1 must write v2 lock files.
v1 lock files are rejected by `verifyHeldoutPartitionSeal`.

**Invariant.** `external_grounding_total === partition_size`. Every claim
in the held-out partition has an assigned oracle category. Enforced by Zod
refine in the schema.

### Wave F closure — external_grounding operationally live (2026-04)

`external_grounding` is now populated at the Claim level via
`Claim.external_grounding` (optional field added in Wave F F1.A).

**How it works.** Claims constructed by the pipeline can opt into oracle
resolution by attaching their grounding payload:

```ts
const claim: Claim = {
  claim_id: "MATH-001",
  claim_type: "correctness",
  text: "2 + 2 equals 4",
  evidence: "...",
  external_grounding: {
    type: "math",
    payload: { expression: "2+2", expected_value: 4 },
  },
};
```

When `concludeSection` / `concludeDocument` is called with a
`ConcludeOptions` that includes `claims` and `onObservation` (as wired by
`packages/mcp-server/src/build-conclude-opts.ts`), the oracle pipeline:
1. Receives a `ClaimObservationFlushed` event for every resolved claim,
   with `external_grounding` propagated from the source `Claim`.
2. When `external_grounding` is present, invokes the appropriate oracle
   via `invokeOracle` in `packages/benchmark/calibration/external-oracle.ts`.
3. Calls `appendObservationLog` with `oracle_resolved_truth` populated,
   breaking annotator-circularity (Curie A2) for that specific claim.

**Default behaviour unchanged.** Leaving `external_grounding` undefined
preserves the existing consensus-majority behaviour. Production claim-
construction code paths that produce externally-verifiable claims SHOULD
populate this field; all other claims continue to resolve via
consensus-majority.

**Oracle types.** `ExternalGroundingType = "schema" | "math" | "code" | "spec"`.
All four types are implemented as real oracles (Wave E). The seam is
verified end-to-end by 3 tests in
`packages/mcp-server/src/__tests__/external-grounding-e2e.test.ts`.

**Wave F closure is now COMPLETE end-to-end (Wave F remediation, 2026-04).**
The MCP `conclude_verification` tool accepts an optional `claims` parameter
(array of Claim-shaped objects) that propagates `external_grounding` through to
the oracle resolution path. Callers — calibration runners, test harnesses, or any
host that supplies the Claim objects from a `plan_section_verification` /
`plan_document_verification` response — get oracle-based ground truth in the
JSONL log. Callers that omit `claims` continue to use consensus-majority
circularity (back-compat preserved).

This closes the Wave D / Wave E / Wave F **triple-pattern**:
- **Wave D A7**: type-level seam — `Claim.external_grounding` field added to core.
- **Wave E A2.3**: orchestrator propagation — `concludeFromVerdicts` reads
  `options.claims` map and populates `ClaimObservationFlushed.external_grounding`.
- **Wave F A2.3**: MCP-tool-API parameter — `conclude_verification` now accepts
  `claims[]`; the handler parses each into a `Claim`, builds the map, and passes
  it to `buildConcludeOpts` via the new `claims` field; `buildConcludeOpts` sets
  `ConcludeOptions.claims`. Verified by
  `packages/mcp-server/src/__tests__/conclude-verification-claims-e2e.test.ts`
  (3 tests: math-grounded → oracle_resolved_truth: true; mixed grounded/ungrounded;
  claims omitted → back-compat).

---

## 4.2 — MAX_ATTEMPTS calibration

### PRE-REGISTRATION (mandatory before implementation) — REVISED for C1

**Status.** Methodology + Kaplan-Meier math layer + Schoenfeld sample-size +
ablation/control-arm seams published in this revision (C1 deliverable, Wave C).
Final calibration is BLOCKED on the ≥823-trial benchmark run feeding the
math layer with real (or mocked-end-to-end) (attempt, pass) data, AND on the
held-out 20% partition being sealed via `data/maxattempts-heldout.lock.json`.
No promotion of the calibrated MAX_ATTEMPTS value (whether 2 or another) may
land in `section-generation.ts` until the falsifier passes (see below).

**Hypothesis (two-sided, conditional).**
- H0: the conditional hazard of passing at attempt k+1 given a failure at
  attempt k is statistically indistinguishable between the two ablation arms
  (with vs. without `prior_violations`); equivalently, hazard ratio HR = 1.
- H1: HR ≠ 1; specifically, the calibration targets detection of HR ≤ 0.7
  (a 30% reduction in the conditional fail-hazard when prior_violations is
  passed forward — a clinically meaningful improvement the retry mechanism
  must demonstrate to justify MAX_ATTEMPTS > 1).

**Estimand — CONDITIONAL, not marginal (Fisher Fi-4.2 critical correction).**
The MAX_ATTEMPTS calibration question is:
  P(passed at attempt k | failed at all attempts < k)
This is a survival quantity. The original Phase-4 plan specified the marginal
P(passed at attempt = k), which conflates first-attempt easy sections with
multi-attempt hard sections and underestimates the value of retries on
already-failing sections. The marginal estimand is hereby retired.

The Kaplan-Meier survival function S(k) = P(T > k), where T is the first
attempt at which a section passes, gives the marginal at-risk fraction at
each attempt level; the conditional pass probability at k+1 equals
1 − S(k+1)/S(k), which is the quantity that drives the
"is one more attempt worth it?" decision.

**Estimator.** Kaplan-Meier non-parametric survival estimator with
Greenwood's-formula 95% CI, stratified by section_type and by ablation arm
(`with_prior_violations` vs `without_prior_violations`). Two-sample
comparison across ablation arms uses the log-rank (Mantel 1966) test.

Math layer published this wave (Wave C1) at
`packages/benchmark/calibration/kaplan-meier.ts`:
- `kmEstimate(events): { times, survival, ci95 }` — KM curve + Greenwood CI.
- `kmMedianAttempts(events): { median, ci95 }` — median attempts-to-pass with
  Brookmeyer-Crowley (1982) CI.
- `logRankTest(armA, armB): { chi2, pValue }` — two-arm log-rank (1 df).
- `schoenfeldRequiredEvents(input): { events, sampleSize }` — sample-size
  derivation (see "Sample size" below).

Module is pure-stdlib (§2.2 layer rule), no I/O, no @prd-gen/core imports.
Tested at `__tests__/kaplan-meier.test.ts` against:
- closed-form check (no censoring → 1 − empirical CDF),
- Kalbfleisch & Prentice 2002 §1.1.1 textbook example (S(6), S(7), S(10)),
- log-rank chi² hand-computation on a 5-subject reference dataset,
- Schoenfeld D=247 / N=823 on the §4.2 production parameters.

**Sufficient statistic.** Per (section_type, ablation_arm, attempt k) cell:
(d_k = events at k, n_k = at-risk just before k, c_k = censored at k).
n_{k+1} = n_k − d_k − c_k. The pooled 4-tuple per arm reproduces the
log-rank chi² without re-reading per-section data.

**Sample size (REVISED — Schoenfeld 1981 derivation, replaces ad-hoc 2,070).**
Two-sample log-rank test for HR = 0.7, α = 0.05 two-sided, power = 0.80,
50/50 allocation:

    D = (z_{α/2} + z_β)² / (p_A · p_B · (log HR)²)
      = (1.95996 + 0.84162)² / (0.5 · 0.5 · (log 0.7)²)
      = (2.80158)² / (0.25 · 0.12722)
      = 7.8489 / 0.031806
      ≈ 246.78  →  ceil = 247 events

Convert to subjects via the first-attempt fail rate (the fraction of sections
that produce ≥ 1 retry observation, i.e. the fraction that ever enter the
at-risk set for log-rank). Production telemetry: first-attempt fail rate
≈ 30% (provisional; recalibrate from real runs before the calibration study).

    N = ceil(D / event_rate) = ceil(246.78 / 0.30) = 823 subjects

The earlier ~2,070 figure derived from a marginal-estimand power calculation
for a different hypothesis (5pp difference in marginal pass rate) and is
hereby superseded. The revised target is **823 sections (~412 per arm)**
under the conditional/survival framing. If first-attempt fail rate is lower
than 0.30 in production, N rises proportionally; the runner MUST recompute
N from the observed event rate before any decision rule fires.

**event_rate=0.30 PROVISIONAL anchor hedge (Popper AP-1 / B9).**
The value 0.30 is a provisional anchor pending CC-2 measurement from real runs.
Pre-flight check: BEFORE running the N=823 calibration study, an initial
K=50 calibration runs against the canned baseline MUST measure the actual
first-attempt fail rate. If the observed event_rate differs from 0.30 by more
than ±0.05 absolute, the Schoenfeld N must be recomputed via
`schoenfeldRequiredEvents({ hr: 0.7, alpha: 0.05, power: 0.80,
allocationA: 0.5, eventRate: observed })` and the study budget revised before
any further data collection.

**MEASURED (Wave E / E3.B, 2026-04-28).** K=50 against the canned baseline
yielded **measured_event_rate = 0.4762** (1050 attempts, 500 events;
Clopper-Pearson 95% CI [0.4456, 0.5069]). |0.4762 − 0.30| = 0.176 >> 0.05
tolerance → **diverges_beyond_tolerance = true**. Per the hedge above, the
Schoenfeld N MUST be recomputed before any §4.2 study begins. With
event_rate=0.4762, the same D=247 implies N = ceil(247/0.4762) ≈ **519
subjects** (~260 per arm) — substantially fewer than the original 823. The
canned-baseline event_rate is much higher than expected because the canned
dispatcher's stochastic section-failure model is more aggressive than a real
production failure model would be; the production event_rate (against real
ecosystems) MUST be re-measured before the canned-only N is treated as
the production target. See `packages/benchmark/calibration/data/event-rate-K50.json`
for the raw measurement.

source: provisional anchor — measure before use (Wave C integration B9,
2026-04-27).

source: Schoenfeld, D. (1981). "The Asymptotic Properties of Nonparametric
  Tests for Comparing Survival Distributions." Biometrika 68(1), 316-319.
source: Collett, D. (2015). "Modelling Survival Data in Medical Research,"
  3rd ed., Ch. 10.2.
source: implementation `schoenfeldRequiredEvents` at
  `packages/benchmark/calibration/kaplan-meier.ts`, tested against the
  hand-computed D=247 / N=823.

**Decision rule (per pre-registered contract).**
1. If `logRankTest(arm_with, arm_without).pValue ≥ 0.05`: ablation arms are
   indistinguishable — `prior_violations` feedback is NOT driving retry
   improvement. Set `calibrated_MAX_ATTEMPTS = 1` (retries are random
   draws). Surface "retry mechanism broken" as a separate Phase-4.2-secondary
   investigation; do NOT silently leave MAX_ATTEMPTS = 3.
2. Else (arms separable; treatment beats control): compute the KM curve on
   the with-prior-violations arm and find the smallest k* such that
   `1 − S(k+1)/S(k) < 0.05` with the upper Greenwood-CI bound also below
   0.05. Set `calibrated_MAX_ATTEMPTS = k*`.
3. If no k* satisfies (2) within the observed support: hold MAX_ATTEMPTS = 3
   (status quo); collect more data.
4. The calibrated value is then validated on the held-out 20% set (negative
   falsifier, below). A failure to outperform the baseline reverts to
   MAX_ATTEMPTS_BASELINE = 3.

**Stopping rule.** Sampling stops when EITHER (a) N ≈ 519 subjects
(recomputed from measured event_rate = 0.4762; see line 624 for the derivation)
have been observed AND each (section_type × ablation_arm) cell has reached its
minimum event count per Schoenfeld, OR (b) the first-attempt fail rate observed
in the first 200 subjects is below 0.10 — at which point the conditional
estimand is unidentifiable in budget and MAX_ATTEMPTS = 3 is held by default
(no calibration possible). Early-stopping for any other reason is a
pre-registration violation.

Note: The original N = 823 figure was based on event_rate = 0.30 (provisional
anchor); the measured rate against the canned baseline is 0.4762, which yields
N ≈ 519 via Schoenfeld eq. (1) (D = 247 required events;
N = ceil(D / event_rate) = ceil(247 / 0.4762) ≈ 519 subjects). See line 624.
source: Popper AP-2 cross-audit finding, Wave E B2 remediation.

**RNG seed (frozen).** `seed = 4_020_704` (interpretation: phase 4.2,
sub-stream 4020704). Committed in this pre-registration block. All
stratified-random partitions over (section_type × ablation_arm) MUST
consume this seed. Re-using a different seed post-hoc invalidates the run.

**Mechanistic instrumentation (Curie A4 / Deming).** Add a
`prior_violations_used: boolean` field to `recordExecution`: true iff the
engineer's draft contains at least one of the violation strings from
`prior_violations`. Without this, retry pass-rate cannot be attributed to
violation feedback vs. random variation. C2's scope (orchestration wiring)
includes this instrumentation; this pre-reg block locks the field name and
type so C2 cannot drift.

**Ablation arm specification (Wave C1 seam).**
- Arm A — `with_prior_violations` (treatment): retry receives the full
  `prior_violations` array from the previous attempt. Current behaviour.
- Arm B — `without_prior_violations` (control): retry receives an EMPTY
  `prior_violations` array. The ablation. Engineer subagent must NOT
  receive the previous violations list in any form.
- **Allocation**: deterministic 50/50 partition by FNV-1a top-bit
  extraction: `(fnv1a32(run_id) >>> 30) < 2` → arm B. ε = 0.50 matches
  Schoenfeld's symmetric-allocation assumption used in the power
  calculation. Top-bit (vs. low-bit `% 4`) extraction avoids FNV-1a's
  known low-bit skew on short ASCII inputs.
- **Seam**: `getRetryArmForRun(runId): RetryArm` exported from
  `packages/benchmark/calibration/calibration-seams.ts`. Reuses the same
  fnv1a32 hash function used by `isControlArmRun`; partition is independent
  of the CC-3 reliability arm because the modulus base differs.
- C2 wires this seam into the retry loop in
  `packages/orchestration/src/handlers/section-generation.ts`. NOT done in
  C1 — only the seam is published.

source: PHASE_4_PLAN.md §4.2 ablation arm; implementation
  `packages/benchmark/calibration/calibration-seams.ts::getRetryArmForRun`.

**Forced-exploration control arm — CC-3 (closed-loop falsifier).**
Phase 4.2 IS a closed loop: a calibrated MAX_ATTEMPTS feeds retry behaviour,
which changes future (attempt, pass) observations, which feeds the next
calibration cycle. Per CC-3, every closed loop must include a
forced-exploration control arm.

- **Allocation**: same partition predicate as Phase 4.1 — `fnv1a32(runId) % 5
  === 0` → control arm (ε = 0.20). Reusing the same predicate intentionally
  so a single run is fully control or fully treatment across both 4.1 and
  4.2; analyses can be joined on run_id without cross-arm contamination.
- **Control arm behaviour**: ignore the calibrated MAX_ATTEMPTS; use the
  hardcoded baseline `MAX_ATTEMPTS_BASELINE = 3`.
- **Treatment arm behaviour**: use the calibrated value.
- **Comparison metric**: section_pass_rate on the held-out 20% set, NOT
  the calibration loop's own (attempt, pass) output (Curie A6 self-reference
  forbidden).
- **Seam**: `getMaxAttemptsForRun(runId, calibratedValue): number` and
  `MAX_ATTEMPTS_BASELINE` exported from `calibration-seams.ts`.
- C2 wires this seam at the retry-loop call site (Wave C2 scope, not C1).

**AP-3 falsification instrument (Wave D delivery).**
The cross-arm comparison metric for §4.2 is computed by
`computeAblationComparison(observationLogPath, lockPath)` in
`packages/benchmark/calibration/ablation-comparison.ts`. It groups
retry-observation records by `arm` (`with_prior_violations` /
`without_prior_violations`), calls `verifyMaxAttemptsHeldoutSeal` BEFORE
reading any held-out data (AP-5 mechanical enforcement), and emits a
typed report with per-arm {n, pass_rate, ci95} plus the difference
{delta, ci95_paired_bootstrap, p_value}. The report's `recommendation`
field encodes the H1/H0 decision: `with_prior_violations_helps`,
`without_helps`, or `inconclusive_underpowered`. Pre-registration: this
function — by name — is the analysis script for the §4.2 ablation
falsifier. CC-1 compliance: schema_version on the report output is the
single change-control signal.

Composition-root wiring shipped in Wave D: `start_pipeline` in
`packages/mcp-server/src/pipeline-tools.ts` populates
`state.retry_policy = { maxAttempts, arm }` from `getMaxAttemptsForRun` +
`getRetryArmForRun`, making the ablation arm assignment ACTIVE in
production runs.

source: PHASE_4_PLAN.md §CC-3; implementation
  `packages/benchmark/calibration/calibration-seams.ts::getMaxAttemptsForRun`,
  `packages/benchmark/calibration/ablation-comparison.ts::computeAblationComparison`,
  `packages/mcp-server/src/pipeline-tools.ts` retry_policy wiring (Wave D).

**Falsifiability (positive + negative — Popper AP-5).**

- *Positive falsifier (H1 evidence):* `logRankTest(arm_with, arm_without).pValue
  < 0.05` AND the calibrated MAX_ATTEMPTS k* lies strictly below the current
  baseline (3) AND the held-out evaluation passes.

- *Negative falsifier (rejection trigger): held-out 80/20 split.*
  - Before any calibration is run, the candidate-run pool is partitioned 80%
    calibration / 20% held-out using the frozen RNG seed `4_020_704`,
    stratified by section_type so each held-out cell preserves the
    population pass/fail ratio.
  - The held-out 20% set is *sealed*: it does not feed any KM or log-rank
    update; no calibration tuning may inspect it.
  - **Mechanical sealing enforcement.** The partition is sealed by writing
    `packages/benchmark/calibration/data/maxattempts-heldout.lock.json`
    (schema reuses the Phase-4.1 `HeldoutPartitionLockSchema`:
    `{ schema_version: 1, rng_seed, partition_hash, partition_size, sealed_at }`).
    `verifyHeldoutPartitionSeal(observed_indices, lockPath)` from
    `calibration-seams.ts` MUST be called BEFORE any held-out evaluation. It
    throws on missing lock, hash mismatch, future `sealed_at`, or null
    template fields.
  - After calibration, the held-out set is replayed under the calibrated
    MAX_ATTEMPTS and (separately) under MAX_ATTEMPTS_BASELINE = 3. Compare
    section_pass_rate using the paired-bootstrap CI of the difference
    implemented at
    `packages/benchmark/calibration/paired-bootstrap.ts::pairedBootstrapAccuracyDifference`
    (Efron & Tibshirani 1993 Ch. 16 §16.4; reproducibility pinned via
    deterministic seeded RNG — Wave E E1).
  - **Reject calibration** (revert to MAX_ATTEMPTS = 3; investigate) IFF the
    held-out section_pass_rate under the calibrated value is lower than
    under the baseline by any margin that exceeds the 95% bootstrap CI of
    the difference.
  - The held-out set is used at most ONCE per calibration generation; re-use
    after a tuning iteration constitutes leakage and voids the falsifier.

- *Ablation falsifier (mechanism check).* If the log-rank test on
  with-vs-without prior_violations returns p ≥ 0.05, the retry MECHANISM is
  broken regardless of the survival-rate signal. Set MAX_ATTEMPTS = 1 and
  surface as a separate engineering investigation. Do NOT lower MAX_ATTEMPTS
  to 2 in this case — that would bake in random-draw-as-feature.

source: docs/PHASE_4_PLAN.md §4.1 negative-falsifier procedure (template);
  M2 mechanical enforcement; Popper AP-5.

**Math layer (this wave, C1).** Pure-stdlib KM/log-rank/Schoenfeld primitives
at `packages/benchmark/calibration/kaplan-meier.ts`. Tests at
`__tests__/kaplan-meier.test.ts`. Seam tests at
`__tests__/calibration-seams.test.ts`. No I/O, no orchestration imports.

**Orchestration wiring (Wave C2 scope, NOT this wave).** C2 will:
1. Replace the hardcoded `MAX_ATTEMPTS = 3` in
   `packages/orchestration/src/handlers/section-generation.ts:46` with a
   call to `getMaxAttemptsForRun(state.run_id, calibratedValue)`.
2. Thread `getRetryArmForRun(state.run_id)` into the retry-prompt builder
   so arm B sections receive an empty prior_violations array.
3. Emit the `prior_violations_used` boolean on every recordExecution.

C1 publishes the seams; C2 consumes them. The seams cannot be removed
without breaking the calibration plan, so Wave C2 cannot ship without
explicit wiring (B-Popper-1 same-pattern enforcement).

---

## 4.3 — Plan-mismatch fire-rate

### PRE-REGISTRATION

**Hypothesis.**
- H0: plan_mismatch fire rate p ≤ 0.01 (one-percent ceiling — "vanishingly rare").
- H1: p > 0.01.

The diagnostic event is observable: each fire appends a string of the form
`[self_check] plan mismatch detected — mismatch_kind:<kind>` to `state.errors`,
where `<kind>` ∈ {`content_mutation`, `ordering_regression`} (source:
`packages/orchestration/src/handlers/self-check.ts` Phase B append, CHANGELOG
[0.2.0] HIGH fix).

**Estimand.** Empirical fire rate p̂ = fire_count / K, plus per-mismatch_kind
rates (p̂_content, p̂_ordering). A run "fires" iff its `state.errors` contains
≥1 mismatch_kind entry; a run can fire at most once per kind per analysis (we
deduplicate per-run before counting, mirroring the Phase B `mismatchSeen` set).

**Estimator.** Direct count + Clopper-Pearson exact 95% CI on the binomial
proportion. No normal approximation — fire_count may be 0 or very small, where
Wald CI is degenerate.

**Sufficient statistic.** (fire_count, K) overall and per (mismatch_kind,
prd_context) cell. Stored as JSONL in
`packages/benchmark/calibration/data/mismatch-fire-rate.<run-id>.jsonl`,
one row per pipeline run.

**Sample size.**
- K=200 → Clopper-Pearson upper 95% bound at fire_count=0 is ≈ 1.83%
  (sufficient to refute H1 only at the 1.83% level, NOT 1%).
- K=300 → upper bound at 0 fires ≈ 1.22%.
- K=460 → upper bound at 0 fires ≈ 0.80% (clears the 1% ceiling).
- Recommended primary K = 460. Fall back to K=3,000 (≈0.12% upper bound) if
  fire_count ∈ {1, 2} and finer resolution is needed.
- Wall time at ~5ms per mocked run (`measurePipeline` with default canned
  dispatcher): K=460 ≈ 2.3s, K=3,000 ≈ 15s.
- Stratification floor (per Fisher): all 8 PRD context types represented at
  ≥ K/8 each. K=460 ⇒ ≥ 58 per context. K=200 ⇒ ≥ 25 per context.

**Stratification (Fisher).** Round-robin assignment of `prd_context` over the
8-element domain (`proposal`, `feature`, `bug`, `incident`, `poc`, `mvp`,
`release`, `cicd` — source: `packages/core/src/domain/prd-context.ts`). Each
run is tagged with its assigned context in the JSONL row so per-cell rates can
be reconstructed.

**Decision rule (pre-registered before data collection — four branches).**
- **Branch A — H0 rejected:** Clopper-Pearson upper 95% bound on overall p̂ < 0.01
  (typically: 0 fires in K ≥ 460 → upper ≈ 0.80%). Outcome: `fallback_unreached_delete_candidate`.
  Publish the evidence, mark the fallback path as "demonstrably unreached,"
  and proceed to deletion under a separate change with a regression test that
  artificially injects a mismatch and verifies the diagnostic still surfaces.
- **Branch B — underpowered regime (K=3,000 fallback trigger):**
  fire_count ∈ {1, 2} on the K=460 primary run. The CP-95 upper bound sits
  above 1% but the event count is too low to conclude root-cause investigation
  with statistical confidence. Outcome: `underpowered_run_fallback_K3000`.
  Run the pre-registered K=3,000 fallback dataset. FIRE_RATE_CEILING (1%) and
  the same Clopper-Pearson upper-bound test apply identically on the fallback;
  no new decision logic is introduced. Expected upper bound at 0 fires in
  K=3,000: ≈ 0.12%.
- **Branch C — investigate root cause:** fire_count ≥ 3 on K=460, OR
  fire_count ≥ 1 on the K=3,000 fallback with CP-95 upper ≥ 0.01.
  Outcome: `investigate_root_cause`. Capture every fire's
  `(mismatch_kind, prd_context, causative_section_if_known, run_id)`, do NOT
  delete the fallback path, hand off the root-cause investigation to the
  orchestration owner.
- **Branch D — underpowered (guard):** K < 460. Outcome: `underpowered`.
  Collect more runs before deciding.
- The control chart (CC-4) governs *re-evaluation* cadence; it does not
  override the binary decision above for the initial K=460 study.

**Stopping rule.** The study stops when EITHER (a) K = 460 runs have completed
AND each prd_context cell has ≥ 58 runs, OR (b) fire_count ≥ 5 — at which
point further sampling cannot lower the upper bound below 1% within budget,
and the priority shifts to root-cause analysis. Early-stopping is permitted
ONLY at these two conditions; "stop because the rate looks fine" is a
pre-registration violation.

**RNG seed.** Round-robin context assignment is deterministic; seed only
governs feature_description sampling (drawn from a fixed K=460-element corpus
committed alongside the data). Seed value: `0xC0FFEE0403` (committed in
`packages/benchmark/calibration/mismatch-fire-rate.ts` BEFORE any data row is
written; fail-fast assertion in the runner verifies the constant has not
changed at analysis time).

**Analysis script (CC-2).**
- Script: `packages/benchmark/calibration/mismatch-fire-rate.ts`.
- Raw data: `packages/benchmark/calibration/data/mismatch-fire-rate.*.jsonl`
  (one file per study run, content-addressable filename).
- Re-run command: `pnpm --filter @prd-gen/benchmark run calibrate:mismatch`
  (hooked once Phase 4.3 collects its first dataset).

**Control chart (CC-4).** XmR chart on per-batch fire rate, batches of size
n=20 runs (so 460/20 = 23 batches). Limits computed from the first 12 batches
and frozen; subsequent batches plot against frozen limits. Re-tune the gate
ONLY when (a) a point falls outside 3σ, OR (b) a run of 8 consecutive batches
sits on one side of the centerline (Western Electric rule 1 + 4). Until then:
hold the decision from the K=460 study.

**Ground-truth backing for the decision.** The mismatch reason is persisted
to `state.errors` by the Phase B handler (`self-check.ts` lines 244-256,
CHANGELOG [0.2.0] HIGH fix). The instrumentation in
`packages/benchmark/src/instrumentation.ts` parses these strings; if the
string format changes, the parser asserts on an unknown-mismatch-kind and
fails the calibration run loudly rather than silently.

**Falsifiability.** Binary, well-specified. The H1 falsifier is the upper
bound of the Clopper-Pearson 95% CI: if it sits below 0.01 with K ≥ 460, H1
is rejected at the pre-registered level.

**AP-5 negative falsifier — injection harness (Curie A3).**
A 0-fire result is ONLY meaningful if the instrumentation can actually detect
mismatch events. The negative falsifier is a synthetic injection round-trip:
1. `packages/benchmark/calibration/__tests__/instrumentation-injection.test.ts`
   — unit test that constructs synthetic `state.errors` with known-good and
   known-bad mismatch strings, calls `extractMismatchEvents`, and asserts
   exact event counts. Runs in CI on every commit; a failure here means the
   prefix in `instrumentation.ts` has drifted from the handler emitter.
2. `packages/benchmark/calibration/mismatch-fire-rate.ts:runPreflightInjectionCheck()`
   — called as Step 0 in the CLI analysis script before any real dataset row
   is consumed. If the injection round-trip returns 0 events, the analysis
   aborts with a clear human-readable error; no decision is emitted and no
   JSONL row is consumed. This ensures the K=460 study cannot accidentally
   report "0 fires" when the upstream emitter has rotated formats.

---

## 4.4 — Strategy-effectiveness closed feedback loop

### PRE-REGISTRATION (mandatory before implementation)

**Hypothesis.** H1: closing the feedback loop (`recordExecution()` populates
`getHistoricalAdjustments()`) produces better section_pass_rate than the
unclosed-loop control arm, on a held-out labeled set.

**Estimand.** Δ = E[section_pass_rate | feedback_enabled] -
E[section_pass_rate | feedback_disabled (control)].

**Estimator.** Two-sample t-test (or Mann-Whitney U if non-normal) per
(prd_context, complexity_tier) cell.

**Sufficient statistic.** (sum_pass_rate, sum_sq_pass_rate, n) per
(strategy, prd_context, complexity_tier, arm) cell. EvidenceRepository must
record sum-of-squares, not just mean, to enable variance estimation
(Fisher Fi-4.4).

**Sample size.**
- For δ=10pp section_pass_rate detection: N ≈ 393 per (strategy, cell, arm).
- 17 strategies × ~12 cells × 2 arms × 50 = 20,400 runs.
- Reduced scope: fix one (prd_context, complexity_tier) cell, compare 4
  strategies head-to-head: 4 × 2 × 393 = 3,144 runs. Manageable.
- For mocked benchmark only — at ~5ms per run, 15 seconds.
- For real ecosystem — 3,144 runs × 30s/run = 26 hours. Prohibitive.

**Forced exploration (CC-3, Curie R4).**
- Mechanism: `ignoreHistory: boolean` on `selectStrategies()`.
- Allocation: `run_id % 5 === 0` → control (ignoreHistory=true), 80% treatment.
- Holdout duration: full Phase 4.4 calibration period; analysis at the end.

**Stable variance — XmR control chart (Deming).**
- Before computing the historical adjustment for a strategy, plot
  actualConfidenceGain values for that strategy on an XmR chart.
- Update the historical adjustment ONLY when:
  - A point falls outside 3σ limits (special-cause: investigate before
    updating), OR
  - A run of 8 consecutive points lies on one side of the mean (sustained
    shift: legitimate update).
- Otherwise: hold the current adjustment. Do NOT tune on individual runs.

**actualConfidenceGain operational definition (Curie A7).**
- If `judge_dispatch_count == 0` on the first attempt (zero claims extracted),
  `actualConfidenceGain` is **omitted** (not zero). recordExecution skips the
  write entirely. Without this guard, every strategy is recorded as
  high-gain in the canned baseline.
- Compare against `chain_of_thought` baseline (Fisher 4.4 hand-off):
  `actualConfidenceGain = strategy_consensus_confidence - chain_of_thought_consensus_confidence`
  on the same input. This requires running each input twice (once with the
  treatment strategy, once with chain_of_thought as control) — doubles the
  N requirement but yields a cleaner signal.

**Decision rule.**
- If treatment arm section_pass_rate > control arm section_pass_rate by ≥10pp
  with 95% CI excluding zero: the closed loop is beneficial; ship.
- If treatment ≤ control: revert to uncalibrated selector; the loop is
  reflexivity-corrupted (Curie A6 confirmed).
- If 95% CI spans zero: insufficient data; collect more or accept that the
  effect is < 10pp.

**Falsifiability (Popper AP-3 + Curie A6).** The control arm IS the falsifier.
Without it, "improvement" is unmeasurable. Closed loops without holdout =
§9 anti-pattern.

---

## 4.5 — KPI gate threshold tuning

### PRE-REGISTRATION (mandatory before implementation) — REVISED for C3

**Status.** Methodology + scaffolding published in this revision (C3 deliverable,
Wave C). Final threshold calibration is BLOCKED on 4.2 + 4.4 producing K≥100
stable runs against a frozen baseline. No threshold value here may be promoted
from "provisional heuristic" to "calibrated" until the calibration runs
specified below complete.

**Hypothesis (per gate, two-sided).**
- H0: each gate's current provisional value equals the value derived from the
  frozen-baseline distribution (per-gate estimand below) within ±5%.
- H1: at least one gate's calibrated value departs from its provisional value
  by more than ±5% (relative).
- Per-gate H0/H1 specialisations are listed below in "Per-gate pre-registration
  subsections".

**Estimand (per gate).** EITHER (95th-percentile of the canned-baseline
distribution) OR (3σ XmR upper control limit), chosen per gate based on
whether the gate codifies a "P95 envelope" or a "process-stable mean ± noise".
Each subsection below names which one.

**Estimator.** Empirical P95 with Clopper-Pearson 95% CI on the order
statistic (gates of P95 type) OR XmR `computeLimits` over 12-batch baseline
(gates of process-stable type). Source: `packages/benchmark/calibration/{clopper-pearson,xmr}.ts`.

**Sufficient statistic (per gate).** The K=100 vector of per-run KPI values,
emitted to `packages/benchmark/calibration/data/kpi-gate-tuning.<bucket>.<run-batch>.jsonl`
with one row per run, schema:

```json
{
  "run_id": "string",
  "machine_class": "m_series_high|m_series_mid|x86_intel|x86_amd|ci_runner",
  "frozen_baseline_commit": "string (provenance: HEAD sha at run time, recorded and never compared)",
  "kpis": "PipelineKpis (full object)",
  "schema_version": 1,
  "timestamp": "ISO-8601 UTC"
}
```

**Power calculation (per gate, +20% true regression at 80% power).**

For a P95-type gate with binomial false-positive rate α=0.05:
- Under H0 (no regression), P(KPI > calibrated_P95) ≈ 0.05 by construction.
- Under H1 (+20% true regression on the perturbed KPI), the perturbed value
  shifts the distribution rightward; for a near-symmetric distribution the
  P(KPI > old_P95) ≈ 0.50–0.85 depending on tail shape.
- N runs to detect this shift at 80% power, two-proportion z-test:
  N ≈ (1.96 + 0.84)² · (p₀(1-p₀) + p₁(1-p₁)) / Δ²
  with p₀=0.05, p₁=0.50, Δ=0.45 → N ≈ 13 per arm. K=100 (the calibration
  budget) is therefore overpowered by 7.7× for the +20% test on a single
  gate, leaving headroom for stratification across machine-class buckets.
- For a 3σ XmR-type gate, Wheeler 1995 §3 demonstrates that a +20% true
  shift in the mean of an in-control process is detected within 8
  consecutive points (Western Electric Rule 4) with probability >0.95.
  K=100 with 12-batch baseline + 38 monitored batches (n=20/batch) easily
  clears this.

**Frozen-baseline definition.**
- "Frozen baseline" = the canned-dispatcher run produced by
  `makeCannedDispatcher` at the source-tree state the calibration run records
  (its `frozen_baseline_commit`, the HEAD sha at run time, is provenance).
- The K≥100 calibration runs MUST be reproducible from the committed RNG
  seed (below) against that exact source-tree state. The seed is committed
  BEFORE any data row is written.
- No decision depends on the identity of a commit hash or on the content of
  `main`. The recorded commit is provenance only: nothing is refused because
  of it. The one pre-flight check compares the SHA-256 of the
  `pipeline-kpis.ts` file being measured with the hash stored in a sealed
  artefact; on a mismatch the run aborts with a clear error rather than
  mixing data from two different instruments (Popper AP-1 ratchet
  protection).

**Per-machine-class wall_time_ms gate.**
- Detection: `detectMachineClass()` in
  `packages/benchmark/calibration/machine-class.ts` buckets the host into
  one of `MACHINE_CLASSES` = `{m_series_high, m_series_mid, x86_intel,
  x86_amd, ci_runner}` from `os.cpus()[0].model` + `os.totalmem()`.
  Heuristics:
  - `Apple M*` model + `totalmem ≥ 32 GB` → `m_series_high`
  - `Apple M*` model + `totalmem < 32 GB` → `m_series_mid`
  - `Intel\b` in model → `x86_intel`
  - `AMD\b` in model → `x86_amd`
  - any other case (unrecognised, virtualised CPU model, empty `cpus()`)
    → `ci_runner` (conservative fallback)
- Per-bucket gate values come from per-bucket K≥100 calibration runs.
  Until those land, every bucket maps to `null` in
  `WALL_TIME_MS_GATE_BY_CLASS` and the function falls back to
  `WALL_TIME_MS_GATE_FALLBACK` (= the current provisional 500ms in
  `KPI_GATES.wall_time_ms_max`).
- Code seam: `getWallTimeMsGateForMachine(): number` in
  `packages/benchmark/calibration/machine-class.ts`. Called by the gate
  evaluator only after the calibrated map is non-empty for the host's
  bucket; before calibration, callers MUST keep using
  `KPI_GATES.wall_time_ms_max` so behaviour is unchanged.

**Synthetic +20% regression test.**
- POSITIVE arm: take canned baseline; apply synthetic +20% perturbation to
  one KPI at a time (`wall_time_ms`, `iteration_count`,
  `mean_section_attempts`); confirm the corresponding gate fires under
  `evaluateGates(perturbed, /* canned */ true)`.
- NEGATIVE arm: take canned baseline UNPERTURBED; apply ±5%
  multiplicative noise; confirm `evaluateGates` returns no violations.
- Test file: `packages/benchmark/calibration/__tests__/gate-tuning-regression.test.ts`.
  Both arms use `it.skip` until the per-machine-class calibration data
  exists; the test SHAPE (perturbation helpers + KPI surface assertions) is
  locked in a non-skipped sanity test against the `KPI_GATES` and
  `PipelineKpis` symbols so type drift is caught at compile time.

**Gate-blocked-run log (Curie R6 censoring mitigation).**
- Every time `evaluateGates` returns a violation in a benchmark run, the
  caller appends one row per (run_id, gate_name) to
  `packages/benchmark/calibration/data/gate-blocked-log.jsonl` via
  `appendGateBlockedEntry({ run_id, gate_name, observed, threshold,
  machine_class })` (timestamp + schema_version are added by the appender).
- Path constant: `GATE_BLOCKED_LOG_PATH` in
  `packages/benchmark/calibration/machine-class.ts`. Gitignored alongside
  the other calibration data sinks.
- The log is the canonical source for auditing whether a tightened gate is
  censoring an underlying distribution shift (Phase 4.5 "Censoring
  mitigation"). Reuses the calibration-seams JSONL append pattern.

**CC-3 control arm — KPI gates.** Phase 4.5 IS a closed loop: calibrated
thresholds gate future runs whose outputs (KPI distributions) feed the next
calibration cycle. Per CC-3:
- Allocation: `isControlArmRun(runId)` (FNV-1a 32-bit, the same partition
  function as 4.1 and 4.4 — a run on the control arm for reliability is on
  the control arm for KPI gates too). ε = 0.20.
- Mechanism: `getKpiGatesForRun<T>(runId, calibratedGates,
  provisionalGates): T` in
  `packages/benchmark/calibration/gate-tuning-seams.ts` (CC-3 forced-exploration
  seam; C3 deliverable) returns the provisional gate set for control-arm runs
  and the calibrated gate set for treatment-arm runs.
- Comparison metric: downstream consensus accuracy / section_pass_rate on
  the held-out partition (below) — NOT the loop's own output (KPI
  distribution after gating).
- Wiring into `evaluateGates` callers is part of Phase 4.5 finalisation,
  NOT this scaffolding step. The seam exists so the wiring cannot ship
  without using it.

**CC-4 control chart per gate.** Each calibrated gate gets an XmR control
chart over per-batch (n=20-run) means. Limits are computed from the first
12 batches and frozen; subsequent batches plot against frozen limits.
Re-tune ONLY when (a) a point falls outside 3σ, OR (b) Western Electric
Rule 4 (run of 8 on one side of mean) fires. Reuses
`packages/benchmark/calibration/xmr.ts::xmrAnalyze`. One XmR record per
gate per machine-class bucket, persisted to
`packages/benchmark/calibration/data/wall-time-ms.<bucket>.xmr.json` for
the per-bucket gate, and `<gate-name>.xmr.json` for global gates.

**Negative falsifier — held-out 20% partition (Popper AP-5).**
- Partitioning: stratified random split of the K≥100 calibration runs into
  80% calibration / 20% held-out, drawn using the frozen RNG seed below.
  Stratified by `machine_class` so each held-out cell preserves the
  machine-class distribution.
- Sealing: written to
  `packages/benchmark/calibration/data/kpigates-heldout.lock.json`
  (committed; Popper AP-5 sealing artifact). Schema:
  `KpiGatesHeldoutLockSchema` (v1, scoped to KPI-gate use case) in
  `packages/benchmark/calibration/heldout-seals.ts`. Verification:
  `verifyKpiGatesHeldoutSeal(lockPath)` from the same module.
  Note: `kpigates-heldout.lock.json` uses v1 field names (rng_seed /
  partition_hash) — the same as `maxattempts-heldout.lock.json` — because
  the sealing artifact is over run_ids, not claim_ids (C3 deliverable).
- Decision: REJECT calibration (revert to provisional gates; investigate)
  IFF, on the held-out 20%:
  - calibrated false-positive rate (% of unperturbed runs that fire any
    gate) > provisional FPR by any margin exceeding the 95% bootstrap CI
    of the difference, OR
  - calibrated false-negative rate at +20% perturbation > provisional FNR
    by the same criterion.
- Re-using the held-out partition after a tuning iteration constitutes
  leakage and voids the falsifier (Popper AP-5).

**RNG seed (frozen).** `seed = 0x4_05_C3` (interpretation: phase 4.5,
sub-stream C3). Committed in this pre-registration block before any
calibration data is collected. Re-using a different seed post-hoc
invalidates the run.

**Decision rule (per gate).**
- If 95% CI on the calibrated estimand (P95 or 3σ UCL) excludes the
  current provisional value AND the held-out negative falsifier above
  does NOT reject: promote calibrated value with a `// source:
  benchmark/<script>, run <date>, N=<count>` comment at the use site,
  the analysis script and JSONL data committed (CC-2), and an XmR
  baseline record (CC-4).
- If 95% CI INCLUDES the provisional value: hold the provisional value;
  document the null result.
- If the held-out falsifier rejects: revert to provisional; investigate
  before any further calibration cycle.

**Stopping rule (per gate per bucket).** Sampling stops when EITHER (a)
K=100 runs have completed for that bucket AND no batch has fired the XmR
"outside-3σ" rule on the in-process calibration metric, OR (b) the
`gate-blocked-log` shows ≥ 5 violations on a SINGLE gate during
calibration — at which point the gate is presumed already miscalibrated
and the priority shifts to root-cause analysis before more runs.

**Per-gate pre-registration subsections.**

Each gate below specifies its own H0/H1, estimand type, and outlier
definition. Eight gates are enumerated; the count matches the
`KPI_GATES` surface in `packages/benchmark/src/pipeline-kpis.ts`.

| # | Gate | Estimand type | H0 (provisional) | H1 (calibrated departs) | Outlier definition |
|---|---|---|---|---|---|
| 1 | `iteration_count_max` | 95th-percentile of baseline + 1σ headroom | 100 | calibrated > 100 by ≥5% (P95+1σ) | run with `iteration_count > calibrated UCL` |
| 2 | `wall_time_ms_max` (per-bucket) | 95th-percentile of per-bucket baseline | 500ms (fallback, all buckets) | calibrated bucket value diverges from 500 by ≥5% | run on bucket B with `wall_time_ms > P95(B)` |
| 3 | `section_fail_count_max` | 95th-percentile of baseline | 5 | calibrated < 5 (canned content enriched) | run with `section_fail_count > P95` |
| 4 | `distribution_pass_rate_max` | suspended on canned; defer to real-ecosystem run | 0.95 (canned-suspended) | calibrate against known-good vs known-bad PRDs only | run with PASS rate > UCL on real ecosystem |
| 5 | `error_count_max` | 95th-percentile of baseline | 5 | calibrated diverges from 5 by ≥5% | run with `error_count > P95` |
| 6 | `safety_cap_hit_allowed` | special-cause defect | false | unchanged (any hit is a defect) | any `safety_cap_hit = true` |
| 7 | `mean_section_attempts_max` | 95th-percentile of baseline | 2.5 | calibrated diverges from 2.5 by ≥5% (real-LLM expected ≈ 1.0–1.2) | run with mean attempts > P95 |
| 8 | `structural_error_count_max` | special-cause defect | 0 | unchanged (any structural error is a defect) | any `structural_error_count > 0` |
| 9 | `cortex_recall_empty_count_max` | 95th-percentile of baseline (real Cortex only) | 3 (canned-suspended) | calibrated bound from real-Cortex K≥100 | run with empty-recall count > P95 on real Cortex |

(Nine rows, not eight — `cortex_recall_empty_count_max` is the ninth gate
introduced by Wave A3; the brief's "~8 KPI gates" estimate predates that
addition. All nine are enumerated to match the actual `KPI_GATES`
surface.)

**Tampering safeguard (Deming + CC-4).** Gate thresholds may only change
when the corresponding XmR chart shows a sustained shift (run of 8 on one
side of the mean) OR a pre-registered re-calibration cycle (e.g., quarterly
or per-major-release). Individual gate violations are NOT grounds for
adjusting the gate. Repeats §4.5 of the prior revision; preserved here so
the tampering rule is co-located with the per-gate table.

**Symmetric anchor-update procedure (Popper AP-1 anti-ratchet).** Anchors
(calibrated gate values) are BIDIRECTIONAL — they may move either tighter OR
looser when evidence justifies. A one-sided ratchet (anchors can only loosen,
never tighten) means a real quality improvement can never tighten the gate,
weakening the falsifier monotonically over time (Popper AP-1 asymmetric
falsifiability violation).

- Anchor MAY move DOWN (tighter) when: a calibration window of K≥100 runs
  against a NEW frozen baseline (post-improvement) shows the new P95 is
  below the current anchor by more than the XmR ±3σ band on the calibration
  metric for that gate.
- Anchor MAY move UP (looser) when: a sustained shift on the EXISTING baseline
  is detected per the Western Electric Rule 4 criterion (run of 8 consecutive
  batches on one side of mean) on the XmR chart for that gate.
- Anchors move ONLY at pre-registered calibration windows (quarterly or
  per-major-release per the tampering safeguard above), never per-run.
- Anti-ratchet motivation: a calibration procedure that can only loosen gates
  is not a calibration procedure — it is a monotone noise accumulator. Both
  directions must be permitted; neither should be the default.

source: Popper AP-1 — asymmetric falsifiability concern; Wave C cross-audit
(code-reviewer finding B6, 2026-04-27).

**Falsifiability.** Two arms of the synthetic test (§"Synthetic +20%
regression test" above) plus the held-out negative falsifier. If either
synthetic arm fails on the calibrated thresholds OR the held-out falsifier
rejects, the gate is miscalibrated; tune K higher, change the percentile,
or revert to provisional.

**Analysis script (CC-2).**
- Script: `packages/benchmark/calibration/calibrate-gates.ts` (Wave D / D3.1
  deliverable, 2026-04). The runner orchestrates K≥100 canned-baseline runs,
  computes per-gate P95 + Clopper-Pearson 95% CI + XmR records, and emits
  the calibration outputs below. Source helpers split for §4 size limits:
  - `gate-stats.ts`         — percentile + CI + XmR record construction.
  - `event-rate.ts`         — §4.2 event_rate measurement (D3.2).
  - `frozen-baseline.ts`    — content-hash pre-flight (Popper AP-1).
  - `calibration-outputs.ts`— Zod schemas + read/write helpers (D3.3).
  - `calibrate-gates-cli.ts`+ `calibrate-gates-constants.ts` — CLI shell.
- Output JSON paths:
  - `data/gate-calibration-K100.json`         — per-gate P95 + CI + xmr_path.
  - `data/gate-calibration-K100.xmr/<gate>.json` — XmR record per gate
    (gitignored; runtime data).
  - `data/event-rate-K50.json`                — §4.2 event_rate hedge output.
- Loader: `packages/benchmark/src/calibrated-gates-loader.ts::loadCalibratedGates`
  reads `gate-calibration-K100.json`, validates against an inline Zod schema
  pinned to `GateCalibrationK100Schema`, and overlays calibrated values onto
  `KPI_GATES` for gates that passed the §4.5 promotion threshold. Returns
  null when the file is missing/invalid/unsealed/no-promotions, so
  provisional defaults remain in effect by default. Production callers use
  `getActiveKpiGates()`; the synthetic regression test
  (`gate-tuning-regression.test.ts`) imports `KPI_GATES` directly to stay
  anchored to provisional values.
- Reproducibility pin: `calibrate-gates.test.ts` asserts that two runs with
  the same seed against the same source tree produce byte-identical
  artefacts (excluding wall_time_ms which is the natural variance source).
- Re-run command: `pnpm --filter @prd-gen/benchmark run calibrate:gates`
  (hooked in `packages/benchmark/package.json`, Wave D / D3.1).
- Calibration data commit: NOT included in the runner-machinery PR. The
  committed stub artefacts under `data/` carry `gates: []` / `k_observed: 0`
  so `loadCalibratedGates()` returns null until the first real run produces
  measured values. Real values are committed in a separate calibration-
  data-only PR.

**AP-3 falsification instrument (Wave D delivery + Wave E E1.B).**
The cross-arm comparison metric for §4.5 is computed by
`computeKpiGateComparison(gateBlockedLogPath, lockPath)` in
`packages/benchmark/calibration/ablation-comparison.ts`. It groups
`gate-blocked-log.jsonl` entries by control vs treatment arm, calls
`verifyKpiGatesHeldoutSeal` BEFORE reading any held-out data (AP-5
mechanical enforcement), and emits per-arm fire-rate stats with
Clopper-Pearson 95% CIs alongside the paired-bootstrap CI of the
difference (Efron & Tibshirani 1993 Ch. 16 §16.4; reproducibility pinned
via deterministic seeded RNG — Wave E E1). Because KPI runs are not
naturally paired (independent runs in each arm), the bootstrap consumes a
synthetic pairing (sort each arm by `run_id` and zip to the shorter
length); this yields a slightly conservative CI. Recommendation rule:
`treatment_better` ← `ci95[0] > 0`; `control_better` ← `ci95[1] < 0`;
otherwise (or n < 30) `inconclusive_underpowered`. The hysteresis guard
prevents a noisy fluctuation from triggering an anchor move. Pre-registration:
this function — by name — is the analysis script for the §4.5 KPI-gate
falsifier. CC-1 compliance: the report's `schema_version` is the single
change-control signal.

source: PHASE_4_PLAN.md §CC-3; implementation
  `packages/benchmark/calibration/ablation-comparison.ts::computeKpiGateComparison`,
  `packages/benchmark/calibration/heldout-seals.ts::verifyKpiGatesHeldoutSeal`
  (Wave D AP-3 falsifier instrument naming, Popper final re-audit, 2026-04-28).

**Implementation gates (Phase 4.5 finalisation, NOT this scaffolding).**
- [x] K≥100 calibration-runner machinery wired (Wave D / D3.1) —
      `calibrate-gates.ts` ships; first real K≥100 batch is a separate PR
- [x] Frozen-baseline content-hash check asserted at runner startup
      (Wave D / D3.1; `frozen-baseline.ts::computePipelineKpisContentHash`)
- [x] First K≥100 calibration batch committed to `data/gate-calibration-K100.json`
      with non-empty `gates` array (Wave E / E3.A, 2026-04-28; K_achieved=100,
      frozen_baseline_commit=76cfc636, runner pre-registered seed 0x4_05_C3)
- [x] **wall_time_ms_max gate disposition (Wave E integration, option b):
      HOLD-PROVISIONAL.** Calibrated value 1.534ms (from 500ms provisional,
      326× tightening) is tagged `hold_provisional=true` in
      `data/gate-calibration-K100.json`. `loadCalibratedGates()` skips
      auto-promotion for `hold_provisional` gates. Reason: calibration was
      run on canned-dispatcher (m_series_mid machine class, ~1ms per run).
      Promoting to 1.534ms would fire on every production claim on non-canned
      dispatchers or other machine classes. Unblocked by: per-machine-class
      non-canned calibration runs (separate PR).
      Source: `packages/benchmark/src/calibrated-gates-loader.ts` + §4.5 brief.
- [x] **cortex_recall_empty_count_max gate disposition (Wave E integration,
      CONCERN-1): HOLD-PROVISIONAL.** Calibrated value 11 (loosened from
      provisional 3). Tagged `hold_provisional=true` in
      `data/gate-calibration-K100.json`. Reason: calibrated against cold-cortex
      canned baseline; production cortex is typically warmer (prior runs seed
      the recall cache), meaning the loosening from 3→11 may mask real recall
      failures in production. The `loadCalibratedGates()` loader skips
      auto-promotion for `hold_provisional` gates. Unblocked by: re-calibration
      with seeded (warm) cortex in a separate PR.
      Source: Fermi disposition, Wave E CONCERN-1 remediation.
- [x] **Production-mode calibration runner machinery wired (Wave F sub-stream
      F2, 2026-04-28).** New file `calibrate-gates-production.ts` mirrors the
      canned runner but drives `measurePipelineAsync` via a
      `makeProductionDispatcher({ agentInvoker })` that delegates LLM-bound
      actions to an injected `AgentInvoker`. `--mode production|canned` flag
      added to the CLI (default `canned`, backward compatible). Pilot K=5
      run committed to `data/gate-calibration-K100-production.json` with
      `data_source: "production_pilot_K=5"` to demonstrate the runner produces
      realistic numbers (wall_time ~4400ms vs canned ~1.4ms; cortex_empty
      ~3.8 vs canned 11). Pilot is NOT promotable (K too small + stub-only).
      Both `wall_time_ms_max` and `cortex_recall_empty_count_max` REMAIN
      `hold_provisional=true` until a real-host (or high-fidelity-stub) K=100
      production batch lands. Promotion criteria + RNG seed
      (`PRE_REGISTERED_SEED_45_PRODUCTION = 0x4_05_C3_FF`) + AgentInvoker
      wiring + wall-clock budget documented in
      `packages/benchmark/calibration/data/production-calibration-runbook.md`.
- [ ] **Production-mode K=100 batch landed** (follow-up session). Once
      committed with `agent_invoker_class: "host-real"` and the runbook's
      §"Promotion criteria" all met, edit `gate-calibration-K100.json` to
      set `hold_provisional=false` and update `calibrated` to the
      production-derived value for both held gates.
- [ ] `WALL_TIME_MS_GATE_BY_CLASS` populated for at least one bucket with
      use-site source comment + JSONL data + XmR record (CC-2)
- [x] Held-out 20% partition sealed in `data/kpigates-heldout.lock.json`
      (Wave E / E3.C, 2026-04-28; rng_seed=0x4_05_C3, partition_size=20,
      partition_hash=bc68df17288d6ba8014406e583b9ff9d57ddecd4998c33fa45f5c71c2146f82c)
- [ ] Negative falsifier evaluated and not rejecting
- [ ] Synthetic +20% regression test continues to pass against calibrated
      values (already passes against provisional in this scaffolding)
- [ ] CC-3 wiring: `evaluateGates` callers consume `getKpiGatesForRun`
- [ ] CC-4 XmR record committed per calibrated gate (per-gate XmR JSONs
      already produced by the runner; commit them when promoted)

**Wave dependencies (downstream of 4.5 finalisation).**
- Wave D (release-readiness gate): consumes calibrated gates as the
  ship/no-ship signal for the canned-baseline benchmark in CI. Cannot
  flip its required-gate set from "any" to "calibrated subset" until
  4.5 finalises.
- Release pipeline: the 4.5 finalisation gate is a precondition for
  flipping `is_canned_dispatcher` from `true` to `false` on
  real-ecosystem CI runs (real runs unsuspend the
  `distribution_pass_rate_max` and `cortex_recall_empty_count_max`
  gates, which only meaningfully fire after their per-gate calibration).

---

## Cross-cutting risks (revised)

### Shannon: mismatch_kinds count-loss (deferred to Wave B+)

`MismatchExtraction.distinctKinds` is a `ReadonlyArray<MismatchKind>` (deduped
per run). Shannon flagged that this loses the per-kind fire count when a single
run fires the same kind multiple times. The correct representation would be
`Record<MismatchKind, number>`. This refactor is deferred: it requires changing
the `PipelineKpis.mismatch_kinds` surface, the `CalibrationRun.mismatch_kinds`
JSONL schema, and the per-kind CI computation in `analyze()`. It is NOT
blocking Phase 4.3 data collection because the current dedup-per-run matches
the pre-registered estimand (a run "fires" at most once per kind). File a
Wave B+ task to migrate to the typed count before any per-kind rate is used
for a Phase 4 deletion decision.

### Reflexivity (Curie A6, A8 / Popper AP-1, AP-3)

Two reflexivity hazards exist:

1. **Strategy effectiveness loop (4.4)** — addressed by ε-greedy control arm
   (CC-3).
2. **KPI gate censoring (4.5)** — addressed by frozen baseline + gate-blocked
   run log.

### Persistence concurrency (Lamport, Curie A1)

EvidenceRepository writes from concurrent runs serialize at the SQLite file
lock. WAL mode is on. Recommend: switch to per-run JSONL append + nightly
batch import to SQLite, eliminating write contention on the hot path.

### Constants-as-knowledge-graves (Deming + §8)

Every Phase 4 constant must commit with:
1. `// source: <script-path> run <date> N=<count>` at the use site.
2. The analysis script in `packages/benchmark/calibration/`.
3. Raw data or reproducible benchmark.

If any of these is missing, the constant has not graduated from "heuristic"
status.

### Parse-failure rate as a separate special-cause signal (Deming)

Parse failures (verdict caveats containing `parse_error` or
`judge_invocation_failed`) are tracked on a separate P-chart. They are NOT
included in the reliability calculation. They trigger infrastructure
investigation, not reliability-prior adjustment.

---

## Implementation gates

Before ANY Phase 4 item ships:
- [ ] CC-1: Pre-registration block completed for the item
- [ ] CC-2: Analysis script + raw data committed
- [ ] CC-3: Forced-exploration / control arm specified for closed loops
- [ ] CC-4: Control chart specified for any threshold updates

Before 4.1 ships:
- [ ] Dual ground-truth procedure (Curie R2)
- [ ] Beta(7,3) prior with sensitivity/specificity split (Laplace)
- [ ] Persistence schema with version snapshot (Laplace L6)
- [ ] Negative falsifier on held-out set (Popper AP-5)
- [ ] CC-3 control arm seam: `isControlArmRun` / `getReliabilityForRun` published
      and wired at call sites in 4.4 / 4.5 (B-Popper-1)
- [ ] Calibration scope decision committed: which option (1/2/3/4) from
      "§4.1 Open design decision" + LLM-annotator independence resolution
      (heterogeneous model families OR externally-grounded held-out subset)
      (B-Fermi-2 gate, revised under Max subscription)
- [ ] dominanceThreshold ESS correction deployed (B-Fermi-3)
- [ ] VerdictDirection renamed to sensitivity_arm/specificity_arm (C-Shannon-CONCERN-3)
- [ ] AnnotatorView enforced at all queue drain consumers (B-Curie-4)
- [ ] busy_timeout = 5000 in SqliteReliabilityRepository (B-Curie-5)
- [ ] judge_id structured record deployed (B-Shannon-6)
- [ ] DEFAULT_RELIABILITY_PRIOR single source of truth in @prd-gen/core (B-Shannon-7)
- [x] Externally-grounded claim corpus committed (Wave F3.A — N=50, breakdown
      schema=15/math=15/code=13/spec=7 at
      `packages/benchmark/calibration/data/reliability-claim-corpus.json`;
      every claim's `expected_truth` matches `invokeOracle()` per F3.B
      validate-corpus.mjs; corpus + corpus-validation test in
      `__tests__/reliability-corpus-seal.test.ts`).
- [x] Held-out 20% partition fully sealed (Wave F3.D —
      `data/heldout-partition.lock.json` schema_version=2,
      seed='phase4-section-4.1-rng-2025', partition_size=10,
      breakdown={schema:3, math:3, code:3, spec:1},
      claim_set_hash=7db6660ce21150a5aa007d5c01718cbe35bb6259ccbe237098724bb04d196247;
      reproducible via `node packages/benchmark/calibration/scripts/seal-reliability-corpus.mjs`).
- [x] Held-out negative-falsifier evaluation runnable end-to-end
      (Wave F3.F — `computeReliabilityComparison` runs against the corpus +
      lock and returns a non-null `ci95_paired_bootstrap`; covered by
      `__tests__/reliability-corpus-seal.test.ts` F3.F describe block).
- [ ] First real calibration batch against the corpus (separate
      calibration-data PR — populates `data/judge-observation-log.jsonl`
      with real judge verdicts on the F3 corpus and re-runs
      `computeReliabilityComparison` to produce the calibrated/prior arm
      decision. Out-of-scope for F3 — F3 ships the gates, not the data.)

Before 4.2 ships:
- [x] Conditional (not marginal) estimand + Kaplan-Meier math layer
      (Fisher Fi-4.2) — published in `kaplan-meier.ts` (Wave C1)
- [x] Sample size revised under Schoenfeld 1981: N = 823 subjects (~412 per
      arm) at HR = 0.7, α = 0.05, power = 0.80, event_rate ≈ 0.30
      (PROVISIONAL — see §4.2 hedge below). The original ~2,070 figure is
      superseded — see §4.2 power calculation (Wave C1)
- [x] Ablation arm seam published: `getRetryArmForRun(runId)` returning
      `with_prior_violations` / `without_prior_violations` (Wave C1)
- [x] CC-3 closed-loop control-arm seam published: `getMaxAttemptsForRun`
      + `MAX_ATTEMPTS_BASELINE = 3` (Wave C1)
- [x] Held-out 20% partition seal template at
      `data/maxattempts-heldout.lock.json` — must be drawn + sealed before
      held-out evaluation (Wave C1)
- [x] Held-out 20% partition SEALED in `data/maxattempts-heldout.lock.json`
      (Wave E / E3.C, 2026-04-28; rng_seed=4_020_704, partition_size=20,
      partition_hash=4fa909b8a165d926272ffd4f4cb43e12eb7a1f0d62f2a77a4e3fcc85f342b634;
      verified by sealed-locks-integration.test.ts)
- [x] `prior_violations_used` instrumentation:
      `packages/benchmark/calibration/retry-observations.ts::extractRetryObservations`
      extracts all 6 required fields from PipelineState per attempt.
      `appendRetryObservationLog` writes to
      `packages/benchmark/calibration/data/retry-observation-log.jsonl` (gitignored).
      **TODO(Wave D):** add `attempt_log` to SectionStatus for exact per-attempt
      violation counts (current extraction approximates intermediate attempts
      as 0 — sufficient for pilot). Wire `getRetryArmForRun(run_id)` so arm
      is not passed manually by every caller (Wave D scope).
- [ ] Retry-loop wiring: `getMaxAttemptsForRun` + `getRetryArmForRun`
      consumed in `section-generation.ts` (Wave D scope)
- [ ] N=823 trials run end-to-end on real or mocked-end-to-end pipeline,
      stratified by section_type and ablation arm (Wave C+ scope; gated on
      Wave D)
- [ ] Held-out 20% set populated, sealed, and replayed under both calibrated
      and baseline MAX_ATTEMPTS (Wave C+ scope)

Before 4.4 ships:
- [ ] 4.1 complete (correct consensus confidence)
- [ ] ε-greedy control arm wired
- [ ] XmR control chart on actualConfidenceGain
- [ ] Zero-claim-attempt guard on recordExecution
- [ ] Reference strategy (chain_of_thought) baseline

Before 4.5 ships:
- [ ] 4.2 + 4.4 complete (stable KPI distributions)
- [ ] K ≥ 100 calibration runs against frozen baseline
- [ ] Gate-blocked run log instrumented
- [ ] Per-machine-class wall_time_ms gate
- [ ] Synthetic +20% regression test passes; ±5% variation does not

---

## Audit lineage

This plan was revised after a 10-agent cross-audit (Phase 3+4):

| Agent | Findings |
|---|---|
| Popper | 5 anti-patterns (AP-1 ratchet, AP-2 broken-by-construction gate, AP-3 missing control arm, AP-4 proxy/target confusion, AP-5 missing negative falsifier) |
| Fermi | 5/5 sample sizes underpowered; 5/8 KPI thresholds out of bracket; arithmetic error in wall_time_ms |
| Shannon | 8 KPIs analyzed; section_pass_rate redundant; judge_dispatch_count brittle (regex-parsed); 5 missing quantities (mean_section_attempts, structural_error_count, section_fail_ids, cortex_recall_empty_count, claims_evaluated typed) |
| Curie | 9 named anomalies (ground-truth-circularity, selector-feedback-reflexivity, zero-first-attempt-confidence-inflation, gate-induced-measurement-censoring, …); 6 mandatory R1-R6 |
| Fisher | All 5 items lack pre-registered analysis plan; 4.2 specification error (marginal vs conditional); 4.4 needs ε-greedy |
| Laplace | Plan specified MLE not Bayesian; Beta(7,3) prior; N=30 dominance threshold; sensitivity/specificity split |
| Deming | Sequencing correction; tampering risk on every threshold; control charts mandatory; parse-failure rate as separate signal |
| Code-reviewer | KPI gate constants need use-site source comments; defaultCraftResult duplicates smoke harness (extract to shared) |
| Test-engineer | iteration_count off-by-one bug (fixed); existsSync gate silently skips; missing connect timeout |
| DevOps | 6/10 packages have zero tests; mcp-server dist drift untracked; --workspace-concurrency=1 unnecessary in pnpm v8+ |

---

## §4.1 Open design decision — calibration scope (Fermi cross-audit)

**Status: UNDECIDED. Decision must be made before annotation work begins.**

**Context.** The 33-cell × 2-arm design (11 claim_types × 3 judge kinds ×
{sensitivity, specificity}) requires N=292/arm observations per cell to detect
|Δ|≥0.10 at power=0.80 (Laplace L4; §4.1 PRE-REGISTRATION). Total observations:
292 × 33 × 2 = 19,272 claims. With LLM agents as the annotator pool (this
project runs on a Claude Max subscription — no human-annotator dollar cost,
only invocation/wall-clock budget), the original Fermi finding ("3-17 years
at 1 run/day with paid human annotators") collapses: parallel agent dispatch
removes the throughput ceiling.

**Cost axis re-framed.** All four options below are zero-marginal-cost in
dollars on the Max subscription. The binding constraints are:
- **Agent-invocation count** (subagent dispatch capacity)
- **Wall-clock at N parallel agents** (orchestrator throughput)
- **Statistical guarantee** (effect size × power)
- **Methodological soundness** (LLM-annotator independence — see warning below)

**WARNING — LLM-annotator independence (Curie circularity).** When the
"dual annotators" are LLM agents and the JUDGES being calibrated are also LLM
agents, two independence concerns emerge:
1. **Annotator-annotator independence.** Two agents from the same model family
   share base biases. The dual-annotator procedure (Curie R2) requires
   annotators be *operationally* independent (blind to peer verdict, judge
   verdict, validator output). LLM-pair independence requires either
   (a) different model families per annotator, or (b) explicit prompt-level
   isolation with verified non-leakage.
2. **Annotator-judge independence.** If annotator-LLMs and judge-LLMs share
   training data, the calibration measures *agreement-with-annotator-LLM*, not
   *agreement-with-truth*. A judge that disagrees with the annotator pool may
   actually be more correct, not less. This is genuinely unsolved by simply
   parallelizing more agents.

**Recommended treatment of independence:** the held-out 20% partition (already
mechanically sealed via `verifyHeldoutPartitionSeal`) should include claims
with externally-verifiable ground truth (e.g., schema-correct vs.
schema-broken JSON, factual claims with ground-truth lookup) so the falsifier
test can distinguish "calibration agrees with annotator pool" from
"calibration agrees with reality." This is a Wave C+ constraint, not a Wave B
implementation gate.

---

### Option 1 — Full parallel agent calibration (NEW DEFAULT under Max subscription)

Dispatch K parallel subagent pairs as the annotator pool. With LLM agents,
1 run/pair/day becomes 1 run/pair/minute or faster.

**Throughput math.** 3,890 runs / 60 parallel pairs at ~30s/claim ≈
3,890 / (60 × 120 claims/hr) = 0.54 hours of orchestrator wall-clock.
Sequential at 1 pair: ~32 hours. Either form is feasible in a single working
session.

| Dimension | Value |
|---|---|
| Agent invocations | ~58,000 (annotator + judge + adjudicator passes) |
| Wall-clock | 1 hour (60-pair parallel) → 32 hours (1-pair sequential) |
| Statistical guarantee | \|Δ\|≥0.10 at power=0.80; full per-cell calibration |
| Falsifier sensitivity | full — all 66 cell-arms calibrated |
| Code/spec changes | none — existing implementation supports this |
| Risk | LLM-annotator independence (see warning above). Must be addressed by either heterogeneous-model-family annotators OR external ground-truth claims in the held-out partition. |

---

### Option 2 — Hierarchical pooling (multilevel model, claim_type as random effect)

Estimate per-judge sensitivity/specificity with claim_type as a partial-pooling
random effect (multilevel / mixed-effects Beta-Binomial). Reduces effective N
from 292/cell to ~292/judge ≈ 9× fewer observations.

**Throughput math.** 3 judge kinds × 292/judge = 876 observations total. At
60 parallel agent pairs × 30s/claim: ~7 minutes wall-clock.

| Dimension | Value |
|---|---|
| Agent invocations | ~2,600 (9× fewer than Option 1) |
| Wall-clock | 7 minutes (parallel) → 4 hours (sequential) |
| Statistical guarantee | \|Δ\|≥0.10 at the per-judge level; claim_type effect is pooled |
| Falsifier sensitivity | reduced — claim_type deviations partially pooled toward judge mean |
| Code/spec changes | replace `splitSensitivitySpecificity` with hierarchical model; new math module; separate pre-registration for the multilevel structure |
| Risk | Statistical complexity; hierarchical assumption (claim_type random effect well-behaved) is unverified — needs sensitivity analysis comparing to Option 1 on a subset. |

---

### Option 3 — Lowered v1 N target (N=80/cell)

Ship v1 with N=80/arm/cell. Detects |Δ|≥0.20 at power=0.80 (not 0.10).
Originally proposed because of the dollar-cost ceiling of paid annotators —
that constraint is dissolved under the Max subscription, but Option 3 remains
useful as a fast smoke-test pass before committing to the full N=292.

| Dimension | Value |
|---|---|
| Agent invocations | ~16,000 |
| Wall-clock | 18 minutes (parallel) → 9 hours (sequential) |
| Statistical guarantee | \|Δ\|≥0.20 at power=0.80 per cell |
| Falsifier sensitivity | low — detects large reliability failures only |
| Code/spec changes | update N_TARGET constant in pre-registration; update stopping rule |
| Risk | Weaker statistical claims; if true reliability shift is 0.10, v1 misses it. Useful as a v0 smoke test before committing the full Option 1 run. |

---

### Option 4 — Subset-of-judges first (calibrate top 1-2 judges in v1)

Calibrate only the 1-2 most-frequently-dispatched judges in v1. Defer remaining
judges to v2.

| Dimension | Value (1 judge / 2 judges, N=292) |
|---|---|
| Agent invocations | ~6,500 / ~13,000 |
| Wall-clock | 7 / 14 minutes (parallel) |
| Statistical guarantee | full per-cell for selected judges; uncalibrated for remainder |
| Falsifier sensitivity | partial — only selected judges contribute |
| Code/spec changes | add judge-dispatch-frequency telemetry to select top judges; add fallback policy (use prior) for uncalibrated judges in consensus.ts |
| Risk | Incomplete consensus weighting; "top-dispatched" judge set may shift as dispatch patterns change. Useful only if Option 1 invocation budget is somehow constrained, which it isn't here. |

---

### Decision rule (revised under Max subscription)

**NEW DEFAULT: Option 1 (full parallel agent calibration).** Zero marginal
cost, ~1 hour parallel wall-clock, full per-cell |Δ|≥0.10 calibration.
**Conditional on resolving the LLM-annotator independence concern** before
the run begins — Wave C+ must commit to either heterogeneous-model-family
annotators OR an externally-grounded held-out subset.

**Recommended sequencing:**
1. Run Option 3 (N=80) first as a smoke test (~18 minutes parallel) to
   validate the pipeline end-to-end and surface any operational issues.
2. Then Option 1 (N=292) for the production calibration.
3. Track Option 2 (hierarchical pooling) as an analytical follow-on once
   Option 1 data is in hand — the multilevel model can be fit on the same
   observation log without re-running the agents.

Option 4 is deprecated under Max subscription (no invocation-budget reason to
prefer it).

**This sequencing must be locked in before annotation begins, but the lock-in
is now a methodological commitment (independence resolution + run order), not
a financial one.**

Source: Fermi cross-audit A1; docs/PHASE_4_PLAN.md §4.1 PRE-REGISTRATION;
Laplace L4 (N=292 derivation); Wave E E1 (paired-bootstrap implementation, Efron & Tibshirani 1993 Ch. 16 §16.4).
