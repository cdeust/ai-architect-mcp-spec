<!-- mcp-name: io.github.cdeust/ai-architect-mcp-spec -->

<p align="center">
  <img src="assets/banner.svg" alt="AI Architect MCP Spec — verified PRDs for agentic delivery pipelines" width="100%"/>
</p>

**AI Architect MCP Spec** is published as `ai-architect-mcp-spec` across its
Claude Code, Codex, Gemini, MCPB, PyPI/npm, and MCP Registry surfaces. `0.7.0`
moved the MCP Registry entry and primary bundle to the new identity while
keeping the Claude/Codex/Gemini plugins under `prd-spec-generator`; `0.8.0`
completed the migration — no `prd-spec-generator` plugin or release alias is
retained anywhere. The former `io.github.cdeust/prd-spec-generator` Registry
versions are deprecated with a pointer to the canonical entry rather than
left active and frozen.

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License">
  <img src="https://img.shields.io/badge/TypeScript-7.0+-3178c6.svg" alt="TypeScript 7.0+">
  <img src="https://img.shields.io/badge/Node-20.x_·_22.x-339933.svg" alt="Node 20/22">
  <img src="https://img.shields.io/badge/Tests-1506_passing-brightgreen" alt="1506 passing">
  <img src="https://img.shields.io/badge/Packages-10-orange" alt="10 packages">
  <img src="https://img.shields.io/badge/MCP_Tools-17-8A2BE2" alt="17 MCP tools">
  <img src="https://img.shields.io/badge/Validators-Hard_Output_Rules-red" alt="Hard Output Rules">
  <img src="https://img.shields.io/badge/Calibration-Closed_Loop-success" alt="Closed-loop reliability calibration">
  <a href="https://www.bestpractices.dev/projects/13832"><img src="https://www.bestpractices.dev/projects/13832/badge" alt="OpenSSF Best Practices"></a>
</p>

<p align="center">
  <strong>Cross-platform PRD verification for Codex, Gemini CLI, Claude Code, CI, and any stdio MCP host.</strong><br>
  The deterministic two-tool verifier travels everywhere; the full 9-file generation pipeline remains available to orchestration-capable hosts.
</p>

<p align="center">
  <a href="#what-an-agent-can-ask-it">What An Agent Asks</a> · <a href="#getting-started">Getting Started</a> · <a href="#the-pipeline">Pipeline</a> · <a href="#the-mcp-tools">Tools</a> · <a href="#multi-judge-verification">Verification</a> · <a href="#calibration--falsification">Calibration</a> · <a href="#architecture">Architecture</a> · <a href="#the-zetetic-standard">Zetetic Standard</a>
</p>

<p align="center">
  <strong>Companion projects:</strong><br>
  <a href="https://github.com/cdeust/Cortex">Cortex</a> — persistent memory that injects past decisions into every PRD<br>
  <a href="https://github.com/cdeust/zetetic-team-subagents">zetetic-team-subagents</a> — 97 genius reasoning patterns that judge each claim<br>
  <a href="https://github.com/cdeust/ai-architect-mcp-codebase">ai-architect-mcp-codebase</a> — the codebase intelligence layer this generator consumes upstream
</p>

---

Every AI agent that drafts a PRD eventually invents a function that doesn't exist, claims latency it can't measure, or writes acceptance criteria that don't tie back to the requirements they're supposed to test. The output sounds confident. It is not actionable. The next stage in the pipeline — code generation, ticket import, sprint planning — silently inherits the hallucination, ships it, and pays for it later.

**AI Architect MCP Spec** is a TypeScript MCP server that fixes this at the structural level. Its portable verifier gives Codex, Gemini CLI, Claude Code, CI, and other stdio MCP hosts the same deterministic Hard Output Rules and cross-section traceability checks. The full pipeline is a stateless reducer (`step(state, result?) → next_state, action`) driven by a host that can execute its orchestration actions; Claude Code is the only packaged full-pipeline host today. Sections are produced one at a time, validated before the host ever sees them, and every load-bearing claim is judged by a panel of genius reasoning agents drawn from `zetetic-team-subagents` against the codebase graph from `ai-architect-mcp-codebase`. The loop is closed: per-judge reliability is calibrated from history, retry budgets are derived from survival statistics, KPI gates are tuned against frozen baselines, and held-out partitions are mechanically sealed so no calibration result can be peeked at before evaluation.

