# Contributing to AI Architect MCP Spec

Thanks for considering a contribution. This project's quality bar comes from
[`rules/coding-standards.md`](https://github.com/cdeust/zetetic-team-subagents/blob/main/rules/coding-standards.md)
(the zetetic standard) — every change goes through the same audit cycle that
shaped Phase 3 and Phase 4.

---

## What this project is

A stateless reducer (`step(state, result?) → next_state, action`) packaged as
an MCP server, with multi-judge verification, deterministic Hard Output Rules
validation, and research-evidence-backed strategy selection. Ten workspace
packages with strict Clean Architecture layering. See [README](README.md) for
the architecture diagram.

---

## Dev setup

**Prerequisites:** Node.js 20.x or 22.x, pnpm v10+ (`corepack enable && corepack prepare pnpm@10`).

```bash
git clone https://github.com/cdeust/ai-architect-mcp-spec.git
cd ai-architect-mcp-spec
pnpm install --frozen-lockfile
pnpm build              # builds all 9 buildable packages
pnpm test               # runs the full test suite (currently 258 tests + 2 integration skipped)
```

The `pnpm verify` script runs install + build + test together — same as CI.

---

## Branching + workflow

- `main` is the integration branch. PRs land here.
- Branch naming: `feature/<short-slug>`, `fix/<short-slug>`, `docs/<short-slug>`, `refactor/<short-slug>`.
- One concern per PR. A bug fix doesn't need surrounding cleanup; a refactor doesn't add features.
- Conventional commit messages preferred but not enforced.

---

## The audit cycle (mandatory for non-trivial changes)

Every non-trivial change goes through a cross-audit before it lands. The
process is automated — agents do the audits — but the discipline is real:

1. **Engineering team review.** Spawn `code-reviewer`, `architect`, `test-engineer`,
   `refactorer`, `security-auditor` (when relevant). Each produces a ranked
   finding list against `rules/coding-standards.md`.
2. **Genius team review.** Spawn the relevant reasoning patterns from
   [zetetic-team-subagents](https://github.com/cdeust/zetetic-team-subagents):
   `feynman` (integrity), `curie` (measurement), `popper` (falsifiability),
   `dijkstra` (correctness), and others depending on the change shape.
3. **Address findings.** CRIT and HIGH must be closed before merge. MEDs may
   be deferred with explicit follow-up tasks.
4. **Re-run the cycle** if any structural change was made in step 3.

The Phase 3+4 audit cycle is documented in [`docs/PHASE_4_PLAN.md`](docs/PHASE_4_PLAN.md)
and the cross-audit findings are visible in commit history. Every PR
description should reference which audits ran and what was found.

---

## Coding standards (excerpt)

Full text in [`rules/coding-standards.md`](https://github.com/cdeust/zetetic-team-subagents/blob/main/rules/coding-standards.md). Key load-bearing rules:

- **§2.2 Layer dependency:** `core ← validation/verification/strategy/meta-prompting ← orchestration ← mcp-server`. Inner layers MUST NOT import outward. Layer violations block merge.
- **§3.2 No `any`:** in production code. `as any` requires an ADR.
- **§4.1 File ≤500 lines.** §4.2 Function ≤50 lines. Test files exempt from §4.1, not §4.2.
- **§7 Local reasoning:** prefer explicit dispatch tables over reflection; the next reader should understand the function from its signature + body alone.
- **§8 Source discipline:** every numeric constant ≥3 significant digits requires `// source: <citation | benchmark | measured | provisional heuristic>`. The pre-commit hook from
  [zetetic-team-subagents](https://github.com/cdeust/zetetic-team-subagents) enforces this.

---

## Testing

**The policy, stated plainly: every change that adds or alters externally
observable behaviour must arrive with tests for that behaviour, in the same
pull request.** A bug fix carries a regression test that fails on the pre-fix
code. A new function carries contract tests for its postconditions. A new error
path carries a test asserting the observable effect of taking it, including the
signal it emits — not only a downstream side effect. Changes that alter no
behaviour (formatting, comments, documentation) are exempt, and saying so in the
PR description is enough.

This is checked during review, and a PR that adds behaviour without tests is
sent back rather than merged with a follow-up promise.

- **Contract tests, not implementation mirrors.** Assertions go on observable
  postconditions, not on the formula the function uses to compute its output.
  See `packages/benchmark/src/__tests__/pipeline-kpis.test.ts` for examples.
- **Mutation survival check.** When adding a test, ask: "what mutation would
  this test fail to catch?" If the answer is "any non-trivial one," the test
  is too weak. The delivery gate asks the same question with Stryker, below.
- **Coverage by package:**
  - `core` / `validation` / `meta-prompting`: contract tests for every public
    surface.
  - `verification`: invariant tests on consensus distribution.
  - `orchestration`: per-handler injection tests + smoke harness for full runs.
  - `benchmark`: KPI gate tests + golden-fixture HOR scoring.
  - `ecosystem-adapters`: unconditional schema-contract pin against the
    live `ai-architect-mcp-codebase` wire shapes (see
    `docs/INTEGRATION-TESTING.md`).

### The delivery gate

`pnpm gate` judges a commit before it is pushed. It runs the checks listed
in `delivery-gate.json` (build, unit, perf), then mutation testing of the
production files the commits touch (`stryker.config.json`). Every mutant
that touches a changed line must be detected by a test. One that no test can
tell from the original is marked on the line above, with its reason:
`// Stryker disable next-line <Mutator>: equivalent: <why>`. A mark without
that reason does not pass, and a file that turns mutation off for more than
one line fails the gate.

The gate judges the committed tree: it refuses work that is not committed.
It checks that tree out into a directory of its own, beside the verdicts in
the git directory, with the installed dependencies of the worktree
(`carry` in `delivery-gate.json`), runs everything there, records a verdict
for the tree, and removes the directory. The worktree is never written: what
a check leaves behind is in the copy, so the verdict is for the tree the
checks ran on, and nothing a check wrote stays to be run later.

Three layers, and what each one holds against:

- **The sandbox, against what a check executes** (dependencies, build
  scripts, tests). Each operation is started in its own sandbox
  (`@anthropic-ai/sandbox-runtime`) with the profile `delivery-gate.json`
  names for it, in `scripts/gate/profiles/`. A profile is the contract of
  the operation: `offline` (build, perf) has no network; `loopback` (unit,
  mutation testing) adds the loopback the tests' servers need, which on macOS
  is every local port. Both write the directory of the run and nothing else,
  and read nothing of the user's home but that directory, the gate's
  checkout and the tools PATH names. Before it runs anything, the gate tries
  under each profile, with a canary, a write in the worktree, the git
  directory, the gate's checkout, the home and a directory outside, each
  write and read the profile denies, and, for `offline`, a port of the host;
  it refuses to run when one succeeds. There is no unsandboxed fallback. A
  check passes when its command ran to its end with status 0: the sandbox
  runtime exits 0 when its command is ended by a signal, so the gate asks the
  command for a mark of its success as well.
- **The pre-push hook of git, against a push that skipped the gate.**
  `pnpm gate:install` puts it in the git directory, for every worktree. Git
  tells it the commits a push sends, whatever wrote the command (an alias, a
  script, another tool), and it refuses one whose tree has no passed verdict.
  It runs the gate of the main checkout and accepts the verdicts of that
  gate only (a verdict names the hash of the gate's code, configuration and
  profiles): a change that rewrites the gate is judged by the gate it
  replaces, run from the main checkout
  (`node <main>/scripts/gate/gate.mjs run` in the worktree).
- **The guard of the session, against going around the hook.** The
  `PreToolUse` hook of `.claude/settings.json` refuses a command that pushes
  while the pre-push hook is not the one git will run, and what the rules of
  `guard.refuse` name: turning the hook off (`--no-verify`,
  `core.hooksPath`), a forced push, a write to the repository through the
  API; and the GitHub tools that send content from their input.
  `.claude/settings.json` is the one permission file of the repository.

What the gate does not hold against, and what does:

- A session that writes a verdict file by hand, or moves the base revision,
  on purpose: the session can write what the gate writes. A command written
  to escape the guard's expressions: they are a list of known ways, not a
  proof. A tool that pushes without running git's hooks. The hosted Pipeline
  is what holds there; it does not run the mutation testing yet.
- The truth of the results: they come from the tree that is judged. A test
  suite that lies passes.
- Dependencies that are not the ones of the lockfile: the copy takes
  `node_modules` as it is in the worktree. The hosted Pipeline installs from
  the lockfile.
- A change that only deletes lines: no line of it is left to mutate.
- On macOS, under `loopback`, a service of the host that listens on
  localhost; and what is readable outside the user's home.

What the gate runs, what counts as production code, what an operation may
reach and what the guard refuses are in `delivery-gate.json` and
`scripts/gate/profiles/`: change those files, not `scripts/gate/*.mjs`. The
decisions are in `gate-lib.mjs`, tested with doubles and inside the gate's
own mutation perimeter; `gate.mjs` holds the adapters and is tested as a
program: a real repository, a real push, and a run with a stand-in for the
sandbox runtime. The sandbox runtime itself is proved by the canary at each
run. It needs Node 22.12 or later, and macOS or Linux.

---

## What NOT to do

- Don't add `// TODO` without an issue reference.
- Don't add backwards-compatibility shims for code paths nobody uses. If it's
  built, it must be called.
- Don't introduce a new abstraction with one implementation. Three concrete
  uses before extracting.
- Don't catch errors "just in case." Either name the failure mode or let it
  propagate.
- Don't add a test that mirrors the implementation. The implementation is
  what we're testing — the test must independently verify the contract.

---

## Code of Conduct

This project follows [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Same
standard applies to issues, PRs, and review discussion as to the project's
own audit cycle: cite, disagree on merits, and acknowledge what you can't
verify.

---

## Reporting security issues

See [`SECURITY.md`](SECURITY.md). Don't open public issues for security
concerns; use the disclosure channel documented there.

---

## License

MIT. Contributions are licensed under the same.
