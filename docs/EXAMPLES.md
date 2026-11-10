# Examples — what a real session looks like

Walks through one canonical pipeline run end-to-end, showing the actions
the host executes and the artifacts the run produces. The transcript
below is shaped by the smoke-harness output (run on the canned dispatcher,
trial tier, codebase indexed). Real LLM output substitutes for the
synthetic placeholders shown here, but the action sequence and the
envelope shapes are identical.

---

## Session: "build OAuth login for the admin console"

### Step 0 — Host invokes the slash command

```
/generate-prd /Users/me/projects/admin-console build OAuth login for the admin console
```

### Step 1 — Host calls `start_pipeline`

```
host: start_pipeline({
  feature_description: "build OAuth login for the admin console",
  codebase_path: "/Users/me/projects/admin-console"
})

  → envelope {
      run_id: "run_lzx8f9_a3k2m1",
      messages: [
        { level: "info", text: "🟦 PRD Spec Generator — TRIAL TIER (full features)" },
        { level: "info", text: "Run ID: run_lzx8f9_a3k2m1" },
        { level: "info", text: "Allowed strategies: 16" },
        { level: "info", text: "PRD context detected: Feature (from trigger words)" },
      ],
      action: {
        kind: "call_pipeline_tool",
        tool_name: "index_codebase",
        arguments: {
          path: "/Users/me/projects/admin-console",
          output_dir: "/Users/me/projects/admin-console/.prd-gen/graphs/run_lzx8f9_a3k2m1",
        },
        correlation_id: "input_analysis_index"
      }
    }
```

The welcome banner + context-detection messages were coalesced into
the `messages` array; the runner internally consumed two `emit_message`
actions and only surfaced the substantive `call_pipeline_tool`.

### Step 2 — Host calls ai-architect-mcp-codebase

```
host: mcp__plugin_ai-architect-mcp-codebase_ai-architect__index_codebase({
  path: "/Users/me/projects/admin-console",
  output_dir: "/Users/me/projects/admin-console/.prd-gen/graphs/run_lzx8f9_a3k2m1"
})

  → { graph_path: ".../run_lzx8f9_a3k2m1/graph", symbols_indexed: 8421, files_parsed: 312, duration_ms: 2841 }
```

### Step 3 — Host submits the result

```
host: submit_action_result(run_id, {
  kind: "tool_result",
  correlation_id: "input_analysis_index",
  success: true,
  data: { graph_path: ".../graph", symbols_indexed: 8421, files_parsed: 312, duration_ms: 2841 }
})

  → envelope {
      messages: [{ level: "info", text: "Codebase indexed (graph: .../graph)." }],
      action: {
        kind: "spawn_subagents",
        purpose: "draft",
        batch_id: "clarification_compose_1",
        invocations: [{
          invocation_id: "clarification_compose_inv_1",
          subagent_type: "zetetic-team-subagents:engineer",
          description: "Compose clarification round 1 of 8",
          prompt: "<full prompt with feature description + recall + context>",
          isolation: "none"
        }]
      }
    }
```

### Step 4 — Host spawns the engineer

```
host: Agent({
  description: "Compose clarification round 1 of 8",
  subagent_type: "zetetic-team-subagents:engineer",
  prompt: "<...>"
})

  → "What is the primary success metric? Choose: p95 latency, conversion rate, security audit pass."
```

### Step 5 — Host submits the subagent's response

```
host: submit_action_result(run_id, {
  kind: "subagent_batch_result",
  batch_id: "clarification_compose_1",
  responses: [{
    invocation_id: "clarification_compose_inv_1",
    raw_text: "{ \"question\": \"What is the primary success metric?\", \"options\": [\"p95 latency\", \"conversion rate\", \"security audit pass\"], \"rationale\": \"...\" }"
  }]
})

  → envelope {
      action: {
        kind: "ask_user",
        question_id: "clarification_answer_1",
        header: "Clarification 1 of 8",
        description: "What is the primary success metric?",
        options: [
          { label: "p95 latency" },
          { label: "conversion rate" },
          { label: "security audit pass" }
        ],
        multi_select: false
      }
    }
```

### Step 6 — Host asks the user

```
host: AskUserQuestion({
  header: "Clarification 1 of 8",
  description: "What is the primary success metric?",
  options: [...]
})

  → user picks "security audit pass"
```

### Step 7 — Host submits the user's answer; loop continues for 7 more clarification rounds

