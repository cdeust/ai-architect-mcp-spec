# Claude security review

`.github/workflows/claude-security-review.yml` runs an advisory security review
of trusted pull requests on the owner's Claude subscription. It runs alongside
the code reviews of [the subscription review contract](review-subscriptions.md)
(Claude and Codex) and the Codex GitHub App's security summary. It posts one
comment and never approves, blocks or merges anything. It stays advisory until
its false-positive rate has been measured on this repository (decision of
2026-11-25).

## Trigger

Three workflows make the review.

1. **`claude-security-review-request.yml`** runs on `pull_request`. GitHub runs a
   pull request's own copy of this file, so it holds nothing worth taking. It has no
   permission, no secret, no checkout and no action: one step prints the head. A
   newer push cancels the request of the head it replaces (`cancel-in-progress`).
2. **`claude-security-review.yml`** runs on `workflow_run`, when a request run
   completes. GitHub runs this file as it is on `main`, never a pull request's copy, so no pull
   request can change what runs with the secret. It trusts nothing in the request run
   beyond what GitHub sets, and checks all of these:
   - the request run's event is `pull_request`;
   - its conclusion is `success`;
   - its path is the request file;
   - its head repository is this repository;
   - neither its actor nor its triggering actor is `dependabot[bot]`.

   Then it reads the pull request again from the API (`resolve`). Only an open pull
   request is admitted, one whose head is the request's head on the same branch and
   repository. It must not be a draft, must target `main` and must not be opened by
   Dependabot. A head that no admissible pull request has is a stated skip. The pull
   request is never checked out: the diff comes from the API.
3. **`claude-read-boundary.yml`** proves on every pull request what the engine can read
   (see "Proof of the read boundary"). It runs the pull request's code and holds no
   secret.

