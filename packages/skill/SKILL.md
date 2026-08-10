---
name: ai-architect-mcp-spec
version: 0.8.0
description: Action-driven PRD generation. The MCP server runs a stateless 20-step pipeline reducer (11 PRD-generation steps + 9 opt-in implementation steps behind a human gate); the host (Claude Code) executes each substantive action and feeds the result back via submit_action_result, looping until done. Multi-judge verification combines genius reasoning patterns with zetetic team subagents. Grounded in the ai-architect ecosystem (ai-architect-mcp-codebase MCP, Cortex MCP, zetetic-team-subagents).
dependencies: node>=20
prd_contexts: proposal, feature, bug, incident, poc, mvp, release, cicd
mcp_tools:
  - start_pipeline
  - submit_action_result
  - get_pipeline_state (read-only diagnostic; does not advance the pipeline)
  - plan_section_verification
  - plan_document_verification
  - conclude_verification
mcp_tools_legacy:
  - get_config, read_skill_config
  - check_health, get_prd_context_info, list_available_strategies
  - validate_prd_section, validate_prd_document
  - get_quality_history, get_strategy_effectiveness
  - coordinate_context_budget, map_failure_to_retrieval
ecosystem:
  - ai-architect-mcp-codebase (Rust MCP) — codebase indexing, graph queries, impact, semantic-diff
  - cortex (Python MCP) — persistent memory, recall, methodology, narrative
  - zetetic-team-subagents — engineer, code-reviewer, test-engineer, security-auditor, dba, ...
  - genius reasoning patterns — liskov, dijkstra, fermi, popper, ...
---

# AI Architect MCP Spec (v0.8.0) — Dispatcher Protocol

You (the host) drive a loop:

1. Call `start_pipeline` → receive an envelope with `{ run_id, messages, action, ... }`.
2. Display every entry in `messages` to the user.
3. Execute `action` per the dispatch table below.
4. Call `submit_action_result(run_id, result)` → receive next envelope.
5. Repeat until `action.kind === "done"` or `action.kind === "failed"`.

**`emit_message` is never returned to the host as `action`.** The runner coalesces all status messages into the `messages` array; the `action` field always carries something the host actually has to do.

---

## ENVELOPE SHAPE

Every response from `start_pipeline` and `submit_action_result` has this shape:

```json
{
  "run_id": "run_abc_123",
  "current_step": "context_detection",
  "messages": [
    { "text": "🟢 PRD Spec Generator — TRIAL TIER\n...", "level": "info" }
  ],
  "action": { "kind": "ask_user" | "call_pipeline_tool" | ... , ... },
  "state_summary": { "sections": [...], "clarification_rounds": 3, "errors": 0 }
}
```

- `run_id` — handle for `submit_action_result` and `get_pipeline_state`. Caputre once from the first response and reuse.
- `messages` — banners/status lines collected while the runner advanced internally to reach `action`. May be empty. Display each `text` at the given `level` (default `info`) before executing `action`.
- `action` — what you must execute. **Never `emit_message`.** Always one of: `ask_user`, `call_pipeline_tool`, `call_cortex_tool`, `spawn_subagents`, `write_file`, `done`, `failed`.

---

## TERMINOLOGY (read this before the dispatch table)

| Term | Means |
|---|---|
| **the host** | Claude Code (or another MCP-aware client) running this dispatcher loop |
| **the project directory** | The codebase root where `.mcp.json` lives — distinct from "the host" |
| **the runner** | The MCP server's stateless reducer behind the pipeline tools |
| **the result** (always typed) | The `ActionResult` value the host passes to `submit_action_result` — exactly one of four `kind`s |
| **agent output** | The raw text returned by an Agent tool call to a subagent — appears in `subagent_batch_result.responses[i].raw_text` |
| **a judge** (`purpose: "judge"`) | A spawned subagent invocation that returns a `JudgeVerdict` JSON object. The same word also names the `judge` field inside `JudgeVerdict`, which holds the `AgentIdentity` of the agent that rendered the verdict. |
| **routing token** | One of `correlation_id`, `invocation_id`, `batch_id`, `question_id` — opaque strings the host MUST echo back unchanged |
| **`messages`** | The array of `{ text, level }` entries the runner collected while advancing internally to the substantive `action`. Display each `text` at its `level` before executing `action`. |
| **substantive action** | Any `action` kind that requires host execution and a submitted result: `ask_user`, `call_pipeline_tool`, `call_cortex_tool`, `spawn_subagents`, `write_file`. Plus terminal kinds `done` and `failed`. (`emit_message` is NEVER returned to the host — the runner coalesces it.) |
| **coalescing** | The runner's behavior of collecting status signals (which would otherwise be individual `emit_message` actions) into the `messages` array, so each response carries exactly one substantive action plus its accumulated message context. |

