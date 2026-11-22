# Security alerts on 2026-11-22

The GitHub APIs for code scanning and Dependabot reported 21 open alerts on
[main at af8ed101](https://github.com/cdeust/ai-architect-mcp-spec/commit/af8ed101cd5fb02c8daf8b577194facbf562bad4).
The alert numbers below identify the original findings.

| Source | Alerts | Change and verification |
| --- | --- | --- |
| CodeQL | 5, 561 | The Swift placeholder rule reads declarations in source order and scans each body span once. The validation suite checks nested Swift comments, declaration order and reported excerpts. |
| CodeQL | 566–571 | The measurable-requirements suite loads full Markdown specimens from fixture files. The validator still receives the original documents. |
| CodeQL | 564 | The launcher installs privately, acquires ownership with an atomic hard link and publishes the completed runtime by rename. Process-level tests cover concurrent launch, owner termination, and reuse after repairing a damaged published directory. |
| CodeQL | 572–575 | The checksum tests import the filesystem operations they use. The assertions still cover mismatched, missing and valid checksums. |
| Dependabot | 46–51 | The lockfile resolves Hono 4.13.20 and minimatch 11.0.1. Tests invoke the consumer APIs. |
| OpenSSF Scorecard | 525 | Seven advisories appeared in the baseline dependency graph. The corrected graph gives zero findings in the local Scorecard Vulnerabilities check. Sandbox Runtime imports Zod v3. Its bounded collection checks receive the upstream fix through a package patch exercised under ESM and CommonJS. |
| OpenSSF Scorecard | 535 | Registry verification selects the latest matching server version from JSON with jq. Shell tests exercise an initially empty registry, convergence, exhausted retries and malformed data. |

The [first hosted CodeQL run on PR 397](https://github.com/cdeust/ai-architect-mcp-spec/actions/runs/45045544777)
reported two further findings, 580 and 581, at the calls that recognized the
opening and empty body of a Swift test. That scan used the merge with the
Vitest dependency update in PR 394. The follow-up replaces both variable-length
matching operations with cursor-based checks.

The local full and production dependency audits each reported zero advisories.
The committed plugin manifest returned `check_health OK: prd-gen 0.9.0` on macOS. The Codex and Gemini portable manifests each initialized the rebuilt bundle and completed both verifier tool checks. The release registry was exercised with fixtures. GitHub records the disposition
of each alert after scanning the merged revision.

Sources and reproduction

- [Code scanning alerts](https://github.com/cdeust/ai-architect-mcp-spec/security/code-scanning) and [Dependabot alerts](https://github.com/cdeust/ai-architect-mcp-spec/security/dependabot).
- [Upstream Zod change](https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd) and [advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
- Install with `pnpm install --frozen-lockfile`, then run `pnpm audit`, `pnpm audit --prod`, `pnpm test:portable` and `pnpm gate` on the candidate commit.
