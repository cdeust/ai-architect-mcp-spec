# Define boundary pilot

The host drives the stdio server built from the producer baseline `e6bdbbbce6b6e90941e59aabe6f38378c4168ee4`. The [delivery-command fixture](../packages/mcp-server/src/__tests__/fixtures/define-delivery-command.json) records the source of the design-derived intent, questions, answers and drafts. The [stdio test](../packages/mcp-server/src/__tests__/define-boundary-stdio.test.ts) substitutes local responses for external actions and writes the exported artifacts to an isolated directory. The [ordered trace](../packages/mcp-server/src/__tests__/__snapshots__/define-boundary-stdio.test.ts.snap) retains repeated actions and uses artifact names in place of run-specific paths.

| Probe | Observed baseline |
|---|---|
| Delivery-command draft | MCP exposes clarification, section generation, file export, self-check and the implementation gate in that order. The host receives `01-prd.md` and `10-verification-report.md`. Self-check reports `needs_attention`. |
| Restart at the gate | The same run ID returns the same saved decision prompt and full state after a server restart. The host stops at the prompt. |
| Semantically empty draft | The same input with each draft set to `ok` yields no external self-check action, reports `passed` with a hard-output score of `1.00`, and reaches the implementation gate. |
| Incompatible quantities in separate sections | The document verifier returns `contradictory_requirements` for one hour versus three hours. |
| Incompatible publication decisions in separate sections | The document verifier does not emit `contradictory_requirements` for automatic publication versus stopping before publication with `--until ci`. |

The test reaches the producer's implementation gate through MCP stdio. The architect-os Define consumer and its versioned input fixture remain to be exercised.

The corrective replay verifies two deterministic blockers. A supplied requirements or acceptance section with no numbered definition lowers the score and requires an explicit override at the implementation gate. Opposing publication instructions also require an explicit override when two sections name the same flag, value and publication target using the tested conditional prose format. The gate reports the findings and rejects a plain `Implement` answer. A resumed pending run is checked against the same rules. The positive pilot retains its original action trace and pre-decision report.

The architect-os step reader at revision `be492ac325aad604f073c7cb9613cda67b7952ce` reads `step.json` and `brief.md` after planning. A replay against that revision passed three negative-control scenarios (22 steps). A missing `step.json`, a schema-invalid `step.json` and a missing `brief.md` each returned exit 2 without creating a session. These scenarios exercise the post-Plan step reader.

From the producer root, run `pnpm build` followed by `pnpm exec vitest run packages/mcp-server/src/__tests__/define-boundary-stdio.test.ts`.
