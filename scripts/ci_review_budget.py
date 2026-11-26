#!/usr/bin/env python3
"""Count the Claude reviews a pull request already received and apply the cap.

Runs from the trusted default-branch checkout of claude-review.yml, before the
review action. It reads workflow-run metadata only: no PR content, no comment
text. A Claude review counts when its run is a success of the same PR, ran under the
review contract (it has the "Claude review budget" job) and the action step
("PR Review") itself succeeded, so runs that skipped the action because the cap
was reached do not count as reviews, nor do reviews of the workflow that
preceded the contract (ADR-1129). Historical runs that only verified Codex used no Claude round.

Writes `round`, `cap`, `skip` and `reviewed_sha` to $GITHUB_OUTPUT. At the cap
no fourth review runs without the budget extension; the merge still needs both verdicts. The label `claude-rereview` raises the cap by one
(a fourth review, never a fifth), however long the label stays attached (ADR-1119).
Any API or protocol error exits non-zero: no silent fallback to "review".

Sources: https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow
https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from collections.abc import Callable
from typing import Any

Record = dict[str, Any]
Gh = Callable[[list[str]], str]

# source: owner decision 2026-11-04 after Cortex PR 856: 20 automatic Claude
# reviews, 22 comments saying "nothing blocks merge", Codex converged in 3
# (ADR-1119).
CAP = 3
BYPASS_LABEL = "claude-rereview"
EXHAUSTED = (
    f"{CAP} of {CAP} reviews used. Both reviews remain required. The label "
    f"{BYPASS_LABEL} allows one more review (ADR-1119)."
)
# The step of claude-review.yml that runs the action; the test pins this name.
ACTION_STEP = "PR Review"
# The job of claude-review.yml that runs this script; the test pins this name.
# A run without it predates the review contract (the cap, then the verdict line
# the merge waits for) and does not count: a pull request reviewed only under
# the old workflow could otherwise never receive a verdict (ADR-1129).
BUDGET_JOB = "Claude review budget"
SHA = re.compile(r"[0-9a-f]{40}")
# source: GitHub REST per_page maximum.
PER_PAGE = 100
# source: operational bound on one `gh api` call, far above its usual second.
GH_TIMEOUT_SECONDS = 60


class BudgetError(ValueError):
    """The run metadata does not have the documented shape."""


def gh_api(args: list[str]) -> str:
    done = subprocess.run(
        ["gh", "api", *args],
        capture_output=True,
        text=True,
        check=True,
        timeout=GH_TIMEOUT_SECONDS,
    )
    return done.stdout


def _lines(text: str) -> list[Record]:
    rows = [json.loads(line) for line in text.splitlines() if line.strip()]
    if any(not isinstance(row, dict) for row in rows):
        raise BudgetError("protocol")
    return rows


def candidate_runs(gh: Gh, repo: str, pr: int, run_id: int, head_ref: str):
    jq = (
        ".workflow_runs[] | {id, conclusion, head_sha, created_at, "
        "prs: [.pull_requests[].number]}"
    )
    text = gh(
        [
            f"repos/{repo}/actions/workflows/claude-review.yml/runs",
            "--method",
            "GET",
            "--paginate",
            "--jq",
            jq,
            "-f",
            "event=pull_request",
            "-f",
            f"branch={head_ref}",
            "-f",
            f"per_page={PER_PAGE}",
        ]
    )
    return [
        row
        for row in _lines(text)
        if row.get("id") != run_id
        and row.get("conclusion") in {"success", "failure"}
        and pr in row.get("prs", [])
    ]


def protected_candidates(gh, repo, pr, run_id, created):
    # pull_request_target runs on main; the protected title carries the actual PR head.
    text = gh([f"repos/{repo}/actions/workflows/claude-review.yml/runs", "--method", "GET",
               "--paginate", "--jq", ".workflow_runs[] | {id, conclusion, display_title, created_at}",
               "-f", "event=pull_request_target", "-f", f"created=>={created}", "-f", f"per_page={PER_PAGE}"])
    selected = []
    for row in _lines(text):
        matched = re.fullmatch(rf"Review PR {pr} at ([a-f0-9]{{40}})", row["display_title"])
        if matched and row["id"] != run_id and row["conclusion"] == "success":
            selected.append({**row, "head_sha": matched[1]})
    return selected


def ran_claude_review(gh: Gh, repo: str, run: Record) -> bool:
    jq = (
        f'[.[].jobs[]] | select(any(.[]; .name == "{BUDGET_JOB}")) '
        f'| [.[] | select(.name == "Claude review") | .steps[]? '
        f'| select(.name == "{ACTION_STEP}") | .conclusion]'
    )
    text = gh([f"repos/{repo}/actions/runs/{run['id']}/jobs", "--paginate", "--slurp", "--jq", jq])
    # jq empty output means a run before the budget contract.
    conclusions = json.loads(text) if text.strip() else []
    if not isinstance(conclusions, list):
        raise BudgetError("protocol")
    return run.get("conclusion") == "success" and "success" in conclusions


def decide(reviews: list[Record], labels: list[str], cap: int = CAP) -> Record:
    ordered = sorted(reviews, key=lambda run: run["created_at"])
    count = len(ordered)
    # The label grants exactly one more review, however long it stays attached.
    allowed = cap + (1 if BYPASS_LABEL in labels else 0)
    last = ordered[-1]["head_sha"] if ordered else ""
    if last and not SHA.fullmatch(last):
        raise BudgetError("protocol")
    return {
        "round": count + 1,
        "cap": cap,
        "skip": "true" if count >= allowed else "false",
        "reviewed_sha": last,
    }


def budget(gh: Gh, repo: str, pr: int, run_id: int, head_ref: str, labels, created=None):
    runs = candidate_runs(gh, repo, pr, run_id, head_ref)
    if created:
        runs.extend(protected_candidates(gh, repo, pr, run_id, created))
    reviews = [run for run in runs if ran_claude_review(gh, repo, run)]
    return decide(reviews, labels)


def output_file(env) -> str:
    """$GITHUB_OUTPUT, accepted only inside the runner's temporary directory.

    The runner creates the file under $RUNNER_TEMP/_runner_file_commands; a path
    anywhere else is not the runner's and is refused (CodeQL py/path-injection).
    source: https://docs.github.com/en/actions/reference/workflows-and-actions/variables
    """
    base = os.path.realpath(env["RUNNER_TEMP"])
    path = os.path.realpath(env["GITHUB_OUTPUT"])
    if not path.startswith(base + os.sep):
        raise SystemExit("GITHUB_OUTPUT is outside RUNNER_TEMP")
    return path


def main() -> int:
    env = os.environ
    result = budget(
        gh_api,
        env["GH_REPO"],
        int(env["PR"]),
        int(env["RUN_ID"]),
        env["HEAD_REF"],
        json.loads(env.get("LABELS", "[]")),
        env.get("CREATED"),
    )
    with open(output_file(env), "a", encoding="utf-8") as out:
        for key, value in result.items():
            out.write(f"{key}={value}\n")
    if result["skip"] == "true":
        print(f"::notice title=Claude review budget used::{EXHAUSTED}")
    else:
        print(f"Claude review {result['round']} of {result['cap']}: go")
    return 0


if __name__ == "__main__":
    sys.exit(main())