```
host: submit_action_result(run_id, {
  kind: "user_answer",
  question_id: "clarification_answer_1",
  selected: ["security audit pass"]
})

  → next clarification compose action…
```

After 8 clarification rounds, the runner emits an `ask_user(question_id: "clarification_continue")` asking whether to proceed or run more rounds. User types `proceed`. The runner advances to `budget` → `section_generation`.

### Step 8 — Section generation (11 sections, trial tier)

For each section, the runner emits:

1. **Strategy selection** (internal — no host action; assignment persisted on `state.sections[i].strategy_assignment`).
2. **`call_cortex_tool({ tool_name: "recall", arguments: { query: "<section-specific>", max_results: 8 } })`** — pulls codebase + memory context.
3. **`spawn_subagents({ purpose: "draft", invocation_id: "section_generate_<type>" })`** — engineer drafts the section. The prompt now includes a `<strategies>` block listing the required strategies (e.g., `chain_of_thought` + `verified_reasoning` for `requirements`; `react` + `verified_reasoning` for `technical_specification`).
4. **In-process validation** (no host action; `validateSection` runs inside the reducer). On pass → next section. On fail with `attempt < 3` → re-spawn the engineer with the violations as `prior_violations` in the prompt. On fail with `attempt = 3` → mark `failed`, advance.

