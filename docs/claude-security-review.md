# Claude security review

`.github/workflows/claude-security-review.yml` runs an advisory security review
of trusted pull requests on the owner's Claude subscription, beside the code
reviews of [the subscription review contract](review-subscriptions.md) (Claude
and Codex) and the Codex GitHub App's security summary. It comments, and it
never approves, blocks or merges anything. The review stays advisory until its
false-positive rate has been measured on this repository (decision of
2026-11-25).

## Engine

The engine is `anthropics/claude-code-action`, at the pin already used by
`claude-review.yml`, authenticated with the existing `CLAUDE_CODE_OAUTH_TOKEN`.
It runs in tag mode (`track_progress`), on the workflow's own `GITHUB_TOKEN`
(`github_token`), not on the Claude GitHub App token, so its comments are
authored by `github-actions[bot]`.
The prompt adapts the audit prompt and the false-positive filtering of
[`anthropics/claude-code-security-review`](https://github.com/anthropics/claude-code-security-review)
at `0c6a49f1fa56a1d472575da86a94dbc1edb78eda` (MIT). It is versioned in
`.github/claude-security-review/scan-instructions.txt` and
`false-positive-filtering.txt`, with the categories and known false positives
of this repository added.

### Why `claude-code-security-review` is not the engine

Read in its code at `0c6a49f1`, on 2026-11-25:

- **It needs an API key.** `action.yml` reads only `claude-api-key` and passes it
  on as `ANTHROPIC_API_KEY`. The scan step exits 1 when that is empty, and
  `validate_claude_available` rejects an empty key. Nothing reads
  `CLAUDE_CODE_OAUTH_TOKEN`. In the Claude Code CLI 2.1.306 binary, the
  non-interactive credential lookup (`mT()`) takes `ANTHROPIC_API_KEY` first and
  sends it as `X-Api-Key` (`Rjt()`), so a subscription token in that input would
  go out as an API key. The owner wants every review on the subscription.
- **Its defaults name retired models.** The scan defaults to
  `claude-opus-4-1-20250805` (`claudecode/constants.py`). The filter's access probe
  calls the hard-coded `claude-3-5-haiku-20241022`
  (`claude_api_client.py`, `validate_api_access`), and when that probe fails,
  `findings_filter.py` falls back silently to the fixed rules.
- **It installs dependencies it does not pin.** It runs `npm install -g
  @anthropic-ai/claude-code` (the latest version) and `pip install` with `>=`
  ranges (`PyGithub`, `requests`, `anthropic`), and installs Node 18 while the CLI
  declares Node 22 or later.
- **It pins nothing on the upstream side.** There is no tag and no release, and
  Dependabot does not update a SHA pin when the upstream has no tag.

It could become the engine if the owner accepts API billing (a new
`ANTHROPIC_API_KEY` secret) and upstream pins its runtime installs and model
defaults. A tag Dependabot can follow would also be needed, or a vendored copy
under the same guards.

To replace the engine, change only the `Claude security review` step. Every
step above it is a guard and stays. The budget counts the step by that name.

## Guards

| Threat (STRIDE) | Guard | Test (`scripts/tests/test_ci_review_security.py`) |
| --- | --- | --- |
| Spoofing: fork or Dependabot code gets the subscription token | Trigger `pull_request` only, never `pull_request_target`. The job `if` is the trust rule of `claude-review.yml`: a head in this repository, not a draft, not `dependabot[bot]`. | contracts `trigger`, `trusted-authors`; mutations `fork-allowed` and a `pull_request_target` trigger |
| Tampering: the PR's `.claude/`, `CLAUDE.md` or hooks run in the review | The checkout is `main` with `persist-credentials: false`, and every script and instruction file comes from it. The action restores `.claude`, `CLAUDE.md` and `.mcp.json` from the base before Claude starts (`restore-config.ts`). Root-owned, read-only managed settings disable all hooks, including the base hook that runs `scripts/gate/gate.mjs` from the PR head. | contracts `checkout-main`, `managed-settings`, `order`; mutations `head-checkout-added`, `settings-writable`, and removing the install step |
| Tampering and elevation: prompt injection through the diff, title, body, comments or files (the upstream README: "not hardened against prompt injection"; tag mode puts the PR body and its comments, which anyone can write on a public repository, in the prompt) | No shell (managed deny on `Bash`, which also blocks tag mode's git wrappers), and `--permission-mode dontAsk` given once. No edit, no write, no web tool, and the `github_ci` and `github_file_ops` MCP servers are denied. The tools left are Read, LS, Glob, Grep, Task, the tracking comment and inline comments. The engine's inputs are an exact set, so `use_commit_signing`, `settings`, `plugins` or `allowed_non_write_users` cannot be added unnoticed. The prompt marks all PR content as untrusted. | contracts `engine-tools`, `engine-inputs`; mutations `bash-allowed`, `--permission-mode auto`, `second-mode`, `use_commit_signing`, `settings-input`; `test_managed_settings_deny_shell_writes_network_hooks_and_secret_files` |
| Information disclosure: the token reaches a comment, a log or an artifact (the repository is public) | Managed deny on reads of `/proc`, `/sys`, `/dev`, `/etc`, `/tmp`, `RUNNER_TEMP`, the action directory, `~/.claude`, `~/.config`, `~/.ssh` and `.git/config`. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`. The word `secrets` appears only in the token test, the quota step and the engine step. No artifact is uploaded. | contracts `secrets`, `engine-scrub`; mutations `second-secret`, `all-secrets` (`toJSON(secrets)`), `indexed-secret` and a leaked env |
| Tampering: an upstream action is changed | Every `uses:` is a full commit SHA with a version comment, and Dependabot (`github-actions`) updates both. The local quota action is main's copy. | contracts `unpinned`, `pin-comment`; mutation `@main` |
| Elevation: a token wider than needed | `permissions: {}` at the top. The job has `contents: read`, `pull-requests: write` (comments) and `actions: read` (the budget). No `id-token`: the session never holds the Claude App token, whose default request is `contents: write` (`src/github/token.ts`). | contracts `workflow-permissions`, `job-permissions`, `engine-inputs`; mutation `app-token` |
| Injection into `run:` | No `${{ }}` in any `run:`. Values pass through `env:`. actionlint and zizmor (pedantic) are clean. | contract `expression-in-run` |
| Execution of PR code during the review | Nothing in the job runs a file of the PR head. The model has no shell. | as for injection, plus `order` |
| Denial of service and cost: a retry loop on the subscription | At most 3 counted reviews per PR (`scripts/ci_security_review.py budget`, ADR-1119). A head already reviewed is not reviewed again (a `reopened` or `ready_for_review` event). A run counts only when its summary was published: `verify` fails the run otherwise, and the budget counts successful runs only. A round runs only when the subscription quota action reports headroom with usage credits off. Concurrency is one run per PR. `timeout-minutes: 30`. Later rounds review only the commits after the last reviewed one. | `BudgetTests`, `VerifyTests`, `JqFilterTests`, `test_the_review_runs_only_inside_the_budget_and_the_quota`, contracts `concurrency`, `timeout`, `verified` |
| Repudiation, forged verdicts, and false positives that block a merge | Advisory. The resolver (`_review_approves`) accepts a verdict only from a `claude[bot]` comment that links a `claude-review.yml` run. This review posts as `github-actions[bot]`, so an injected "Verdict: approve" in its summary is never read, and `verify` fails a summary that carries a verdict line anyway. The workflow name is outside every `workflow_run` list, and the required check is `merge` only. The action's header links the run. | contract `wakes-merge`, `test_the_merge_resolver_never_reads_this_workflow`, `test_its_comments_cannot_carry_a_verdict_the_resolver_accepts`, `VerifyTests.test_a_verdict_line_fails` |
| Missing secret, a first PR whose files are not on main yet, or an unreadable quota | The job ends green and says why in its summary (the quota step is `continue-on-error`, and its outcome is read). | `GuardScriptTests`, contract `quota-soft` |

Each contract is a named check over the parsed workflow. The mutation tests
remove each guard in turn, and the matching check must fail
(`SecurityReviewMutationTests`).

## Not proven before the first real run

- No review has run. On the pull request that adds the workflow, main does not
  have these files yet, so the job takes the "not installed on main yet" skip.
  The first real review is the first trusted PR after the merge.
- The managed-settings keys were checked against the strings of CLI 2.1.306.
  The action installs 2.1.328, and its enforcement has not been observed.
- That the diff written under `.git/claude-security-review/` survives the
  action's checkout of the PR head was read in the action's code, not observed.
- That the action creates and updates its tracking comment with a `GITHUB_TOKEN`
  limited to `pull-requests: write`, and that `verify` then finds it as
  `github-actions[bot]`. This was read in the action's code
  (`OVERRIDE_GITHUB_TOKEN`), not observed.
- The false-positive rate. It decides when the review may become blocking.

## Not handled here

- The fork approval policy of the repository is
  `first_time_contributors_new_to_github`. The upstream README recommends
  approval for all external contributors. That setting is the owner's to change.
  The job does not run fork code either way.
- In `claude-review.yml`, Claude can run `Bash(gh pr comment:*)`, and the
  restored base hook runs `scripts/gate/gate.mjs` from the PR head. The
  resolver binds a verdict to its author and a run link, not to the comment the
  review run wrote. These are a separate change.