---

## DISPATCH TABLE — ONE ROW PER ACTION KIND

### `ask_user`

**Action shape:**
```json
{
  "kind": "ask_user",
  "question_id": "prd_context",
  "header": "Which kind of PRD?",
  "description": "...",
  "options": [{ "label": "feature", "description": "..." }] | null,
  "multi_select": false
}
```

**Execute:** Invoke `AskUserQuestion` with `header`, `description`, and `options` (if non-null). If `options === null`, accept freeform.

**Submit:**
```json
{
  "kind": "user_answer",
  "question_id": "<echo action.question_id verbatim>",
  "selected": ["<chosen option label string>"],
  "freeform": "<text answer if any>"
}
```

`AskUserQuestion` returns the chosen option's `label` string directly. Place that string in `selected[0]`. If the user typed a freeform answer, place it in `freeform` and leave `selected` empty.

---

### `call_pipeline_tool`

**Action shape:**
```json
{
  "kind": "call_pipeline_tool",
  "tool_name": "index_codebase",
  "arguments": { "path": "/abs/path", "output_dir": "...", "language": "auto" },
  "correlation_id": "input_analysis_index"
}
```

**Execute:** Call the **ai-architect-mcp-codebase MCP** tool named `tool_name` with `arguments` exactly as provided. The tool prefix is `mcp__plugin_<plugin-name>_<server-key>__<tool_name>`. The plugin is `ai-architect-mcp-codebase` and its sole `.mcp.json` server key is `ai-architect`, so the prefix is `mcp__plugin_ai-architect-mcp-codebase_ai-architect__<tool_name>`. Inspect your `.mcp.json` to confirm.

**If the ai-architect-mcp-codebase MCP is not registered in your project**, submit a tool_result with `success: false`. The pipeline will halt with a `failed` action; the user must register the dependency before re-running.

**Submit (success):**
```json
{
  "kind": "tool_result",
  "correlation_id": "<echo action.correlation_id verbatim>",
  "success": true,
  "data": <the JSON the tool returned, unmodified>
}
```

**Submit (failure):**
```json
{
  "kind": "tool_result",
  "correlation_id": "<echo action.correlation_id verbatim>",
  "success": false,
  "error": "<error string>"
}
```

---

### `call_cortex_tool`

**Action shape:** identical to `call_pipeline_tool` but `tool_name` refers to a **Cortex MCP** tool. Tool prefix convention: `mcp__plugin_hypermnesia-mcp_cortex__<tool_name>` or `mcp__cortex__<tool_name>` per your `.mcp.json`.

> The plugin-scoped prefix carries **both** the plugin name and the MCP server key: `mcp__plugin_<plugin-name>_<server-key>__<tool>`. Cortex renamed the plugin `cortex` -> `hypermnesia-mcp` in v4.15.0 (community-directory name collision) while keeping the server key `cortex`, so the prefix is `mcp__plugin_hypermnesia-mcp_cortex__`, not `mcp__plugin_cortex_cortex__`. An unresolvable MCP tool name is dropped silently by the host, so the old prefix fails with no error. <!-- mcp-prefix-allow-legacy: this line quotes the dead spelling on purpose -->


The handlers currently emit `tool_name: "recall"` for section-context retrieval. Other Cortex tools may be added by future handlers; do not assume a fixed list.

