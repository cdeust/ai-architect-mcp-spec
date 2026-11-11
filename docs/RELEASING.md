# Releasing

How a version of ai-architect-mcp-spec is released. Written from the 0.9.0
release (2026-11-11) and from what the workflows do; where the two disagree,
the workflow file is right and this page is stale.

## What triggers a release

There is no manual tag and no manual GitHub Release.

1. A pull request that bumps the version merges to `main`.
2. The `tag` job of `.github/workflows/pipeline.yml` runs on that push, after
   `contract`, `unit`, `regression`, `e2e`, `environment` and `install` are
   green on the merge commit. It reads the version from
   `.claude-plugin/plugin.json` (`DEFAULT_VERSION_FILE`; `ci.json` declares no
   `version_file` or `release_packages`) and pushes the annotated tag
   `v<version>` with the deploy key `RELEASE_TAG_SSH_KEY`. An existing tag is
   left where it is, so a merge that does not change the version publishes
   nothing. Without the secret the job skips and says so in its summary.
3. The tag starts `.github/workflows/release.yml` (`on: push: tags: v*.*.*`).
   Its `release` job builds, tests, packs and attests the `.mcpb`, and creates
   the GitHub Release; its `publish_registry` job then publishes `server.json`
   to the MCP Registry and checks that the registry serves the new version.

Once the tag exists it is not moved. Everything `release.yml` checks must
therefore already hold on the release branch: run it locally first (below).

## What ships, and from where

| Surface | What the user runs | Built when |
|---|---|---|
| Claude Code / Codex / Gemini plugin | the **committed** `mcp-server/index.js`, started by `bin/ensure-deps.mjs` from the cloned repository (`.mcp.json`) | by whoever last ran `pnpm bundle` and committed it |
| `.mcpb` (GitHub Release, MCP Registry) | `mcp-server/index.js` rebuilt by `release.yml` (`pnpm build`, `pnpm bundle`, `scripts/release/stage-mcpb.sh`) | at release time |

Two consequences:

- A plugin install runs no build (`bin/ensure-deps.mjs` only runs `npm ci` in
  `mcp-server/`), so a stale committed bundle is what plugin users get. The
  release commit carries a rebuilt bundle.
- `release.yml` rebuilds and then runs
  `git diff --exit-code packages/mcp-server/dist/` ("Verify mcp-server bundle
  is current"). A committed `packages/mcp-server/dist` that is behind the
  source fails the release **after** the tag exists. The release commit carries
  a rebuilt `dist` too, new files included.

## Steps

Work in a worktree, on a branch from the current `main`
(`git worktree add .claude/worktrees/release-next -b release/<version> origin/main`).

1. **Choose the version** from `CHANGELOG.md` `[Unreleased]`, by SemVer. Before
   1.0: a breaking change or a new feature bumps the minor, fixes alone bump
   the patch.
2. **Bump the hand-edited version sites** (`scripts/check-distribution-identity.mjs`
   compares each with `package.json`):
   - `package.json`
   - `.claude-plugin/plugin.json`
   - `.claude-plugin/marketplace.json` (`metadata.version` and the plugin entry)
   - `.codex-plugin/plugin.json`
   - `gemini-extension.json`
   - `manifest.json`
   - `server.json`: `version`, `packages[0].version`, and the tag inside
     `packages[0].identifier`. `fileSha256` stays absent: the workflow computes
     it and never commits it.
   - `packages/skill/SKILL.md`: the `version:` frontmatter line and the title.

   Do not edit `mcp-server/package.json` or `mcp-server/package-lock.json` by
   hand: `pnpm bundle` stamps them (`scripts/stamp-bundle-version.mjs`).
   Version numbers in comments, tests and older changelog sections are history.
3. **Changelog**: put `## [<version>] — <date> — <summary>` under
   `## [Unreleased]`, which stays, empty. `release.yml` takes the release notes
   from that section, and `check:identity` requires the heading.
4. **Rebuild what is committed**:
   ```bash
   pnpm install --frozen-lockfile
   pnpm build      # packages/mcp-server/dist
   pnpm bundle     # mcp-server/index.js, and stamps mcp-server/package*.json
   ```
   Commit `packages/mcp-server/dist` (add untracked files), `mcp-server/index.js`,
   `mcp-server/package.json` and `mcp-server/package-lock.json`.
5. **Test count**: `node scripts/check-doc-claims.mjs --fix` rewrites the count
   quoted in `README.md`, `package.json`, `manifest.json`, both
   `.claude-plugin` files and `.bestpractices.json`. Run it last, after any
   test was added.
6. **Run what CI and `release.yml` run**:
   ```bash
   pnpm check:identity
   pnpm lint
   pnpm test
   pnpm test:coverage
   pnpm test:perf
   pnpm run test:portable
   pnpm run test:portable:runtime
   bash scripts/release/smoke-mcpb.sh
   pnpm check:docs
   python3 -B -m unittest discover -s scripts/tests -p 'test_*.py'
   node scripts/check-health-stdio.mjs "$PWD"   # the plugin launch, as the environment job runs it
   ```
   and the packing steps of `release.yml`, outside the repository:
   ```bash
   STAGE="$(mktemp -d)/ai-architect-mcp-spec-mcpb"
   bash scripts/release/stage-mcpb.sh "$STAGE"
   npx -y @anthropic-ai/mcpb@latest pack "$STAGE" "$STAGE.mcpb"
   jq --arg sha "$(shasum -a 256 "$STAGE.mcpb" | awk '{print $1}')" \
     '.packages[0].fileSha256 = $sha' server.json > "$STAGE.server.json"
   node scripts/release/verify-mcpb-checksum.mjs "$STAGE.mcpb" "$STAGE.server.json"   # prints OK:
   ```
   Then build once more and confirm nothing moved:
   `pnpm build && pnpm bundle && git status --short` shows no change under
   `packages/mcp-server/dist` or `mcp-server/`.
7. **Commit** (`release: <version>`, signed off), push the branch, open the
   pull request. The CI contract of `docs/agent-guidance.md` applies to it like
   to any other.

## What cannot be checked before the tag

These steps of `release.yml` need the tag, GitHub's OIDC token or the public
release, and run only there: the Sigstore attestation of the `.mcpb` and the
SBOM, the creation of the GitHub Release, and the whole `publish_registry` job
(download and attestation check of the public asset, `mcp-publisher` login and
publish, the registry read-back).

## If the release fails after the tag

- `release` failed: fix on `main` under a new patch version. The tag is not
  moved and not deleted.
- `release` succeeded and `publish_registry` failed: rerun `release.yml` with
  `workflow_dispatch` and the `tag` input. It republishes that tag's
  `server.json` without rebuilding anything.
