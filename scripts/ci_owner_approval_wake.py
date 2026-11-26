"""Wake the resolver once the approval record of this label has finished, or say why not.

Runs in `Owner approval wake` (.github/workflows/owner-approval-wake.yml), from the
pull request's own checkout, with `actions: read` only. A pull request can change
this script; at worst it then does not wake the resolver, or writes a false
summary. It cannot cause a merge: the resolver of main reads the record of
`Owner approval` (run from main) and the label's events itself.

It waits for the record born of its own event: only records created from shortly
before this wake run count, and it concludes on the newest record of this title,
whatever its status. It never ends in silence: when the record did not run, has
not finished in time, or the records cannot be read, the job fails with a summary
that names the cause and the owner's gesture that starts again.
"""
from datetime import datetime, timedelta, timezone
import json
import os
import re
import subprocess
import sys
import time

DEADLINE_SECONDS = 10 * 60  # the job's timeout-minutes (12) leaves room for the summary
POLL_SECONDS = 15
# The record and this wake are started by the same `labeled` event, within
# seconds; a record older than this margin belongs to an earlier event.
MARGIN_SECONDS = 30
LABEL = "owner-approved"
AGAIN = "Remove the owner-approved label and set it again."
POLICY = ("an Actions event policy may block pull_request_target for "
          ".github/workflows/owner-approval.yml")
# Any title of a record that executed main's workflow; a run GitHub blocks may
# carry another title.
RECORD = re.compile(r"Owner approval \S+ PR [1-9][0-9]* label \S+ base \S+ at [0-9a-f]{40} by \S+")
STAMP = "%Y-%m-%dT%H:%M:%SZ"


def title(pr, base, head, actor):
    """The run title `Owner approval` (owner-approval.yml) writes for this event."""
    return f"Owner approval labeled PR {pr} label {LABEL} base {base} at {head} by {actor}"


def records(repo, since, read):
    """Every pull_request_target run of owner-approval.yml created since `since`, all pages."""
    pages = read(f"repos/{repo}/actions/workflows/owner-approval.yml/runs"
                 f"?event=pull_request_target&created=%3E%3D{since}&per_page=100")
    return [run for page in pages for run in page.get("workflow_runs", [])]


def wait(repo, pr, base, head, actor, started, read, clock, sleep, deadline=DEADLINE_SECONDS):
    """Return (ok, message) once this event's record has finished, or the deadline passed.

    `started` is when this wake run was created (seconds since the epoch).
    """
    since = datetime.fromtimestamp(started - MARGIN_SECONDS, timezone.utc).strftime(STAMP)
    expected = title(pr, base, head, actor)
    start = clock()
    while True:
        runs = records(repo, since, read)
        mine = [run for run in runs if run.get("display_title") == expected]
        if mine:
            run = max(mine, key=lambda run: (run.get("created_at") or "", run.get("id") or 0))
            if run.get("status") == "completed":
                if run.get("conclusion") == "success":
                    return True, "The approval record finished; the resolver is woken."
                return False, (f"The approval record did not run (conclusion {run.get('conclusion')}): "
                               f"{POLICY}. No merge follows. " + AGAIN)
        elif any(run.get("status") == "completed" and run.get("conclusion") != "success"
                 and not RECORD.fullmatch(run.get("display_title") or "") for run in runs):
            return False, (f"An approval record was blocked before it ran: {POLICY}. No merge follows. " + AGAIN)
        if clock() - start >= deadline:
            return False, ("No finished approval record after 10 minutes, so the resolver is not woken and "
                           f"no merge follows; {POLICY}, or GitHub is slow. " + AGAIN)
        sleep(POLL_SECONDS)


def gh_pages(path):
    raw = subprocess.check_output(["gh", "api", "--paginate", "--slurp", path], timeout=60)
    return json.loads(raw)


def created(repo, run_id, read):
    """When this wake run was created, in seconds since the epoch."""
    [run] = read(f"repos/{repo}/actions/runs/{run_id}")
    return datetime.strptime(run["created_at"], STAMP).replace(tzinfo=timezone.utc).timestamp()


def main(read=gh_pages, clock=time.time, sleep=time.sleep):
    env = os.environ
    try:
        started = created(env["GH_REPO"], int(env["GITHUB_RUN_ID"]), read)
        ok, message = wait(env["GH_REPO"], int(env["PR"]), env["BASE"], env["HEAD_SHA"], env["ACTOR"],
                           started, read, clock, sleep)
    except (subprocess.SubprocessError, OSError, ValueError, KeyError) as error:
        ok, message = False, (f"Reading the approval records failed ({type(error).__name__}), so the resolver "
                              "is not woken and no merge follows. " + AGAIN)
    print(message)
    with open(env["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
        print(message, file=summary)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