**Submit:** same `tool_result` shape as `call_pipeline_tool`. Pass `data` through unmodified — the runner's parser expects the standard Cortex `{ results: [{ content, score, ... }] }` shape.

---

### `spawn_subagents`

**Action shape:**
```json
{
  "kind": "spawn_subagents",
  "purpose": "draft" | "judge" | "review",
  "batch_id": "self_check_verify",
  "invocations": [
    {
      "invocation_id": "self_check_judge_0001",
      "subagent_type": "zetetic-team-subagents:genius:liskov",
      "description": "Judge FR-001 (genius:liskov)",
      "prompt": "<full self-contained prompt — DO NOT modify>",
      "isolation": "none"
    }
  ]
}
```

`purpose` is an observability label — your dispatch logic does NOT branch on it.

`subagent_type` is an opaque string. Pass it verbatim to the Agent tool's `subagent_type` parameter. Do not parse, normalize, or construct it yourself.

**Execute:** Issue **all** invocations in a **single message** with **multiple parallel Agent tool calls**. (Sequential dispatch produces a correct result but multiplies wall-clock time by N — for self-check batches with many judges this can exceed practical timeouts.) Each Agent call: `subagent_type = invocation.subagent_type`, `description = invocation.description`, `prompt = invocation.prompt`. **Never modify the prompt** — judge prompts contain JSON-output instructions that the runner's parser depends on.

**Submit:**
```json
{
  "kind": "subagent_batch_result",
  "batch_id": "<echo action.batch_id verbatim>",
  "responses": [
    {
      "invocation_id": "<echo invocation.invocation_id verbatim>",
      "raw_text": "<the agent's full final reply text>"
    },
    {
      "invocation_id": "<echo invocation.invocation_id verbatim>",
      "error": "<set this if the agent failed; raw_text optional>"
    }
  ]
}
```

For a successful agent: include `raw_text` (the full reply string). The runner extracts JSON from it.
For a failed agent: include `error`. The runner records an `INCONCLUSIVE` verdict for that claim.

---

### `write_file`

**Action shape:**
```json
{ "kind": "write_file", "path": "prd-output/abc12345/01-prd.md", "content": "..." }
```

**Execute:** Write `content` to `path` (relative to the project directory). Create parent directories as needed.

**Submit:**
```json
{ "kind": "file_written", "path": "<echo action.path verbatim>", "bytes": <UTF-8 byte length of content> }
```

`bytes` is the UTF-8 byte length of `content` (not character count). Use `Buffer.byteLength(content, 'utf8')` or equivalent.

---

### `done`

**Action shape:**
```json
{ "kind": "done", "summary": "...", "artifacts": ["overview: passed", ...] }
```

**Execute:** Display `messages` (if any), then `summary`, then the `artifacts` list. **Stop the loop.**

---

### `failed`

**Action shape:**
```json
{ "kind": "failed", "reason": "...", "step": "input_analysis" }
```

**Execute:** Display `messages` (if any), then `reason` and the failing `step`. **Stop the loop.** If the user wants more detail, call `get_pipeline_state(run_id, format: "full")` and show `state.errors[]`. The `full` response is bounded to the 100,000-char MCP budget and degrades least-relevant detail first (grounding → oldest clarifications → section content); a `__bounded` block records anything omitted/elided, and `errors[]` is never shed. To pull the full code-graph grounding that `full` sheds first, call `get_pipeline_state(run_id, format: "grounding")`.

---

## ERROR TRANSPORT

`submit_action_result` itself can return `isError: true` from the MCP layer. Two cases:

| Cause | Recovery |
|---|---|
| Concurrent submission rejected — you called `submit_action_result` for the same `run_id` while a previous call was still in flight | The host implementation has a bug. Wait for the in-flight call to return, then submit ONCE. Do not retry blindly. |
| Unknown `run_id` | The MCP server process restarted and lost in-memory state. The pipeline cannot be resumed — call `start_pipeline` to begin a new run. |

In both cases, display the `error` field from the response to the user and stop.

---

## HARD RULES

1. **Never modify `prompt` in any `spawn_subagents.invocations[i]`.** Forward it verbatim. Modifying judge prompts breaks the runner's JSON parser; modifying drafter prompts produces sections that fail validation.

