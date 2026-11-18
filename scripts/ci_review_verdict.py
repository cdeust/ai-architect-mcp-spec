#!/usr/bin/env python3
"""Fail the review run when it posted no verdict the resolver can read (#361).

Meant to run in claude-review.yml right after the `PR Review` step, from the
trusted default-branch checkout; the step that calls it is a follow-up (#361),
because the change that adds it must touch .github/workflows. A review that
posts no verdict is not a review: the resolver holds the merge ("Claude has
not posted a verdict on this head") and only a new review run brings one. Run 44351841638 on #360 ended as a success
with only its progress list, so the budget counted it as one of the three
reviews of the branch although nothing was reviewed.

The run passes when a comment of `claude[bot]` (type Bot) links this run
(`/actions/runs/<RUN_ID>`, not followed by a digit) and carries a line
`Verdict: approve` or `Verdict: block`: the same comment test the resolver
applies in pipeline-post-merge.yml (`_review_approves`), which also requires the
run to succeed and its `PR Review` step to succeed. It exits non-zero
otherwise; once the step is wired, such a run concludes as a failure,
ci_review_budget.py (successful runs only) does not count it, and the next
push is admitted as the same round. Any API or protocol error also exits
non-zero.

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


def verdict_of_run(rows: list[Record], run_id: int) -> str | None:
    """The verdict the resolver would read for this run, or None.

    Of the reviewer comments that link this run, the one updated last wins, and
    within it the last verdict line, as in the resolver.
    """
    link = re.compile(re.escape(f"/actions/runs/{run_id}") + r"(?!\d)")
    found: tuple[str, str] | None = None
    for row in rows:
        body = row.get("body") or ""
        if row.get("login") != REVIEWER or row.get("type") != "Bot":
            continue
        if not link.search(body):
            continue
        verdicts = VERDICT.findall(body)
        if verdicts:
            candidate = (row.get("updated_at") or "", verdicts[-1])
            if found is None or candidate[0] >= found[0]:
                found = candidate
    return found[1] if found else None


def main() -> int:
    env = os.environ
    repo, pr, run_id = env["GH_REPO"], int(env["PR"]), int(env["RUN_ID"])
    verdict = verdict_of_run(comments(gh_api, repo, pr), run_id)
    if verdict is None:
        print(
            "::error title=Claude review posted no verdict::No comment of "
            f"{REVIEWER} links run {run_id} with a 'Verdict: approve' or "
            "'Verdict: block' line. A run without a verdict fails so that the "
            "review budget does not count it (#361)."
        )
        return 1
    print(f"Claude review verdict of run {run_id}: {verdict}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
