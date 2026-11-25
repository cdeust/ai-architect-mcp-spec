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

## Define v1

A host can opt into planning data by calling `get_pipeline_state` with its `run_id` and `format: "define_handoff_v1"`. The response has one `handoff` object with `version: 1`, `run_id`, `requirements` and `acceptance`. Each requirement has `id` and `text`. Each acceptance criterion adds `requirement_ids`. The schema rejects unknown fields, duplicate IDs, unresolved references and requirements without acceptance coverage.

End the criterion's text with its explicit references in parentheses, for example `Check the receipt (FR-001, NFR-002).` A mention inside the criterion, example code, comments or a link destination does not supply traceability.

Read the handoff while the implementation question is pending. The producer requires passed PRD sections, a passed self-check, individual verification evidence for the evaluated claims, and a current document and verification policy that permit the handoff. It returns an MCP error for missing evidence, an invalid document, a completed decision or an oversized response. The read preserves the saved decision and action order. Hosts keep command arguments and executor policy in their own trusted configuration.

The original delivery fixture fails the Define v1 read. A second deterministic replay adds the three acceptance references to its testing draft and produces the handoff before and after restart. The stdio suite can also run against a reconstructed plugin by setting `PRD_GEN_TEST_PLUGIN_ROOT` to the staged plugin root containing `.mcp.json`.

## Sourced decisions

Drafts receive a shared register built from the feature description and recorded clarification answers. Each source has an ID of `user-request` or `clarification:<round>:<position>`. Position is one-based in the saved clarification list. Question text provides context and the answer supplies evidence. The register retains unclassified answers and groups matching policy values with their sources. Saved actions can be replayed, and subsequent drafts derive the register from the saved state.

The comparison covers explicit conditional publication statements in Markdown prose and numbered definitions, including requirement tables. The instruction ``With `--until ci`, never publish the verified commit.`` forbids publication of that target. Adding `automatically` narrows the refusal. The comparison matches the same flag, value and target and skips block quotes and code blocks. Explicit register citations in a Source or Traceability cell must exist. If the register contains a decision for that flag and target, the citation must support the stated policy.

Define removes an HTML quotation from normative text only when a matching `</blockquote>` closes it. Unpaired tags remain in the text. An opener in a list item, table cell or heading can pair only within that container. Two literal mentions at the document root, an opener followed later by a closer, therefore form a quotation across the intervening blocks. Use inline code to document those tags as separate examples.

An opposing draft uses the existing validation retry. Conflicting human decisions stay visible together and block the v1 handoff. The producer checks these findings again when reading a saved gate. A dedicated stdio variant names the publication target in the clarification answer and covers retry, restart and refusal.