2. **Never alter routing tokens.** `correlation_id`, `invocation_id`, `batch_id`, and `question_id` are opaque values emitted by the runner; the host echoes them back unchanged on the corresponding result. The runner uses them to route results back to the handler that is waiting.

3. **Always issue `spawn_subagents` invocations in parallel.** One message; many Agent tool calls. (Performance, not correctness — but production-relevant.)

4. **Never call `start_pipeline`, `submit_action_result`, or `get_pipeline_state` from inside an Agent tool call.** Subagents return their text; the host (not the subagent) submits the batch result.

5. **Stop the loop on `done` or `failed`.** Do not re-call `submit_action_result` afterwards.

6. **One pipeline = one `run_id`.** Do not interleave actions from different runs.

7. **Never call `submit_action_result` concurrently for the same `run_id`.** The runner's in-flight guard rejects with `isError: true`.

8. **`subagent_type` is opaque.** Pass it verbatim to the Agent tool. Do not construct, normalize, or guess it.

---

## VERIFICATION TAXONOMY (judge-facing — host does not enforce)

This table describes constraints baked into judge prompts. The host does not enforce verdicts; the runner does, via the `concludeDocument` consensus engine.

| Verdict | Meaning |
|---|---|
| PASS | Structurally complete + verifiable from the document |
| SPEC-COMPLETE | Test method specified; needs runtime to confirm |
| NEEDS-RUNTIME | Cannot verify at design time |
| INCONCLUSIVE | Depends on unresolved OQ-XXX or external factor |
| FAIL | Structurally invalid or contradicts other claims |

NFR claims (latency, throughput, fps, storage) MUST NOT receive PASS — judges receive this constraint in their prompts. The host does not inspect or filter verdicts.

---

## ECOSYSTEM BOUNDARY (informational — for project setup, not host dispatch)

| Concern | Owner |
|---|---|
| Codebase indexing, graph queries, impact, semantic diff | **ai-architect-mcp-codebase MCP** |
| Persistent memory, recall, narrative, methodology | **Cortex MCP** |
| Reasoning roles (engineer, reviewer, dba, ...) | **zetetic-team-subagents** |
| Genius reasoning patterns | **zetetic-team-subagents/genius** |
| PRD generation, multi-judge verification, hard-output rules, file export | **ai-architect-mcp-spec** (this) |

A correctly configured project has all four ecosystem dependencies registered in `.mcp.json`. Missing dependencies surface as `tool_result.success: false` from `call_pipeline_tool` or `call_cortex_tool`, which causes the pipeline to emit `failed`.

---

## CORTEX MEMORY HOOKS (what gets remembered + recalled across sessions)

Cortex is the persistent memory engine. The pipeline uses it on two surfaces — **recall during section generation** (already covered in the `call_cortex_tool` dispatch row above) and **storage of decisions/lessons that future sessions benefit from**. The host does not orchestrate this storage; Cortex's hooks (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `SessionEnd`, `Notification`) capture it automatically when the Cortex plugin is installed.

### What recall pulls IN (during section generation)

Each section's `pending → retrieving` transition emits `call_cortex_tool({ tool_name: "recall", arguments: { query: "<section-specific>", max_results: 8 } })`. The query template is per-section-type (see `packages/orchestration/src/section-plan.ts:SECTION_RECALL_TEMPLATES`):

| Section type | Recall query shape | What's recalled |
|---|---|---|
| `requirements` | `requirements decisions for <feature>` | Past FR decisions, rejected approaches, scope boundaries |
| `technical_specification` | `architecture pattern <feature> ports adapters` | Past architecture choices, port/adapter conventions, framework rejections |
| `data_model` | `data model <feature> tables relationships migrations` | Schema decisions, migration history, FK conventions |
| `acceptance_criteria` | `acceptance criteria <feature> Given When Then` | Past AC patterns, traceability conventions |
| `security_considerations` | `security threats <feature> auth authz STRIDE` | Threat model decisions, auth choices, secret-handling patterns |
| `performance_requirements` | `performance NFR <feature> latency throughput SLA` | Past p95/p99 targets, measurement methods, capacity decisions |
| `testing` | `testing strategy <feature> coverage e2e integration` | Test patterns, coverage decisions, anti-patterns to avoid |

