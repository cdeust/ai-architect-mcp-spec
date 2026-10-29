# Native CI re-render from template main 5f5537a (2026-10-29)

Template: cdeust/zetetic-team-subagents main `5f5537a` (#220 alias merge, #222 private fetch on private repository, #223 Codex receipt reading).
Command: `python3 scripts/lib/render_ci.py <repo> --native-review` (template worktree at 5f5537a; second run wrote 0 files, idempotent).
Checks: actionlint on .github/workflows/*.yml exit 0; `python3 -B -m unittest discover -s scripts/tests -p 'test_ci*.py'` OK.
Files are rendered output only; the template was not modified.
