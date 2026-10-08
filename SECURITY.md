# Security Policy

## What the server accesses

AI Architect MCP Spec is an MCP server that turns a feature description into a
9-file PRD. Its exposure, stated plainly:

- **It runs as an MCP server in your session**, with the permissions your MCP
  host grants it, and it reads/writes the PRD workspace files it is pointed at.
- **It provisions runtime dependencies on first launch.** The distributed
  `.mcpb` bundle externalises three runtime deps that `bin/ensure-deps.sh`
  installs from the npm registry at first run — a pnpm workspace + lockfile is
  exactly the shape npm supply-chain attacks target (a postinstall script in a
  transitive dependency).
- **It shells out to the ecosystem** (optional ai-architect-mcp-codebase / Cortex
  MCPs) only when you configure them.

Because the delivered artifact is a bundled npm-derived `.mcpb`, "what is
actually in this bundle" is a genuinely hard question — which is why the SBOM
and the checksum guarantee below exist.

## Supply-chain assurance

As of issue #29, every release (`.github/workflows/release.yml`) ships:

- **Build provenance** — the `.mcpb` bundle and the SBOM each carry a
  Sigstore-backed build-provenance attestation. Verify a download binds to
  this repository and workflow:

  ```bash
  gh attestation verify ai-architect-mcp-spec.mcpb --repo cdeust/ai-architect-mcp-spec
  ```

- **Checksum integrity, verified in the pipeline** — the `.mcpb` SHA-256 is
  published as a `.sha256` companion **and** written into `server.json`
  (`packages[0].fileSha256`, the value the MCP registry hands consumers). The
  release job runs `scripts/release/verify-mcpb-checksum.mjs` and **fails the
  release if server.json's checksum does not equal the built artifact** —
  closing the #23 defect class (a published integrity value that did not match
  the artifact), not just its instance. The assertion is unit-tested.

- **SBOM** — `ai-architect-mcp-spec.cdx.json` (CycloneDX, generated from
  `pnpm-lock.yaml`) enumerates the workspace dependency graph and accompanies
  every release.

- **Continuous checks** — `pnpm audit --prod --audit-level high` and
  dependency review on PRs (`ci.yml`), CodeQL for JavaScript/TypeScript on a
  schedule (`codeql.yml`), and OpenSSF Scorecard (`scorecard.yml`). The
  Scorecard number is a recorded baseline, not a badge.

**Not published to npm.** All workspace packages under `packages/` are
`private: true`; nothing is published to the npm registry, so npm provenance
(`npm publish --provenance`) has no artifact to sign. The distributed artifact
is the `.mcpb`, which is attested above. If npm publishing is ever introduced,
the release workflow already holds `id-token: write`, so `--provenance` is a
one-line addition.

**What this does NOT claim.** Provenance proves *who built the artifact and
from which commit*, not that the source is free of defects; and it is worth
nothing to a user who does not run the verification.

### Scorecard controls, and the one that is declined

Issue #36 addressed the nine open Scorecard findings. Seven closed because a
control now exists, not because the alert was silenced:

| check | control |
|---|---|
| `VulnerabilitiesID` | 39 advisories → 0, with `auditConfig.ignoreGhsas` (pnpm-workspace.yaml) emptied. Floors in `overrides` (pnpm-workspace.yaml) are each advisory's `first_patched_version`. |
| `PinnedDependenciesID` | `bin/ensure-deps.sh` runs `npm ci` against a committed `mcp-server/package-lock.json`, verifying integrity hashes on the user's machine. |
| `TokenPermissionsID` | every workflow declares top-level `permissions:`. |
| `DependencyUpdateToolID` | `.github/dependabot.yml`, covering `npm` **and** `github-actions` (SHA pins do not age out on their own). |
| `FuzzingID` | property-based tests under `fast-check` (`packages/validation/src/__tests__/validate-section.properties.test.ts`). |
| `BranchProtectionID` | `main` requires a pull request and passing CI (`build + test` on 20.x/22.x, CodeQL analyse), blocks force-pushes and deletion, and requires conversation resolution. |

