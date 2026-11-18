---
name: deliver
description: Deliver a change of this repository (commit, gate, review, pull request). Use before any git push, gh pr create or GitHub write, and whenever the user asks to ship, deliver, push or open a pull request.
---

# Deliver a change

Nothing leaves the machine before its tests and the mutation testing of the lines it changed have passed. The rule is enforced, not requested: the `PreToolUse` hook of `.claude/settings.json` refuses a push or a pull request for a tree that has no passed verdict of the gate. This skill is the way through it.

Two layers: the hook stops a bypass, and the sandbox stops what runs. Each operation of the gate starts in its own sandbox with the profile of its contract (`scripts/gate/profiles/`), which lets it write the worktree and nothing that judges it. If the gate says the sandbox does not hold, stop: there is no unsandboxed run.

What the gate runs is in `delivery-gate.json` (checks, what counts as production code, what counts as a delivery) and `stryker.config.json`. Change the files, not this skill, when the gate changes.

## Steps

1. **Commit** the work on its branch, in a worktree under `.claude/worktrees/` (conventional commit, files staged one by one). The verdict is for a committed tree.
2. **Run the gate**: `pnpm gate`. It builds, runs the unit and perf suites, then Stryker on the production files the diff changed, and judges every mutant that touches a changed line.
   - A check fails: fix the cause, commit, run again.
   - A mutant is undetected: write the test that kills it. Only when no test can tell the mutant from the original, mark it on the line above: `// Stryker disable next-line <Mutator>: equivalent: <the invariant that makes it so>`. Never weaken or delete a test to pass.
   - Passed: the verdict is recorded for the tree. Any later edit is another tree and needs its own run.
3. **Review in fresh contexts.** Start one subagent per reviewer of `.claude/agents/` (code quality, test coverage, security, performance, documentation accuracy), all in one message, each given the diff and nothing of this conversation. A reviewer that only confirms what it was told has not reviewed. Fix what they find, then go back to step 1.
4. **Run the CI commands** of `ci.json` that the gate does not (`regression`), on the committed tree.
5. **Deliver** following the CI contract of `docs/agent-guidance.md` (one pull request in flight, push once per verdict, no forced push). Use the GitHub MCP tools or `gh`. The pull request body carries each command with its passed, failed and skipped counts, and the gate's mutation line (`N mutant(s) on the changed lines, all detected`).

## When the hook refuses

The message names the tree. Either the work is not committed, the gate was not run on this tree, or it failed. Run step 2. Do not bypass the hook, edit `.claude/settings.json`, or write a verdict file by hand: a verdict is evidence only because the gate wrote it.
