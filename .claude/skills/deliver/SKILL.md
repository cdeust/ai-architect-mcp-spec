---
name: deliver
description: Deliver a change of this repository (commit, gate, review, push, pull request). Use before any git push or pull request, and whenever the user asks to ship, deliver, push or open a pull request.
---

# Deliver a change

A change is judged before it is pushed: its tests, then mutation testing of the lines it touches. This is enforced, not requested. Git's pre-push hook refuses a commit whose tree has no passed verdict of the gate, and the `PreToolUse` hook of `.claude/settings.json` refuses what goes around it. This skill is the way through.

What the gate runs is in `delivery-gate.json` and `scripts/gate/profiles/` (checks, production code, what a sandboxed operation may reach, what the guard refuses). Change those files, not this skill, when the gate changes. CONTRIBUTING.md, "The delivery gate", says what each layer holds against and what it does not.

## Steps

1. **Commit** the work on its branch, in a worktree under `.claude/worktrees/` (conventional commit, files staged one by one). If the change touches `packages/mcp-server/src`, run `pnpm build` and commit the rebuilt `packages/mcp-server/dist` with it: the gate fails when a check leaves tracked files changed.
2. **Run the gate**: `pnpm gate`. Each operation runs in its own sandbox, after a canary proved the sandbox holds. If the change touches the gate itself (`scripts/gate/`, `delivery-gate.json`, `stryker.config.json`), run the gate of the main checkout from the worktree instead: `node <main checkout>/scripts/gate/gate.mjs run`.
   - The gate says the sandbox does not hold: stop. There is no unsandboxed run.
   - A check fails: fix the cause, commit, run again.
   - A mutant is undetected: write the test that kills it. Only when no test can tell the mutant from the original, mark it on the line above: `// Stryker disable next-line <Mutator>: equivalent: <the invariant that makes it so>`. Never weaken or delete a test to pass.
   - Passed and recorded: the verdict is for this tree. Any later edit is another tree and needs its own run.
3. **Review in fresh contexts.** The reviewer is never the author. Start one subagent per reviewer of `.claude/agents/` (code quality, test coverage, security, performance, documentation accuracy), all in one message, each given the files of the change and what it is meant to guarantee, and nothing of this conversation. Ask each to defeat the change, not to confirm it. Fix what they find, then go back to step 1.
4. **Run the CI commands** of `ci.json` that the gate does not (`regression`), on the committed tree.
5. **Push** with `git push`, following the CI contract of `docs/agent-guidance.md` (one pull request in flight, push once per verdict, no forced push). If the pre-push hook is not installed, `pnpm gate:install`. Then open the pull request (`gh pr create`, or the GitHub tool that creates one). Its body carries each command with its passed, failed and skipped counts, and the gate's mutation line (`N mutant(s) on the changed lines, all detected`).

## When a push is refused

The message names the ref, the tree and the reason: no verdict, a verdict that is not a passed one for this tree, or a verdict written by another gate than the one of the main checkout. Run step 2. Do not pass `--no-verify`, change `core.hooksPath`, edit `.claude/settings.json`, push through the API, or write a verdict file by hand: a verdict is evidence only because the gate wrote it.
