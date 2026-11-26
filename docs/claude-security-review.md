# Claude security review

`.github/workflows/claude-security-review.yml` runs an advisory security review
of trusted pull requests on the owner's Claude subscription. It runs alongside
the code reviews of [the subscription review contract](review-subscriptions.md)
(Claude and Codex) and the Codex GitHub App's security summary. It posts one
comment and never approves, blocks or merges anything. It stays advisory until
its false-positive rate has been measured on this repository (decision of
2026-11-25).

## Design

The workflow has two jobs.

1. **`security-review`** has `contents: read`, `pull-requests: read` and `actions: read`.
   - It checks out `main` and runs the guards. The token and the files must be
     present on main. The event's head must still be the PR's head. The definition
     that runs (the PR's, at its merge commit) must still carry the job names and the
     step names the budget counts attempts by, each at its job or step place in the
     file. A PR that renames one of them, or quotes or comments it, gets no security
     review, and the summary says so. The budget must have room, and the
     subscription must have quota.
   - It installs read-only managed settings and writes the pull request diff to
     `.claude-security-review/` in the workspace.
   - It then runs the engine. The engine publishes nothing: it returns JSON
     (`--json-schema`), which becomes the job output `findings`.
2. **`publish`** has `contents: read` and `pull-requests: write`. It runs on a fresh
   checkout of `main` and holds no secret.
   - It checks that JSON against the schema in
     `scripts/ci_security_review_publish.py`, the one the engine also receives. It
     checks the shape, the types, the paths, the categories, the line and confidence
     ranges, and a confidence of 8 or more. A prose field longer than its bound is
     cut to it, not dropped. A path must be relative, made of non-empty segments with no `.` or
     `..` segment and no whitespace at either end of a segment. It must not start
     with a drive letter or `~`, must not contain `://`, and must not hold a
     backslash, a backtick or a line break. The comment shows the path in ASCII.
     Every character outside printable ASCII, and every one of `@ # & < > [ ]`, is
     written as a JSON escape. A look-alike or an invisible character therefore
     cannot pass for `/` or `..`, and nothing in a path can act as a mention, a
     reference or a link.
   - It renders each prose field (summary, description, scenario, recommendation)
     as one inline code span on one line. Markdown renders nothing inside a code
     span: no link, autolink, `GH-123` or URL reference, image, HTML or emphasis.
     A line break in the text cannot start a heading or a forged finding either.
     Backticks are replaced. For any scanner that reads the raw body, mentions,
     `#<digit>` and a `Verdict:` at the start of a line are still broken. A finding
     whose shape, types, path, category or ranges break the schema is dropped, and
     the drop is counted in the comment. An output whose shape breaks the schema is
     refused.
   - It normalises the text: NFKC first. It then removes control, format,
     non-spacing and enclosing marks, surrogate, private-use and unassigned
     characters. Spacing marks (Mc) are kept.
   - It bounds each prose field after normalisation, because NFKC can turn one
     character into eighteen. It keeps the comment under 60,000 characters by
     dropping whole findings, and says how many it dropped. A cut never falls
     inside a line, so it cannot leave a code span open.
   - It posts one comment as `github-actions[bot]`.

## Engine

The engine is `anthropics/claude-code-action`, at the pin `claude-review.yml`
already uses.

- **Authentication.** It uses the existing `CLAUDE_CODE_OAUTH_TOKEN`, and the
  workflow's own `GITHUB_TOKEN` (`github_token`) instead of the Claude App token.
- **Mode.** It runs in agent mode: it has a prompt and no `track_progress`.
  - Agent mode creates no tracking comment, installs no comment tool, and never
    checks the pull request head out (`src/modes/agent/index.ts` has no
    `setupBranch`). The working tree the model reads is therefore `main`.
  - The action restores its `SENSITIVE_PATHS` (`restore-config.ts`: `.claude`,
    `CLAUDE.md`, `AGENTS.md`, `.mcp.json` and others) from the pull request's base
    branch. That branch is `main` unless the PR is stacked on another one.
- **Prerequisites.** Two steps exist for this engine and are not guards:
  - "Authorize pinned action fetch" runs in a private repository only. It lets the
    action fetch the base branch.
  - "Install subprocess isolation" installs bubblewrap for the CLI's subprocess
    sandbox. Both are taken from `claude-review.yml`.
- **Settings.** `--setting-sources user` (`parse-sdk-options.ts`) keeps project and
  local settings out, whichever branch they were restored from. The managed
  settings still apply.
- **Bots.** `allowed_bots` lists `claude[bot]` and `chatgpt-codex-connector[bot]`,
  so their pushes are reviewed. With bots allowed, the action authenticates git
  through a helper, so `.git/config` holds no token (`git-config.ts`).
- **Tools.** Read, Glob, Grep, LS and Task are allowed, and Bash is denied outright.
- **Prompt.** It adapts the audit prompt and the false-positive filtering of
  [`anthropics/claude-code-security-review`](https://github.com/anthropics/claude-code-security-review)
  at `0c6a49f1fa56a1d472575da86a94dbc1edb78eda` (MIT). The adapted text is
  versioned in `.github/claude-security-review/scan-instructions.txt` and
  `false-positive-filtering.txt`, with this repository's categories and known
  false positives added.

The diff is `compare/<base>...<head>` of the event's own base and head SHAs
(`application/vnd.github.diff`). These are the changes the PR introduces from
their merge base, at the head this run labels, never at a later push.

- When the full diff cannot be read, the per-file patches of the same compare
  replace it. This covers a diff that is too large and any gh failure; the log
  names the reason. A note then says that the compare API lists at most 300 files and
  that a file without a patch is not reviewed.
- The fallback reads the patches as JSON records. Only a non-empty `patch` field
  counts as readable, and each file name is written as one quoted string, so a
  name holding a newline can neither fake a hunk nor forge diff lines. Records are
  split on `\n` only, because gh writes U+0085 raw inside a value. When no file
  has a readable patch, the round stops.
- The three-dot compare can include more than the PR when its base was rewritten
  after the head merged it. It never includes less.
- When neither can be read, the round stops before the engine and spends nothing.
  A clean comment never stands for a review of nothing.
- It is cut at 1,000,000 bytes, and the cut file says so.

A later round also gets the diff since the last published review
(`compare/<reviewed>...<head>`). The prompt says that merges from main appear
there, and that only what the PR diff also contains is reviewed. When that diff
cannot be read, the round reviews the whole diff.

### Why `claude-code-security-review` is not the engine

Read in its code at `0c6a49f1`, on 2026-11-25:

- **It needs an API key.**
  - `action.yml` reads only `claude-api-key`, passes it on as `ANTHROPIC_API_KEY`,
    and the scan step exits 1 when it is empty.
  - `validate_claude_available` rejects an empty key. Nothing reads
    `CLAUDE_CODE_OAUTH_TOKEN`.
  - In the Claude Code CLI 2.1.306 binary, the non-interactive credential lookup
    (`mT()`) takes `ANTHROPIC_API_KEY` first and sends it as `X-Api-Key` (`Rjt()`).
    A subscription token passed in that input would therefore be sent as an API key.
  - The owner wants every review on the subscription.
- **Its defaults name retired models.**
  - The scan defaults to `claude-opus-4-1-20250805` (`claudecode/constants.py`).
  - The filter's access probe calls the hard-coded `claude-3-5-haiku-20241022`
    (`validate_api_access`). When that probe fails, `findings_filter.py` silently
    falls back to the fixed rules.
- **It installs dependencies it does not pin.** It runs `npm install -g
  @anthropic-ai/claude-code` (the latest version) and `pip install` with `>=`
  ranges. It installs Node 18, while the CLI declares Node 22 or later.
- **It publishes the model's output as is.** It posts the findings straight from
  the model's output, so nothing neutralises a mention before it is posted.
- **Upstream gives no version to pin.** It has no tag and no release, and
  Dependabot does not update a SHA pin when upstream has no tag (`dependabot-core`
  `update_checker.rb`: `return unless latest_tag`).

It could become the engine if all of these held:

- the owner accepts API billing, through a new `ANTHROPIC_API_KEY` secret;
- upstream pins its runtime installs and its model defaults;
- its output goes through the same validate-and-publish job;
- upstream publishes a tag Dependabot can follow, or a vendored copy runs under
  the same guards.

To replace the engine, change only the `Claude security review` step, its two
prerequisites and the schema. Every other step above it is a guard and stays, and
so does the publish job. The budget counts the step and its job by name: a PR that
renames either gets no review, and after such a rename merges, earlier attempts recorded
under the old name are no longer counted for open PRs.

## Guards

| Threat (STRIDE) | Guard | Test (`scripts/tests/test_ci_review_security.py`) |
| --- | --- | --- |
| Spoofing: fork or Dependabot code gets the subscription token | Only `pull_request` triggers it, never `pull_request_target`. The job `if` is the trust rule of `claude-review.yml` (a head in this repository, not a draft, the actor is not `dependabot[bot]`), plus: the author is not `dependabot[bot]`. | contracts `trigger`, `trusted-authors`; mutations `fork-allowed`, `dependabot-author` and a `pull_request_target` trigger |
| Tampering: the PR's `.claude/`, `CLAUDE.md`, hooks or scripts run in the review | Both jobs check out `main` with `persist-credentials: false`, and every script and instruction file comes from it. In agent mode the PR head is never checked out, and the action restores its sensitive paths from the base anyway (`restore-config.ts`). Root-owned, read-only managed settings disable all hooks. No step runs after the engine in its job. The whole parsed workflow is pinned by a digest in the tests, so changing an extra step, an env mapping or a run script needs a deliberate edit of that digest in the same PR. It does not stop a trusted author: a `pull_request` run follows the PR's own workflow, as for `claude-review.yml`. | `test_the_workflow_is_exactly_the_reviewed_one`; contracts `checkout-main`, `managed-settings` (the exact install script), `order`, `engine-inputs`; mutations `head-checkout-added`, `publish-on-head`, `settings-writable`, `step-after-engine`, `track_progress`, and removing the install step |
| Tampering and elevation: prompt injection through the diff or the files it adds (the upstream README says the action is "not hardened against prompt injection") | The model publishes nothing: it has no comment tool. It has no shell either (managed deny on `Bash`). `--permission-mode dontAsk` is given once, and `--strict-mcp-config` is set. It has no edit, write or web tool, and the `github_ci` and `github_file_ops` servers are denied. The engine's inputs and arguments are an exact set. The prompt marks the PR as untrusted data. | contracts `engine-tools`, `engine-inputs`; mutations `bash-allowed`, `comment-tool`, `--permission-mode auto`, `second-mode`, `no-strict-mcp`, `no-schema`, `commit-signing`, `settings-input`; `test_managed_settings_are_exactly_the_documented_guards` |
| Elevation through another bot: an injected `@codex review`, a cross-reference or a `Verdict:` line in the comment | `publish` first normalises the text with NFKC, which turns `＠` and `﹫` into `@`. It then turns every line ending into a newline and removes control, format, non-spacing and enclosing marks. It then puts a zero-width space after every `@` and every `#` before a digit, replaces backticks, and turns a `Verdict:` at the start of a line into `Verdict​:`, whatever its case. Each prose field then becomes one code span on one line, which renders no link, reference, mention or HTML. Paths are shown as ASCII escapes. In this repository, `@codex review` posted by `github-actions[bot]` is the Codex request channel. The resolver (`_claude_verdicts`) reads verdicts of `claude[bot]` only. | `PublishTests`: hostile text with lookalikes, joiners and combining marks, and the resolver's own `_claude_verdicts` reading a published comment as if `claude[bot]` had written it. Also `test_its_comment_cannot_carry_a_verdict_the_resolver_accepts`. |
| Information disclosure: the token reaches a comment, a log or an artifact (the repository is public) | Managed settings deny reads of `/proc`, `/sys`, `/dev`, `/etc`, `/tmp`, `/var`, `/opt`, the runner install directories, `RUNNER_TEMP`, the action directory, `~/.claude`, `~/.claude.json`, `~/.config`, `~/.local`, `~/.ssh`, `~/.docker`, `~/.npmrc`, `~/.gitconfig` and every `.git/` directory. This is a deny list over the action's bare `Read` allow. Whether the CLI resolves links before it matches these rules has not been observed. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` is set. `publish` holds no secret, and no artifact is uploaded. | contracts `secrets`, `engine-scrub`; mutations `second-secret`, `all-secrets` (`toJSON(secrets)`), `indexed-secret`, `secret-in-publish`; the exact deny list; `test_the_input_folder_is_outside_git_which_the_engine_may_not_read` |
| Tampering: an upstream action is changed | Every `uses:` is pinned to a full commit SHA with a version comment, and Dependabot (`github-actions`) updates both. The local quota action is main's copy. | contracts `unpinned`, `pin-comment`; mutation `@main` |
| Elevation: a token wider than needed | `permissions: {}` at the top. The review job is read-only. Only `publish` has `pull-requests: write`, and it holds no secret. There is no `id-token`, so the session never holds the Claude App token, whose default request includes `contents: write` (`src/github/token.ts`). | contracts `workflow-permissions`, `job-permissions`, `published`, `engine-inputs`; mutations `app-token`, `publish-wide` |
| Injection into `run:` | No `run:` contains `${{ }}`: values pass through `env:`, including the model's JSON, which reaches `publish` as an environment variable. actionlint and zizmor (pedantic) report nothing. | contract `expression-in-run` |
| Denial of service and cost: a retry loop on the subscription | A PR gets at most 3 attempts (`budget`, ADR-1119). An attempt is any job attempt whose engine step ran, whatever it concluded, re-runs included: every attempt of every finished run is read with `filter=all`, and so are this run's earlier attempts. The scan stops once the cap is reached. When the API counts more runs of the branch than it lists (its 1,000-result limit), the job fails rather than undercount; whether `total_count` itself is capped at 1,000 has not been observed. A row repeated by pagination counts once. A `publish` re-run alone counts for the engine attempt before it. A failing review or a re-run therefore cannot loop. A head already attempted is never attempted again, whether after a reopen, a `ready_for_review`, a re-run or a push back to an earlier head. A later round starts from the last published review, never from an attempt that published nothing. A re-run of an old run whose head is no longer the PR's head spends no round, and nothing is counted for it. A round runs only when the subscription quota action reports headroom (more than 0%) with usage credits off. Concurrency allows one run per PR, and `timeout-minutes` is 30. | `BudgetTests` (including stale heads, renamed counted names, the 1,000-run refusal, repeated rows and the early stop), `JqFilterTests`, `GuardScriptTests`; contracts `concurrency`, `timeout`, `gated`; mutations `budget-ungated`, `quota-ungated`, `decide-ungated` |
| Repudiation, and false positives that block a merge | The review is advisory. The only required check is `merge`, and the workflow name is outside every `workflow_run` list. The comment names the head and links the run attempt. | contract `wakes-merge`, `test_the_merge_resolver_never_reads_this_workflow`, `PublishTests` |
| A missing secret, a first PR whose files are not on main yet, or an unreadable quota | The job ends green and states the reason in its summary. The quota step is the only `continue-on-error` step, and its outcome is read. | `GuardScriptTests`; contracts `quota-soft`, `continue-on-error` |
| Malformed or oversized model output | The engine receives the schema with its bounds: patterns, ranges, `maxItems` and `maxLength`. `publish` drops and counts a finding whose shape, types, path, category or ranges break it, cuts prose to its bound, and refuses an output whose shape breaks it; the attempt still counts. If the engine enforces the bounds, the worst-case JSON stays under the 128 KiB of one environment string (`execve(2)`) and the job output under 1 MB. If it does not, an oversized output makes `publish` fail at start, which is closed: no comment, and the attempt counts. The comment stays under 60,000 characters, under GitHub's 65,536: whole findings are dropped, the drop is stated, and the run link is kept. | `test_invalid_findings_are_dropped_and_counted_not_fatal`, `test_output_whose_shape_breaks_the_schema_is_refused`, the two worst-case size tests, `test_the_schema_given_to_the_engine_carries_the_bounds_publish_enforces`; mutations `publish-raw-findings`, `output-dropped` |

Each contract is a named check over the parsed workflow. The mutation tests
remove each guard in turn and require the matching check to fail
(`SecurityReviewMutationTests`).

## Not proven before the first real run

- No review has run yet. On the pull request that adds the workflow, main does not
  have these files, so the job takes the "not installed on main yet" skip. The
  first real review will be on the first trusted PR after the merge.
- The managed-settings keys were checked against the strings of CLI 2.1.306. The
  action installs 2.1.328, and no one has observed it enforce them, link
  resolution included.
- The following was read in the action's code but not observed:
  - that agent mode leaves the main checkout and `.claude-security-review/` in place;
  - that `--json-schema` yields `structured_output` (`run-claude-sdk.ts`);
  - that the actor check works with a `pull-requests: read` workflow token.
- No attack test has run against the live engine: no canary has asked it to read
  `/proc/self/environ`, run Bash, or call a tool outside its list and checked that
  each attempt is refused. That test needs a paid model turn on a runner, and it
  belongs to the first real run.
- The false-positive rate is not measured. It decides when the review may become
  blocking.

## Not handled here

- Cost, beyond the per-PR cap: concurrency is per PR, so several PRs pushed at
  once run their engines at the same time, from quota readings taken before any
  of them started. A run is admitted with any headroom above 0%. A run has no turn
  bound other than its 30-minute timeout, and Task sub-agents run within it. A
  shared concurrency group, a quota reserve or a turn bound each needs an owner
  decision on the value.
- Renaming a PR's head branch: the runs API filters on the branch name, so the
  earlier runs of a renamed branch are not counted. That needs write access.

- The repository's fork approval policy is `first_time_contributors_new_to_github`.
  The upstream README recommends approval for all external contributors. Changing
  that setting is the owner's call. The job does not run fork code either way.
- A push by a GitHub App other than `claude[bot]` and
  `chatgpt-codex-connector[bot]` passes the job condition and then fails the
  action's actor check, so the job ends red. The check is not required, and such a
  run counts as an attempt. A condition that admits an actor by name would be
  spoofable (zizmor `bot-conditions`), so none is used (the condition that excludes
  `dependabot[bot]` stays).
- Inline comments: each finding gives its `file:line` in the one comment instead.
- The model's text is shown inside code spans, normalised and neutralised as above,
  URLs included. It is not rendered, so nothing in it links, references or mentions.
- That managed settings still load under `--setting-sources user` was read in the
  SDK code and documentation. It has not been observed.
