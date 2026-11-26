"""Wake the resolver once the approval record of this label has finished, or say why not.

Runs in `Owner approval wake` (.github/workflows/owner-approval-wake.yml), from the
pull request: it decides nothing, since the resolver reads the record of
`Owner approval` (run from main) itself. It never ends in silence: when the record
did not run, or has not finished in time, the job fails with a summary that names
the cause and the owner's gesture that starts again, removing and setting the label.
"""
from datetime import datetime, timedelta, timezone
import json
import os
import subprocess
import sys
import time

DEADLINE_SECONDS = 10 * 60  # the job's timeout-minutes (12) leaves room for the summary
POLL_SECONDS = 15
LABEL = "owner-approved"
AGAIN = "Remove the owner-approved label and set it again."


def title(pr, head, actor):
    """The run title `Owner approval` (owner-approval.yml) writes for this event."""
    return f"Owner approval labeled PR {pr} label {LABEL} at {head} by {actor}"


def records(repo, since, read):
    """Every pull_request_target run of owner-approval.yml created since `since`, all pages."""
    pages = read(f"repos/{repo}/actions/workflows/owner-approval.yml/runs"
                 f"?event=pull_request_target&created=%3E%3D{since}&per_page=100")
    return [run for page in pages for run in page.get("workflow_runs", [])]


def wait(repo, pr, head, actor, read, clock, sleep, deadline=DEADLINE_SECONDS):
    """Return (ok, message) once the record has finished, or the deadline passed."""
    since = (datetime.fromtimestamp(clock(), timezone.utc) - timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
    expected = title(pr, head, actor)
    start = clock()
    while True:
        finished = [run for run in records(repo, since, read)
                    if run.get("display_title") == expected and run.get("status") == "completed"]
        if finished:
            run = max(finished, key=lambda run: (run.get("created_at") or "", run.get("id") or 0))
            if run.get("conclusion") == "success":
                return True, "The approval record finished; the resolver is woken."
            return False, (f"The approval record did not run (conclusion {run.get('conclusion')}): an Actions "
                           "event policy may block pull_request_target for .github/workflows/owner-approval.yml. "
                           "No merge follows. " + AGAIN)
        if clock() - start >= deadline:
            return False, ("No finished approval record after 10 minutes, so the resolver is not woken and "
                           "no merge follows. " + AGAIN)
        sleep(POLL_SECONDS)


def gh_pages(path):
    raw = subprocess.check_output(["gh", "api", "--paginate", "--slurp", path], timeout=60)
    return json.loads(raw)


def main():
    env = os.environ
    ok, message = wait(env["GH_REPO"], int(env["PR"]), env["HEAD_SHA"], env["ACTOR"],
                       gh_pages, time.time, time.sleep)
    print(message)
    with open(env["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
        print(message, file=summary)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
