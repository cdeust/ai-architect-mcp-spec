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
from datetime import datetime, timedelta, timezone
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
# GitHub caps searches using event, branch or created at 1,000, even when more exist.
# https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow
SEARCH_LIMIT = 1000
SECOND = timedelta(seconds=1)
UTC_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
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


def utc_second(stamp):
    try:
        return datetime.strptime(stamp, UTC_FORMAT).replace(tzinfo=timezone.utc)
    except (TypeError, ValueError) as exc:
        raise BudgetError("invalid workflow creation time") from exc


def run_page(gh, args, number, expected_total=None):
    page = json.loads(gh([*args, "-f", f"page={number}"]))
    total, rows = page["total_count"], page["workflow_runs"]
    if (type(total) is not int or total < 0 or (expected_total is not None and expected_total != total)
            or not isinstance(rows, list) or len(rows) != min(PER_PAGE, total - (number - 1) * PER_PAGE)
            or any(type(row["id"]) is not int or row["id"] < 1 for row in rows)
            or len({row["id"] for row in rows}) != len(rows)):
        raise BudgetError("incomplete or ambiguous workflow run page")
    return total, rows


def remaining_pages(gh, args, total, first):
    rows = first.copy()
    for number in range(2, (total + PER_PAGE - 1) // PER_PAGE + 1):
        rows.extend(run_page(gh, args, number, total)[1])
    if len({row["id"] for row in rows}) != total:
        raise BudgetError("duplicate workflow run across pages")
    return rows


def workflow_runs(gh, repo, event, created, until, branch=None):
    args = [f"repos/{repo}/actions/workflows/claude-review.yml/runs", "--method", "GET",
            "-f", f"per_page={PER_PAGE}"]
    filtered = [*args, "-f", f"event={event}"]
    if branch is not None:
        filtered.extend(("-f", f"branch={branch}"))
    unfiltered = None

    def matches(row, start, end):
        return (row["event"] == event and (branch is None or row["head_branch"] == branch)
                and start <= utc_second(row["created_at"]) <= end)

    def window(start, end):
        nonlocal unfiltered
        bounds = f"created={start.strftime(UTC_FORMAT)}..{end.strftime(UTC_FORMAT)}"
        search = [*filtered, "-f", bounds]
        total, first = run_page(gh, search, 1)
        observed = first if total >= SEARCH_LIMIT else remaining_pages(gh, search, total, first)
        if not all(matches(row, start, end) for row in observed):
            raise BudgetError("workflow run outside its search")
        if total < SEARCH_LIMIT:
            return observed
        if start == end:
            # REST timestamps resolve to seconds. Only the unfiltered workflow listing has no search cap.
            # Read it once per search, bounded by its first total_count and the documented page size.
            if unfiltered is None:
                unfiltered = remaining_pages(gh, args, *run_page(gh, args, 1))
            rows = [row for row in unfiltered if matches(row, start, end)]
        else:
            middle = start + ((end - start) // SECOND // 2) * SECOND
            rows = window(start, middle) + window(middle + SECOND, end)
        ids = {row["id"] for row in rows}
        # At the cap, GitHub can report only 1,000. Above it the server exposed the full count.
        if (len(ids) != len(rows) or len(ids) < total or (total > SEARCH_LIMIT and len(ids) != total)
                or not all(row["id"] in ids for row in first)):
            raise BudgetError("workflow history changed or is incomplete across date windows")
        return rows

    # Older callers without the PR creation date can still recover their entire branch history.
    start = utc_second(created) if created is not None else datetime.fromtimestamp(0, timezone.utc)
    if start > until:
        raise BudgetError("PR creation time after budget snapshot")
    return window(start, until)


def candidate_runs(gh, repo, pr, head_ref, created, until):
    return [row for row in workflow_runs(gh, repo, "pull_request", created, until, head_ref)
            if [pull["number"] for pull in row["pull_requests"]] == [pr]]


def protected_candidates(gh, repo, pr, created, until):
    # pull_request_target runs on main; the protected title carries the actual PR head.
    selected = []
    for row in workflow_runs(gh, repo, "pull_request_target", created, until):
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
    until = datetime.now(timezone.utc).replace(microsecond=0)
    runs = candidate_runs(gh, repo, pr, head_ref, created, until)
    if created:
        runs.extend(protected_candidates(gh, repo, pr, created, until))
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
