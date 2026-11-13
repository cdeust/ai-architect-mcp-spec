---
name: audit-prd
description: Audit a multi-section PRD with deterministic Hard Output Rules and cross-section consistency checks. Use when reviewing a complete product requirements document, checking FR-to-AC coverage, acceptance-criteria numbering, story-point arithmetic, or test traceability.
---

# Audit a PRD

Use the `prd-spec-verifier` MCP server to produce an evidence-based structural audit.

## Workflow

1. Read the complete PRD without rewriting it.
2. Split it into sections and map each section to the closest `section_type` accepted by the `validate_prd_document` tool schema. Ask for clarification when a mapping is genuinely ambiguous.
3. Call `validate_prd_document` with every mapped section, preserving content exactly. The report is paged: while `__page.next_offset` is not `null`, call again with the same arguments and `item_offset` set to it, and read the violations of every page.
4. Report each violation with its rule identifier, severity, affected section, and the evidence returned by the tool.
5. Group repeated findings and distinguish blocking violations from warnings.
6. State the scope limit: a passing report demonstrates conformance to the implemented structural rules only. It does not establish factual accuracy, product value, implementation feasibility, security, or semantic correctness.

Do not invent a pass for checks the tool did not run. Do not silently repair the PRD unless the user also asks for edits.
