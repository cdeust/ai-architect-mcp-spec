#!/usr/bin/env python3
"""Count the Claude reviews a pull request already received and apply the cap.

Runs from the trusted default-branch checkout of claude-review.yml, before the
review action. It reads workflow-run metadata only: no PR content, no comment
text. A Claude review counts when its own run attempt succeeded for the same PR, ran under the
review contract (the in-job counting step, or the historical budget job) and the action step
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
# Historical runs used a separate budget job. New runs count in the action's
# own job so a failed-job rerun also checks the remaining rounds (ADR-1129).
BUDGET_JOB = "Claude review budget"
BUDGET_STEP = "Count the reviews this PR already received"
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


def page_records(gh, args, key):
    pages = json.loads(gh([*args, "--paginate", "--slurp"]))
    if not isinstance(pages, list) or not pages:
        raise BudgetError("missing REST pages")
    records = [record for page in pages for record in page[key]]
    if (any(type(page["total_count"]) is not int or page["total_count"] != len(records) for page in pages)
            or any(type(record["id"]) is not int or record["id"] < 1 for record in records)
            or len({record["id"] for record in records}) != len(records)):
        raise BudgetError("incomplete or ambiguous REST results")
    return records


def workflow_runs(gh, repo, *filters):
    args = [f"repos/{repo}/actions/workflows/claude-review.yml/runs", "--method", "GET",
            "-f", f"per_page={PER_PAGE}"]
    for field in filters:
        args.extend(("-f", field))
    return page_records(gh, args, "workflow_runs")


def candidate_runs(gh: Gh, repo: str, pr: int, head_ref: str):
    return [row for row in workflow_runs(gh, repo, "event=pull_request", f"branch={head_ref}")
            if [pull["number"] for pull in row["pull_requests"]] == [pr]]


def protected_candidates(gh, repo, pr, created):
    # pull_request_target runs on main; the protected title carries the actual PR head.
    selected = []
    for row in workflow_runs(gh, repo, "event=pull_request_target", f"created=>={created}"):
        matched = re.fullmatch(rf"Review PR {pr} at ([a-f0-9]{{40}})", row["display_title"])
        if matched:
            selected.append({**row, "head_sha": matched[1]})
    return selected


def counted_reviews(gh, repo, run, last_attempt):
    run_id = run["id"]
    prefix = f"repos/{repo}/actions/runs/{run_id}"
    # gh accepts --paginate with --slurp, and forbids adding --jq to that pair.
    jobs = page_records(gh, [f"{prefix}/jobs?filter=all&per_page={PER_PAGE}"], "jobs")
    if any(job["run_id"] != run_id for job in jobs):
        raise BudgetError("job belongs to another run")
    legacy = any(job["name"] == BUDGET_JOB for job in jobs)
    def succeeded(attempt):
        if attempt == run["run_attempt"]:
            return run["conclusion"] == "success"
        record = json.loads(gh([f"{prefix}/attempts/{attempt}"]))
        if (record["id"] != run_id or record["run_attempt"] != attempt or record["status"] != "completed"
                or not isinstance(record["conclusion"], str) or not record["conclusion"]):
            raise BudgetError("historical run attempt is not verified")
        return record["conclusion"] == "success"

    present = {job["run_attempt"] for job in jobs}
    if any(succeeded(attempt) for attempt in set(range(1, last_attempt + 1)) - present):
        raise BudgetError("missing jobs of a successful attempt")
    reviews, seen = [], set()
    for job in jobs:
        attempt = job["run_attempt"]
        if type(attempt) is not int or attempt < 1 or attempt > run["run_attempt"]:
            raise BudgetError("invalid historical review attempt")
        if attempt > last_attempt or job["name"] != "Claude review":
            continue
        if attempt in seen:
            raise BudgetError("ambiguous Claude job for one attempt")
        seen.add(attempt)
        if job["status"] != "completed" or job["conclusion"] != "success":
            continue
        relevant = [step for step in job["steps"] if step["name"] in (BUDGET_STEP, ACTION_STEP)]
        steps = {step["name"]: step for step in relevant}
        if len(steps) != len(relevant):
            raise BudgetError("ambiguous Claude job steps")
        counted = steps.get(BUDGET_STEP, {})
        if not legacy and counted.get("conclusion") != "success":
            continue
        action = steps.get(ACTION_STEP, {})
        if action.get("conclusion") != "success":
            continue
        if succeeded(attempt):
            reviews.append({"head_sha": run["head_sha"], "created_at": action["completed_at"]})
    return reviews


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


def budget(gh: Gh, repo: str, pr: int, run_id: int, head_ref: str, labels, created=None, run_attempt=1):
    runs = candidate_runs(gh, repo, pr, head_ref)
    if created:
        runs.extend(protected_candidates(gh, repo, pr, created))
    seen, reviews = set(), []
    for run in runs:
        identity, attempt = run["id"], run["run_attempt"]
        if type(attempt) is not int or attempt < 1 or type(identity) is not int or identity < 1 or identity in seen:
            raise BudgetError("invalid or duplicate workflow run")
        seen.add(identity)
        last = attempt
        if identity == run_id:
            if attempt != run_attempt:
                raise BudgetError("current attempt does not match workflow history")
            last = attempt - 1
        if last:
            reviews.extend(counted_reviews(gh, repo, run, last))
    if run_attempt < 1 or (run_attempt > 1 and run_id not in seen):
        raise BudgetError("current rerun history unavailable")
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
        int(env["RUN_ATTEMPT"]),
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
