---
name: generate-prd
description: Generate a production-ready PRD with verification and business KPIs
allowed-tools: Bash, Read, Write, Glob, Grep, WebFetch, WebSearch
argument-hint: "[project-description]"
---

# Generate PRD

This is the legacy entry point. The current dispatcher loop lives in
`packages/skill/commands/generate-prd.md` and is documented in
`packages/skill/SKILL.md`. Both run the same MCP server with the same
unconditional capability set — there is no mode detection, no license
gating, no environment branching.

## Step 1 — Load SKILL.md

**MANDATORY**: Use the Read tool to read SKILL.md from the skill package
(`packages/skill/SKILL.md`, or whatever path the host plugin resolves to
via `read_skill_config`). It contains the dispatcher protocol, action
shapes, and the full pipeline contract.

## Step 2 — Drive the pipeline

If the user provided a project description in `$ARGUMENTS`, use it as the
initial input. Otherwise, ask for a project description with
`AskUserQuestion`.

Then call `start_pipeline(feature_description, codebase_path?, prd_context?,
request_size?, semantic_review: true)` (SKILL.md, step 1, says how to declare the kind and the size),
display
each `messages` entry returned, execute `action`, and call
`submit_action_result(run_id, result)` until `action.kind === "done"` or
`"failed"`. Every action kind is governed by the SKILL.md dispatch table.
