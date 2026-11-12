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
   and the version file it names, with the validator of that earlier commit. In Cortex,
   the two pull requests that added a key to `ci.json` together with the validator that
   accepts it each merged, then failed that job, and the test jobs of that run were
   skipped. Such a pull request replays the step before it is opened and before each push
   to it: the validator as it was before its commits, on the tree after them. So a key
   enters `ci.json` in a pull request after the one that taught the validator to accept
   it; what fails without the key, a validator that requires it or a reader that refuses
   its absence, comes with the key or after it; a key the validator requires leaves
   `ci.json` after the validator stopped requiring it.