The secret is read only by the `security-review` job, which declares the environment
`review-subscriptions`. That environment admits `main` only. A `workflow_run` run's
ref is the default branch, so it passes that rule; a pull request's ref does not.
GitHub blocks `pull_request_target` by default in public repositories from
2026-12-02. That change names `pull_request_target` only, not `workflow_run`
([changelog](https://github.blog/changelog/2026-11-02-pull_request_target-blocked-by-default-december-2)),
so this review needs no exception to the new policy.

A `workflow_run` workflow runs only from the default branch. The engine therefore
cannot run on the pull request that adds it, nor on one that changes it. Before a
change merges, the proof job is the only runtime evidence for it.

## Design

The engine workflow has two jobs.

1. **`security-review`** has `contents: read`, `pull-requests: read` and `actions: read`.
   - It checks out `main` at the commit GitHub runs the workflow from, and runs the
     guards in this order:
     1. find the pull request;
     2. mark the job with its number;
     3. check the token;
     4. count the budget;
     5. write the diff and the prompt;
     6. decide.
   - The decision admits a round only while the budget has room, on a head not
     already reviewed, with a diff that holds changes.
   - It installs read-only managed settings and the pinned CLI, and runs the engine.
     The engine publishes nothing: it returns JSON (`--json-schema`), which becomes
     the job output `findings`.
2. **`publish`** has `contents: read` and `pull-requests: write`. It runs on a fresh
   checkout of `main` and holds no secret and no environment.
   - **Validation.** It checks that JSON against the schema in
     `scripts/ci_security_review_publish.py`, the one the engine also receives.
     - It checks the shape, the types, the paths, the categories, the line and
       confidence ranges, and a confidence of 8 or more.
     - A prose field must hold a visible character. A prose field longer than its
       bound is cut to it, not dropped.
     - A summary that is blank refuses the output, as the schema does.
   - **Paths.** A path must be relative, made of non-empty segments with no `.` or
     `..` segment and no whitespace at either end of a segment. It must not start
     with a drive letter or `~`, must not contain `://`, and must not hold a
     backslash, a backtick or a line break.
     - The comment shows the path in ASCII. Every character outside printable ASCII,
       and every one of `@ # & < > [ ]`, is written as a JSON escape.
     - A look-alike or an invisible character therefore cannot pass for `/` or `..`,
       and nothing in a path can act as a mention, a reference or a link.
   - **Credentials.** It withholds every finding whose path or prose holds the shape
     of a credential, and replaces such a summary with a fixed line.
     - The shapes are `sk-ant-`, `ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_` and
       `github_pat_`, the rule of architect-os's comment guard.
     - The match runs after normalisation and with every space removed, so neither a
       format character, a space nor a line break can split a key.
     - The comment counts the findings withheld.
   - **Prose.** It renders each prose field (summary, description, scenario,
     recommendation) as one inline code span on one line.
     - Markdown renders nothing inside a code span: no link, autolink, `GH-123` or
       URL reference, image, HTML or emphasis. A line break in the text cannot start
       a heading or a forged finding either.
     - Backticks are replaced. For any scanner that reads the raw body, mentions,
       `#<digit>` and a `Verdict:` at the start of a line are still broken.
     - A finding whose shape, types, path, category or ranges break the schema is
       dropped, and the drop is counted in the comment. An output whose shape breaks
       the schema is refused.
   - **Normalisation.** It normalises the text with NFKC first. It then removes
     control, format, non-spacing and enclosing marks, surrogate, private-use and
     unassigned characters. Spacing marks (Mc) are kept.
   - **Size.** It bounds each prose field after normalisation, because NFKC can turn
     one character into eighteen.
     - It keeps the comment under 60,000 characters by dropping whole findings, and
       says how many it dropped.
     - A cut never falls inside a line, so it cannot leave a code span open.
   - It posts one comment as `github-actions[bot]`.

## Engine

The engine is `anthropics/claude-code-action`, at the pin `claude-review.yml`
already uses.

- **Authentication.** It uses the existing `CLAUDE_CODE_OAUTH_TOKEN`, from the
  environment, and the workflow's own `GITHUB_TOKEN` (`github_token`) instead of the
  Claude App token.
- **Mode.** It runs in agent mode: it has a prompt and no `track_progress`
  (`src/modes/detector.ts`).
  - `workflow_run` is an automation event of the action (`src/github/context.ts`), so
    it is not an entity context. The action creates no tracking comment, installs no
    comment tool, never checks the pull request head out, and restores nothing
    from a base branch (`run.ts`, restore only for an entity pull request).
  - The working tree the model reads is therefore `main`.
  - On `workflow_run` the action checks the write access of the actor, of the
    request run's actor, and of a fork's owner (`run.ts`, `permissions.ts`).
- **CLI.** `path_to_claude_code_executable` points at the CLI that "Install the pinned
  Claude CLI" installs from `.github/claude/cli/package-lock.json` with `npm ci`, which
  checks every package's integrity. The action therefore does not run its own
  `curl https://claude.ai/install.sh | bash`.
  - With that input, and with `allowed_bots` set, the action adds no
    `--permission-mode auto` of its own (`src/modes/permission-mode.ts`). The CLI
    receives exactly the workflow's `claude_args`.
- **Prerequisite.** "Install subprocess isolation" installs bubblewrap for the CLI's
  subprocess sandbox, as in `claude-review.yml`. It is not a guard.
- **Settings.** `--setting-sources user` (`parse-sdk-options.ts`) keeps project and
  local settings out. The managed settings still apply, and the proof job checks both.
- **Bots.** `allowed_bots` lists `claude[bot]` and `chatgpt-codex-connector[bot]`,
  so their pushes are reviewed. With bots allowed, the action authenticates git
  through a helper rather than a token in the remote URL (`git-config.ts`).
- **Tools.** The engine selects and pre-approves `Read`. It scans the diff and
  applies the false-positive filter in the same session. On the pinned CLI the
  project reviewer was unavailable, and a built-in child received `Agent` in its
  own inventory. The production engine therefore has no delegation capability.
  [Linux trial on the parent](https://github.com/cdeust/ai-architect-mcp-spec/actions/runs/45772511415/job/139748259276)
  - The managed settings (`.github/claude/managed-settings.json`, one file for every
    Claude workflow of the repository) also deny, as defence in depth should the flag
    be lost:
    - the shells (Bash, PowerShell), Grep, Glob, LSP and the MCP resource tools;
    - the tools that need no permission, act outside the session or run work:
      RemoteTrigger, SendMessage, PushNotification, CronCreate, CronDelete,
      ScheduleWakeup, Skill, EnterWorktree, SendFeedback, SendUserFile,
      ShareOnboardingGuide, Artifact, Workflow and Monitor;
    - the legacy names Projects and MultiEdit (denying a name that is not a tool only
      prints a startup warning).
  - They also turn off the auto and bypass modes, disable every hook, and set
    `blockReadsOutsideWorkingDirectories`.
  - The Claude Code docs apply `Read` deny rules to Grep and Glob only for the folder
    a search starts from, which is why both are removed rather than bounded.
- **Prompt.** It adapts the audit prompt and the false-positive filtering of
  [`anthropics/claude-code-security-review`](https://github.com/anthropics/claude-code-security-review)
  at `0c6a49f1fa56a1d472575da86a94dbc1edb78eda` (MIT).
  - The adapted text is versioned in `.github/claude-security-review/scan-instructions.txt`
    and `false-positive-filtering.txt`, with this repository's categories and known
    false positives added.
  - Both files are pinned by digest in the tests, so a change to a threshold is a
    deliberate one.

The diff is `compare/<base>...<head>` of the pull request's base and of the request's
head (`application/vnd.github.diff`). These are the changes the PR introduces from
their merge base, at the head this run labels, never at a later push.

- **Decoding.** The diff is decoded leniently: a byte that is not UTF-8 (a Latin-1
  file) becomes U+FFFD and does not stop the review.
- **Fallback.** When the full diff cannot be read, the per-file patches of the same
  compare replace it. This covers a diff that is too large and any gh failure; the
  log names the reason. A note then says that the compare API lists at most 300 files
  and that a file without a patch is not reviewed.
  - The fallback reads the patches as JSON records. Only a non-empty `patch` field
    counts as readable.
  - Each file name is written as one quoted string, so a name holding a newline can
    neither fake a hunk nor forge diff lines.
  - Records are split on `\n` only, because gh writes U+0085 raw inside a value.
  - When no file has a readable patch, the round stops.
- **Scope.** The three-dot compare can include more than the PR when its base was
  rewritten after the head merged it. It never includes less.
- **Unreadable.** When neither can be read, the round stops before the engine and
  spends nothing. A clean comment never stands for a review of nothing.
- **Empty.** An empty diff is a stated skip, and the engine does not run.
- **Cut.** The diff is cut at 1,000,000 bytes. The cut note names the files whose
  diff starts after the cut (up to 200, then a count), so the summary can say which
  files were not read.

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

To replace the engine, change only the `Claude security review` step, its
prerequisites and the schema. Every other step above it is a guard and stays, and
so does the publish job. The budget counts the step and its job by name.

## Guards

| Threat (STRIDE) | Guard | Test (`scripts/tests/test_ci_review_security.py` unless named) |
| --- | --- | --- |
| Spoofing and tampering: a pull request changes what runs with the subscription token | The secret-bearing workflow runs on `workflow_run`, from `main`; the pull request's copy of it never runs. The secret comes from the environment `review-subscriptions` (main only), on that job alone. The request file holds no permission, secret, action or checkout. | contracts `trigger`, `environment`, `request-origin`; `request_violations`; mutations back to `pull_request`, `pull_request_target`, an added `push`, another `workflow_run` source, the environment removed or renamed, an environment on `publish`, a secret, an action or permissions in the request; `test_ci_review_secret_scope.py` |
| Spoofing: fork, Dependabot or an unrelated run reaches the token | The job `if` checks the request run's event, conclusion, path, head repository, actor and triggering actor. `resolve` reads the pull request from the API: open, same head, branch and repository, not a draft, base `main`, author not Dependabot. The action checks the write access of the actors and of a fork's owner. | contracts `request-origin`, `resolve`; mutations `fork-allowed`, `other-path`, `failed-request`, `dependabot-actor`; `ResolveTests` |
| Tampering: the PR's `.claude/`, `CLAUDE.md`, hooks or scripts run in the review | Both jobs check out `main` at `github.sha` with `persist-credentials: false`, and every script and instruction file comes from it. No action other than checkout and the engine runs. The PR head is never checked out. Root-owned, read-only managed settings disable all hooks. No step runs after the engine in its job. The whole parsed workflow and both instruction files are pinned by digest. | `test_the_workflow_is_exactly_the_reviewed_one`, `test_the_instructions_are_exactly_the_reviewed_ones`; contracts `checkout-main`, `actions`, `managed-settings`, `order`, `engine-inputs`; mutations `head-checkout-added`, `persisted-credentials`, `publish-on-head`, `settings-writable`, `settings-from-elsewhere`, `step-after-engine`; proof job (hook canary) |
| Tampering and elevation: prompt injection through the diff or the files it adds (the upstream README says the action is "not hardened against prompt injection") | The model publishes nothing: it has no comment tool. `--tools "Read"`, `--permission-mode dontAsk` given once, `--strict-mcp-config`. The managed settings deny shells, search, edit, write, web and the outbound tools, and turn off the auto and bypass modes. The CLI tool inventory excludes delegation. The prompt marks the PR as untrusted data. | contracts `engine-tools`, `engine-inputs`; mutations `all-tools`, `bash-allowed`, `comment-tool`, auto, `bypass-mode`, `second-mode`, `no-strict-mcp`, `no-schema`, `user-settings-only`, `commit-signing`, `settings-input`; `test_managed_settings_are_exactly_the_documented_guards`; proof job |
| Elevation through another bot: an injected `@codex review`, a cross-reference or a `Verdict:` line in the comment | `publish` first normalises the text with NFKC, which turns `＠` and `﹫` into `@`, and makes every line ending a newline. It removes control, format, non-spacing and enclosing marks. It puts a zero-width space after every `@` and every `#` before a digit, replaces backticks, and breaks a `Verdict:` at the start of a line, whatever its case. Each prose field becomes one code span on one line. Paths are shown as ASCII escapes. The resolver (`_claude_verdicts`) reads verdicts of `claude[bot]` only; this comment is `github-actions[bot]`'s. | `PublishTests`; `test_its_comment_cannot_carry_a_verdict_the_resolver_accepts` |
| Information disclosure: the token or the GitHub token reaches a comment, a log or an artifact (the repository is public) | Both tokens are in the CLI process's own environment (`run.ts` sets `GITHUB_TOKEN`; `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` cleans only subprocesses), so what bounds them is what the model can read; whatever the command line holds is under `/proc` too. The settings refuse `/proc`, `/sys`, `/dev`, `/etc`, `/tmp`, `/var`, `/opt`, `/run`, `/root`, `/srv`, `/mnt`, `/boot`, `/snap`, every runner folder `~/work/_*`, the runner install directories, every dotfile and dot folder of the home, and every `.git/` directory, and block reads outside the workspace. `publish` withholds any credential shape. `publish` holds no secret, and no artifact is uploaded. | contracts `secrets`, `engine-scrub`; mutations `second-secret`, `all-secrets`, `indexed-secret`, `secret-in-publish`; the exact deny list; `test_a_finding_holding_a_credential_shape_is_withheld_whole`; proof job |
| Tampering: an upstream action or the CLI is changed | Every `uses:` is pinned to a full commit SHA with a version comment. The CLI comes from main's lockfile (`npm ci`, integrity-checked) and is checked to be 2.1.328; the action's install script does not run. | contracts `unpinned`, `pin-comment`, `actions`; mutations `@main`, `unpinned-cli`; `test_the_cli_lockfile_pins_the_version_the_engine_checks` |
| Elevation: a token wider than needed | `permissions: {}` at the top. The review job is read-only. Only `publish` has `pull-requests: write`, and it holds no secret. There is no `id-token`, so the session never holds the Claude App token, whose default request includes `contents: write` (`src/github/token.ts`). | contracts `workflow-permissions`, `job-permissions`, `published`, `engine-inputs`; mutations `app-token`, `publish-wide` |
| Injection into `run:` | No `run:` contains `${{ }}`: values pass through `env:`, including the model's JSON, which reaches `publish` as an environment variable. The marker step's name carries the number `resolve` validated, never event text. | contract `expression-in-run` |
| Denial of service and cost: a retry loop on the subscription | A PR gets at most 3 attempts (`budget`, ADR-1119), counted as follows. | `BudgetTests`, `JqFilterTests`, `GuardScriptTests`; contracts `concurrency`, `timeout`, `gated`; mutations `budget-ungated`, `prompt-ungated`, `decide-ungated`, `marker-ungated`, `marker-renamed` |
| Repudiation, and false positives that block a merge | The review is advisory. The only required check is `merge`. The engine workflow's name is outside every other `workflow_run` list, and the request's name is in this one's only. The comment names the head and links the run attempt. | contract `wakes-merge`, `test_the_merge_resolver_never_reads_this_workflow`, `PublishTests` |
| A missing secret, an inadmissible pull request or an empty diff | The job ends green and states the reason in its summary. No step continues on error. | `GuardScriptTests`, `ResolveTests`; contract `continue-on-error` |
| Malformed or oversized model output | The engine receives the schema with its bounds: patterns, ranges, `maxItems` and `maxLength`. `publish` drops and counts a finding that breaks it, cuts prose to its bound, and refuses an output whose shape breaks it; the attempt still counts. If the engine enforces the bounds, the worst-case JSON stays under the 128 KiB of one environment string (`execve(2)`). If it does not, `publish` fails at start, which is closed: no comment, and the attempt counts. The comment stays under 60,000 characters. | `test_invalid_findings_are_dropped_and_counted_not_fatal`, `test_output_whose_shape_breaks_the_schema_is_refused`, the size tests, `test_the_schema_given_to_the_engine_carries_the_bounds_publish_enforces`; mutations `publish-raw-findings`, `output-dropped` |

How the budget counts:

- **Attempts.** An attempt is any job attempt whose engine step ran, whatever it
  concluded: success, failure, cancellation and time-out all count.
- **Re-runs.** Every attempt of every run is read with `filter=all`, finished or not,
  and so are this run's earlier attempts. A re-run therefore cannot loop.
- **Which pull request.** A run belongs to the pull request by its title (head
  branch and head) and by the job's marker step, which names the number `resolve`
  found.
- **Refusals.** The job fails rather than undercount when a page counts more runs
  than it lists, or 1,000 are listed (the API's limit with an event filter). A row
  repeated by pagination counts once.
- **Publish re-runs.** A `publish` re-run alone counts for the latest engine attempt
  before it.
- **Heads.** A head already attempted is never attempted again. A later round starts
  from the last published review. A superseded head is cancelled at the request, or
  refused by `resolve`, and spends nothing.
- **Limits.** Concurrency allows one run per head branch, and `timeout-minutes` is 30.

The subscription quota is no longer read before a round. The quota action read no
window under the OAuth sign-in (run 45748962072: `oauth_sign_in_exposes_no_usage_limits`),
and PR 406 removes it. The cap of three attempts per pull request is the cost bound, as for
`claude-review.yml` after PR 406.

Each contract is a named check over the parsed workflow. The mutation tests
remove each workflow guard in turn and require the matching check to fail
(`SecurityReviewMutationTests`). The managed settings are pinned by
`test_managed_settings_are_exactly_the_documented_guards`: exact keys and values,
and the deny list as a set with no duplicates.

## Proof of the read boundary

`claude-read-boundary.yml` runs `scripts/ci_claude_read_trial.py` on `ubuntu-latest` on
every pull request and every push to `main`.

- **Setup.** The script installs nothing of its own. It reads the engine's step from
  the workflow, installs the managed settings by running the workflow's own install
  step (root-owned, 0444, `/etc/claude-code`), and runs the CLI of
  `.github/claude/cli` against a fake model served on localhost. No real model is
  called and no secret exists in that job.
- **The fake model.** It asks for one tool call per turn:
  - `Read` of a file outside the checkout, through `..`, through a link, of
    `.git/config`;
  - `/proc/self/environ` directly, through `../../…`, through `/./`, through a link,
    then `/proc/self/cmdline`, the parent's `environ`, `/proc/self/root`,
    `/proc/self/cwd/..`;
  - `~/.env`, `~/.git-credentials`, `/run`, `/root`, `/tmp` and `RUNNER_TEMP`;
  - `Grep` and `Glob` outside the checkout, `Bash`, `WebFetch`;
- **Canaries.** Every target holds a random canary, and the CLI's environment holds
  it too. A planted `.claude/settings.local.json` hook writes a canary file when it
  runs.
- **Two arms.**
  - The control arm runs without the managed settings and with wide arguments. The
    outside file, `..`, the link, `.git/config`, `Grep`, `Glob` and `Bash` must leak
    there with a successful result containing the expected content for that target.
    The hook must run.
  - The engine arm runs under the managed settings with the engine's exact
    `claude_args`. It fails on any leak, a hook that ran, an unanswered call, a
    missing Read capability or a tool outside the engine allowlist. The CLI may
    advertise its structured response tool and deferred-tool placeholder. An offer
    of Agent fails the trial even if no call used it.

Both arms must read the versioned review instructions in the workspace and return
a line specific to the scan instructions. The recorder matches each result in the
transcript to a call already issued in that arm, including a returned structured
output. Identical history can be retransmitted. An extra or conflicting result
fails the trial. Full results are graded in memory. The job summary contains the boolean observations for
each probe and the tool inventories.

## Where the token may go

`scripts/tests/test_ci_review_secret_scope.py` holds two rules for every workflow of
the repository:

- A job that names `CLAUDE_CODE_OAUTH_TOKEN` must meet two conditions:
  - it declares `review-subscriptions`, a name held in that test alone;
  - no event that runs a pull request's copy of the workflow triggers it
    (`pull_request`, `push` to a branch other than `main`, `workflow_dispatch`, and
    so on).
- A job that runs Claude must meet two conditions:
  - it installs `.github/claude/managed-settings.json` with the exact step above;
  - no Claude run chooses the auto, bypass or accept-edits mode.

The jobs that predate these rules are listed with what closes them:

- `claude-review.yml` (on `pull_request`, auto mode, no managed settings) and
  `claude.yml` (no environment, no managed settings) are closed by the
  `claude-review.yml` PR that follows this one.
- `review-subscription.yml` is deleted by PR 406.

The list may only shrink: a new break, or a listed one that no longer breaks, fails
the test.

What stays exposed until the owner acts, in this order:

1. Define `CLAUDE_CODE_OAUTH_TOKEN` in the environment `review-subscriptions`.
   Until then, the review's job reads the repository secret. This page does not rely
   on what a job reads when the environment lacks the secret.
2. Delete the repository secret `CLAUDE_CODE_OAUTH_TOKEN` once every reader declares
   the environment on `main`. Until then, any pull request of this repository can add
   a `pull_request` workflow that reads it; the contract test catches such a workflow
   only once it is on `main`. Deleting the repository secret closes that.

## Not proven before the first real run

- **No real review has run.** The engine runs only from `main`, so the first real
  review will be on the first trusted PR after the merge.
- **What the proof job covers.** It shows on the pinned CLI, under Linux, what the
  engine can read with the managed settings against a fake
  model. It does not show what a real model does with that boundary.
  - It does not run the action's own TypeScript, which builds the session through the
    SDK.
  - It does not cover the runner files that only exist with a secret (none is
    present in that job).
- **Read in the action's code but not observed:**
  - that agent mode leaves the main checkout and `.claude-security-review/` in place;
  - that `--json-schema` yields `structured_output` (`run-claude-sdk.ts`);
  - that the actor check works with a `pull-requests: read` workflow token on
    `workflow_run`.
- **The false-positive rate is not measured.** It decides when the review may become
  blocking.

## Not handled here

- **Cost, beyond the per-PR cap.** Concurrency is per head branch, so several PRs
  pushed at once run their engines at the same time. A run has no turn bound other
  than its 30-minute timeout. A shared concurrency
  group or a turn bound each needs an owner decision on the value.
- **Debug logging.** Re-running the job with debug logging on (`ACTIONS_STEP_DEBUG`)
  makes the action print every message and tool result (`parse-sdk-options.ts`
  forces `showFullOutput`). It cannot be turned off by an input. A re-run needs
  write access, and what a tool result can hold is bounded by the read boundary
  above.
- **The action's own install.** `action.yml` runs `bun install --production` for its
  own code. The SHA pin fixes that code, not the resolution of its dependencies.
  - The isolation step installs `bubblewrap` and `socat` from the runner's package
    archive, unpinned.
  - The engine is offered no shell, so neither is reachable from the model.
- **Deleted runs and branch names.**
  - Deleting earlier workflow runs (write access), or runs passing the retention
    period, removes them from the count, so a long-lived or cleaned PR gets rounds
    back.
  - Runs are matched by head branch and marker, so a branch renamed while its PR is
    open (write access) starts a new count.
- **A count refusal makes the job red**, even for a head already reviewed: it is
  checked before the head is.
- **Fork approval.** The repository's fork approval policy is
  `first_time_contributors_new_to_github`. The upstream README recommends approval for
  all external contributors. Changing that setting is the owner's call. The job does
  not run fork code either way.
- **Other GitHub Apps.** A push by an App other than `claude[bot]` and
  `chatgpt-codex-connector[bot]` passes the job condition and then fails the action's
  actor check, so the job ends red. The check is not required, and such a run counts
  as an attempt.
- **Inline comments.** Each finding gives its `file:line` in the one comment instead.
- **Rendering.** The model's text is shown inside code spans, normalised and
  neutralised as above, URLs included. It is not rendered, so nothing in it links,
  references or mentions.
- **Encoded or split keys.** A key the model encodes (base64, reversed, split across
  findings) does not match a credential shape. What prevents it is the read boundary:
  the model cannot read the key in the first place.