**10 packages. 17 MCP tools. 20 pipeline steps (11 PRD generation + 9 opt-in implementation). Multi-judge verification with consensus. Closed-loop calibration with externally-grounded falsifiers. 1506 tests. Every numeric constant traces to a citation, a benchmark, or a `// source: provisional heuristic` admission.**

---

## Closed-loop reliability calibration

Verification is not a one-shot pass/fail report. Every claim resolution can flush an observation back to a calibration repository, every consensus run can pull calibrated posteriors from history, and every closed loop runs an external control arm so the calibration's effect is *measured*, not assumed.

- **Per-judge Bayesian reliability calibration** — Beta(7,3) prior with sensitivity / specificity split per `claim_type`. Posteriors stored in a SQLite-backed `ReliabilityRepository`; observations flushed on every claim resolution.
- **MAX_ATTEMPTS retry calibration** — Kaplan-Meier survival math (`kmEstimate` / `kmMedianAttempts` / `logRankTest` with Greenwood + Brookmeyer-Crowley CIs); Schoenfeld sample-size derivation event-rate-corrected to ~519 (was 823) against the measured `event_rate=0.4762`, CP CI `[0.4456, 0.5069]`.
- **KPI gate tuning** — Clopper-Pearson exact CIs; per-machine-class wall_time normalization with 5-bucket `detectMachineClass`; frozen-baseline content-hash assertion; `loadCalibratedGates` + `hold_provisional` ratchet protection.
- **Plan-mismatch fire-rate** — measured via XmR control charts (Wheeler 1995, Western Electric 1956) with a synthetic injection round-trip pre-flight that catches drift between the diagnostic prefix and the regex matcher.
- **Externally-grounded held-out subsets** — Ajv schema oracle, mathjs oracle, `tsc` subprocess code oracle, `validateSection` spec oracle. `OracleUnavailableError` typed throw replaces stub-mode fabrication. This is the layer that breaks annotator-circularity — judges and oracles share no inference path.
- **CC-3 forced-exploration control arms** — every closed loop carves out a 20% partition that reverts to the prior. Without it, calibration-on-calibration looks like progress whether or not it actually is.
- **Cross-arm comparison metrics** — `computeAblationComparison` / `computeReliabilityComparison` / `computeKpiGateComparison` produce paired-bootstrap CIs (Efron & Tibshirani 1993 §16.4; deterministic mulberry32 RNG; 12-decimal reproducibility pin). Outcome is a falsifiable recommendation: `calibrated_helps`, `prior_helps`, or `inconclusive_underpowered`.
- **Mechanically-enforced held-out partition seals** — three sealed lock files (`maxattempts-heldout.lock.json`, `kpigates-heldout.lock.json`, `heldout-partition.lock.json`) commit a sha256 of the partition before evaluation. The `SEAL_VERIFIED` typeof sentinel is the only way to compute cross-arm metrics on a sealed partition; passing anything else is a type error at the boundary.
- **Production-mode dispatcher** — `makeProductionDispatcher` + `AgentInvoker` interface. The CLI `--mode production|canned` flag selects whether calibration sees real verdicts or canned ones; the canned arm is preserved for offline reproducibility.

---

## What an agent can ask it

```
start_pipeline(feature_description, codebase_path?)
  → returns the first NextAction; the host executes it and feeds the result
    back via submit_action_result. Eleven steps later: 9 PRD files written.

submit_action_result(run_id, result)
  → drives the reducer one more step. The host sees only SUBSTANTIVE actions
    (ask_user, call_pipeline_tool, call_cortex_tool, spawn_subagents,
     write_file, done, failed). emit_message is coalesced into the
     messages array; the host never has to "advance past" a banner.

validate_prd_section(content, section_type)
  → deterministic Hard Output Rules — zero LLM calls, pure regex/parsing.
  → returns: violations[], hasCriticalViolations, totalScore.

validate_prd_document(sections[])
  → cross-section checks: SP arithmetic, AC numbering, FR-AC coverage,
    test traceability. Catches what per-section validation misses.

coordinate_context_budget(prd_context, completed_sections[])
  → per-section retrieval/generation token budgets so Cortex recall and
    section drafting don't fight over the same context window.

map_failure_to_retrieval(violations[])
  → closes the validation→retrieval feedback loop. When a section fails
    validation, this returns the corrective Cortex query that would
    have prevented the failure.
```

---

## Getting started

### Install (marketplace — recommended)

```bash
claude plugin marketplace add cdeust/ai-architect-mcp-spec
claude plugin install ai-architect-mcp-spec@ai-architect-mcp-spec-marketplace
```