**`CodeReviewID` is declined, and the reason is structural.** It scores
"approved changesets" over recent history, and GitHub does not permit a user to
approve their own pull request. On a single-maintainer repository the only ways
to make this check pass are to add a second human reviewer or to have the
maintainer approve their own work through a second account — the first is not
available here, and the second manufactures the evidence the check exists to
gather. Branch protection therefore requires a pull request with
`required_approving_review_count: 0`: every change still lands through a PR with
CI enforced and a reviewable diff, which is the part that carries real value at
this team size, while the approval count honestly reports zero rather than
laundering a self-approval into a green metric. This is revisited the moment a
second maintainer joins.

**`CIIBestPracticesID` is declined for the same structural reason.** Scorecard's
`checks/evaluation/cii_best_practices.go` awards its
maximum only for the **gold** badge (silver 7, passing 5, in progress 2) and
reports a finding at any score below maximum. Gold is not reachable here: it
requires `contributors_unassociated` (at least two significant contributors not
associated with each other) **and** `two_person_review` (at least half of all
proposed modifications reviewed by someone other than their author). Both need a
second person, which is the same wall as `CodeReviewID` and not one a
single-maintainer project clears by doing better engineering.

The badge itself **is** shown, as of 2026-07-27, because it now reports an
achieved level rather than an unfinished self-assessment. The project earned the
**passing** badge that day at 100% of the passing criteria (67 of 67: 56 met,
11 not applicable) and the **silver** badge the same day at 100% of the silver
criteria (55 of 55: 41 met, 9 not applicable, 5 unmet-with-reason). The earlier
position here was that a badge reading
`in progress — 0%` is a worse signal than no badge, since it advertises an
incomplete questionnaire as though it were an assurance; that objection does not
apply to a level that was actually earned, and it still applies to gold, which
this project does not claim.

The answers behind the badge are not only in the web form. Every passing and
silver criterion is answered in [`.bestpractices.json`](.bestpractices.json) at
the repository root, which bestpractices.dev reads directly from the default
branch, so each claim sits in version control next to the evidence it cites and
changes to it are reviewable. Five silver criteria are answered `Unmet` with
their reasons rather than argued into a pass (`dco`, `bus_factor`,
`internationalization`, `version_tags_signed`, `hardening`); all are SHOULD or
SUGGESTED, and no MUST is unmet at either level.

The badge is still not the load-bearing artifact. The honest ones are the same
as before — an empty audit ignore list, integrity-verified provisioning,
least-privilege tokens, branch protection, property-based tests — each of which
a reader can verify from this repository rather than from a shield.

## Reporting a Vulnerability

If you discover a security issue in this project, **do not** open a public
issue. Instead, send a private report to the maintainer.

**Disclosure channel:** open a [private security advisory on GitHub](https://github.com/cdeust/ai-architect-mcp-spec/security/advisories/new).

Include:

- Affected version (or commit SHA)
- Reproduction steps or proof of concept
- Impact assessment (what does an exploit accomplish?)
- Suggested fix, if you have one

## Response SLA

| Severity | First response | Patch / mitigation |
|---|---|---|
| Critical (RCE, data exfiltration, auth bypass) | 24 hours | 7 days |
| High | 3 days | 14 days |
| Medium / Low | 7 days | Best effort |

## Supported Versions

Only the latest minor release on `main` receives security patches.

## Disclosure Timeline

1. Reporter sends private advisory.
2. Maintainer acknowledges receipt within the first-response SLA.
3. Maintainer + reporter agree on a coordinated disclosure date (default
   30 days from the patched release).
4. Patched release ships; reporter is credited unless they prefer
   anonymity.
5. Public advisory published on the agreed date.

## Out of Scope

- Vulnerabilities in third-party dependencies that have not been patched
  upstream — please report those upstream first.
- Issues that require an attacker to already have control of the host
  process (in-process supply-chain attacks).
- Self-inflicted misconfigurations of your own MCP server registration.

## Recognition

Reporters who follow this disclosure process are credited in the release
notes for the patched version, unless they explicitly request anonymity.