For the canned-dispatcher smoke run on a trial tier feature: 6 sections pass on first try, 5 fail their hard-output rules (because the canned drafts can't satisfy `clean_architecture` / `no_orphan_ddl` / `test_traceability_integrity` etc. — real LLM output normally does). Real LLM-driven runs typically pass 9–11 of 11 sections.

### Step 9 — JIRA generation

```
  → envelope {
      action: {
        kind: "spawn_subagents",
        purpose: "draft",
        batch_id: "jira_generation",
        invocations: [{
          invocation_id: "jira_generation_engineer",
          subagent_type: "zetetic-team-subagents:engineer",
          description: "Generate JIRA tickets",
          prompt: "<...source PRD content...>",
          isolation: "none"
        }]
      }
    }
```

### Step 10 — File export

One `write_file` action per file. The host writes each, returns `file_written`, the runner emits the next. For a `feature` run whose sections all passed:

```
prd-output/run_lzx8f/
  ├── 00-run-notes.md          # names 06, 08 and 09 as skipped, with the reason
  ├── 01-prd.md                # Overview + Goals + Requirements + User Stories + TS + AC
  ├── 02-data-model.md
  ├── 03-api-spec.md
  ├── 04-security.md
  ├── 05-testing.md
  ├── 07-jira-tickets.md
  └── stage-5.affected_symbols.json
```

`10-verification-report.md` follows at `implementation_gate`. The files of every other context are listed in the README, section "Exported files per context profile".

### Step 11 — Self-check (multi-judge verification)

After file export, the runner enters `self_check`. **Phase A:** plans the verification batch — extracts atomic claims from every section, selects per-claim panels (e.g., `[liskov, alexander, dijkstra, architect]` for an architecture claim; `[fermi, carnot, curie, erlang]` for a performance claim). Emits a `spawn_subagents` action with one invocation per `(claim × judge)` pair.

```
  → envelope {
      action: {
        kind: "spawn_subagents",
        purpose: "judge",
        batch_id: "self_check_verify",
        invocations: [
          { invocation_id: "self_check_judge_0000",
            subagent_type: "zetetic-team-subagents:genius:liskov",
            ... },
          { invocation_id: "self_check_judge_0001",
            subagent_type: "zetetic-team-subagents:genius:alexander",
            ... },
          // ... up to 4 × 11 = 44 invocations for a fully-claimed trial PRD
        ]
      }
    }
```

The host issues all judges in parallel (one message, multiple Agent tool calls) and submits the batch result.

**Phase B:** consensus engine aggregates per-claim verdicts. Each `JudgeVerdict` is `{ verdict: PASS|SPEC-COMPLETE|NEEDS-RUNTIME|INCONCLUSIVE|FAIL, confidence, rationale, caveats }`. The `weighted_average` strategy (default) produces a `ConsensusVerdict` per claim. NFR claims (latency, throughput, fps, storage) are filtered to refuse PASS — a NFR claim with a measurement method receives SPEC-COMPLETE; without one, NEEDS-RUNTIME.

### Step 12 — Done

```
  → envelope {
      action: {
        kind: "done",
        summary: "Self-check complete.\nSections: 11/11 passed, 0 failed.\nDeterministic violations: 0\n...",
        artifacts: ["overview: passed", "goals: passed", ..., "testing: passed"],
        verification: {
          claims_evaluated: 38,
          distribution: { PASS: 32, "SPEC-COMPLETE": 4, "NEEDS-RUNTIME": 2, INCONCLUSIVE: 0, FAIL: 0 },
          distribution_suspicious: false
        }
      },
      messages: [
        { level: "info", text: "Self-check complete. Sections: 11/11 passed..." }
      ]
    }
```

The host displays the summary to the user. Pipeline run complete.

---

## What did the closed feedback loop do?

While the run was happening, **for every section that reached a terminal status (passed or failed), one `ExecutionResult` per required strategy was enqueued onto `state.strategy_executions`**. The mcp-server composition root drained that queue and forwarded each entry to `EffectivenessTracker.recordExecution`, which wrote rows to the local SQLite evidence database (`~/.prd-gen/evidence.db` by default, or the absolute path in `PRD_GEN_EVIDENCE_DB` when set):

```sql
SELECT strategy, claim_characteristics, was_compliant, actual_confidence_gain
  FROM strategy_executions
  WHERE session_id = 'run_lzx8f9_a3k2m1';

strategy             | claim_characteristics                            | was_compliant | gain
chain_of_thought     | ["multi_step_logic","cross_reference"]           | 1             | 0.20
verified_reasoning   | ["multi_step_logic","cross_reference"]           | 1             | 0.20
react                | ["codebase_integration","tool_use"]              | 1             | 0.18
verified_reasoning   | ["accuracy_critical","architecture_design"]      | 1             | 0.22
recursive_refinement | ["security_critical","high_precision"]           | 0             | 0
... 7 more rows
```

These rows feed back into the next session's `selectStrategy` call via `getHistoricalAdjustments`. A strategy that consistently fails for a given claim shape gets a negative adjustment; one that consistently succeeds gets a positive adjustment. The adjustment is bounded `[-0.3, +0.3]` so no single session can dominate the prior.

---

## Failure example: section retries exhausted

If a section can't pass validation in 3 attempts (e.g., the engineer produces drafts with FR-numbering gaps every time), the run still completes — the section is marked `failed`, an entry appears in `state.errors` with `kind: "section_failure"`, and the pipeline advances to the next section. The final `done` summary shows `Sections: 10/11 passed, 1 failed`. The user sees the failed section's last violations in the output and can re-prompt with more context.

This is the precautionary design: a single section failure doesn't sink the whole PRD. The user gets 10 good sections, and `00-run-notes.md` names the 11th (its draft is withheld from the exported files) to fix manually, rather than "the pipeline crashed and you have nothing."

---

## Failure example: confirmatory bias caught

If every judge in every panel returns PASS for every claim, the run reaches `done` BUT `done.verification.distribution_suspicious` is `true`. The user sees:

```
Multi-judge claims: 38
  PASS:           38
  SPEC-COMPLETE:  0
  NEEDS-RUNTIME:  0
  INCONCLUSIVE:   0
  FAIL:           0
  ⚠ Distribution suspicious — 100% PASS suggests confirmatory bias.
```

The flag fires when ≥5 claims all pass unanimously. It's informational
— the run still produces files — but the user is warned that the panel
may be too soft on this kind of claim and that a manual review is
warranted before shipping the PRD.

---

## Inspecting state mid-run

```
host: get_pipeline_state({ run_id: "run_lzx8f9_a3k2m1", format: "full" })
```

Returns the full `PipelineState`. Useful for:

- Debugging a stuck run (`current_step`, `errors[]`).
- Inspecting strategy assignments (`sections[i].strategy_assignment`).
- Verifying clarification capture (`clarifications[]`).
- Reading the queue before it's drained (`strategy_executions[]`).

This call is **read-only**. It does not advance the pipeline.

---

## Run the smoke harness yourself

```bash
git clone https://github.com/cdeust/ai-architect-mcp-spec.git
cd ai-architect-mcp-spec
pnpm install --frozen-lockfile
pnpm build
pnpm test --filter @prd-gen/orchestration smoke
```

Output ends with the action coverage summary: every action kind that
was emitted during a full run, the number of iterations, the final
state. The smoke harness is the most-condensed exposition of the
protocol.
