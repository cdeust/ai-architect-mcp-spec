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


timestamp = native["timestamp"]


def current_runs(api, repository, pr, head):
    path = (f"/repos/{repository}/actions/workflows/claude-review.yml/runs"
            f"?event=pull_request_target&head_sha={head}")
    title = f"Review PR {pr['number']} at {head}"
    runs = [run for run in api.records(path, "workflow_runs")
            if protected_run(run, repository, REVIEW_PATH, "pull_request_target")
            and run["display_title"] == title]
    if not runs or any(run.get("status") != "completed" for run in runs):
        raise ValueError("protected Claude review has not succeeded on this head")
    # REST run IDs and created_at identify the original event. updated_at includes
    # completion of the latest attempt, including a rerun of an older-numbered run.
    runs.sort(key=lambda run: timestamp(run["updated_at"]))
    if len(runs) > 1 and runs[-1]["updated_at"] == runs[-2]["updated_at"]:
        raise ValueError("ambiguous order of protected Claude review attempts")
    return runs


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


def claude_state(pages, head, repo, runs, bot):
    attempt_by_id = {run["id"]: run["run_attempt"] for run in runs}
    current = runs[-1]["id"], runs[-1]["run_attempt"]
    link = re.compile(rf"\[View job run\]\(https://github\.com/{re.escape(repo)}/actions/runs/"
                      r"([1-9][0-9]*)/attempts/([1-9][0-9]*)\)")
    latest, older_blocks = [], []
    for page in pages:
        for row in native["native_comments"](page, head)["nodes"]:
            if row["author"] != bot:
                continue
            lines = row["body"].strip().split("\n")
            selected = []
            for line in lines:
                match = link.fullmatch(line)
                if match:
                    run_id, attempt = map(int, match.groups())
                    if attempt <= attempt_by_id.get(run_id, 0):
                        selected.append((line, (run_id, attempt)))
            if not selected:
                continue
            if row["editor"] != (bot if row["lastEditedAt"] is not None else None):
                raise ValueError("unverified Claude verdict editor")
            if (len(selected) != 1 or lines[-3:-1] != [f"Reviewed commit: {head}", selected[0][0]]
                    or sum(line.startswith("Verdict:") for line in lines) != 1
                    or lines[-1] not in ("Verdict: approve", "Verdict: block")):
                raise ValueError("invalid Claude verdict")
            issued = timestamp(row["lastEditedAt"] or row["createdAt"])
            if selected[0][1] == current:
                latest.append((lines[-1], issued))
            elif lines[-1] == "Verdict: block":
                older_blocks.append(issued)
    if len(latest) != 1 or latest[0][0] != "Verdict: approve":
        return "block"
    return "block" if any(issued >= latest[0][1] for issued in older_blocks) else "approve"


def require_reviews(api, repository, pr, head, tested_at=None):
    runs = current_runs(api, repository, pr, head)
    run = runs[-1]
    if run.get("conclusion") != "success":
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
    last_change = None
    for page in pages:
        pull = page["data"]["repository"]["pullRequest"]
        changes = pull["timelineItems"]["nodes"]
        if pull["baseRefName"] != "main" or not isinstance(changes, list) or len(changes) > 1:
            raise ValueError("unverified PR base")
        if changes:
            changed = timestamp(changes[0]["createdAt"])
            last_change = max(changed, last_change or changed)
            proofs = [run["created_at"]] + ([] if tested_at is None else [tested_at])
            if any(timestamp(at) <= changed for at in proofs):
                raise ValueError("a new review and Pipeline are required after the base change")
    if native["state"](pages, head, created_after=last_change)[0] != "approve":
        raise ValueError("native Codex approval is missing")
    if claude_state(pages, head, repository, runs, CLAUDE) != "approve":
        raise ValueError("native Claude approval is missing or conflicting")
