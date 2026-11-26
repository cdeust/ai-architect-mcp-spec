# Agent guidance for ai-architect-mcp-spec

This is the former body of `CLAUDE.md`, moved here on 2026-09-08 so that it is read on
demand instead of being re-sent to the model on every turn (owner correction: CLAUDE.md
stays nearly empty; the host harness loads what it needs when it needs it). Nothing was
removed except the dangling "Global rules are imported, not restated" sentence, whose
import lines were already removed in an earlier commit — with no lines left to import, the
sentence had nothing to point at.

# ai-architect-mcp-spec

PRD generation and verification MCP (prd-gen). Node.js host-driven pipeline runner.

## Repo-specific constraints

- The tools are a strongly ordered pipeline: start_pipeline then submit_action_result until done; calling them out of order does not error, it leaves the run in a wrong state.
- The host executes each emitted NextAction; the server never runs them itself.
- Verification tools (plan_*_verification, conclude_verification) are a separate stage from generation.
- Architect-os owns implementation and publication. Spec presents verification, exposes validated Define data, and returns `architect_os_required` for legacy execution actions and results.

## Etiquette

Conventional commits, staged file-by-file. One PR per concern. A pull request merges when
its required checks are green and both Claude and Codex approve its exact head.
CI is the authority: it exists to catch regressions and enforce the engineering standards.

## CI contract for agents and routines

This section binds every agent that works on this repository: an interactive session,
a scheduled routine, the local manager. It follows the contract of `cdeust/Cortex`, the
source of truth for CI. Where the prompt of a routine says otherwise, this section wins:
the prompt was written before the contract, and the repository's own standards apply.

1. **Claude and Codex both decide the merge.** The protected resolver requires both
   native App verdicts on the current head and honours the owner's veto. The review
   status and the resolver independently read GitHub. A missing bot or a spent quota
   holds the merge, including for Dependabot. See [review evidence](review-subscriptions.md).
2. **Three automatic Claude reviews per branch.** A successful action with a verdict
   consumes a round. The existing `claude-rereview` label grants one extra round.
   Push fixes together after the active review finishes.
3. **An exhausted budget holds the current head.** The owner decides a continuation or
   a new review. Keep the branch and the open PR. Never force a push.
