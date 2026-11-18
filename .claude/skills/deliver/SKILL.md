---
name: deliver
description: Deliver a change of this repository (commit, gate, review, push, pull request). Use before any git push or pull request, and whenever the user asks to ship, deliver, push or open a pull request.
---

# Deliver a change

A change is judged before it is pushed: its tests, then mutation testing of the lines it touches. This is enforced, not requested. Git's pre-push hook refuses a commit whose tree has no passed verdict of the gate, and the `PreToolUse` hook of `.claude/settings.json` refuses what goes around it. This skill is the way through.

What the gate runs is in `delivery-gate.json` and `scripts/gate/profiles/` (checks, production code, what a sandboxed operation may reach, what the guard refuses). Change those files, not this skill, when the gate changes. CONTRIBUTING.md, "The delivery gate", says what each layer holds against and what it does not.

## Steps

1. **Commit** the work on its branch, in a worktree under `.claude/worktrees/` (conventional commit, files staged one by one). The gate judges the committed tree and refuses anything else, an untracked file included.
2. **Run the gate**: `pnpm gate`. The gate that judges is the one of the base revision (`origin/main`), taken out of git: `git fetch` first if the base moved. It checks the commit out into a directory of its own and runs each operation there, in its own sandbox, after a canary proved the sandbox holds; your worktree is not written.
   - The gate says the sandbox does not hold: stop. There is no unsandboxed run.
   - A check fails: fix the cause, commit, run again.
   - A mutant is undetected: write the test that kills it. Only when no test can tell the mutant from the original, mark it on the line above: `// Stryker disable next-line <Mutator>: equivalent: <the invariant that makes it so>`. Never weaken or delete a test to pass.
   - Passed and recorded: the verdict is for this tree. Any later commit is another tree and needs its own run.
3. **Review in fresh contexts.** The reviewer is never the author. Start one subagent per reviewer of `.claude/agents/` (code quality, test coverage, security, performance, documentation accuracy), all in one message, each given the files of the change and what it is meant to guarantee, and nothing of this conversation. Ask each to defeat the change, not to confirm it. Fix what they find, then go back to step 1.
4. **Check what the gate does not play.** Rule 8 of the CI contract (`docs/agent-guidance.md`) still applies: compare the `unit` and `regression` commands of `ci.json` with the checks of `delivery-gate.json`, and run on the committed tree whatever the gate does not list.
5. **Push** with `git push`, following the CI contract of `docs/agent-guidance.md` (one pull request in flight, push once per verdict, no forced push). If the pre-push hook is not installed, `pnpm gate:install` (it needs `origin/main` fetched, with the gate on it). Then open the pull request (`gh pr create`, or the GitHub tool that creates one). Its body carries each command with its passed, failed and skipped counts, read from the gate's output, and the gate's mutation line (`N mutant(s) on the changed lines, all detected`).

## When a push is refused

The message names the ref, the tree and the reason: no verdict, a verdict that is not a passed one for this tree, or a verdict written by another gate than the one of the base revision (the gate changed on the base since, or the commit brought its own). Run step 2. Do not pass `--no-verify`, change `core.hooksPath`, force the push, merge by hand, edit `.claude/settings.json`, push through the API, or write a verdict file by hand: a verdict is evidence only because the gate wrote it.
