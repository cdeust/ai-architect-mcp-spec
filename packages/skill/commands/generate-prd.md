---
name: generate-prd
description: Action-driven PRD generation. The MCP server runs the pipeline; you (the host) drive the dispatch loop.
allowed-tools: Bash, Read, Write, Glob, Grep, AskUserQuestion, Agent
argument-hint: "[feature-description] [optional-codebase-path]"
---

# /generate-prd — Dispatcher Loop

You are the host. Drive the pipeline by:

1. Calling `start_pipeline`.
2. For each envelope returned: display every entry in `messages`, then execute `action`.
3. Calling `submit_action_result(run_id, result)` with the result.
4. Looping until `action.kind === "done"` or `"failed"`.

**SKILL.md is the load-bearing reference for this protocol. Read it first.** The dispatch table in SKILL.md governs every action kind. This file is a quick-start driver only.

---

## Step 1 — Parse $ARGUMENTS

Tokenize `$ARGUMENTS` on whitespace.

- If the **first** token is an absolute path that exists on disk and is a directory: treat that token as `codebase_path`. Treat the **rest of the string** (everything after the first whitespace) as `feature_description`. If nothing follows the path, ask the user via `AskUserQuestion` for a feature description.
- Otherwise: treat the entire `$ARGUMENTS` string as `feature_description`. `codebase_path` is omitted.
- If `$ARGUMENTS` is empty: ask the user via `AskUserQuestion` for a feature description before continuing.

Example: `/generate-prd /Users/me/projects/myapp build OAuth login` →
- `codebase_path = "/Users/me/projects/myapp"`
- `feature_description = "build OAuth login"`

Example: `/generate-prd build OAuth login` →
- `codebase_path` omitted
- `feature_description = "build OAuth login"`

---

## Step 2 — Initialize

Call:
```
start_pipeline({
  feature_description: "<parsed description>",
  codebase_path: "<parsed path, or omit>"
})
```

Capture `run_id` from the response. Reuse it on every subsequent `submit_action_result`.

---

## Step 3 — Drive the loop

For each envelope:

1. Display every entry in `messages` (text at the given level — info, warn, or error). These are banners and status updates the runner produced while advancing internally; show them in order.
2. Read `action.kind` and dispatch per the SKILL.md table:

| action.kind | What you do | Result you submit back |
|---|---|---|
| `ask_user` | `AskUserQuestion` with `header`, `description`, `options` | `user_answer` (echo `question_id` verbatim; `selected[0]` is the chosen label string) |
| `call_pipeline_tool` | Call the named tool on the **ai-architect-mcp-codebase MCP** | `tool_result` (echo `correlation_id` verbatim) |
| `call_cortex_tool` | Call the named tool on the **Cortex MCP** | `tool_result` (echo `correlation_id` verbatim) |
| `spawn_subagents` | Issue ALL invocations in parallel via Agent tool, one message; do not modify prompts | `subagent_batch_result` (echo `batch_id` and each `invocation_id` verbatim) |
| `write_file` | Write `content` to `path` (mkdir as needed) | `file_written` (echo `path` verbatim; `bytes` is UTF-8 byte length) |
| `done` | Display `summary` + `artifacts`. **STOP** | (none — exit) |
| `failed` | Display `reason` + `step`. **STOP** | (none — exit; optionally fetch full state) |

3. Call `submit_action_result(run_id, result)` with the appropriate result.

**Note:** `emit_message` will never appear as `action.kind`. The runner coalesces all status messages into the `messages` array on each response. You always have something concrete to do when you receive `action`.

---

## Step 4 — Concurrency rules

- **Never** call `submit_action_result` concurrently for the same `run_id`. The in-flight guard rejects with `isError: true`.
- **Always** issue `spawn_subagents` invocations in a single message with multiple parallel Agent tool calls.
- **Never** modify a prompt, `correlation_id`, `invocation_id`, `batch_id`, `question_id`, `path`, or `subagent_type`. Echo them verbatim. They are the runner's routing tokens.
- **Never** call `start_pipeline` / `submit_action_result` / `get_pipeline_state` from inside an Agent tool call (i.e., from inside a spawned subagent).

---

## Step 5 — Error transport

If `submit_action_result` itself returns `isError: true`:

- Display the error string from the response to the user.
- Do not retry. Stop the loop.
- If the message says "concurrent submission rejected", you have a host-side bug in your loop logic. Fix the loop before re-running.
- If the message says "unknown run_id", the MCP server restarted and lost state. Begin a new run with `start_pipeline`.

---

## Step 6 — On `done`

Show the user:
- The `summary` field
- The `artifacts` list (one entry per section)
- The output directory path (the `path` of any `write_file` action you handled — typically `prd-output/<run_id_prefix>/`)

---

## Step 7 — On `failed`

Show:
- `reason`
- `step` (which step failed)

If the user asks for more detail, call:
```
get_pipeline_state({ run_id, format: "full" })
```

The `errors[]` field in the returned state contains the full diagnostic trail.

`format: "full"` is **bounded to the 100,000-char MCP response budget**. If the
state is large (big codebase grounding, many clarification turns, long section
markdown), the response degrades gracefully in priority order — least-relevant
detail first — until it fits. Degradation is observable: a `__bounded` block
lists every field that was omitted or elided and how many chars it reclaimed,
and any omitted blob carries a `hint` for re-fetching it. The diagnostic
skeleton (`errors[]`, statuses, scalars) is **never** shed, so the failure trail
always survives. Shed order: `codebase_grounding`/`prd_validation` →
oldest `clarifications` → `sections[].content`.

To retrieve the full code-graph grounding that `format: "full"` sheds first,
call:
```
get_pipeline_state({ run_id, format: "grounding" })
```
This returns `codebase_grounding` (+ `prd_validation` when the pair fits). At
their input-cap worst case the two blobs together exceed the budget, so
`format: "grounding"` may itself shed `prd_validation` to a stub — re-fetch it
alone with `get_pipeline_state({ run_id, format: "validation" })`. Dynamic
loading throughout — the detail is never lost, just fetched on demand.

Every `start_pipeline` / `submit_action_result` response carries a `__bounded`
marker. When its `applied` list records `action.invocations[].prompt`, the
`spawn_subagents` prompts were replaced by `omitted` stubs to fit the budget.
Fetch them with
`get_pipeline_state({ run_id, format: "action" })`: the response is paged by whole
invocations under the same budget. Call again with
`invocation_offset: __page.next_offset` until `next_offset` is `null`, then
dispatch the full batch.

`get_pipeline_state` is **read-only** and does not advance the pipeline. Use it
for diagnosis only, except `format: "action"`, which is the required recovery
step for omitted prompts before a batch is dispatched.

---

## Notes

- The pipeline calls **ai-architect-mcp-codebase MCP**, **Cortex MCP**, and **zetetic-team-subagents** on your behalf via `call_pipeline_tool`, `call_cortex_tool`, and `spawn_subagents` actions. Do not call them outside the dispatch table.
- Tool prefixes (`mcp__<server-key>__<tool_name>`) depend on your project's `.mcp.json` registration keys. Inspect `.mcp.json` to derive the actual prefix; the convention examples in SKILL.md are illustrative.