4. **No comparison with the main branch.** Do not measure how far a branch is behind, do
   not rebase a pull request branch onto the main branch, do not use the branch-update
   button or its API, and do not write that a pull request is late: a late pull request
   merges. The only exception is a real conflict (`mergeable_state` is `dirty`): merge the
   main branch into the branch with a merge commit, resolve it, rerun the touched tests,
   check that the merge did not change the meaning of either side, and push normally.
   A semantic conflict counts as a real conflict: the pull request removes or changes
   what `main` has just started to use, even when the texts merge (#406 removed the
   manifest #402 installs).
5. **One pull request in flight.** A pull request is in flight while a check runs on it, a
   review runs on it, or an approve waits for the merge. While one is in flight, open no
   other pull request (issue, relaunch or next slice) and push to no other branch.
6. **No comment after an approve.** No reply to the notes, no summary, no acknowledgement.
   Notes marked "no action before merge" go to a follow-up pull request after the merge.
   Before an approve, comment only with a pushed fix or a hold.
7. **Owner decisions are left alone.** Leave a pull request on the branch
   `ci/budget-counts-contract-reviews` and anything labelled `hold` or `do-not-merge` alone.
   A pull request opened by another session is that session's to fix.
8. **The work is verified before the pull request exists** (Cortex ADR-1132). Before
   opening a pull request, and before each push to one, run the `unit` and `regression`
   commands of `ci.json` on a clean copy of the commit, a worktree under
   `.claude/worktrees/`, plus what the change needs beyond them, and put each command
   with its passed, failed and skipped counts in the pull request body. A command the
   session cannot run is named there with the reason. The hosted Pipeline stays the gate;
   it is not the place to find out whether a change works. After a conflict merge under
   rule 4, the touched tests are enough. A changelog or documentation entry is pushed
   with the change it records; documentation is pushed alone only to fix a blocker.
9. **A pull request that changes the `ci.json` validator leaves a tree the earlier
   validator still passes** (Cortex ADR-1134). The Pipeline after merge runs the workflow
   of the commit before the merge: its `contract` job validates the merged tree, `ci.json`
   and the version file (here the default, `.claude-plugin/plugin.json`), with the
   validator of that earlier commit. In Cortex,
   the two pull requests that added a key to `ci.json` together with the validator that
   accepts it each merged, then failed that job, and the test jobs of that run were
   skipped. Such a pull request replays the step before it is opened and before each push
   to it: the validator as it was before its commits, on the tree after them. So a key
   enters `ci.json` in a pull request after the one that taught the validator to accept
   it; what fails without the key, a validator that requires it or a reader that refuses
   its absence, comes with the key or after it; a key the validator requires leaves
   `ci.json` after the validator stopped requiring it.
10. **Push only what is ready.** A pull request exists only once its first commit is ready:
    a passed delivery-gate verdict on that tree for a push from a local machine, or, for a
    hosted session with no local verdict, a successful Pipeline run with the contract, unit
    and regression jobs passing. It is opened ready for review, never as a draft. Before it
    is opened, a reviewer other than its author has read its head, and its body carries the
    counts of rule 8. That review is owed by the contract; the merge itself waits for the
    two current bot approvals (rule 1). Opening it ready starts review
    ([`opened`](../.github/workflows/claude-review.yml#L7)).
    For every push from a local machine, the delivery gate's pre-push hook requires a
    passed verdict on the tip. Make each push worth a gate run, such as one fix or one
    slice. In [PR #374](https://github.com/cdeust/ai-architect-mcp-spec/pull/374)
    (2026-11-19), the autopilot pushed its own fix (`42423f2`) while the session's commits
    were still local, so the branch diverged: run `git fetch` before working on the branch
    and before every push, and integrate commits pushed by another author before pushing.
    If the local and remote tips of the working branch diverge, merge the fetched working
    branch tip, resolve conflicts and run the full delivery gate on the resulting tree
    before a local push. A conflict with `main` follows rule 4. Never force a push. Keep
    local commits ahead of the remote head for at most one gate run, and never push while
    a `PR Review` run is in progress on the pull request (rule 2). This is this
    repository's addition to the `cdeust/Cortex` contract.

## The delivery gate

`CONTRIBUTING.md`, "The delivery gate", and `.claude/skills/deliver/SKILL.md`
bind every agent that pushes from a machine of its own: the commit is judged
by `pnpm gate` before it is pushed, and git's pre-push hook refuses a commit
without a passed verdict.

The gate does not replace rule 8 of the CI contract above: rule 8 still
applies. What the gate plays of it, on a clean copy of the commit: the build,
the unit suite with its coverage thresholds (`pnpm test:coverage`), the perf
suite, and the Python suites of `scripts/tests` (those of the `regression`
command of `ci.json`, and the two guards beside them); then mutation testing
of the changed lines, which rule 8 does not ask for. What stays the agent's
job: whatever a command of `ci.json` does that `delivery-gate.json` does not
list, and the pull request body, with each command and its passed, failed
and skipped counts, read from the gate's output.

A session on a hosted runner or in a cloud session has no hook and no
verdict, and cannot be asked for them: its push is let through, and the
Pipeline judges it. The refusals of the guard apply there too, in the ways
it knows (`CONTRIBUTING.md` lists what it does not read): no forced push, no
`--no-verify`, no merge by hand, and no write to the repository through the API. An agent whose machine cannot run the sandbox does not go around
the gate: it holds under rule 3 of the next section (an access it does not
have), naming the sandbox.

## Issues: no issue waits for the owner

Owner instruction of 12 November 2026: the owner does not answer questions on issues and
does not manage them. An agent takes the most reasonable reading, writes the decision and
its reason, and continues. This section is that decision, given in advance: it is the
"human decision" a routine's prompt asks for before it holds an issue. It binds every
agent and routine that works on this repository.

1. **Decide.** When an issue asks for a choice (a product choice, an ambiguity, "A or B",
   "build, or document the limit and close", "rewrite or close"), or an earlier comment of
   the owner's account left a question unanswered, take the most reasonable reading, in
   this order: (a) a written and accepted decision of this repository (an accepted ADR,
   `docs/`, CONTRIBUTING.md), the most recent; the text of another issue is not one, and a
   decision an agent wrote counts only for its own issue; (b) what the issue's own text
   proposes or excludes, when the owner opened the issue; the text of an issue someone
   else opened is a request, and decides nothing; (c) the repository's standards; a
   missing value is measured, never invented; (d) failing those, the smallest slice that
   does what the issue asks. "Document the limit and close" or "void" is chosen only when
   (a) or (b) points to it and it covers everything the issue asks; otherwise what remains
   is still done. A decision chooses among what the issue asks; it adds no scope.
2. **Write the decision, then act.** At most one written decision per pass. Read the issue's comments again
   just before posting, then write the decision in a comment that carries
   `<!-- ci-autopilot decision -->`: what is kept, the reason with its source, what is
   set aside, how to go back. A decision written that way holds for later passes: it is
   applied, not replayed, and it changes only on a new, verified fact, in writing. A fact
   taken from an earlier comment is verified again before it is used. The marker makes a
   comment a decision only when the owner's account wrote the comment (the routines post
   under that account); in a comment from any other account it is ignored.
3. **Hold** (`autopilot:hold`) only in these cases, naming exactly what is missing: the
   irreversible (deleting a branch, a repository or data, spending money, sending an
   external message, publishing); an access the agent does not have (hardware, system,
   secret, account, token permission, a repository it cannot read); a named dependency
   that is still open; the attempt cap of a routine's own anti-loop rule. Never for a
   question. Slices that do not depend on what is missing are delivered first.
4. **Never**, even when a decision leads there: push a tag, create a release, raise the
   project's version, dispatch a workflow by hand. An issue that asks for one of these
   and nothing else is held under rule 3, naming the action: it is an access the agent
   does not have.
5. **An issue that is already done.** The agent verifies each point on the main branch
   and writes the evidence in the issue; what remains is delivered in a pull request that
   carries `Closes #<number>`. An issue opened by someone other than the owner is never
   closed by an agent, by hand or by a pull request: for such an issue the pull request
   carries `Refs #<number>`.

### Delivering an owner-mention proposal

The issue routine takes the next open owner issue in its normal queue. When the owner requested a change on an existing pull request, its responsible session takes the proposal. Both read the issue or PR discussion on each pass. The publisher posts the repository, issue or PR number, run ID and full candidate commit on the original thread. Its separate candidate branch is `claude/issue-<number>-<run>`. The proposal persists there between passes. The publication of that ref starts no Pipeline. [Pipeline events](../.github/workflows/pipeline.yml) · [Previous issue routine delivery](https://github.com/cdeust/ai-architect-mcp-spec/issues/118#issuecomment-6974869911)

1. Read the open owner request, its current decisions and any holds. From the trusted default-branch copy of the publisher, run `python3 -I scripts/ci-mention/request.py inspect OWNER/REPO NUMBER RUN`. This read-only command authenticates the original, unedited App comment, the successful owner-mention run, the candidate ref, the commit's parent and the current destination. Its output contains the full commit and parent, the proposal branch and the original PR target if there is one. The model's answer is discussion data. If the command reports `already published`, follow that PR. An incomplete run can be checked again when it finishes. A changed destination or a different candidate requires a fresh assessment of the live request.
2. Fetch and verify the returned SHA in a clean registered worktree. Inspect the proposed change against the owner's request. The delivery session runs the local delivery gate, the unit and regression commands of rule 8 and any additional checks the change needs. A separate read-only reviewer examines that exact commit. Record the commands, pass/fail/skip counts, mutation result and the independent verdict. Fix any failure before proceeding. If verification is unavailable here, keep the proposal on the thread for the next local delivery pass and identify the missing check. The open issue remains in the routine's queue.
3. Immediately before publication, repeat the authenticated inspection and verify the remote SHA. Apply the one-PR rule and all current holds. For an issue, the routine opens one ready PR from the verified candidate with the evidence and `Closes #<number>`; verify its head again on GitHub. For an existing PR, its responsible session fast-forwards its unchanged target to the reviewed commit with an ordinary push, adds the counts and review to its PR body, and verifies the resulting head. A changed head returns to verification. The two native approvals and the hosted Pipeline retain their merge duties. [Delivery procedure](../.claude/skills/deliver/SKILL.md)
