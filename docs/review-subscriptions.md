# PR review subscriptions

The PR workflow first enforces the review-round budget. Its budget job records
one default-branch workflow run ID for that attempt. GitHub can send multiple
`workflow_run` events as jobs start. Only the recorded workflow reads quota,
and both admission and merge verify its identity. If its measurement fails,
the round remains blocked. Rerunning all jobs creates a new source attempt
with its own nomination. The default-branch workflow selects from measured
eligible subscriptions using the remaining percentage in the tightest applicable
window. Codex wins a tie. Claude runs through the official Claude Code action.
Codex runs through the OpenAI GitHub App. OpenAI controls the model used by
that app. [OpenAI GitHub integration](https://learn.chatgpt.com/docs/third-party/github)

| Claude | OpenAI GitHub review meter | CI decision |
| --- | --- | --- |
| Eligible | Positive | Select the larger remaining percentage |
| Eligible | Exhausted or unreported | Select Claude |
| Excluded | Positive | Reuse a review on this head or request one with `@codex review` |
| Excluded | Unreported | Read a native review already triggered by the repository |
| Excluded | Exhausted | Hold the review |

A failed quota read holds the round. Read-only reuse waits for a completed,
authenticated code review on the current head. The repository's native automatic
review trigger determines which PR events start reviews outside CI. An absent
receipt leaves admission unverified. A request, reaction and security-review
summary do not establish code approval. Reusing a completed native receipt on
the same head counts once against the review budget.

### OpenAI meter

The trusted workflow accepts an optional `CODEX_REVIEW_USAGE_TOKEN` and
`CODEX_REVIEW_ACCOUNT_ID` in the main-only `review-subscriptions` GitHub
Environment. The bearer must authorize the usage endpoint for the ChatGPT
account linked to the review installation. The workflow checks the response
account and reads `code_review_rate_limit` from a fixed HTTPS GET. It allows
a new request on a measured individual subscription with available headroom
and no credit balance or unlimited credits reported. Configure the Environment's
deployment branches before adding its credential. PR code only sees the
provider decision. [OpenAI usage client](https://github.com/openai/codex/blob/cf3ff1530d821ec2d26452da4971d8e3e7d18d25/codex-rs/backend-client/src/client/rate_limit_resets.rs)

On 2026-11-22 the signed-in account's response contained
`"code_review_rate_limit": null`, while the GitHub app completed the code review
of commit `42ed284`. A null meter has no numeric value. The general Codex
allowance measures a different activity. [Native receipt](https://github.com/cdeust/ai-architect-mcp-spec/pull/391#issuecomment-7078116054) · [OpenAI pricing](https://learn.chatgpt.com/docs/pricing)
