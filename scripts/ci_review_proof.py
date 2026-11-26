"""Authenticate the latest protected Claude attempt and both current GitHub verdicts."""

from pathlib import Path
import re
import runpy

native = runpy.run_path(str(Path(__file__).with_name("ci_native_verdict.py")))
# GitHub identifies this App account on architect-os#147, issuecomment-7183310145.
CLAUDE = {"login": "claude", "id": "BOT_kgDODIGtWg", "__typename": "Bot"}
REVIEW_PATH = ".github/workflows/claude-review.yml"
REVIEW_TITLE = re.compile(r"Review PR ([1-9][0-9]*) at ([a-f0-9]{40})")
WAKE_TITLE = re.compile(r"Review updated PR ([1-9][0-9]*)")


def protected_run(run, repository, path, event):
    if (run.get("path") != path or run.get("event") != event
            or (run.get("repository") or {}).get("full_name") != repository
            or (run.get("head_repository") or {}).get("full_name") != repository):
        return False
    if event in ("issue_comment", "workflow_run"):
        return run.get("head_branch") == "main"
    title = REVIEW_TITLE.fullmatch(run.get("display_title") or "")
    prs = run.get("pull_requests") or []
    if not title or len(prs) != 1:
        return False
    pr = prs[0]
    return (pr.get("number") == int(title[1]) and run.get("head_sha") == title[2]
            and pr.get("head", {}).get("sha") == title[2] and pr.get("base", {}).get("ref") == "main")


def current_run(api, repository, pr, head):
    path = (f"/repos/{repository}/actions/workflows/claude-review.yml/runs"
            f"?event=pull_request_target&head_sha={head}")
    title = f"Review PR {pr['number']} at {head}"
    runs = [run for run in api.records(path, "workflow_runs")
            if protected_run(run, repository, REVIEW_PATH, "pull_request_target")
            and run["display_title"] == title]
    return max(runs, key=lambda run: run["id"], default=None)


def review_pages(api, repository, number, head):
    owner, repo = repository.split("/")
    variables = {"owner": owner, "repo": repo, "pr": number}
    seen = set()
    while True:
        page = api.request("POST", "/graphql", {"query": native["QUERY"], "variables": variables})
        info = native["native_comments"](page, head)["pageInfo"]
        yield page
        if info["hasNextPage"] is False:
            return
        cursor = info["endCursor"]
        if info["hasNextPage"] is not True or not isinstance(cursor, str) or not cursor or cursor in seen:
            raise ValueError("invalid comment pagination")
        seen.add(cursor)
        variables = dict(variables, endCursor=cursor)


def claude_state(pages, head, repo, run, bot):
    link = f"[View job run](https://github.com/{repo}/actions/runs/{run['id']}/attempts/{run['run_attempt']})"
    verdicts = []
    for page in pages:
        for row in native["native_comments"](page, head)["nodes"]:
            if row["author"] != bot:
                continue
            lines = row["body"].strip().split("\n")
            if link not in lines:
                continue
            if row["editor"] != (bot if row["lastEditedAt"] is not None else None):
                raise ValueError("unverified Claude verdict editor")
            if (lines[-3:-1] != [f"Reviewed commit: {head}", link]
                    or sum(line.startswith("Verdict:") for line in lines) != 1
                    or lines[-1] not in ("Verdict: approve", "Verdict: block")):
                raise ValueError("invalid Claude verdict")
            verdicts.append(lines[-1])
    return "approve" if verdicts == ["Verdict: approve"] else "block"


def require_reviews(api, repository, pr, head, tested_at=None):
    run = current_run(api, repository, pr, head)
    if not run or run.get("status") != "completed" or run.get("conclusion") != "success":
        raise ValueError("protected Claude review has not succeeded on this head")
    attempt, run_id = run["run_attempt"], run["id"]
    if type(attempt) is not int or attempt < 1 or type(run_id) is not int or run_id < 1:
        raise ValueError("invalid protected run identity")
    path = f"/repos/{repository}/actions/runs/{run_id}/attempts/{attempt}/jobs"
    jobs = [job for job in api.records(path, "jobs") if job["name"] == "Claude review"]
    if len(jobs) != 1:
        raise ValueError("missing or ambiguous Claude review job")
    job = jobs[0]
    if (job["run_id"] != run_id or job["run_attempt"] != attempt or job["head_sha"] != run["head_sha"]
            or job["status"] != "completed" or job["conclusion"] != "success"):
        raise ValueError("Claude job identity or outcome differs")
    for name in ("PR Review", "Record Claude approval"):
        steps = [step for step in job["steps"] if step["name"] == name]
        if len(steps) != 1 or steps[0]["conclusion"] != "success" or steps[0]["status"] != "completed":
            raise ValueError("Claude did not record an approval in this attempt")
    pages = list(review_pages(api, repository, pr["number"], head))
    for page in pages:
        pull = page["data"]["repository"]["pullRequest"]
        changes = pull["timelineItems"]["nodes"]
        if pull["baseRefName"] != "main" or not isinstance(changes, list) or len(changes) > 1:
            raise ValueError("unverified PR base")
        if changes:
            changed = changes[0]["createdAt"]
            stamp = r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ"
            proofs = [run["created_at"]] + ([] if tested_at is None else [tested_at])
            if (not isinstance(changed, str) or not re.fullmatch(stamp, changed)
                    or any(not isinstance(at, str) or not re.fullmatch(stamp, at) or at <= changed for at in proofs)):
                raise ValueError("a new review and Pipeline are required after the base change")
    if native["state"](pages, head)[0] != "approve":
        raise ValueError("native Codex approval is missing")
    if claude_state(pages, head, repository, run, CLAUDE) != "approve":
        raise ValueError("native Claude approval is missing or conflicting")
