# Coase Dispatch Policy — 2026-05-04

**Analyst:** Coase (boundary + transaction-cost agent)
**Scope:** Parallel engineer dispatch in the agentic-ai monorepo
**Trigger:** 15 locked worktrees observed; cross-agent contamination causing pre-push gate failures

This audit records the May 2026 proposal. The old dispatch helper has been
retired. For current worktree handling and the shared pre-push gate, follow
the repository's [agent guidance](../agent-guidance.md#the-delivery-gate).

---

## §1 Option Matrix

| Dimension | A: One agent / worktree (current) | B: One agent / clone | C: Branch + locked main | D: CI-as-builder |
|---|---|---|---|---|
| **Filesystem cost** | ~600 MB/worktree (node_modules copied) | ~1.2 GB/clone (full object store duplicated) | ~600 MB/worktree | Near-zero local; CI runner storage |
| **Time-to-spawn** | 45–90 s (pnpm install in fresh tree) | 3–8 min (clone + install) | 45–90 s | 0 s local; 3–5 min CI queue |
| **Time-to-merge-PR** | Fast if worktree clean; stalls if locked | Fast; no lock contention | Fast | Fast; bottleneck is CI queue depth |
| **Blast radius (single agent failure)** | Leaves locked worktree; poisons next dispatch | Isolated; failure deletes clone | Branch-only; main remains clean | Branch-only; CI runner is ephemeral |
| **Coordination cost (internal)** | **High** — orchestrator must serialize cleanup; no enforcement today | Low | Medium — orchestrator must lock/unlock main | Low — orchestrator only monitors CI status |
| **Transaction cost (external)** | Low | High — clone time, disk I/O per agent | Low | Medium — CI API calls, queue wait, credential management |
| **Root cause of current failure** | Agents `cd` out of assigned worktree; locked worktrees never removed | N/A | N/A | N/A |

**Evidence base:** 15 worktrees currently locked in `.claude/worktrees/`; zero cleanup hooks installed in `.git/hooks/` (only `.sample` files present); `git status --porcelain` shows untracked `.claude/` in main working tree, confirming root contamination.

---

## §2 Recommended Option: A (repaired) with Option C boundary rule

**Option B** has a transaction cost that does not clear: a full `git clone` per agent on a repo with 600 MB node_modules takes 3–8 minutes and ~1.2 GB disk. With 11 parallel agents, that is 13 GB of disk usage and 5+ minutes of pure spawn overhead. The savings (simpler isolation) do not exceed the cost at this dispatch frequency.

**Option D** relocates the build boundary to CI, which is correct long-term but does not address the immediate contamination problem — agents still write to the shared worktree before pushing.

**Option A is the efficient boundary**, but only with two repairs drawn from Option C:

1. The main working tree (`/Users/cdeust/Developments/prd-spec-generator`) is designated read-only for all engineer agents — equivalent to "locking main."
2. Worktree cleanup is made atomic with dispatch: the orchestrator removes the worktree before confirming success back to the user.

**Coase condition:** the coordination cost of enforcing worktree isolation is lower than the transaction cost of cloning per agent or the ongoing transaction cost of contamination incidents (failed CI, manual `git worktree remove --force`, debug time).

---

## §3 Orchestrator Policy

### Before dispatching an engineer

1. Run `git -C /path/to/repo status --porcelain` — must be empty (ignoring `.claude/` via `.gitignore`). If not, ABORT dispatch and report the dirty file list.
2. Run `git -C /path/to/repo worktree list --porcelain` — confirm the target worktree slot does not already exist.
3. Pass the exact worktree path to the engineer prompt (see §4). Never omit it.

### After an engineer reports back

1. Verify the branch was pushed: `git -C <worktree-path> log origin/<branch> --oneline -1` must return output.
2. Run `git worktree remove <worktree-path>` (no `--force`). If this fails, the agent left uncommitted or unstaged changes — file a contamination report and do not dispatch the next agent until resolved.
3. Delete the local branch tracking entry if no longer needed.
4. Only then dispatch the next agent.

### Forbidden

- Dispatching two agents into the same worktree path.
- Allowing an agent to report success without verifying branch push.
- Using `--force` on `git worktree remove` silently — this means contamination occurred and must be logged.
- Passing the parent root path as the working directory.

---

## §4 Dispatch Contract (boilerplate for every engineer prompt)

```
WORKTREE CONTRACT — READ BEFORE ACTING

You are engineer agent <AGENT_ID>.
Your working directory is: <WORKTREE_PATH>
Your branch is: <BRANCH_NAME>

RULES:
1. Every file path you read or write MUST start with <WORKTREE_PATH>.
   NEVER reference /Users/cdeust/Developments/prd-spec-generator (the parent root).
2. Before your first commit, run:
     git -C <WORKTREE_PATH> status --porcelain
   If any line references files outside your assigned scope, ABORT and report
   "CONTAMINATION DETECTED: <file list>" to the orchestrator.
3. Do NOT bypass pre-push hooks with PRE_PUSH_SKIP_TESTS=1 or --no-verify
   except for branch deletion pushes (git push origin --delete <branch>).
4. When done, push your branch:
     git -C <WORKTREE_PATH> push -u origin <BRANCH_NAME>
   Then report "DONE: branch pushed, worktree clean" to the orchestrator.
5. Do NOT run git worktree remove yourself. The orchestrator does cleanup.
```

---

## §5 Automation List

| Item | Type | Owner | Status |
|---|---|---|---|
| Worktree cleanup verification (post-engineer) | Orchestrator-only policy | Orchestrator | **Policy defined in §3** |
| `.gitignore` entry for `.claude/worktrees/` | Config | Repository | **To add** |
| CI step: reject PRs from agents that bypassed pre-push | CI workflow | CI (GitHub Actions) | **Future — not blocking** |

---

## Boundary verdict

The proposed boundary was **Option A with Option C's lock rule**: one agent per worktree, main root reserved for the orchestrator, and cleanup verified before another dispatch.

The 15 currently-locked worktrees are direct evidence that the cleanup step has zero enforcement today. The policy in §3 closes that gap.
