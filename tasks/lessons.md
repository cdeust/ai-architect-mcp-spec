# Clarification compose validation

Validate model-produced fields before creating a clarification turn. On a violation, record the field and the applicable size in the bounded error history and ask the complete fallback question. Preserve legacy question text when reading checkpoints.

At `9565bab`, the initial regression run had 28 failures and 19 passes. Replaying the final two test files against that production source gave 29 failures and 20 passes. At `cc8a24b`, all 49 passed. The workspace build and lint passed, and Vitest passed 2,630 tests in 171 files. Focused Stryker runs killed all 119 generated mutants in the selected compose, replay, turn-update and schema ranges.
