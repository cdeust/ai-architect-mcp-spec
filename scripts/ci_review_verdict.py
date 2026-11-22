#!/usr/bin/env python3
"""Fail the review run when no verdict of it that the resolver can read is found (#361).

Runs in a separate job of claude-review.yml after a successful review, from a
fresh default-branch checkout. A review that
posts no verdict is not a review: the resolver holds the merge ("Claude has
not posted a verdict on this head") and only a new review run brings one. Run 44351841638 on #360 ended as a success
with only its progress list, so the budget counted it as one of the three
reviews of the branch although nothing was reviewed.

The run passes when a comment of `claude[bot]` (type Bot) links this run
(`/actions/runs/<RUN_ID>`, not followed by a digit) and carries a line
`Verdict: approve` or `Verdict: block`: the same comment test the resolver
applies in pipeline-post-merge.yml (`_review_approves`), which also requires the
run to succeed and its `PR Review` step to succeed. It exits non-zero
otherwise, so such a run concludes as a failure,
ci_review_budget.py (successful runs only) does not count it, and the next
push is admitted as the same round. Any API or protocol error also exits
non-zero. A verdict that links another reviewed run of the same head, which
the resolver would read, does not pass this run: #361 asks for a comment that
links this run (note 3 of review 1 of #366).

A verdict the API does not list yet, or a `gh api` call that fails or times
out, would fail a run that did post its verdict, and the resolver would then
hold the merge until the next push (note 2 of review 1 of #362). So the
comments are read up to READ_ATTEMPTS times, READ_RETRY_SECONDS apart, while
no verdict is found or the call fails; the last failure is raised. A protocol
error is not retried: a reply of the wrong shape is not a transient state.

Lines are split on "\n" only: `gh --jq` writes one compact JSON object per
line and escapes "\n", but leaves characters such as U+0085 or U+2028 raw,
which str.splitlines() would treat as line breaks inside a comment body.

Source: https://docs.github.com/en/rest/issues/comments#list-issue-comments
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from collections.abc import Callable
from typing import Any

Record = dict[str, Any]
Gh = Callable[[list[str]], str]

# The author the resolver reads verdicts from (pipeline-post-merge.yml).
REVIEWER = "claude[bot]"
# The verdict line the resolver reads (pipeline-post-merge.yml, _review_approves).
VERDICT = re.compile(r"^Verdict: (approve|block)\s*$", re.M)
# source: GitHub REST per_page maximum.
PER_PAGE = 100
# source: operational bound on one `gh api` call, far above its usual second.
GH_TIMEOUT_SECONDS = 60
# source: operational bound. The review posts its verdict before its step ends,
# so a comment missing from the list is a listing delay of seconds; three reads
# 10 s apart cover it. A run that posted nothing pays the two sleeps and two
# more reads, each bounded by GH_TIMEOUT_SECONDS: at most 2 x (10 + 60) = 140 s
# more than one read, and at most 3 x 60 + 2 x 10 = 200 s for the whole step
# (note 1 of review 1 of #363).
READ_ATTEMPTS = 3
READ_RETRY_SECONDS = 10
# The `gh api` failures worth another read: an error status or a timeout.
TRANSIENT = (subprocess.CalledProcessError, subprocess.TimeoutExpired)


class VerdictError(ValueError):
    """The comment metadata does not have the documented shape."""


def gh_api(args: list[str]) -> str:
    done = subprocess.run(
        ["gh", "api", *args],
        capture_output=True,
        text=True,
        check=True,
        timeout=GH_TIMEOUT_SECONDS,
    )
    return done.stdout


def comments(gh: Gh, repo: str, pr: int) -> list[Record]:
    text = gh(
        [
            f"repos/{repo}/issues/{pr}/comments?per_page={PER_PAGE}",
            "--paginate",
            "--jq",
            ".[] | {login: .user.login, type: .user.type, body, updated_at}",
        ]
    )
    rows = [json.loads(line) for line in text.split("\n") if line.strip()]
    if any(not isinstance(row, dict) for row in rows):
        raise VerdictError("protocol")
    return rows


def verdict_of_run(rows: list[Record], run_id: int, attempt_url: str | None = None) -> str | None:
    """The verdict the resolver would read for this run, or None.

    Of the reviewer comments that link this run, the last verdict line of each
    is paired with its `updated_at`, and the greatest pair wins: the resolver's
    `max(verdicts)`, so of two comments updated at the same instant `block`
    wins over `approve` there and here (note 1 of review 1 of #362).
    `updated_at` is read as the resolver reads it, `comment["updated_at"]`,
    without a default: the `--jq` filter always emits the key, and a null value
    gives the same verdict, or the same TypeError, here as there (note 2 of
    review 1 of #372).
    """
    link = (re.compile(re.escape(f"]({attempt_url})")) if attempt_url else
            re.compile(re.escape(f"/actions/runs/{run_id}") + r"(?!\d)"))
    found: list[tuple[str, str]] = []
    for row in rows:
        body = row.get("body") or ""
        if row.get("login") != REVIEWER or row.get("type") != "Bot":
            continue
        if not link.search(body):
            continue
        verdicts = VERDICT.findall(body)
        if verdicts:
            found.append((row["updated_at"], verdicts[-1]))
    return max(found)[1] if found else None


def read_verdict(
    read: Callable[[], list[Record]], run_id: int, sleep: Callable[[float], None],
    attempt_url: str | None = None,
) -> tuple[str | None, int]:
    """The verdict of this run, read again while it is missing or the call fails.

    Returns the verdict (None when no read found one) and how many reads failed,
    so that the annotation of a run whose earlier reads failed names them (note 2
    of review 1 of #363). The last read is outside the loop, so its failure is
    raised as it is: a None verdict always comes from a last read that succeeded
    and listed no verdict, whatever failed before (note 1 of review 1 of #364).
    It does not prove the review posted none: a verdict listed after the last
    read, or one the resolver cannot read, ends here too (note 1 of review 1 of
    #365).
    """
    failed = 0
    for attempt in range(1, READ_ATTEMPTS):
        try:
            found = verdict_of_run(read(), run_id, attempt_url)
        except TRANSIENT as error:
            failed += 1
            found, why = None, f"gh api failed: {type(error).__name__}"
        else:
            why = "no verdict listed"
        if found is not None:
            return found, failed
        print(f"Run {run_id}, read {attempt} of {READ_ATTEMPTS}: {why}; reading again.")
        sleep(READ_RETRY_SECONDS)
    return verdict_of_run(read(), run_id, attempt_url), failed


def main() -> int:
    env = os.environ
    repo, pr, run_id = env["GH_REPO"], int(env["PR"]), int(env["RUN_ID"])
    attempt_url = None
    if "RUN_ATTEMPT" in env:
        attempt_url = f"https://github.com/{repo}/actions/runs/{run_id}/attempts/{int(env['RUN_ATTEMPT'])}"
    verdict, failed = read_verdict(
        lambda: comments(gh_api, repo, pr), run_id, time.sleep, attempt_url
    )
    if verdict is None:
        print(
            "::error title=Claude review verdict not found::No comment of "
            f"{REVIEWER} links run {run_id} with a 'Verdict: approve' or "
            f"'Verdict: block' line after {READ_ATTEMPTS} reads"
            + (f", {failed} of which failed (gh api)" if failed else "")
            + ". A run whose verdict is not found fails so that the "
            "review budget does not count it (#361)."
        )
        return 1
    print(f"Claude review verdict of run {run_id}: {verdict}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
