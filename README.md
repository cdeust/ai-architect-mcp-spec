<!-- mcp-name: io.github.cdeust/ai-architect-mcp-spec -->

# AI Architect MCP Spec

Check requirements, acceptance criteria and test traceability before a specification becomes code. AI Architect MCP Spec is a local MCP server with a deterministic verifier and a host-driven PRD workflow. You can run the verifier on an existing document or use the full profile to generate and verify a PRD.

## What works today

| Capability | Behavior | Evidence |
| --- | --- | --- |
| Portable verifier | `validate_prd_section` checks one Markdown section. `validate_prd_document` adds cross-section checks for requirement IDs, acceptance criteria and test links. | [MCP handlers](packages/mcp-server/src/index.ts) · [Portable runtime smoke test](scripts/smoke-portable-hosts.mjs) |
| Symbol references | Supply `known_symbols` to report unresolved inline-code references as advisory findings. The optional graph integration belongs to the full workflow. | [Validation handlers](packages/mcp-server/src/index.ts) · [Symbol check](packages/mcp-server/src/symbol-check.ts) |
| Full PRD workflow | The server emits the next action and records the result. The host runs model calls, asks questions and writes exported artifacts. The packaged `/generate-prd` command requests a model review of scope and declared edge cases. | [Host command](packages/skill/commands/generate-prd.md) · [MCP stdio scenarios](packages/mcp-server/src/__tests__/define-boundary-stdio.test.ts) |
| Planning handoff | An eligible checkpoint exposes validated requirements and acceptance criteria. Spec derives a proposal for one Step and binds it to the Define data with SHA-256. Architect OS prepares the preview and owns approval and execution. | [Define contract](packages/orchestration/src/define-handoff.ts) · [Plan projection](packages/orchestration/src/verified-plan.ts) · [Architect OS Plan](https://github.com/cdeust/architect-os/blob/227768523d7a586acb40c39e254bf98d988a9e56/docs/plan.md) |
| Implementation review dossier | With an operator-approved record, Spec returns a Git comparison for the pinned revisions and marks each acceptance criterion `evidence_required`. | [Review contract](packages/mcp-server/src/implementation-review.ts) · [MCP stdio scenarios](packages/mcp-server/src/__tests__/define-boundary-stdio.test.ts) |

The verifier reports whether the input satisfies its implemented rules. A report with no violations establishes structural conformance. Factual accuracy and implementation behavior require their own evidence. [Rule implementation](packages/validation/src/hard-output-rules/)

## The pipeline

![Spec workflow. An existing PRD can go directly to the portable verifier. In the full flow, a host drives PRD generation and verification, Spec exports validated Define and a deterministic proposal, and Architect OS prepares a preview. An operator can also request a pinned implementation dossier. Independent Plan review and measured delivery replay are next.](docs/diagrams/spec-delivery-flow.svg)

### Generate and verify a PRD

Call `start_pipeline`, execute the returned `NextAction`, and send the result with `submit_action_result`. Repeat until the server returns a terminal action. Use `get_pipeline_state` to recover the current action and inspect saved progress. When an action or report is paginated, follow `__page.next_offset` to the last page before acting on the complete result. [MCP protocol](packages/mcp-server/src/pipeline-tools.ts) · [Host dispatch rules](packages/skill/SKILL.md)

The full packaged workflow uses the companion tools and model actions described in the host skill. Set `codebase_path` only when the host can execute the graph actions through [AI Architect MCP Codebase](https://github.com/cdeust/ai-architect-mcp-codebase). Scope and edge-case review checks model findings and citations against the saved review inputs. Findings, inconclusive results, stale evidence or missing evidence can block Define. [Semantic review](packages/orchestration/src/semantic-review.ts) · [Define gate](packages/orchestration/src/define-handoff.ts)

### Read a planning handoff

Use `get_pipeline_state` with the saved `run_id`. An eligible checkpoint is a successful automatic completion or a legacy checkpoint with a pending decision that permits a handoff.

| Format | Result |
| --- | --- |
| `define_handoff_v1` | Validated requirements and acceptance criteria with explicit requirement references. |
| `verified_plan_v1` | A deterministic proposal for the `plan_step` you supply. The hashes bind the run, Define file and proposal file. The file format is compact UTF-8 JSON with a trailing newline. |
| `implementation_review_v1` | A read-only dossier for the `plan_step` and `review_id` you supply. The trusted launcher config binds the approved manifest and exact Git revisions. The dossier can be `ready_for_review` while every criterion still needs behavioral evidence. |

[Projection implementation](packages/mcp-server/src/pipeline-tools.ts) · [Review dossier setup](https://github.com/cdeust/ai-architect-mcp-spec/pull/385)

### Exported files per context profile

The table shows the files of a fully passed run with the standard request size. Failed or skipped sections can reduce the export. See `00-run-notes.md` for omissions.

| Context | Files written |
|---|---|
| `proposal` | `00-run-notes.md`, `01-prd.md`, `05-testing.md`, `06-deployment.md`, `07-jira-tickets.md`, `10-verification-report.md` |
| `feature` | `00-run-notes.md`, `01-prd.md`, `02-data-model.md`, `03-api-spec.md`, `04-security.md`, `05-testing.md`, `07-jira-tickets.md`, `10-verification-report.md`, `stage-5.affected_symbols.json` |
| `bug` | `00-run-notes.md`, `01-prd.md`, `05-testing.md`, `06-deployment.md`, `07-jira-tickets.md`, `10-verification-report.md`, `stage-5.affected_symbols.json` |
| `incident` | `00-run-notes.md`, `01-prd.md`, `04-security.md`, `05-testing.md`, `06-deployment.md`, `07-jira-tickets.md`, `10-verification-report.md`, `stage-5.affected_symbols.json` |
| `poc` | `00-run-notes.md`, `01-prd.md`, `05-testing.md`, `07-jira-tickets.md`, `10-verification-report.md`, `stage-5.affected_symbols.json` |
| `mvp` | `00-run-notes.md`, `01-prd.md`, `05-testing.md`, `06-deployment.md`, `07-jira-tickets.md`, `10-verification-report.md`, `stage-5.affected_symbols.json` |
| `release` | `00-run-notes.md`, `01-prd.md`, `04-security.md`, `05-testing.md`, `06-deployment.md`, `07-jira-tickets.md`, `10-verification-report.md`, `stage-5.affected_symbols.json` |
| `cicd` | `00-run-notes.md`, `01-prd.md`, `04-security.md`, `05-testing.md`, `06-deployment.md`, `07-jira-tickets.md`, `10-verification-report.md`, `stage-5.affected_symbols.json` |

A run declared `request_size: "tiny"` writes `00-run-notes.md`, `01-prd.md`, `05-testing.md`, `07-jira-tickets.md` and `10-verification-report.md`, whatever its context except an incident. Incidents follow their table row.

[Export regression](packages/orchestration/src/__tests__/readme-export-files.test.ts)

### Integration status

- **Ready** on Spec `main`. The portable verifier, host-driven Define verification, deterministic proposal and revision-bound review dossier are implemented. [Verification and Define](https://github.com/cdeust/ai-architect-mcp-spec/pull/387) · [Deterministic proposal](https://github.com/cdeust/ai-architect-mcp-spec/pull/383) · [Review dossier](https://github.com/cdeust/ai-architect-mcp-spec/pull/385)
- **Next** for the paired loop. The independent review handoff reached the Architect OS preview in an offline replay using a candidate Spec bundle and two model fixtures. Production evidence still needs signed-in adapters that attest the account and effective model, results on specimen inputs before Step, and results per criterion on the delivered revision. [Architect OS integration and replay](https://github.com/cdeust/architect-os/pull/123)

## Getting started

### Portable verifier

The checked-in Codex and Gemini CLI manifests start `mcp-server/index.js --profile verifier` and expose the two deterministic validation tools. The verifier makes zero model calls. [Codex manifest](.codex-plugin/plugin.json) · [Gemini CLI manifest](gemini-extension.json)

For any stdio MCP host, clone the repository and install the bundled server dependencies. Use Node 20 or later for the launcher.

```bash
git clone https://github.com/cdeust/ai-architect-mcp-spec.git
cd ai-architect-mcp-spec/mcp-server
npm ci --omit=dev
```

Configure the host to start `node /absolute/path/to/ai-architect-mcp-spec/mcp-server/index.js --profile verifier`. Call `validate_prd_section` with `section_type` and `content`. To check cross-section traceability, pass `sections` as an array of objects with `type` and `content` to `validate_prd_document`. [Request schemas](packages/mcp-server/src/index.ts)

### Full profile in Claude Code

```bash
claude plugin marketplace add cdeust/ai-architect-mcp-spec
claude plugin install ai-architect-mcp-spec@ai-architect-mcp-spec-marketplace
```

Start a fresh session, configure the companions required by the [host skill](packages/skill/SKILL.md), then run `/generate-prd` with a feature description. The plugin uses Node and npm to start its bundled server. The host supplies the model and companion tools. [Plugin launcher](.mcp.json) · [Generate PRD command](packages/skill/commands/generate-prd.md)

#### Supported platforms

The CI matrix runs these jobs. It probes the plugin launcher, `node bin/ensure-deps.mjs`, over stdio. On macOS and Windows, the environment command then runs `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test`, `pnpm bundle`, the portable checks and `scripts/release/smoke-mcpb.sh`.

| Platform | CI runner | Jobs |
|---|---|---|
| Linux | `ubuntu-latest` | unit, regression, e2e, environment, install |
| macOS | `macos-latest` | environment (plugin launch, the test suite and the `.mcpb` smoke), install |
| Windows | `windows-latest` | environment (plugin launch, the test suite and the `.mcpb` smoke), install |

[Platform contract](scripts/portable-distribution.test.mjs) · [CI commands](ci.json) · [CI runs](https://github.com/cdeust/ai-architect-mcp-spec/actions/workflows/pipeline.yml)

#### What the `.mcpb` carries

The bundle carries the MCP server and its launch configuration. `check_health` reports `degraded` with `skillAvailable: false` and `evidenceDbHealthy: false` for the bundle. Use the Claude Code plugin for its packaged skill and commands. [Bundle manifest](manifest.json) · [Bundle smoke test](scripts/release/smoke-mcpb.sh)

### Companion ecosystem

These are the plugin commands printed by the current full-profile preflight. The codebase companion applies when you supply `codebase_path`. The portable verifier is standalone.

```bash
claude plugin marketplace add cdeust/ai-architect-mcp-codebase
claude plugin marketplace add cdeust/Cortex
claude plugin marketplace add cdeust/zetetic-team-subagents

claude plugin install ai-architect-mcp-codebase@ai-architect-mcp-codebase-marketplace
claude plugin install hypermnesia-mcp@cortex-plugins
claude plugin install zetetic-team-subagents@zetetic-marketplace
```

[Preflight contract](packages/orchestration/src/__tests__/preflight-install-advice.test.ts)

## Reproduce the checks

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:portable
pnpm test:portable:runtime
```

The boundary scenarios drive MCP stdio with recorded fixture responses. The portable runtime smoke test checks the tool surface through the launchers declared in the host manifests. [Boundary scenarios](packages/mcp-server/src/__tests__/define-boundary-stdio.test.ts) · [Portable smoke test](scripts/smoke-portable-hosts.mjs)

## Contribute

The [architecture and dependency rules](CONTRIBUTING.md) describe how the core, validation, orchestration and MCP layers fit together. See the [assurance case](docs/ASSURANCE-CASE.md) for the verification evidence and [release instructions](docs/RELEASING.md) for packaging.

[MIT license](LICENSE) · [Privacy](PRIVACY.md) · [Security](SECURITY.md)
