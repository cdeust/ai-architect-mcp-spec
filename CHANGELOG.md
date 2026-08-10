# Changelog

All notable changes to this project will be documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **The release workflow never told the MCP Registry about a release.**
  `scripts/publish-mcp-registry.sh` existed as a manual runbook but no
  workflow called it, so `registry.modelcontextprotocol.io` kept serving
  `0.7.0` for `io.github.cdeust/ai-architect-mcp-spec` after `v0.8.0` was
  tagged, tested, and released. Added a `publish_registry` job to
  `.github/workflows/release.yml` (needs the `release` job; `workflow_dispatch`
  recovery path for tags whose registry publish is missing) that downloads
  and re-verifies the public `.mcpb` release asset (checksum + provenance
  attestation), publishes `server.json` to the registry via
  `mcp-publisher login github-oidc` (no stored credential), and fails the job
  if a follow-up query against the registry's own API disagrees with what
  was published. Removed `scripts/publish-mcp-registry.sh`, which this job
  supersedes.

## [0.8.0] — 2026-08-10 — canonical identity completed, cross-repo contract fixes

> The `[0.7.0]` section below was silently rewritten in place by the commit
> that produced most of this release (`a883cec`, #71), attributing this
> release's own not-yet-shipped identity completion to the already-tagged
> `v0.7.0` — whose immutable GitHub Release body still carries the original
> wording. Restored verbatim here; the corrected, actually-new text moves to
> this section, where an upgrader reading release notes will actually see it.

### Changed

- **BREAKING: the `prd-spec-generator` plugin identity and release alias are
  gone.** `v0.7.0` kept the product and Claude/Codex/Gemini plugins under the
  `prd-spec-generator` name while only the MCP Registry entry and primary
  bundle moved to `ai-architect-mcp-spec`; this release finishes the
  migration started there. The product, full-pipeline skill,
  Claude/Codex/Gemini plugins, MCPB asset, and Registry entry are now all
  `ai-architect-mcp-spec`; no `prd-spec-generator` plugin or `.mcpb` release
  alias is retained. **Existing callers must replace the
  `prd-spec-generator:generate-prd` skill qualifier with
  `ai-architect-mcp-spec:generate-prd`**, and anyone depending on the
  `prd-spec-generator.mcpb` release asset must switch to
  `ai-architect-mcp-spec.mcpb` — `release.yml` no longer publishes the legacy
  alias or its checksum. The internal `@prd-gen/*` workspace packages,
  `PRD_GEN_*` environment variables, `.prd-gen` data directory, and `prd-gen`
  MCP server/tool namespace remain stable protocol and storage identifiers;
  none of them was ever a published plugin or marketplace identity, so none
  of them changes here. (#71)

- **BREAKING: the affected-symbols sidecar is now emitted (with empty
  arrays) whenever `technical_specification` ran and found zero claims,
  instead of being omitted.** A docs-only or infra-only PRD that legitimately
  produces no code-level claims was previously indistinguishable, by file
  presence alone, from "extraction never ran." `ai-architect-mcp-codebase`
  `stages/stage-6.md` keys its regex-fallback decision on the sidecar
  *file's* absence, not on an empty payload — a consumer relying on the old
  omit-when-empty behavior to detect "extraction didn't run" will now see the
  file present with empty arrays for a zero-claims PRD. The
  `technical_specification` prompt was also corrected to always emit the
  affected-symbols block, since the previous prompt instructed the model to
  omit it when nothing was touched, masking the zero-claims signal at the
  source. Source: `ai-architect-mcp-codebase` `stages/stage-6.md`, "Zero-claims
  case — not the same as absent" (§4.2), pinned at commit
  `92216cd90f8f26cb15348675fc6556b8293edfc1`. (#80)

- **`ecosystem-adapters`' upstream client is renamed
  `AutomatisedPipelineClient` → `AiArchitectCodebaseClient`**, matching the
  upstream server's own rename (`automatised-pipeline` →
  `ai-architect-mcp-codebase`), with its config type and source file renamed
  to match. The class is exported from `@prd-gen/ecosystem-adapters`, but
  that workspace package is `"private": true` and has never been published —
  it has no consumer outside this repo, so the rename is not breaking for any
  external caller. Self-referential doc comments that still called this
  project `prd-spec-generator` (its own former name) were also corrected.
  (#78, closes #75)

- `@modelcontextprotocol/sdk` 1.29.0 → 1.30.0; `mcp-server/index.js` rebuilt
  from source against the updated types. Existing test suites pass
  unmodified. (#79)

### Fixed

- **The codebase-intelligence tool prefix pointed at a revoked plugin
  spelling.** `ai-architect-mcp-codebase` renamed its server key to
  `ai-architect` (canonical since its own v0.9.0), so the correct prefix is
  `mcp__plugin_ai-architect-mcp-codebase_ai-architect__`. This repo still
  named the pre-rename spelling in `SKILL.md`, `EXAMPLES.md`, and
  `preflight.ts`'s remediation text; the host silently drops calls to an
  unresolvable tool name rather than raising, so `call_pipeline_tool`
  returned nothing and the pipeline continued as if the call had succeeded.
  `mcp-tool-prefixes.test.ts`'s hand-copied allowlist carried the same dead
  spelling, so the gate that should have caught this would have rejected the
  fix; the allowlist moved in the same commit as the two call sites it
  guards. A stale `cortex@cortex-plugins` reference in the same remediation
  text (that plugin renamed to `hypermnesia-mcp` in v4.15.0) was corrected
  alongside it rather than left as the next silent failure. (#73)

### Security

- Raise `fast-uri` to 3.1.5, the first patched version for
  GHSA-7p8r-x3mc-p8w7, and rebuild the committed MCP bundle.
- Raise `hono` to 4.12.34, the first patched version for
  GHSA-8j4g-w8fx-2239, and rebuild the committed MCP bundle. A production-tree
  `pnpm audit` reports zero remaining vulnerabilities after both updates.

### Docs

- Add `CLAUDE.md` wiring this repo into the global zetetic agent rules
  (`~/.claude/rules/model-behavior.md`, `coding-standards.md`). (#76)

## [0.7.0] — 2026-08-03 — portable verifier and canonical distribution identity

### Added

- **Canonical distribution identity.** The product and Claude/Codex/Gemini
  plugins remain `prd-spec-generator`, while the official MCP Registry entry
  and primary portable bundle become `ai-architect-mcp-spec` at version 0.7.0.
  Repository-facing branding and URLs move to **AI Architect MCP Spec** at
  `cdeust/ai-architect-mcp-spec`.
  Releases retain `prd-spec-generator.mcpb` as a byte-identical compatibility
  asset, and the existing `prd-gen` server/tool namespace remains unchanged.
  The release procedure deprecates all versions of the former Registry entry
  only after the new canonical entry is active.

- **Portable Spec Verifier for Codex and Gemini CLI.** Both host manifests now
  launch the same opt-in `verifier` profile, which advertises and accepts only
  `validate_prd_section` and `validate_prd_document`. The shared `audit-prd`
  and `validate-spec` skills preserve the boundary between deterministic
  structural conformance and semantic or factual correctness. The existing
  Claude manifest still selects no profile, so its default 17-tool `full`
  surface is unchanged. Distribution tests pin manifest versions, launch
  arguments, supported skill frontmatter, and that Claude compatibility
  invariant.

### Fixed

- **Registry checksum guard now validates the field consumers actually read.**
  Release automation and verification use the schema-defined `fileSha256`
  property rather than agreeing circularly on an unused `file_sha256` field.
  The checksum is omitted until the artifact exists, and both identity and
  digest guards explicitly reject the former all-zero placeholder.

- **Codex and Gemini verifier startup from immutable plugin installs.** Their
  host manifests now execute the bundled server directly instead of running a
  first-launch `npm ci` inside the installed plugin directory, which Codex
  mounts read-only. Ajv is statically imported so esbuild carries it in the
  bundle, and the portable-host smoke test makes the staged plugin root
  read-only before exercising MCP initialize, tool discovery, and validation.
  Claude Code remains the primary full-profile interface: its `.mcp.json`
  launch path and 17-tool surface are unchanged and covered by regression
  tests. The obsolete verifier-only dependency branch was removed from the
  remaining Claude launcher after the portable hosts stopped invoking it.

- **The server advertised the wrong version to every host that connected.**
  `serverInfo.version` was the literal `0.4.0` in `packages/mcp-server/src/index.ts`
  while package.json, `.claude-plugin/plugin.json`, manifest.json and server.json
  all carried `0.6.1` — three releases of drift, read by every MCP client at
  handshake and by the registry entry built from it. The number is no longer
  written down twice: `server-version.ts` resolves it at startup from the
  package.json that ships beside the running bundle (the plugin tree and the
  staged .mcpb both carry `mcp-server/package.json`), falling back to the root
  package.json for workspace runs, and returning an obviously-unresolved
  sentinel rather than a plausible-looking number if neither can be read.
  `pnpm bundle` stamps `mcp-server/package.json` from the root version
  (`scripts/stamp-bundle-version.mjs`), and CI's bundle-freshness check now
  diffs all of `mcp-server/`, so an unstamped commit fails.

  The gate that should have caught this is fixed too: `smoke-mcpb.sh` printed
  `serverInfo.version` in its OK line while asserting only that a serverInfo
  existed, so the wrong version passed CI in green for three releases. It now
  asserts the advertised version equals the one manifest.json declares — two
  independent mirrors of the release, so the check can actually fail.

### Added

- **MCP prompts capability** (#28): `prompts/list` + `prompts/get` publish the
  pipeline ordering as enumerable protocol — `run_prd_pipeline(context, request)`
  (coordinate_context_budget → start_pipeline → get_pipeline_state →
  submit_action_result → plan_document_verification → conclude_verification) and
  `verify_prd_document(run_id)`. Each step's one-line summary is pulled from the
  live registered-tool description (the same schema `tools/list` advertises), so
  the ordering is not hand-copied a third time — `packages/mcp-server/src/mcp-prompts.ts`.
- **MCP tool profiles** (#28): `full`/`agent` profiles (`tool-profiles.ts`)
  selected by `--profile` / `PRD_GEN_PROFILE`. `agent` advertises the 12
  agent-facing generation/verification tools; `full` exposes all 17 including the
  internal diagnostics (get_config, read_skill_config, check_health,
  get_quality_history, get_strategy_effectiveness). Per-profile `initialize`
  instructions.
- **resources/list interop shim** (#28): the server now answers `resources/list`
  and `resources/templates/list` with empty arrays and declares the resources
  capability, so clients that probe resources regardless of declared capabilities
  do not surface `-32601` as a failed connection (CBM upstream #958). Rationale
  recorded at the use site in `index.ts` per §8.

### Security

- **Every known-vulnerable dependency is gone, and the audit ignore list is now
  empty** (#36, Scorecard `VulnerabilitiesID`). The tree carried 39 advisories
  (1 critical, 12 high) and `pnpm.auditConfig.ignoreGhsas` suppressed 8 of them.
  Both are now zero: `pnpm audit` reports `{critical:0, high:0, moderate:0,
  low:0}` with nothing suppressed. Floors come from each advisory's
  `first_patched_version`, not from guesswork — `vitest` (critical
  GHSA-5xrq-8626-4rwp, `packages/benchmark` was pinned at `^2.0.0` while the
  rest of the repo ran `^4`), `vite` 8.1.5, `postcss` 8.5.23, `hono` 4.12.32,
  `@hono/node-server` 2.0.5, `fast-uri` 3.1.4, `ip-address` 10.3.1, `qs` 6.15.3,
  `body-parser` 2.3.0, `js-yaml` 4.3.0, `esbuild` 0.28.1, `mathjs` 15.2.0.
  Transitive floors are pinned via `pnpm.overrides`, each satisfying its
  declaring parent's own range (`@modelcontextprotocol/sdk` is already at its
  latest 1.29.0, so there was no upstream release to wait for).
  The previous deferral said mathjs was "absent from the shipped .mcpb"; that
  was false — `grep -c mathjs mcp-server/index.js` returns 730 on the bundle it
  described — so the two-major bump was owed rather than optional.

- **The plugin's runtime provisioning now verifies integrity hashes**
  (#36, Scorecard `PinnedDependenciesID`). `bin/ensure-deps.sh` ran `npm install
  --no-package-lock` on the *user's* machine at first launch, so the shipped
  plugin re-resolved `^8.17.1` to whatever it meant that day, unverified. It now
  runs `npm ci` against a committed `mcp-server/package-lock.json` (44 of 45
  entries carry an `integrity` hash). Scorecard's shell checker accepts exactly
  this one form: `isNpmUnpinnedDownload` treats a command as pinned only when it
  contains `ci`, so pinning versions inside `npm install pkg@1.2.3` satisfies
  neither the checker nor the actual threat.

- **Least-privilege `GITHUB_TOKEN` across CI** (#36, Scorecard
  `TokenPermissionsID`): `ci.yml` declared no top-level `permissions:` block.
  Per Scorecard's own `checks/evaluation/permissions.go`, that undeclared
  top-level is what zeroed the check; `release.yml`'s job-level `contents:
  write` — which creating a GitHub Release genuinely requires — costs nothing
  because that file already declares `contents: read` at top level.

### Added

- **Property-based tests for `validateSection`** (#36, Scorecard `FuzzingID`):
  six contract invariants under `fast-check` — never throws, score stays in
  [0,1], `rulesPassed`/violations partition `rulesChecked`,
  `hasCriticalViolations` agrees with the violation set, determinism, and
  section-type echo. The function is fed LLM output, so its input space is "any
  string a model might emit"; the two defects `regex-hardening.test.ts` records
  (`[:<≤<=]` never matching `<=`, and `test_foo` matching inside `mytest_foo`)
  were both reachable by ordinary inputs nobody had written down.

- **Dependabot** (#36, Scorecard `DependencyUpdateToolID`) for `npm` and
  `github-actions`. The second ecosystem matters as much as the first: every
  `uses:` is pinned by commit SHA, and a SHA pin never ages out on its own, so
  without it the repo trades a supply-chain risk for an unpatched-action risk.

### Fixed

- **The `.mcpb` bundle could not start.** `manifest.json` declares
  `server.mcp_config` = `node ${__dirname}/mcp-server/index.js`, and the staged
  tree carried no `node_modules`: launching it exited immediately with
  `Cannot find module 'ajv'`. `bin/ensure-deps.sh` shipped inside the bundle but
  nothing in the `.mcpb` ever invoked it — that launcher belongs to the *plugin*
  path (`.mcp.json`), which passes it explicitly. The `.mcpb` now ships with its
  runtime dependencies already provisioned from the committed lockfile
  (`--omit=optional` leaves out the platform-specific `better-sqlite3`, whose
  absence is the already-declared Beta(7,3) prior fallback).

  The reason this survived a green suite is that the suite exercises the
  workspace *sources*; nothing ever started the artifact users install. So
  staging moved out of `release.yml` into `scripts/release/stage-mcpb.sh`, and
  `scripts/release/smoke-mcpb.sh` stages the bundle and speaks MCP to it over
  stdio, asserting `initialize` returns a `serverInfo` and `tools/list` returns
  17 tools. It runs as the `mcpb smoke` CI job on every push **and** as a gate
  in `release.yml` before packing. Verified to fail on the defect it exists to
  catch: with provisioning removed it reports `SMOKE FAIL: no response to
  initialize — the server did not start`.

  Both channels are now verified end-to-end from a clean tree: the plugin path
  (`ensure-deps.sh` → `npm ci` → 44 packages) and the `.mcpb` path both reach
  `initialize OK → prd-gen 0.4.0, 17 tools`.

- **The ReDoS growth-ratio assertion no longer fails on an unchanged tree.**
  `expectSubQuadratic` timed every `small` sample and then every `large` one, so
  ambient-load drift between the two blocks landed entirely in the numerator —
  on a 90-file parallel suite that is routine, and `main` produced ratio 3.42
  against a 2.5 ceiling on one run while passing the next two. The pair is now
  timed back-to-back and the median is taken over per-pair ratios, so the load
  term is common to numerator and denominator and cancels. The assertion keeps
  its 2.5 ceiling and its power: measured against an injected O(n²) worker it
  still reports 4.00 idle and 3.81 under eight competing CPU spinners, versus
  0.03/0.05 for a linear one.

- **The external-judge harness no longer reads any file on the path to the
  network** (`js/file-access-to-http`, the last CodeQL alert open on `main`).
  Both inputs used to be paths chosen at run time — `prompt_source` named a
  file inside the claim *data*, and `judge.mjs --prompt-file` named one on the
  command line — so the corpus was substitutable: point either at another file
  and its bytes are posted to a third-party LLM API. #37 guarded the first with
  a traversal check; this removes both reads instead. The corpus is now bound
  by a static `import … with { type: "json" }`, AC-008's historical text is
  inline in the fixture (its file recorded in `evidence_source` as provenance,
  pinned byte-for-byte by a test), and `judge.mjs` reads stdin — `< prompt.txt`
  is the same invocation with the shell doing the open. Verified with the
  CodeQL CLI against the query's own model: 1 result before, 0 after, and 0 new
  alerts across the full `security-and-quality` suite.

- **Three polynomial-ReDoS patterns closed** in the hard-output rules
  (`js/polynomial-redos`, the two CodeQL alerts that survived #37). All three
  were reported at the shared `findPatternViolations` call site but lived in the
  patterns handed to it: `sp_not_in_fr_table`'s cell scan, and
  `no_placeholder_tests`' TODO-body and matrix-row patterns. Each measured
  3.9x–4.0x per doubling before the fix — 2.6 s on a 176 KB single-line input —
  and is now linear. Pinned by growth-ratio tests (not wall-clock thresholds) in
  `packages/validation/src/__tests__/regex-hardening.test.ts`, each of which
  fails on the pre-fix code.

- Internal diagnostics tools are **gated, not merely hidden** under the `agent`
  profile (#28 criterion 5): an excluded tool is absent from `tools/list` AND
  rejected on call (`RegisteredTool.disable()` → `-32602 "Tool … disabled"`).
  Hiding from the list while still executing would be a hole, not an
  optimization. Asserted by `packages/mcp-server/src/__tests__/mcp-prompts.test.ts`.

### Removed

- **`judge.mjs --prompt-file`** — prompt text now comes from stdin only.
  `node judge.mjs … < prompt.txt` is byte-for-byte the same invocation with the
  shell performing the open, so no capability is lost; what goes is a second
  way to do one thing that happened to be the exfiltration primitive above. No
  caller in the repo used the flag.

- **`prompt_source` in `fixtures/ground-truth.json`**, replaced by the inline
  `evidence` field every other claim already used, plus an `evidence_source`
  provenance pointer that nothing reads. `resolveClaimEvidence` therefore no
  longer touches the filesystem, and the `resolveInsideFixtures` containment
  helper added in #37 is gone with the read it guarded.

### Changed

- **`sp_not_in_fr_table` is now row-scoped** (consequence of the ReDoS fix
  above; the old pattern had no linear equivalent). `\s` and `[^|]` both match
  `\n`, so the old greedy cell loop ran to the LAST Story-Points cell in the
  section and emitted ONE violation whose evidence spanned every row in
  between. Two offending rows now produce two violations, each carrying its own
  row as `offendingContent` — so a section with N offending rows scores N
  penalties where it previously scored one.

- **`no_placeholder_tests` matrix-row detection is line-scoped.** For the same
  reason (`\s` matching `\n`), a `// TODO` on the line *after* a matrix row was
  read as that row's third cell. A markdown row cannot wrap, so this removes a
  false positive rather than a detection.

- The default MCP tool profile is `full` (behaviour preserved). This diverges
  from #28 criterion 3's "default to the agent-facing set": shrinking the
  *default* advertised surface is a breaking change (a client that called a
  now-hidden tool would break), so — mirroring automatised-pipeline's
  `ToolProfile` and this parity wave's decision across all three repos — `full`
  stays the default and `agent` is opt-in. No default behaviour change ships, so
  `manifest.json` / `server.json` need no default update; the opt-in env
  (`PRD_GEN_PROFILE`) is documented here.

- Public-readiness baseline: LICENSE (MIT, sole independent author),
  CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md.
- GitHub issue templates (bug / feature / audit-finding) and PR template
  with audit-cycle checklist.
- GitHub Actions release workflow (`release.yml`): tag-triggered build +
  test + bundle-freshness gate + CHANGELOG-driven release notes.
- `assets/banner.svg` — ANSI Shadow project banner matching the ai-architect
  ecosystem's visual contract.
- README cross-links to companion projects (Cortex, zetetic-team-subagents,
  automatised-pipeline).
- `.claude-plugin/marketplace.json` and rewritten `plugin.json` — marketplace
  distribution via `claude plugin marketplace add cdeust/prd-spec-generator`.
- `mcp-server/index.js` — reproducible ESM bundle (esbuild; `better-sqlite3`
  stays external); `pnpm bundle` script; CI bundle-freshness gate.
- `pnpm verify` end-to-end chain: install → build → bundle → test.

> Note (2026-07-17, #22 backfill): these bullets predate the `[0.2.1]`
> boundary below — they shipped alongside the `## [0.2.0]` version-bump
> commit (`6c41cb7`) whose own dedicated section further down this file
> already describes a *different* set of changes (Phase 4 strategy-wiring).
> Reconciling `[0.2.0]`'s content with what `6c41cb7` actually shipped is a
> separate, `[0.2.0]`-scoped correction outside #22's 0.2.1–0.5.0 backfill
> range, so this residual is left in place rather than reattributed on
> unverified inference.

## [0.6.1] — 2026-07-22 — doc accuracy, registry metadata, cross-host install

### Added

- README "Use with other MCP hosts" section (Gemini CLI, Codex, Cursor,
  Windsurf, VS Code) — explicitly scoped to the standalone deterministic
  spec-linter surface (`validate_prd_section`, `validate_prd_document`,
  plus the direct-consumption planning/diagnostics tools). The full
  action-driven pipeline remains host-dependent and is only supported on
  Claude Code; the docs say so rather than overclaiming.

### Fixed

- Docs aligned with measured reality (#25): test-count badges and prose
  628/629 → 877 (vitest workspace count), pipeline step count 9 → 20
  (11 PRD-generation steps + 9 opt-in implementation steps behind the
  `implementation_gate` human gate), SKILL.md version refs (stale
  3.2.0/3.1.0 → package version), and the "does not write code" claim
  rewritten honestly: the server never edits source or pushes, but the
  opt-in steps 12–20 do drive host subagents that write, test, and review
  an implementation, gated by `implementation_gate` and `pr_gate`.
- De-flaked real-tsc oracle tests (#25 + this release): the subprocess
  tests measure 0.3–3.9s solo (2026-07-22, darwin arm64) but exceeded
  vitest's 5000ms default under full-suite parallel load, failing as
  timeouts rather than code failures. `vi.setConfig({ testTimeout:
  30_000 })` applied to `code-oracle.test.ts` (#25) and
  `external-oracle.test.ts`, with the measurement recorded at the use
  site. `findTscBinary`'s `tsc --version` probe timeout also raised
  3s → 10s (`TSC_PROBE_TIMEOUT_MS`): the probe measures 1.6s wall solo,
  so 3s left <2× headroom and made `isTscAvailable()` flip
  load-dependently — throwing `OracleUnavailableError` with tsc
  installed.
- LICENSE is now the verbatim MIT text (#26): GitHub licensee reported
  NOASSERTION because of the custom preamble and trailing citations note,
  breaking license bots and the marketplace's validate-licenses CI. The
  preamble, independence statement, and citations note moved verbatim to
  the README license section.
- `server.json` migrated from the 2025-07-09 snake_case schema to the
  current 2025-12-11 camelCase registry schema
  (`registryType`/`fileSha256`/`websiteUrl`) required by `mcp-publisher`
  for official MCP registry publication (#26).

> Note: no privacy-policy change in this release — `PRIVACY.md` has
> shipped since `8decec5` and is staged into the `.mcpb` by `release.yml`.

## [0.6.0] — 2026-07-17

### Added

- **Claim tiering + model-diversity judge slots** (`@prd-gen/verification`).
  A claim whose own text names a deterministically executable verification
  method (grep/diff/time/kcov/exit-status/named gate) skips the judge panel
  and gets a synthesized rule-tier verdict instead
  (`{kind:"rule",name:"rule-tier"}`); architecture-typed claims get one
  judge per model in `VerifyBudgetConfig.diversity_models` (default
  `["haiku","sonnet"]`) instead of N persona-prompted judges on one
  underlying model. `JudgeVerdict.model` records which model judged each
  claim; `10-verification-report.md` renders a cross-model-agreement
  summary. Measured on the calibration fixture: 30 → 23 judge invocations
  (-23%).
- **Explicit verification acceptance policy at `implementation_gate`.**
  `VerificationPolicyConfig` (`block_on`, `min_subjective_sampled_ratio`,
  `on_unsampled_below_ratio`, `on_cross_model_disagreement` —
  composition-root-injectable, default null uses
  `DEFAULT_VERIFICATION_POLICY`) and `evaluatePolicy()`, a pure function
  turning verification results into `pass` / `needs_attention` / `blocked`.
  `implementation_gate` now shapes its "Implement / PRD only" question from
  that verdict — a bare "Implement" is never offered while blocked — and
  records any human derogation on `post_specs.policy_derogation`.
- **Host-side external-judge executor** (`scripts/external-judge/`). A
  zero-dependency Node CLI (`judge.mjs`) that posts a judge prompt to an
  OpenAI-compatible endpoint (Gemini via AI Studio, Mistral via La
  Plateforme) when a `spawn_subagents` invocation names a non-Anthropic
  model, plus a calibration harness (`calibrate.mjs`) gated on agreement
  ≥ 0.7. No API key configured produces an explicit skipped result, never
  a fabricated verdict.
- Bilingual (FR/EN) hard-output-rule detection: opt-out markers and
  per-rule topic/keyword signal lists now recognize French phrasing via a
  shared lexicon (`rules/lexicon.ts`); 12 previously English-only rule
  checks (crypto, input validation, output encoding, structured logging,
  alerting thresholds, API contract docs, deprecation strategy, etc.) gain
  an explicit opt-out path, audited by
  `packages/validation/src/__tests__/opt-out-coverage.test.ts`.
- Budget-gated haiku judge panel for `self_check` verification
  (`PipelineState.verify_budget`, composition-root-injected): default
  panel reduced to 1 judge/claim (2 for architecture claims); a budget
  gate asks the user (reduced sample / full fleet / skip verification)
  when the invocation count exceeds a configurable cap (default 20).
- `submit_action_result` / `start_pipeline` response-size bound
  (`boundEnvelopeResponse`): an oversized `spawn_subagents` action has
  every invocation's prompt replaced by an observable `OmittedStub`; the
  full unbounded action is recoverable via
  `get_pipeline_state(run_id, format:"action")`.
- `10-verification-report.md` now written by `implementation_gate` before
  the implementation decision is asked, carrying per-claim judge verdicts
  when available.
- Root `pnpm lint` typechecks every workspace package via `tsc --noEmit`
  (`lint` script added to all 9 TS packages) and runs in CI.

### Fixed

- Root `lint` script was structurally broken: `tsc --noEmit` at the repo
  root found no `tsconfig.json` (only `tsconfig.base.json` exists), so it
  printed CLI help and exited non-zero — invisible because CI never ran
  it. Fixed by delegating to each package's own `lint` script via
  `pnpm -r run lint`; CI now runs the step so it cannot rot silently again.
- Hard-output-rule false positives on French-language PRD sections
  (technical_specification, cryptographic_standards, rate_limiting,
  secure_communication, GDPR consent, distributed_tracing) that had
  explicit, justified "non applicable" prose the English-only detector
  could not recognize.
- `test_traceability_integrity`'s test-function pattern only matched
  Swift-style `func test_xxx(`, so bash-defined tests (`test_xxx() { }`,
  `function test_xxx() { }`) were reported missing even when present.
- `claim-extractor.ts`'s evidence-snippet window used a fixed ±N-line
  radius that ignored claim boundaries, letting an adjacent claim's
  wording bleed into the current claim's evidence and mis-tier it;
  `snippet()` now stops at the neighboring claim's own start line.
- `file-export.ts` wrote placeholder text for companion files whose
  source section(s) produced no content; such files are now omitted
  entirely, with the omission and its reason recorded in
  `00-run-notes.md` (numbering stays stable).
- `renderJudgeVerdicts` stringified the structured `AgentIdentity` judge
  field as `"[object Object]"` instead of `"kind:name"`.

### Fixed (release workflow)

- `release.yml` never wrote the real `.mcpb` SHA-256 back into
  `server.json#/packages/0/file_sha256`, leaving a permanent
  `000...000` placeholder in every published release's manifest. The
  workflow now patches the checksum after packing the `.mcpb` and
  pushes the single-file update back to `main` as part of the same
  release job, so this fix is already in effect for the v0.6.0 tag
  itself. Fixes #23.

## [0.5.0] — 2026-07-14 — orchestration Phases 1-5 (PRD generation runner, implementation gate, testing loop, PR stage)

### Added

- **Phase 1 — Cortex memory loop.** Closes the per-run Cortex recall/store
  loop for the orchestration stages (#7).
- **Phase 2 — git-historian investigation stage.** New pipeline stage that
  investigates repository history before grounding (#8).
- **Phase 3a — types/state.ts split by concern** (refactor, #9).
- **Phase 3b — implementation gate + pre-impl grounding stage** (#10).
- **Phase 3c — post-impl verification sequence stage** (#11).
- **Phase 4a — implementation stage** (#12).
- **Phase 4b — testing stage + bounded review loop** (#13, #14).
- **Phase 5 — PR gate + PR creation stage** (#15).
- `stage-5.affected_symbols.json` sidecar emitted for the automatised-pipeline
  anti-hallucination validator.

### Fixed

- AP impact-analysis coupling, round numbering, and `.prd-gen` directory
  hygiene repaired (`caf98e9`).

### Changed

- `mcp-server` bundle regenerated for the Phase 1-5 orchestration additions.

Source: commits `caf98e9..045edf8` (`git log v0.4.1..v0.5.0` equivalent —
no `v0.4.1`/`v0.5.0` git tags survive locally; range bounded by the
`.claude-plugin/plugin.json` version-bump commits `71b8f02`→`045edf8`).

## [0.4.1] — 2026-07-07 — CI green (run-semaphore test fix) + AIA banner

### Added

- `server.json` (MCP registry manifest, `io.github.cdeust/prd-spec-generator`)
  — MCP Registry / Glama / Anthropic Directory submission metadata for the
  `.mcpb` package (`8decec5`). Ships with a placeholder
  `packages[0].file_sha256`; see #23.

### Fixed

- `run-semaphore` test captured the wrong `server.tool()` call argument as
  the handler under test, masking the actual assertion (`ba164f3`).

### Changed

- Project banner and README ledger synced to measured tool/test counts
  (`5f17e26`).
- `mcp-server` esbuild bundle refreshed for the 0.4.0 cut (`8a5085c`).

Source: commits `2812eca..71b8f02` (bounded by the `.claude-plugin/plugin.json`
version-bump commits).

## [0.4.0] — 2026-06-10 — bounded-io: Zod size contracts, aggregate response budget, run governors

### Added

- **Bounded-io Phase 1c.** Zod size contracts on previously-unbounded MCP
  tool inputs/outputs (`cd356ad`).
- **Bounded-io Phase 3.** Run semaphore, run-store eviction, and evidence
  retention governors (`e833686`).
- **Codebase grounding.** PRDs are grounded on the codebase graph via
  automatised-pipeline; codebase-grounding injected into section prompts
  during meta-prompting (`90cf344`, `640ebe8`).
- Coase dispatch policy + engineer isolation script for agent dispatch
  (`e4d0933`).

### Fixed

- `get_pipeline_state(format:"full")` now bounded to the aggregate 100k MCP
  response budget (`e43f41a`).
- MCP startup deadlock: script-only runners dropped from the calibration
  library barrel that was pulling them into the server's import graph
  (`051e9c1`).
- Externalised MCP runtime deps now provisioned on first plugin launch
  (`0b40835`).
- Cortex `recall` response parsing now reads the canonical `memories`/`count`
  keys (`3402de4`).

### Changed

- `ai-architect` MCP references renamed to `automatised-pipeline` across the
  codebase (`5b4bafd`).
- `mcp-server/index.js` bundle rebuilt for the grounding changes (`5577cb8`).

Source: commits `5bb7dd9..2812eca` (bounded by the `.claude-plugin/plugin.json`
version-bump commits).

## [0.3.0] — 2026-04-28 — Phase 4 closed-loop calibration (Waves A–F) + preflight step + naming cleanup

### Added

- **Phase 4.1 closed-loop reliability calibration.** Bayesian Beta(7,3) prior
  with sensitivity / specificity split per `claim_type`; SQLite-backed
  `ReliabilityRepository`; observation-flush hook on every claim resolution;
  CC-3 control arm via `getReliabilityForRun` (deterministic 20% partition
  forced-explored on the prior); JSONL audit logs alongside the SQLite store.
- **Phase 4.2 MAX_ATTEMPTS retry-budget calibration.** Kaplan-Meier survival
  math (`kmEstimate`, `kmMedianAttempts`, `logRankTest`) with Greenwood and
  Brookmeyer-Crowley CIs; Schoenfeld sample-size derivation; CC-3 control arm
  via `getRetryArmForRun`. Stopping rule revised from N=823 to N≈519 after
  measuring `event_rate=0.4762` (CP CI [0.4456, 0.5069]).
- **Phase 4.3 plan-mismatch fire-rate measurement.** Clopper-Pearson exact
  binomial CI; XmR control charts with frozen limits (Wheeler 1995 + Western
  Electric 1956 rules); fault-injection harness; pre-flight synthetic
  injection round-trip that catches drift between the diagnostic prefix and
  the regex matcher.
- **Phase 4.5 KPI gate tuning.** Frozen-baseline content-hash assertion;
  per-machine-class wall_time normalization with 5-bucket `detectMachineClass`;
  `loadCalibratedGates` + `hold_provisional` ratchet protection for thin-data
  gates; K=100 baseline committed under `packages/benchmark/calibration/data/`.
- **Externally-grounded oracle subsystem.** Ajv schema oracle, mathjs oracle,
  `tsc` subprocess code oracle, `validateSection` spec oracle.
  `OracleUnavailableError` typed throw replaces stub-mode fabrication —
  breaks annotator-circularity at the type-system boundary.
- **Paired-bootstrap implementation** (Efron & Tibshirani 1993 §16.4) —
  deterministic mulberry32 RNG; 12-decimal reproducibility pin; CI-based
  recommendation rule (`calibrated_helps` / `prior_helps` /
  `inconclusive_underpowered`); continuous-null p-value uniformity test.
- **Cross-arm comparison metrics.** `computeAblationComparison`,
  `computeReliabilityComparison`, `computeKpiGateComparison`. Each accepts a
  `SEAL_VERIFIED` typeof sentinel as a parameter; the only way to obtain it
  is to verify the held-out partition's sha256 first. Peeking before
  evaluation is a type error.
- **Production-mode dispatcher.** `makeProductionDispatcher` +
  `AgentInvoker` interface for non-canned calibration; CLI
  `--mode production|canned` flag selects whether calibration sees real
  verdicts or canned ones; the canned arm is preserved for offline
  reproducibility.
- **Claim-level `external_grounding` field.** Propagates from `Claim`
  through the orchestrator to the oracle-resolution path. The
  `conclude_verification` MCP tool now accepts an optional `claims` array
  carrying `external_grounding` so oracle-resolved truth replaces LLM-only
  consensus where schema / math / code / spec oracles are available.
- **Three sealed held-out lock files.**
  `packages/benchmark/calibration/data/maxattempts-heldout.lock.json` (§4.2),
  `packages/benchmark/calibration/data/kpigates-heldout.lock.json` (§4.5),
  `packages/benchmark/calibration/data/heldout-partition.lock.json` (§4.1,
  50-claim externally-grounded corpus). Each commits a sha256 of the
  partition before evaluation.
- **Audit lineage.** Six cross-audit cycles by Popper / Curie / Fermi /
  Shannon / code-reviewer over Waves A–F; ~50 BLOCKs closed across the wave
  sequence.
- `preflight` pipeline step (runs after `banner`, before `context_detection`):
  probes Cortex (`memory_stats`) and, when `codebase_path` is supplied,
  ai-architect (`health_check`); emits one actionable `failed` action with
  setup advice on probe failure.
- `preflight_status: "ok" | "skipped" | null` field on `PipelineState`.
- `skip_preflight: boolean` parameter on `start_pipeline` MCP tool for
  callers that accept degraded mode.

### Changed

- `start_pipeline_v2` → `start_pipeline`; `get_pipeline_state_v2` →
  `get_pipeline_state` (no v1 ever existed; suffix was historical baggage).
- `commands/generate-prd.md` (repo root): rewritten as a thin wrapper
  pointing at `packages/skill/SKILL.md` and the dispatcher loop — no
  mode detection, no environment branching, no license resolution.
- Plugin name `ai-prd-generator` → `prd-spec-generator`; MCP server name
  `ai-prd-tools` → `prd-gen`; `.mcp.json` extension bug fixed
  (`index.mjs` → `index.js`).
- `docs/PHASE_4_PLAN.md` relocated from repo root.
- CONTRIBUTING.md Code of Conduct section: points at local
  `CODE_OF_CONDUCT.md` (custom) instead of Contributor Covenant.
- Test count: 248 → 267 (preflight handler + regression suites);
  267 → 583 across Phase 4 Waves A–F (+316 tests, mostly calibration
  invariants, oracle round-trips, paired-bootstrap reproducibility,
  seal verification, and cross-arm metric edge cases).
- §4.2 Schoenfeld sample size revised from N=823 to N≈519 based on
  measured `event_rate=0.4762` (CP CI [0.4456, 0.5069]) — Popper AP-2
  closure.
- `MAX_ATTEMPTS` exported from `@prd-gen/orchestration` as
  `MAX_ATTEMPTS_DEFAULT` (was module-private; calibration needs to read it
  to derive the survival baseline).
- Build chain: `composite: true` + project reference wiring fixes the
  `pnpm -r build` chain across all 10 packages so the calibration subtree
  can consume orchestration types without circular references.
- `package.json#description`, `.claude-plugin/plugin.json#description`,
  `.claude-plugin/marketplace.json` descriptions: rewritten to reflect
  Phase 4 closure (closed-loop calibration, externally-grounded oracles,
  sealed falsifier protocols).
- Plugin version 0.2.3 → 0.3.0 (minor bump: new pipeline step + new
  `start_pipeline` parameter, both backward-compatible).

### Fixed

- Silent per-section Cortex degradation: before the `preflight` step, a
  disabled Cortex plugin caused every recall to return `success: false`
  tagged as `upstream_failure` with no user-visible warning; section
  quality degraded without any diagnosis path. Fixed by the preflight probe.

### Removed

- `mcp-server/index.mjs` (stale orphan, superseded by the `index.js`
  bundle).

Source: `git log 0203eb3..5bb7dd9 --oneline --no-merges` (Waves A–F,
`342f15f`..`5bb7dd9`; ~90 commits); range bounded by the
`.claude-plugin/plugin.json` version-bump commits `0203eb3`→`5bb7dd9`, the
latter carrying `"version": "0.3.0"`.

## [0.2.3] — 2026-04-26

### Added

- `hasExplicitOptOut(content, topicSignals)` helper in `@prd-gen/validation`:
  recognises "N/A — local CLI" / "by construction" / "no network" / "out of
  scope" markers within ±240 chars of a topic signal, exempting 13 service-
  shaped hard-output rules for features that genuinely have no network
  surface, no users, no PII, or no DB.

### Fixed

- Service-shaped hard-output rules (auth, rate limiting, secure
  communication, GDPR consent, distributed tracing, sensitive-data
  protection, etc.) falsely failed local-CLI / library / batch-job PRDs
  that explicitly acknowledged the topic was out of scope. Fixed via
  `hasExplicitOptOut` (see Added).

Source: commit `0203eb3` ("Add hasExplicitOptOut helper for service-shaped
hard-output rules").

## [0.2.2] — 2026-04-26

### Fixed

- `no_self_referencing_deps` rule: regex used `[^|]*` which matched
  newlines, allowing it to walk forward into later markdown table rows and
  false-flag any FR-NNN referenced as a dependency by a subsequent row.
  Fixed by anchoring both table and prose patterns on `[^|\n]*`; prose
  pattern additionally bounded to 200 chars.

Source: commit `6f1fe80` ("Fix no_self_referencing_deps regex walking
across markdown table rows").

## [0.2.1] — 2026-04-25 — license-tier removal + public-readiness docs

### Added

- `packages/core/src/domain/capabilities.ts`: single `CAPABILITIES` object
  replacing the removed `TIER_CAPABILITIES` record; values match the previous
  "licensed" tier exactly so behaviour for all callers is unchanged.
- `docs/INTEGRATION-TESTING.md`: walk-through for `AIPRD_PIPELINE_BIN`
  live-test setup, failure-mode table, and conventions for new integration
  tests.
- `docs/EXAMPLES.md`: canonical session transcript ("build OAuth login for
  the admin console") showing every host-visible action envelope and the
  EvidenceRepository rows produced; two failure scenarios.
- Cortex memory-hooks section in `packages/skill/SKILL.md`: documents
  per-section recall query templates, what to store out, and that Cortex
  hooks (not the host) persist session content automatically.

### Changed

- Pipeline step `license_gate` renamed to `banner`; handler
  `handleLicenseGate` → `handleBanner`.
- README MCP tools section corrected: named tools that don't exist
  (`conclude_section` / `conclude_document`) replaced with the real
  `conclude_verification`; tool count corrected 11 → 19 across badge, intro,
  install copy, architecture diagram, and `marketplace.json`; dead
  `#companion-projects` anchor fixed to `#companion-ecosystem`.
- `packages/skill/SKILL.md`, `skill-config.json` (root + package), and
  `commands/generate-prd.md`: renamed `ai-prd-generator` references toward
  `prd-spec-generator` (`mcp__prd-gen__validate_license`), the first pass of
  the plugin-rename completed in `[0.3.0]`.
- Test count: 258 → 248 (10 tier-specific tests removed, 7 added: 3
  Capabilities domain + 3 banner handler injection + 1 free-tier removal).
- Tool count: 19 → 17.

### Removed

- License-tier system carried over from the Swift port:
  `packages/core/src/domain/license-tier.ts` (`LicenseTierSchema`,
  `TIER_CAPABILITIES`, `LicenseTier`, `TierCapabilities`);
  `license_tier` field on `PipelineState`; `licenseTier` on `PRDDocument`;
  `license_tier_override` option on `start_pipeline`; `licenseTier` param
  on `selectStrategy`; `license_tiers` / `free_tier` / `trial_tier` /
  `licensed_tier` blocks in both `skill-config.json` files.
- `validate_license` and `get_license_features` MCP tools.
- `packages/orchestration/src/handlers/license-gate.ts` (replaced by
  `banner.ts`).
- Free-tier-degraded-assignment branch in `strategy/selector.ts` and
  matching test.
- Cowork-mode branching in `commands/generate-prd.md` (detected a
  `validate_license` tool that no longer exists).

Source: commits `2c3d83b`, `4a7ab44`, `7e953e8`, `5ea93d8` (the last bumping
`.claude-plugin/plugin.json` to `"version": "0.2.1"`).

## [0.2.0] — Phase 4: strategy-wiring + audit-cycle closure

### Added

- **Phase 4 strategy-wiring.** The `@prd-gen/strategy` package
  (research-evidence DB, claim analyzer, weighted selector,
  EffectivenessTracker) is now wired end-to-end through section-generation:
  - `selectStrategy` is called once per section at the pending → retrieving
    transition; the assignment is persisted on `SectionStatus`.
  - `buildSectionPrompt` renders a `<strategies>` block with required /
    optional / forbidden strategies + research citations.
  - Terminal section transitions enqueue one `ExecutionResult` per
    required strategy into `state.strategy_executions`.
  - The mcp-server composition root drains the queue into the
    `EvidenceRepository` via `EffectivenessTracker.recordExecution`,
    closing the feedback loop.
- Three error kinds (`section_failure` / `structural` / `upstream_failure`)
  in `state.error_kinds[]` so KPI gates distinguish handler bugs from
  recoverable upstream service failures.
- Typed `verification` field on the `done` action (replaces brittle regex
  parsing of the prose summary).
- Mixed-verdict KPI test that exercises consensus engine end-to-end.
- Per-handler injection tests + canned-dispatcher routing tests +
  feasibility-gate / license-gate / clarification proceed-branch tests.
- Schema round-trip test for `PipelineStateSchema` with populated
  strategy fields.

### Changed

- `consensus.ts`: `clampUnit` guards on every reliability/confidence input;
  `NO_INFORMATION_FLOOR=0.2` skips judges whose `adjustedReliability` would
  produce anti-correlated likelihoods.
- `DEFAULT_RELIABILITY_PRIOR_MEAN` doc-comment corrected (was mis-described
  as "uniform weak prior"; actually Beta(7,3), ESS=10).
- `buildExecutionResult` now emits one entry per required strategy (not
  just `required[0]`). Confidence gain decoupled from retry count.
- `start_pipeline_v2` → `start_pipeline`; `get_pipeline_state_v2` →
  `get_pipeline_state` (no v1 ever existed).
- `validation/audit-flags/engine.ts` split into engine + helpers +
  pipeline-ops + types modules (was 510 lines, all over §4.1).
- `handleSelfCheck` split into Phase A + Phase B + dispatcher (was 116
  lines, over §4.2).
- `smoke.test.ts` split into smoke + handler-injection (was 812 lines).

### Fixed

- **CRIT:** `runner.ts` coalesce-cap path bypassed `appendError`, breaking
  the `errors`/`error_kinds` lockstep invariant.
- **CRIT:** `parseVerdicts` return-empty mutation survived Phase B
  degradation tests (now caught by typed verification assertions).
- **CRIT:** `pipeline-tools.ts` inline ActionResult schema duplicated the
  canonical `ActionResultSchema`; now references the canonical schema
  directly.
- **CRIT:** Layer violation — `orchestration` was importing from
  `@prd-gen/ecosystem-adapters`. Pure domain types (`Claim`, `JudgeVerdict`,
  `JudgeRequest`, `AgentIdentity`) moved to `@prd-gen/core`.
- **HIGH:** `start_pipeline_v2` did not drain `strategy_executions` after
  initial step (now drains).
- **HIGH:** Free-tier zero-gain `ExecutionResult` entries were
  contaminating `chain_of_thought` cross-tier statistics; free-tier
  recording is now skipped.
- **HIGH:** Plan-mismatch diagnostic (`mismatch_kind:content_mutation` vs
  `:ordering_regression`) now surfaces in `state.errors` (was buried in
  unread synthetic verdict caveats).
- 60+ additional findings closed across two cross-audit cycles
  (Phase 3+4); see commit history `c664c95..main`.

### Tests

- 81 → 258 (+220% coverage) across 17 test files in 9 packages.
- Live integration test against the Rust automatised-pipeline binary,
  env-gated by `AIPRD_PIPELINE_BIN`.

## [0.1.0] — Initial release

- Stateless reducer (`step(state, result?) → next_state, action`) with
  9 pipeline steps.
- 11 MCP tools.
- Multi-judge verification with weighted-average + Bayesian consensus.
- Deterministic Hard Output Rules validation.
- 10 workspace packages with strict Clean Architecture layering.
