---
name: validate-spec
description: Validate one PRD or technical-specification section with deterministic Hard Output Rules. Use when checking a single overview, requirement set, user-story section, acceptance-criteria section, API specification, data model, security section, test plan, deployment plan, risk section, timeline, source-code section, or test-code section.
---

# Validate a specification section

Use the `prd-spec-verifier` MCP server for a focused structural check.

## Workflow

1. Read the section without rewriting it.
2. Select the closest `section_type` accepted by the `validate_prd_section` tool schema. Ask for clarification if the section's role is ambiguous.
3. Call `validate_prd_section` with the exact content and selected type. The report is paged: while `__page.next_offset` is not `null`, call again with the same arguments and `item_offset` set to it, and read the violations of every page.
4. Report rule identifiers, severities, evidence, and the returned score. Separate violations from checks that passed.
5. State the scope limit: the validator checks implemented formatting, traceability, and consistency rules. It does not prove that claims are true, requirements are desirable, code exists, or the design is feasible.

Do not infer semantic correctness from a zero-violation result. Do not edit the section unless the user asks for a revision.