The recall results land in the engineer subagent's prompt as `<codebase_context>...</codebase_context>` (truncated to 800 chars per result; max 8 results per section — see `RECALL_MAX_RESULTS_INCLUDED` in `section-generation.ts`). The engineer is instructed to weight recall content but not blindly copy it.

### What's worth storing OUT (for future PRDs)

When this PRD reaches `done`, the Cortex `SessionEnd` hook captures session content automatically. The most valuable artifacts to store:

1. **Clarification answers.** The Q&A turns in `state.clarifications` — these are the user's load-bearing decisions. Tag: `decision`, `feature:<feature_description>`.
2. **Section-failure violations.** Each entry in `state.errors` with `error_kind: "section_failure"` represents a validator violation the engineer couldn't fix in 3 attempts. These are anti-patterns worth remembering. Tag: `lesson`, `failure-mode:<rule>`.
3. **Strategy effectiveness.** Each `state.strategy_executions` entry records `(strategy, claim_characteristics, wasCompliant, actualConfidenceGain)`. This is the closed feedback loop — recorded automatically via `EffectivenessTracker.recordExecution` into the project's `EvidenceRepository` (separate from Cortex; SQLite-backed). Cortex is NOT the storage for this signal — it lives in `~/.prd-gen/evidence.db`.
4. **Multi-judge verdict patterns.** `done.verification.distribution` per claim. A `distribution_suspicious=true` flag is itself worth remembering — it indicates the panel was likely too soft on this kind of claim. Tag: `lesson`, `verification:confirmatory-bias`.

The host does NOT explicitly call `cortex.remember(...)` from the dispatch loop — Cortex's `PostToolUse` and `SessionEnd` hooks observe the `done` action's `summary` + `verification` fields and store what's structured enough to retrieve later.

### Verification of recall freshness

If a section's recall returns content stale enough to mislead the engineer, the validator catches it via `fr_traceability` / `architecture` / etc., the section retries, and a new draft emerges without the stale guidance. The retry budget (`MAX_ATTEMPTS=3`) is the safety bound on bad-recall propagation.

---

## MINIMAL WORKED LOOP (illustrative; not exhaustive)

```
host: start_pipeline({ feature_description: "build OAuth login", codebase_path: "/abs/path" })

  → envelope { run_id, messages: [<welcome banner>, <PRD context detected: Feature>],
              action: { kind: "call_pipeline_tool", tool_name: "index_codebase",
                        arguments: { path: "/abs/path", output_dir: "...", language: "auto" },
                        correlation_id: "input_analysis_index" } }

host: displays the 2 messages, then calls mcp__<your-pipeline-key>__index_codebase(...)
host: submit_action_result(run_id, { kind: "tool_result", correlation_id: "input_analysis_index",
                                       success: true, data: { graph_path: "...", ... } })

  → envelope { messages: [<Codebase indexed: ...>, <Scope acceptable. Proceeding to clarification.>],
              action: { kind: "spawn_subagents", purpose: "draft", batch_id: "clarification_compose_1",
                        invocations: [ { invocation_id: "...", subagent_type: "zetetic-team-subagents:engineer",
                                         prompt: "<compose clarification question>", ... } ] } }

host: spawns the engineer subagent in parallel, collects the JSON-formatted question
host: submit_action_result(run_id, { kind: "subagent_batch_result", batch_id: "clarification_compose_1",
                                      responses: [ { invocation_id: "...", raw_text: "..." } ] })

  → envelope { messages: [],
              action: { kind: "ask_user", question_id: "clarification_answer",
                        header: "Round 1: <question>", ... } }

... loop continues until action.kind === "done" or action.kind === "failed"
```

The runner collects status messages (welcome banner, PRD-context-detected, codebase-indexed, scope-decision, ...) into `messages`. The host displays them and proceeds to `action`. There is never a "void" round-trip where the host has nothing to submit.
