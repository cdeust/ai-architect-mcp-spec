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
The approval is therefore the label `owner-approved`, set by the owner in one
action. No agent sets it.

The approval is bound to a head commit, not to a date. `Owner approval`
(`owner-approval.yml`) runs on `pull_request_target`, so GitHub runs it as it is
on `main` and a pull request cannot change it. GitHub documents that this event
runs in the context of the default branch, with `GITHUB_SHA` the last commit of
that branch: the run's own commit is not the head. The run's title is the record,
defined on `main`: `Owner approval <labeled|synchronize> PR <n> label <label> at
<head commit> by <actor>`.
[Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)

The protected resolver (`pipeline-post-merge.yml`, run from `main` by
`pipeline-after-merge.yml`) merges when every row holds:

| Condition | Read from |
| --- | --- |
| The required Pipeline jobs of the head succeeded | the Pipeline run, `_validate_jobs` |
| The label `owner-approved` is on the pull request | the pull request |
| The newest `labeled` record of that label for this pull request completed with success and has the owner's user account as actor, triggering actor and title actor | the runs of `owner-approval.yml`, event `pull_request_target`, since the pull request was opened |
| That record names the current head commit | its title |
| No `synchronize` record and no `unlabeled` event of the label came after it | the records, the issue events |
| No `hold` or `do-not-merge` label, no "do not merge" title | the pull request |

| Pipeline | Approval | Outcome |
| --- | --- | --- |
| Green | The owner's newest record names this head | Merge |
| Green | No record: absent, or set with `GITHUB_TOKEN`, which starts no run | Held: `the owner has not approved this head` |
| Green | Set by another account, an app, or rerun by another account | Held: `the approval label was not set by the owner` |
| Green | Names another head (a push, a head reused from another PR, a return to an earlier head) | Held: `the approval names another head` |
| Green | A push or a removal came after it | Held: `a push came after the approval` or `the approval was removed after it was given` |
| Running | The owner's record names this head | Held while the Pipeline runs; its completion merges, with no new label |
| Red | Any | Not merged: the failed job is named |

A held merge ends the resolver run green with a notice. The next completion of
the Pipeline or of `Owner approval wake` wakes the resolver again.
`Owner approval wake` runs from the pull request on `labeled` and only wakes the
resolver: a pull request that changes it can delay a merge, never cause one,
because the resolver reads the records from `main` itself. On `synchronize`,
`Owner approval` removes the label so the pull request shows the truth; the
resolver does not rely on that removal. A rerun of an approval record keeps its
title, so it never approves another head; a rerun by another account changes the
triggering actor and the resolver refuses it. A low-risk Dependabot update
(ADR-1126) is the one merge without the owner's approval. The owner can always
merge by hand.

A pull request that changes this rule is judged by the resolver of `main`. The
owner merges it by hand, on a green gate and an independent review.

## The pull_request_target dependency