Restart your Claude Code session. The 17 MCP tools register on first
stdio handshake. Then:

```
/generate-prd build OAuth login for the admin console
```

The plugin's bundled MCP server at `mcp-server/index.js` is self-contained
(only `better-sqlite3` is an optional native dependency for the evidence
repository — gracefully degrades to in-memory mode when absent).

#### Migrating from `prd-spec-generator`

The old plugin and marketplace are deprecated publications, not aliases. Remove
them before installing the canonical package:

```bash
claude plugin uninstall prd-spec-generator@prd-spec-generator-marketplace
claude plugin marketplace remove prd-spec-generator-marketplace
claude plugin marketplace add cdeust/ai-architect-mcp-spec
claude plugin install ai-architect-mcp-spec@ai-architect-mcp-spec-marketplace
```

Callers that used `prd-spec-generator:generate-prd` must use
`ai-architect-mcp-spec:generate-prd`. The `prd-gen` MCP server name,
`@prd-gen/*` private workspace packages, `PRD_GEN_*` environment variables,
and `.prd-gen` local data directory remain stable internal interfaces; they do
not keep the deprecated publication installed.

Plugin-scoped MCP tool names include both the publication name and the stable
server key, so prompts, automation, and allowlists must migrate the complete
prefix:

- old: `mcp__plugin_prd-spec-generator_prd-gen__<tool>` <!-- mcp-prefix-allow-legacy -->
- new: `mcp__plugin_ai-architect-mcp-spec_prd-gen__<tool>`

Gemini CLI also keys installed extensions by the manifest name. Replace an
installed extension under the former identity instead of updating it in place:

```bash
gemini extensions uninstall prd-spec-generator
gemini extensions install https://github.com/cdeust/ai-architect-mcp-spec
```

### Companion ecosystem

For full effect, install the three companion plugins so the pipeline can
consume codebase intelligence, persistent memory, and the genius-agent
panel:

```bash
claude plugin marketplace add cdeust/ai-architect-mcp-codebase  # codebase graph intel
claude plugin marketplace add cdeust/Cortex                  # persistent memory
claude plugin marketplace add cdeust/zetetic-team-subagents  # the genius + team agents

claude plugin install ai-architect-mcp-codebase
claude plugin install hypermnesia-mcp
claude plugin install zetetic-team-subagents
```

