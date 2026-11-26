# Review evidence

The protected resolver requires a successful Pipeline on the current PR head and two approvals. A hold label or a “do not merge” title remains the owner’s veto. This contract also applies to Dependabot. An unavailable provider, a missing verdict or an exhausted review budget holds the merge.

| Evidence | What GitHub must show |
| --- | --- |
| Claude | The newest protected `PR Review` run for this PR and commit completed its review action and recorded a structured approval. One comment from the Claude App names the same SHA and run attempt and ends in `Verdict: approve`. The query authenticates the bot author and the last editor. |
| Codex | The native connector’s versioned summary names this SHA, the review completed and it has no unresolved findings. The GraphQL query follows all pages, checks the current head and authenticates both author and last editor. |
| Published result | The protected `Review updated` workflow writes the `Claude and Codex reviews` status on the actual PR commit. A missing approval produces a failure. On review edits, deletion, creation or the completion of the Pipeline or Claude review, it reads both verdicts again. The protected resolver independently reads those sources immediately before submitting the expected head SHA to GitHub. |

## Why the quota reader was removed

The protected selector on #414 could not see usage limits after OAuth sign-in. On #411 and #407 its terminal probe failed. In each case the percentage was absent and the requested review was never verified. Both review systems now operate independently of that display. [#414 producer](https://github.com/cdeust/ai-architect-mcp-spec/actions/runs/45770024795/job/139740168408) · [#411 producer](https://github.com/cdeust/ai-architect-mcp-spec/actions/runs/45772732224/job/139748975741) · [#407 producer](https://github.com/cdeust/ai-architect-mcp-spec/actions/runs/45756254346/job/139695453422).

## Protected inputs and publication

`pull_request_target` takes the workflow and its configuration from the protected base. The workflow admits open same-repository, ready PRs targeting main. The installed Anthropic action uses the documented explicit-prompt agent mode at the architect-os pin. Agent mode preserves the protected checkout. Tracking mode’s branch setup would check out the candidate. Git fetches the two immutable SHAs into a separate bare repository and generates their complete merge-base diff. The review reads that diff and the reviewer definitions from the protected checkout. The managed policy limits publication to the GitHub MCP’s `add_issue_comment` tool on the event PR, with its exact commit and attempt footer. Claude has no shell. [Agent mode](https://github.com/anthropics/claude-code-action/blob/4411a9e9b0283becf4b924f7bce360fd7756c78c/src/modes/agent/index.ts) · [Tracking mode](https://github.com/anthropics/claude-code-action/blob/4411a9e9b0283becf4b924f7bce360fd7756c78c/src/modes/tag/index.ts) · [Documented review modes](https://github.com/anthropics/claude-code-action/blob/4411a9e9b0283becf4b924f7bce360fd7756c78c/docs/solutions.md).

GitHub's REST records for a protected review include the PR head in both the run and job and the protected base in the PR association. The workflow execution's `github.sha` is the trusted checkout. [Public run with its association](https://api.github.com/repos/cli/cli/actions/runs/45835202584) · [Run jobs](https://api.github.com/repos/cli/cli/actions/runs/45835202584/jobs) · [GitHub event reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target).

## Operator dependencies and acceptance

The Claude App installation and `CLAUDE_CODE_OAUTH_TOKEN` must be available to the trusted review. A base retarget requires a subsequent protected review and Pipeline for the same head. Reopen or push the reviewed correction to obtain new evidence. Dependabot remains held until a separate protected admission can run Claude for it. Owner configuration must allow the protected event. Codex needs automatic reviews enabled for this repository and available capacity in the connected environment. An integration comment or request proves neither a completed review nor its verdict. A manual fresh `@codex review` request remains the owner’s action under repository rule 6. Advisory security scans do not supply either code review.

The first hosted run after owner integration must demonstrate the two native receipts on one head, a successful status from the protected workflow, and an edited or withdrawn verdict reopening the gate before a merge. Review statuses can also be written by identities with commit-status write access. The resolver always checks both native receipts and the protected Claude run directly. The owner decides whether to require the published status in live rules.
