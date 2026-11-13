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

## Etiquette

Conventional commits, staged file-by-file. One PR per concern. A pull request merges when
CI is green and a review verdict is posted on it; the owner does not gate merges by hand.
CI is the authority: it exists to catch regressions and enforce the engineering standards.

## CI contract for agents and routines

This section binds every agent that works on this repository: an interactive session,
a scheduled routine, the local manager. It follows the contract of `cdeust/Cortex`, the
source of truth for CI. Where the prompt of a routine says otherwise, this section wins:
the prompt was written before the contract, and the repository's own standards apply.

1. **The review verdict decides the merge.** The `PR Review` workflow posts a comment by
   `claude[bot]` that ends with `Verdict: approve` or `Verdict: block`. The resolver merges
   a pull request whose last verdict covers its head, reads approve, and whose required
   checks are green. No agent merges by hand or enables auto-merge.
2. **Three reviews per branch.** The budget counts review runs by branch name, so every
   push to an open pull request spends one. Push once per verdict, with every blocker of
   that verdict fixed, and never while a `PR Review` run is in progress on the pull
   request: the review would land on a commit that is no longer the head.
3. **Budget spent without an approve on the head: a new branch.** Push the same commits to
   `<branch>-r<N>`, open a pull request with the same title and body plus a "Continuation"
   section naming the old one, leave one "Continued in #n" line on the old one, close it.
   A forced push of any kind, `--force-with-lease` included, is never used: it does not
   reset the budget and it rewrites a branch another agent may hold.
4. **No comparison with the main branch.** Do not measure how far a branch is behind, do
   not rebase a pull request branch onto the main branch, do not use the branch-update
   button or its API, and do not write that a pull request is late: a late pull request
   merges. The only exception is a real conflict (`mergeable_state` is `dirty`): merge the
   main branch into the branch with a merge commit, resolve it, rerun the touched tests,
   check that the merge did not change the meaning of either side, and push normally.
5. **One pull request in flight.** A pull request is in flight while a check runs on it, a
   review runs on it, or an approve waits for the merge. While one is in flight, open no
   other pull request (issue, relaunch or next slice) and push to no other branch.
6. **No comment after an approve.** No reply to the notes, no summary, no acknowledgement.
   Notes marked "no action before merge" go to a follow-up pull request after the merge.
   Before an approve, comment only with a pushed fix or a hold.
7. **Owner decisions are left alone:** a pull request on the branch
   `ci/budget-counts-contract-reviews`, anything labelled `hold` or `do-not-merge`, a draft.
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
2. **Write the decision, then act.** At most one written decision per pass, and only
   when no pull request of the repository is in flight. Read the issue's comments again
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