GitHub blocks `pull_request_target` by default in public repositories from
2 December 2026, unless an applicable Actions event policy allows it; a blocked
attempt creates a failed run and the workflow does not execute. This repository
is public, and `Owner approval` is its only workflow on that event.
[Changelog](https://github.blog/changelog/2026-11-02-pull_request_target-blocked-by-default-december-2) ·
[Control workflow execution](https://docs.github.com/actions/how-tos/administer/control-workflow-execution) ·
[Policies API](https://docs.github.com/en/rest/actions/policies) ·
[Securely using pull_request_target](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)

The exception is defensible because the file runs nothing of the pull request:
no checkout, no download, no artifact, no third-party action; the pull request
reaches it only through event values in its title and the number passed to
`gh pr edit --remove-label`; `permissions: {}` at the workflow level and
`pull-requests: write` on the `clear` job alone.
`test_the_record_workflow_keeps_the_form_its_policy_exception_allows` holds that
form: any addition to the file must keep it.

The policy, scoped to this file and this event, status Active. The coordinator
creates it under the owner's account when this change merges; no agent of a pull
request creates or changes it. The body follows the schema of the Policies API
(the page gives no example for an event policy):

```
gh api -X POST repos/cdeust/ai-architect-mcp-spec/actions/policies --input - <<'EOF'
{"name": "Allow pull_request_target for owner-approval.yml",
 "enforcement": "active",
 "conditions": {"workflow_path": {"include": [".github/workflows/owner-approval.yml"], "exclude": []}},
 "rules": [{"type": "restrict_action_events", "parameters": {"allowed_events": ["pull_request_target"]}}]}
EOF
```

To read it back: `gh api repos/cdeust/ai-architect-mcp-spec/actions/policies`. On
2026-11-26 that call answered `{"total_count":0,"policies":[]}`.

Without the policy, the label is set but no record runs: the resolver holds with
"the label is on the pull request but no approval record exists" or "the
approval record did not run", both naming the policy as the probable cause. A
record counts only once its run completed with success, so a blocked run, a
startup failure or a cancelled run never approves, whatever its title. On a
push, the label then stays on the pull request, but the approval still names
the earlier head and is refused.

## Known divergence from the CI generator

`pipeline-post-merge.yml` and `pipeline-after-merge.yml` are rendered by
zetetic-team-subagents `render-ci`. The owner paused that repository on
2026-11-25, so its template still renders the bot verdict gate. This repository
carries the owner-approval resolver in the rendered copies, and both files say
so in their header. A re-render would overwrite the change and bring back a merge
that waits for a bot verdict. Nobody runs `render-ci` here until the template
carries the change. If someone does, `GeneratorDivergenceTests` in
`scripts/tests/test_ci_review_owner_approval.py` fails in the regression job. The
change will next be carried to architect-os.

## Threat model

Tests: `scripts/tests/test_ci_review_owner_approval.py`.

| Threat | Defence | Test |
| --- | --- | --- |
| An agent sets the label itself | An agent pushes with the owner's token, so GitHub's events cannot tell it from the owner. The defences are the contract (rule 1), the session guard, and the event log, which names who set the label and when. The guard (`guard.protectedLabel` in `delivery-gate.json`, `writesLabel` in `scripts/gate/gate-lib.mjs`) reads the arguments of gh, past assignments, wrappers (`env -i`, `sudo`, `command`), a binary path and gh's own options (`-R`): it refuses `pr`/`issue` `edit`/`create` adding a label it cannot read or that names it, `label create`/`edit`/`clone`, every `alias set`/`import`, every `gh api graphql`, any REST write to an issue, a pull request or its labels, and GitHub MCP tools whose input names it. It is a barrier of use, not a proof of identity: it cannot stop `bash -c` or another interpreter, a tool outside this guard (curl is refused by another rule, not every HTTP client), an agent that runs without this guard, or the owner's token used anywhere else. | `gate.test.mjs` "refuses every gh form that may set the owner's approval label", `test_the_session_guard_refuses_setting_the_approval_label` |
| A push slipped in after the approval, a head reused from another PR, a return to an earlier head, a rerun of an old run, a push with `GITHUB_TOKEN` that starts no workflow | The approval is bound to the head commit in the record. Only the newest record counts, and a later `synchronize` record or `unlabeled` event voids it. | `test_the_approval_table`, `test_a_rerun_of_an_old_head_needs_a_new_approval` |
| The pull request changes the approval workflows | `Owner approval` runs from `main` (`pull_request_target`); only its records count, and the records of the PR's own workflows are refused. The wake decides nothing. | `test_the_record_runs_from_main_and_its_title_matches_the_resolver`, `test_the_wake_decides_nothing`, rows "a record from the PR's own workflow" and "another workflow file" |
| A label set with `GITHUB_TOKEN` or by an app | `GITHUB_TOKEN` events start no run, so there is no record. An app is the actor of its record and is refused. | rows "label but no record", "set by an app" |
| The owner labels while a push lands (time of check, time of use) | The record names the head at the moment of the label, which may be a head the owner did not read. Before labelling, the owner checks that the head shown is the one read; the record's title names it afterwards. | not testable: inherent to a label |
| The Pipeline run is the pull request's own (`pipeline.yml` runs from the PR): a PR can empty its jobs and keep their names | The owner's review of the diff; no bot reads it any more. This predates this change. | none |
| A fork or Dependabot pull request | The resolver merges only same-repository heads. A label set by a bot, or by any account other than the owner's user account, does not approve. Dependabot keeps only the low-risk path. | `test_the_approval_table` ("set by a bot", "bot with the owner's login") |
| A required check removed by the pull request itself | The required job names are in the resolver, which runs from `main`. A missing or failed job holds the merge. | `test_a_failed_or_absent_review_job_does_not_fail_the_merge_gate` (positive control) |
| A review bot absent, failed or out of quota | No job of `PR Review` is read by the resolver, and none wakes it. | `test_the_resolver_reads_no_bot_verdict`, `test_review_bots_do_not_wake_the_resolver` |