Each plugin is independently useful; together they are the ai-architect
ecosystem. See [Companion ecosystem](#companion-ecosystem) above.

### Building from source

For development or to run the audit cycle locally:

```bash
git clone https://github.com/cdeust/ai-architect-mcp-spec.git
cd ai-architect-mcp-spec
pnpm install --frozen-lockfile
pnpm build      # builds all 9 buildable packages via tsc
pnpm bundle     # produces the standalone mcp-server/index.js
pnpm test       # 1506 tests (vitest workspace, all packages; the
                # ai-architect-mcp-codebase wire contract is pinned
                # unconditionally — see docs/INTEGRATION-TESTING.md)
```

`pnpm verify` runs all of the above (install + build + bundle + test) —
same as CI.

**Prerequisites for source builds:** Node.js 20.x or 22.x, pnpm v10+
(`corepack enable && corepack prepare pnpm@10`).

### Smoke-test offline

```bash
# Reducer end-to-end without a real host (uses the canned dispatcher):
pnpm test --filter @prd-gen/orchestration smoke

# Benchmark KPI run:
pnpm test --filter @prd-gen/benchmark pipeline-kpis
```

Both run in <2s on an M-series Mac. No LLM calls, no MCP traffic — the
reducer is fully driven by canned ActionResults so you can audit behaviour
offline.

### Use with other MCP hosts

Honest scoping first. The **full pipeline is host-dependent**: the reducer
returns actions (`ask_user`, `spawn_subagents`, `write_file`) that assume a
host which executes them and feeds results back. Claude Code (via the plugin +
`/generate-prd` skill) remains the only packaged host for that workflow.

Codex and Gemini instead receive the portable **Spec Verifier**: a no-LLM
surface with exactly two deterministic tools and the same `audit-prd` and
`validate-spec` skills:

- `validate_prd_section` — Hard Output Rules against a single section
- `validate_prd_document` — cross-section checks (SP/AC/FR/test traceability)

Install it in Codex from the repository marketplace:

```bash
codex plugin marketplace add cdeust/ai-architect-mcp-spec
codex plugin add ai-architect-mcp-spec@ai-architect-mcp-spec-marketplace
```

Install the same package as a Gemini CLI extension:

```bash
gemini extensions install https://github.com/cdeust/ai-architect-mcp-spec
```

Both manifests launch `mcp-server/index.js` with `--profile verifier`. The
existing Claude manifest passes no profile and therefore retains the default
17-tool `full` surface.

A zero-violation result means that the document satisfies the implemented
structural rules. It does **not** prove factual accuracy, product value,
implementation feasibility, security, or semantic correctness.

For an un-packaged MCP host, clone the repository and select the same narrow
profile explicitly. Replace `/abs/path` with the clone location.

```bash
git clone https://github.com/cdeust/ai-architect-mcp-spec.git /abs/path/ai-architect-mcp-spec
cd /abs/path/ai-architect-mcp-spec/mcp-server
npm ci --omit=dev
```

**OpenAI Codex CLI** (`~/.codex/config.toml`, shared with the ChatGPT
desktop app and Codex IDE extension):

```bash
codex mcp add prd-spec -- node /abs/path/ai-architect-mcp-spec/mcp-server/index.js --profile verifier
```

**Cursor** (`.cursor/mcp.json`) and **Windsurf**
(`~/.codeium/windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "prd-spec": {
      "command": "node",
      "args": [
        "/abs/path/ai-architect-mcp-spec/mcp-server/index.js",
        "--profile",
        "verifier"
      ]
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "prd-spec": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/abs/path/ai-architect-mcp-spec/mcp-server/index.js",
        "--profile",
        "verifier"
      ]
    }
  }
}
```

---

## The pipeline

The reducer produces twenty sequential steps: eleven PRD-generation steps, then nine opt-in post-specs implementation steps entered only through a human gate. Each step emits at most one substantive action; the host executes it and feeds the result back. A typical trial-tier feature run (11 sections) takes ~62 host-visible iterations.

| # | Step | What it produces |
|---|------|------------------|
| **1** | `banner` | Welcome banner with run ID + feature description + capability summary |
| **2** | `preflight` | Probes the required ecosystem MCPs (Cortex, ai-architect) before the pipeline depends on them; skippable via `skip_preflight` |
| **3** | `context_detection` | Detects PRD type from trigger words; asks user when ambiguous |
| **4** | `input_analysis` | Calls `index_codebase` (ai-architect-mcp-codebase) when a path is provided; sets `codebase_graph_path` |
| **5** | `feasibility_gate` | Detects epic-scope inputs (≥2 EPIC_SIGNALS); asks user to focus |
| **6** | `clarification` | Compose-then-answer rounds (4–10 depending on tier); short-circuits on "proceed" |
| **7** | `budget` | Per-section retrieval/generation token allocation via Cortex paper's 60/30/10 split |
| **8** | `section_generation` | One section at a time: Cortex recall → engineer draft → validate → (retry up to 3) |
| **9** | `jira_generation` | Synthesises JIRA tickets from requirements + user_stories + acceptance_criteria |
| **10** | `file_export` | Writes 9 files (6 core + 3 companion) per SKILL.md |
| **11** | `self_check` | Two-phase multi-judge verification (see below); typed `verification` field on `done` |

Steps 12–20 are the opt-in post-specs implementation loop: `implementation_gate` (human gate — "Implement" vs "PRD only"; also writes `10-verification-report.md`) → `pre_impl_grounding` → `implementation` (engineer subagent in an isolated worktree) → `post_impl_verification` (index → detect changes → semantic diff → security gates) → `testing` → `review` (a FAIL verdict retries `implementation` on the same worktree, bounded by `REVIEW_RETRY_CAP`) → `pr_gate` (mandatory human gate before any push) → `pr_creation` → `finalize`. Answering "PRD only" at `implementation_gate` skips straight to `finalize`; `complete` is the terminal marker, not a step.

Every step is independently testable (`stepOnce(state, result?)` returns the same shape as the runner). The runner coalesces `emit_message` actions internally so the host never sees a no-op.

---

## The MCP tools

Three surfaces. The reducer drives the full pipeline; the validation + verification
+ budget tools can be consumed directly by other systems without entering the
pipeline; the diagnostics surface exposes config + health + history.

```
Reducer (3):
  start_pipeline             Initialize a run; returns first NextAction
  submit_action_result       Drive the reducer one step; returns next NextAction
  get_pipeline_state         Read-only state snapshot for diagnostics

Validation (2):
  validate_prd_section       Hard Output Rules — single section
  validate_prd_document      Cross-section checks (SP/AC/FR/test traceability)

Verification (3):
  plan_section_verification  Extract claims + select judge panels
  plan_document_verification Same, document-wide
  conclude_verification      Aggregate JudgeVerdict[] → VerificationReport;
                             accepts optional `claims` array carrying
                             `external_grounding` so oracle-resolved ground
                             truth can replace LLM-only consensus where
                             schema/math/code/spec oracles are available

Budget + feedback (2):
  coordinate_context_budget  Per-section token allocation
  map_failure_to_retrieval   Validation failure → corrective Cortex query

Diagnostics (7):
  get_config, read_skill_config, check_health, get_prd_context_info,
  list_available_strategies, get_quality_history, get_strategy_effectiveness
```

Each tool takes structured Zod-validated arguments and returns a typed response. No tool calls an LLM — section drafts and judge verdicts come back via the host's `spawn_subagents` action so the same pipeline runs against any agent runtime.

---

## Multi-judge verification

The `self_check` step is a two-phase contract. Phase A plans the verification batch and persists a snapshot of `(claim_ids, judges)` to state. Phase B receives the verdicts, parses them against the snapshot, and aggregates via the consensus engine.

```
plan_document_verification(sections[])
  → extracts atomic Claims (FR-001, AC-005, NFR-LATENCY-1, ...)
  → selects a panel per claim type:
      architecture        → liskov + alexander + dijkstra + architect
      performance         → fermi + carnot + curie + erlang
      security            → wu + ibnalhaytham + security-auditor
      data_model          → mendeleev + dba + lavoisier
      acceptance_criteria → toulmin + popper + test-engineer
      ...

[host spawns the panel; each agent returns a JSON verdict]

conclude_verification(verdicts[])
  → Per claim, runs consensus():
      strategy: weighted_average (default) | bayesian
      fail_threshold: 0.5  (≥50% confidence-weighted FAIL → forces FAIL)
      precautionary tie-breaker: more-severe verdict wins
  → distribution_suspicious flag fires when 100% PASS over ≥5 claims
  → returns ConsensusVerdict[] with full distribution + dissenting list
```

The verdict taxonomy is deliberately five-level — not binary. NFR claims (latency, fps, throughput, storage) **MUST NOT receive PASS**: they are SPEC-COMPLETE if a measurement method is specified, NEEDS-RUNTIME otherwise. Judges that default to PASS for everything are caught by the `distribution_suspicious` detector and flagged in the typed `done.verification` field.

---

## Calibration & falsification

The verification subsystem is itself a hypothesis: that *consensus weighted by historically-calibrated reliability* outperforms *consensus weighted by a uniform prior*. The closed loop below is what tests it.

1. **Observe.** Each verification run can flush per-judge observations (claim_id, claim_type, judge_id, verdict, oracle_truth?) to a SQLite reliability repository. Observations carry an `external_grounding` field that propagates from `Claim` through the orchestrator to the oracle resolution path; when an external oracle (Ajv schema, mathjs, `tsc`, `validateSection`) can resolve the claim, its truth replaces LLM-only consensus.
2. **Calibrate.** On subsequent runs, calibrated posteriors weight consensus per judge, per `claim_type`. A 20% control-arm partition is forced-explored using the prior (`getReliabilityForRun` / `getRetryArmForRun` decide which arm a given run lands in deterministically from `run_id`). Without the control arm, calibration-on-calibration looks like progress whether or not it actually is.
3. **Compare.** Cross-arm metrics (`computeAblationComparison`, `computeReliabilityComparison`, `computeKpiGateComparison`) run paired-bootstrap CIs (Efron & Tibshirani 1993 §16.4; deterministic mulberry32 RNG; 12-decimal reproducibility pin) and emit one of three falsifiable recommendations: `calibrated_helps`, `prior_helps`, or `inconclusive_underpowered`.
4. **Seal.** Held-out partitions are committed to lock files (`maxattempts-heldout.lock.json` for §4.2, `kpigates-heldout.lock.json` for §4.5, `heldout-partition.lock.json` for the §4.1 50-claim externally-grounded corpus) with a sha256 hash of the partition. The cross-arm metric functions accept a `SEAL_VERIFIED` typeof sentinel as a parameter; the only way to obtain that sentinel is to verify the seal first. Peeking at a held-out partition before evaluation is a type error.
5. **Ground.** Where an external oracle can resolve a claim deterministically, it does. Where it cannot, `OracleUnavailableError` is thrown rather than fabricating a stub-mode truth. This is the line that breaks annotator-circularity: judges trained against (or biased toward) LLM-style reasoning cannot poison calibration that uses non-LLM truth.

The lock files, the seal-verification dance, and the control-arm partition together mean: when a cross-arm comparison says "calibrated_helps with 95% CI excluding zero," the claim is *measured*, not vibes-checked. When it says "inconclusive_underpowered," that is also a falsifiable claim — you need more data, not more confidence.

---

## Architecture

Ten workspace packages, each independently buildable, with strict Clean Architecture layering enforced by package boundaries.

```
core              ← domain types, schemas, agent identities
                    │  no I/O, no infrastructure dependency
                    │  Zod-validated; the only place where verdict /
                    │  section_type / capability shapes are defined
                    ▼
validation        ← Hard Output Rules (per-section + cross-section)
                    │  pure functions; no I/O
                    ▼
strategy          ← thinking-strategy selector (genius pattern routing)
                    │
meta-prompting    ← prompt builders for clarification / draft / jira
                    │  pure string composition
                    ▼
verification      ← claim extraction + judge selection +
                    │  consensus engine (weighted_average + Bayesian)
                    │  + buildJudgePrompt
                    ▼
orchestration     ← stateless reducer, 20 step handlers, runner
                    │  step(state, result?) → next_state, action
                    │  emit_message coalescing; canned-dispatcher utility
                    ▼
ecosystem-adapters← StdioMcpClient, AiArchitectCodebaseClient, CortexClient
                    │  the only package allowed to do I/O
                    ▼
mcp-server        ← composition root; 17 tools registered;
                    │  evidence repository (better-sqlite3, optional)
                    ▼
benchmark         ← pipeline KPI measurements + golden-fixture HOR scoring
                    │  + calibration/ subtree:
                    │    · ReliabilityRepository (SQLite, observation flush)
                    │    · Kaplan-Meier + log-rank + Schoenfeld N
                    │    · Clopper-Pearson exact CI + XmR control charts
                    │    · paired-bootstrap (Efron-Tibshirani 1993 §16.4)
                    │    · external oracles (Ajv / mathjs / tsc / validate)
                    │    · machine-class detector + frozen-baseline gates
                    │    · sealed held-out lock files (sha256 + SEAL_VERIFIED)
                    │    · production-mode dispatcher + AgentInvoker seam
                    │  Audit lineage: JSONL + .xmr sidecars per run.
skill             ← SKILL.md + slash-command definitions for Claude Code
```

### Dependency rule (absolute)

Every package's `package.json` is checked: `core` depends only on `zod`; `verification` depends only on `core`; `orchestration` depends on `core`/`validation`/`verification`/`meta-prompting` (NOT on `ecosystem-adapters`); `ecosystem-adapters` depends on `core` + `verification`; `mcp-server` is the only place where everything composes.

A cross-audit found and fixed two layer violations:
- `orchestration` was importing `extractJsonObject` and `buildJudgePrompt` from `ecosystem-adapters` — pure utilities lived in the wrong package; moved to `core` and `verification` respectively.
- Pure domain types (`Claim`, `JudgeVerdict`, `JudgeRequest`, `AgentIdentity`) lived in `ecosystem-adapters/contracts/subagent.ts`; moved to `core/domain/agent.ts`. The infrastructure package now re-exports them as a backward-compat shim.

---

## What this fixes that previous PRD generators don't

| Failure mode | What we do |
|---|---|
| **Section drift between turns** | Single immutable `PipelineState` snapshot per step; reducer is pure; host can replay any step |
| **Hallucinated symbols** | `validate_prd_section` runs Hard Output Rules; symbols cross-checked against `ai-architect-mcp-codebase` graph if `codebase_path` is set |
| **NFRs claiming PASS without measurement** | Verdict taxonomy refuses PASS for latency/throughput/fps/storage; consensus engine forwards SPEC-COMPLETE / NEEDS-RUNTIME |
| **Confirmatory bias (every judge says PASS)** | `distribution_suspicious` flag fires at 100% PASS over ≥5 claims; surfaced in typed `done.verification.distribution_suspicious` |
| **Acceptance criteria not traceable to requirements** | Cross-document validator checks FR-AC coverage and AC numbering gaps |
| **Tests claiming "comprehensive" without listing what they cover** | Test-traceability rule: every section's claimed test must reference an FR or AC ID |
| **Retries that use the same context as the failure** | `map_failure_to_retrieval` closes the validator→Cortex feedback loop; corrective queries before retry |
| **Magic-number budgets ("we'll use 4K tokens for retrieval")** | `coordinate_context_budget` produces per-section allocations from the canonical SECTIONS_BY_CONTEXT plan |

---

## How it composes with the rest of the ecosystem

```
                            ┌────────────────────────────────────┐
                            │         Claude Code (host)         │
                            └────────────────────┬───────────────┘
                                                 │ stdio MCP
              ┌──────────────────────────────────┼──────────────────────────────────┐
              ▼                                  ▼                                  ▼
   ┌───────────────────┐              ┌────────────────────┐              ┌───────────────────┐
   │   ai-architect-   │   graph_path │   ai-architect-    │  recall      │      Cortex       │
   │   mcp-codebase    │ ───────────► │   mcp-spec         │ ◄─────────── │   (memory engine) │
   │   (Rust MCP)      │              │   (TS MCP)         │              │   (Python MCP)    │
   │                   │   symbols    │                    │  excerpts    │                   │
   │   read-only       │ ◄──────────► │   stateless        │ ───────────► │   thermodynamic   │
   │   intelligence    │              │   reducer          │              │   memory          │
   └───────────────────┘              └─────────┬──────────┘              └───────────────────┘
                                                │
                                                │ spawn_subagents
                                                ▼
                                  ┌─────────────────────────────┐
                                  │   zetetic-team-subagents    │
                                  │   97 genius + 19 team       │
                                  │   Each judge cites its      │
                                  │   primary paper.            │
                                  └─────────────────────────────┘
```

Each project owns one concern. `ai-architect-mcp-codebase` knows what's true about the code. Cortex knows what we already decided. zetetic-team-subagents knows how to reason about a specific shape of claim. **AI Architect MCP Spec** is the deterministic glue that turns those three signals into a PRD an agent can act on.

---

## The Zetetic Standard

Every load-bearing constant in this codebase carries a `// source:` annotation. Three forms are accepted:

```typescript
// source: <citation>          // a paper, a spec, a referenced design doc
// source: benchmark <path>    // a committed benchmark whose output produced this value
// source: provisional heuristic — <calibration plan>
                               // honest admission; tells the next reader
                               // (a) why the value is what it is today and
                               // (b) what evidence would change it
```

The cross-audit found and tagged every previously bare constant. Examples:

```typescript
// pipeline-kpis.ts
const KPI_GATES = {
  /** source: provisional heuristic. Smoke baseline = 62 iterations on
   *  trial+codebase; cap is 100 (~60% headroom). dijkstra cross-audit
   *  derived a structural max of 9 emit_message hops; the substantive-
   *  action count builds on that. Replace with measured P95 + 1σ once
   *  the calibrated baseline has enough runs. */
  iteration_count_max: 100,
  ...
};

// verification/consensus.ts
/** source: provisional heuristic — Beta(7,3) (mean 0.7, ESS=10,
 *  moderately informative toward reliability). Replaced per agent by
 *  Beta(α+correct, β+incorrect) once calibrated from history. */
const DEFAULT_RELIABILITY_PRIOR_MEAN = 0.7;
```

The four pillars (consistent / true / useful / necessary) and the seven rules of zetetic inquiry are inherited from the [zetetic-team-subagents standard](https://github.com/cdeust/zetetic-team-subagents#the-zetetic-standard). Provisional values are not silently propagated as truth.

---

## What this system does not do

The same standard applied to itself.

1. **The PRD pipeline does not write code — and the server itself never does.** Steps 1–11 produce a PRD; symbols in the PRD are validated against the graph but never edited by us. The opt-in implementation loop (steps 12–20) runs only when a human answers "Implement" at `implementation_gate`; there, the host's engineer/test-engineer/code-reviewer subagents write, test, and review the implementation in an isolated worktree, and nothing is pushed or turned into a PR without the mandatory `pr_gate` approval. This server only emits `spawn_subagents` actions — it never edits source files or pushes branches itself.
2. **It does not validate prose quality.** Hard Output Rules check structural invariants (FR numbering, AC traceability, NFR shape, cross-references). They do not check whether a sentence is well-written or persuasive. That is what the multi-judge phase is for, and even there the judges return verdicts on *claims* — atomic assertions — not on style.
3. **The judge phase is end-to-end testable but the judges are not deterministic.** In tests we use a canned dispatcher that returns 100% PASS by construction; the `distribution_suspicious` detector exists precisely because real judge panels can also degenerate into confirmatory consensus, and we do not pretend otherwise.
4. **The KPI gates are calibrated, not hand-picked.** `iteration_count_max`, `wall_time_ms_max`, and `mean_section_attempts_max` are calibrated against the K=100 frozen baseline with Clopper-Pearson exact CIs, per-machine-class wall_time normalization, and `loadCalibratedGates` + `hold_provisional` ratchet protection. The lock file commits a content-hash of the baseline; mutating it post hoc fails the seal verification. Where data is still thin, gates remain `hold_provisional` rather than locked. See [docs/PHASE_4_PLAN.md](docs/PHASE_4_PLAN.md) for the full pre-registration.
5. **Citation presence ≠ citation validity.** A `// source: Knuth 1998` comment satisfies the convention whether or not Knuth 1998 exists or supports the value. We enforce that the citation IS THERE; the cross-audit cycle (genius + team review every phase) is what keeps it honest.

---

## Reproducing the audit cycle

The repo ships a multi-agent cross-audit workflow. After every non-trivial phase:

```bash
# Engineering team review:
#   architect, code-reviewer, refactorer, test-engineer, security-auditor,
#   devops-engineer, dba (when relevant)

# Genius team review:
#   feynman (integrity), curie (measurement), popper (falsifiability),
#   dijkstra (correctness), shannon (signal), deming (variation),
#   poincare (qualitative), ...
```

Each agent reads the current state of the code (not from memory) and produces a ranked finding list, severity-ranked. Findings are closed in the cycle that raised them; anything that cannot be closed without new measurement is carried with the evidence required to close it written down, so a deferral is a stated obligation rather than a silence.

---

## Project layout

```
packages/
├── core/                  Domain types · schemas · agent identities · evidence repo
├── validation/            Hard Output Rules · per-section + cross-section validators
├── verification/          Claim extraction · judge selection · consensus engine
├── meta-prompting/        Prompt builders (clarification / draft / jira)
├── strategy/              Thinking-strategy selector
├── orchestration/         Stateless reducer · 20 step handlers · runner · canned-dispatcher
├── ecosystem-adapters/    StdioMcpClient · AiArchitectCodebaseClient · CortexClient
├── mcp-server/            Composition root · 17 MCP tools registered
├── benchmark/             Pipeline KPI measurement · golden-fixture HOR scoring
│   └── calibration/       ReliabilityRepository · KM survival ·
│                          Clopper-Pearson · XmR · paired-bootstrap ·
│                          external oracles · sealed held-out partitions ·
│                          production-mode dispatcher
└── skill/                 SKILL.md · slash-command definitions
```

---

## License

MIT — see [LICENSE](LICENSE).

**Project documents:** [ROADMAP](docs/ROADMAP.md) (what the project intends to
do, and what it will not do, for the next year) ·
[CONTRIBUTING](CONTRIBUTING.md) (how to propose a change,
and the testing policy) · [GOVERNANCE](GOVERNANCE.md) (who decides, and what
happens to the project if the maintainer stops) · [SECURITY](SECURITY.md) (how
to report a vulnerability, and the supply-chain guarantees) ·
[Assurance case](docs/ASSURANCE-CASE.md) (the security argument and where it
stops) · [CODE OF CONDUCT](CODE_OF_CONDUCT.md) · [CHANGELOG](CHANGELOG.md).

This software is the independent work of Clément Deust. It was developed
outside any employment relationship and is not affiliated with, endorsed by,
or owned by any past or present employer. It is part of the ai-architect
ecosystem ([Cortex](https://github.com/cdeust/Cortex),
[ai-architect-mcp-codebase](https://github.com/cdeust/ai-architect-mcp-codebase),
[zetetic-team-subagents](https://github.com/cdeust/zetetic-team-subagents)).

Citations and primary sources for algorithms and constants are documented
inline in the code via `// source:` annotations per the project's
source-discipline rules. Removing those annotations does not change the
license terms but does forfeit attribution to the original research the
code is built on.

---

<p align="center">
  <em>Don't ship a PRD that hallucinates a function it can't measure.<br>
  Ship one whose every claim was judged by Pearl, Curie, Liskov, and a panel of seven others, validated against the call graph, and grounded in what Cortex remembers from yesterday.</em>
</p>
