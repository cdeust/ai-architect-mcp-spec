# Review and merge

Owner decision of 2026-11-25: "pas de check du quota et tous les bots deviennent
optionnels et le merge un approve du user". No workflow measures a review
subscription. The review bots give advice. The merge rests on the owner's approval
of the current head.

## Why the quota routing was removed

From 2026-11-22 to this change, a default-branch workflow measured the Claude
subscription from the `/usage` screen of the pinned Claude Code CLI before each
review. Every receipt of that period read `usage_credits: unknown` and no
current-session window, and the billing guard required both. Claude was never
admitted, so every review of the repository in that period was done by Codex
alone. When the Codex review quota ran out (PR #400, run 45694105520), no review
could be admitted, and green pull requests stopped merging.

## Review bots are optional

- **Claude.** `PR Review` runs the Claude Code action on same-repository pull
  requests that are ready for review, within the three-review budget, which is a
  cost cap. The action step continues on error. The job summary says whether the
  review ran, did not complete (quota, outage, error) or did not run. The verdict
  line is advice to the owner.
- **Codex.** The OpenAI GitHub App reviews the pull requests its repository
  settings select. CI neither requests nor waits for that review.
- **Security reviews** (CodeQL, Scorecard). They report findings and are not
  jobs the resolver requires.

The branch protection of `main` requires one check, `merge`, the aggregate job of
the Pipeline. Controlling usage credits (extra usage) is done in the owner's
account settings: CI does not read or guard it.
[Extra usage](https://support.claude.com/en/articles/12429409-extra-usage-for-paid-claude-plans)

## The owner's approval

GitHub refuses an approving review from the author of a pull request, and agents
push under the owner's account.
[Approving a pull request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews)
The approval is therefore the label `owner-approved`, set in one action by the
owner, or by the owner's bot on the owner's explicit consent for this pull request
and this head. No agent sets it.

The protected resolver (`pipeline-post-merge.yml`, run from `main` by
`pipeline-after-merge.yml`) merges when every row of the left column holds:

| Condition | Read from |
| --- | --- |
| The required Pipeline jobs of the head succeeded | the Pipeline run, `_validate_jobs` |
| The label `owner-approved` is on the pull request | the pull request |
| The last `labeled`/`unlabeled` event of that label is `labeled`, by the repository owner's account of type User | the issue events |
| That event is after the head's first `pull_request` Pipeline run | the Pipeline runs of the head |
| No `hold` or `do-not-merge` label, no "do not merge" title | the pull request |

| Pipeline | Approval | Outcome |
| --- | --- | --- |
| Green | Set by the owner after the head was pushed | Merge |
| Green | Absent, removed, or last set by another account | Held, green run, notice |
| Green | Set before the current head (a push came after it) | Held: `the approval predates this head` |
| Running | Set by the owner after the push | Held while the Pipeline runs; its completion merges, with no new label |
| Red | Any | Not merged: the failed job is named |

A held merge ends the resolver run green with a notice. The next completion of
the Pipeline or of `Owner approval` wakes the resolver again. The `Owner approval`
workflow runs on `labeled` and on `synchronize`. On `synchronize` it removes the
label, so a pushed head always needs a new approval. A label set in the seconds
between a push and the creation of its Pipeline run counts as stale and must be
set again. A low-risk Dependabot update (ADR-1126) is the one merge without the
owner's approval. The owner can always merge by hand.

A pull request that changes this rule is judged by the resolver of `main`. The
owner merges it by hand, on a green gate and an independent review.

## Threat model

Tests: `scripts/tests/test_ci_review_owner_approval.py`.

| Threat | Defence | Test |
| --- | --- | --- |
| An agent sets the label itself | An agent pushes with the owner's token, so GitHub's events cannot tell it from the owner. The defences are the contract (rule 1), the session guard that refuses `--add-label owner-approved`, any quoted label and label writes through the API, and the event log, which names who set the label and when. The GitHub MCP tools that edit issues are not covered by the guard. | `test_the_session_guard_refuses_setting_the_approval_label` |
| A push slipped in after the approval | The approval must follow the head's first Pipeline run. `Owner approval` removes the label on each push. The merge sends the tested head SHA. | `test_the_approval_table` ("approval predates a push"), `test_the_approval_workflow_clears_a_stale_label_on_every_push` |
| An approval given on another head | Same date check. A label set before the current head counts for no head after it. | `test_the_earliest_run_of_the_head_dates_it` |
| A fork or Dependabot pull request | The resolver merges only same-repository heads. A label set by a bot, or by any account other than the owner's user account, does not approve. Dependabot keeps only the low-risk path. | `test_the_approval_table` ("set by a bot", "bot with the owner's login") |
| A required check removed by the pull request itself | The required job names are in the resolver, which runs from `main`. A missing or failed job holds the merge. | `test_a_failed_or_absent_review_job_does_not_fail_the_merge_gate` (positive control) |
| A review bot absent, failed or out of quota | No job of `PR Review` is read by the resolver, and none wakes it. | `test_the_resolver_reads_no_bot_verdict`, `test_review_bots_do_not_wake_the_resolver` |
