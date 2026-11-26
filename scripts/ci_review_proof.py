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
    ids = [(run["id"], run["run_attempt"]) for run in runs]
    if (any(type(run_id) is not int or run_id < 1 or type(attempt) is not int or attempt < 1
            for run_id, attempt in ids) or len({run_id for run_id, _ in ids}) != len(ids)):
        raise ValueError("ambiguous protected Claude run identities")
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


EDIT_HISTORY = """query($id:ID!, $after:String) {
  node(id:$id) { ... on IssueComment {
    id body createdAt lastEditedAt
    author { __typename login ... on Bot { id } }
    editor { __typename login ... on Bot { id } }
    userContentEdits(first:100, after:$after) {
      totalCount
      nodes { id editedAt deletedAt diff editor { __typename login ... on Bot { id } } }
      pageInfo { hasNextPage endCursor }
    }
  } }
}"""


def comment_history(api, row):
    cursor, seen_cursors, revisions = None, set(), set()
    total = None
    while True:
        result = api.request("POST", "/graphql", {"query": EDIT_HISTORY, "variables": {"id": row["id"], "after": cursor}})
        if result.get("errors"):
            raise ValueError("unable to read native comment history")
        comment = result["data"]["node"]
        if not comment or any(comment[key] != row[key] for key in ("id", "body", "createdAt", "lastEditedAt", "author", "editor")):
            raise ValueError("native comment changed while reading its history")
        edits = comment["userContentEdits"]
        size = edits["totalCount"]
        if type(size) is not int or size < 0 or (total is not None and size != total):
            raise ValueError("inconsistent native edit count")
        total = size
        for revision in edits["nodes"]:
            identity = revision["id"]
            if not isinstance(identity, str) or not identity or identity in revisions:
                raise ValueError("duplicate or missing native edit identity")
            revisions.add(identity)
            yield revision
        info = edits["pageInfo"]
        if info["hasNextPage"] is False:
            if len(revisions) != total:
                raise ValueError("incomplete native comment history")
            return
        cursor = info["endCursor"]
        if info["hasNextPage"] is not True or not isinstance(cursor, str) or not cursor or cursor in seen_cursors:
            raise ValueError("invalid native edit pagination")
        seen_cursors.add(cursor)


def claude_revisions(row, history):
    created = timestamp(row["createdAt"])
    if row["lastEditedAt"] is None:
        if row["editor"] is not None:
            raise ValueError("unverified Claude verdict editor")
        yield created, row["body"]
        return
    latest = timestamp(row["lastEditedAt"])
    if row["editor"] != CLAUDE or latest < created:
        raise ValueError("unverified Claude verdict editor or timestamp")
    previous = None
    for edit in history(row):
        at, body = timestamp(edit["editedAt"]), edit["diff"]
        if (edit["editor"] != CLAUDE or edit["deletedAt"] is not None or not isinstance(body, str)
                or at < created or (previous is not None and at > previous)):
            raise ValueError("unverified Claude verdict history")
        if previous is None and (at != latest or body != row["body"]):
            raise ValueError("missing latest Claude comment revision")
        yield at, body
        previous = at
    if previous != created:
        raise ValueError("missing original Claude comment revision")


def claude_receipt(body, commit, link, attempts):
    lines = body.strip().split("\n")
    if commit not in lines:
        return None
    if (len(lines) < 3 or lines[-3] != commit or lines.count(commit) != 1
            or sum(line.startswith("Verdict:") for line in lines) != 1
            or lines[-1] not in ("Verdict: approve", "Verdict: block")):
        raise ValueError("invalid Claude verdict")
    match = link.fullmatch(lines[-2])
    if not match:
        raise ValueError("unknown Claude attempt on this head")
    run_id, attempt = map(int, match.groups())
    if attempt > attempts.get(run_id, 0):
        raise ValueError("unobserved Claude attempt on this head")
    return (run_id, attempt), lines[-1]


def claude_state(pages, head, repo, runs, action, history):
    attempts = {run["id"]: run["run_attempt"] for run in runs}
    current = runs[-1]["id"], runs[-1]["run_attempt"]
    link = re.compile(rf"\[View job run\]\(https://github\.com/{re.escape(repo)}/actions/runs/"
                      r"([1-9][0-9]*)/attempts/([1-9][0-9]*)\)")
    commit = f"Reviewed commit: {head}"
    seen, blocks = set(), []
    approval = None
    for page in pages:
        for row in native["native_comments"](page, head)["nodes"]:
            if row["author"] != CLAUDE:
                continue
            identity = None
            # A later revision can remove the footer or change its verdict. Read
            # every revision before determining whether this comment names the head.
            for at, body in claude_revisions(row, history):
                receipt = claude_receipt(body, commit, link, attempts)
                if receipt is None:
                    continue
                attempt, verdict = receipt
                if attempt in seen or (identity is not None and attempt != identity):
                    raise ValueError("ambiguous Claude attempt on this head")
                identity = attempt
                if verdict == "Verdict: block":
                    blocks.append(at)
                elif attempt == current and row["lastEditedAt"] is None:
                    approval = at
            if identity is not None:
                seen.add(identity)
    started_at = timestamp(action["started_at"])
    if approval is None or not started_at <= approval <= timestamp(action["completed_at"]):
        return "block"
    # A distinct review which actually started after the block can resolve it.
    return "block" if any(at >= started_at for at in blocks) else "approve"


DELETIONS = """query($owner:String!, $repo:String!, $pr:Int!, $after:String) {
  repository(owner:$owner, name:$repo) { pullRequest(number:$pr) {
    headRefOid baseRefName
    timelineItems(first:100, after:$after, itemTypes:[COMMENT_DELETED_EVENT]) {
      filteredCount
      nodes { ... on CommentDeletedEvent { id createdAt deletedCommentAuthor { __typename login ... on Bot { id } } } }
      pageInfo { hasNextPage endCursor }
    }
  } }
}"""


def last_provider_deletions(api, repository, number, head):
    owner, repo = repository.split("/")
    variables = {"owner": owner, "repo": repo, "pr": number}
    deleted = {CLAUDE["id"]: "", native["BOT"]["id"]: ""}
    seen, events, total = set(), set(), None
    while True:
        data = api.request("POST", "/graphql", {"query": DELETIONS, "variables": variables})
        if data.get("errors"):
            raise ValueError("unable to read PR comment deletions")
        pr = data["data"]["repository"]["pullRequest"]
        if pr["headRefOid"] != head or pr["baseRefName"] != "main":
            raise ValueError("PR changed while reading comment deletions")
        timeline = pr["timelineItems"]
        size = timeline["filteredCount"]
        if type(size) is not int or size < 0 or (total is not None and total != size):
            raise ValueError("inconsistent comment-deletion count")
        total = size
        for event in timeline["nodes"]:
            identity = event["id"]
            if not isinstance(identity, str) or not identity or identity in events:
                raise ValueError("missing or duplicate comment-deletion event")
            events.add(identity)
            author = event["deletedCommentAuthor"]
            if author is not None and (not isinstance(author, dict) or not author.get("__typename")
                    or not author.get("login") or (author["__typename"] == "Bot" and not author.get("id"))):
                raise ValueError("unknown deleted comment author")
            at = timestamp(event["createdAt"])
            # GitHub preserves the deleted author's identity and the deletion time,
            # but not the body or head. Unknown authors can be either reviewer.
            for bot in (CLAUDE, native["BOT"]):
                if author is None or author.get("id") == bot["id"]:
                    deleted[bot["id"]] = max(deleted[bot["id"]], at)
        info = timeline["pageInfo"]
        if info["hasNextPage"] is False:
            if len(events) != total:
                raise ValueError("incomplete PR comment-deletion history")
            return deleted
        cursor = info["endCursor"]
        if info["hasNextPage"] is not True or not isinstance(cursor, str) or not cursor or cursor in seen:
            raise ValueError("invalid PR deletion pagination")
        seen.add(cursor)
        variables = dict(variables, after=cursor)


def review_snapshot(pages):
    # Only reviewer records and the base change affect the verdict. Human
    # discussion may continue while an edited provider comment is verified.
    snapshot = []
    for page in pages:
        pr = page["data"]["repository"]["pullRequest"]
        changes = tuple(item["createdAt"] for item in pr["timelineItems"]["nodes"])
        rows = [(row["id"], row["createdAt"], row["lastEditedAt"], row["body"], row["author"], row["editor"])
                for row in pr["comments"]["nodes"] if row["author"] in (CLAUDE, native["BOT"])]
        snapshot.append((pr["baseRefName"], changes, rows))
    # Page boundaries can move when an unrelated comment is added.
    return ({(base, changes) for base, changes, _ in snapshot}, [row for _, _, rows in snapshot for row in rows])


def attempt_snapshot(runs):
    return [(run["id"], run["run_attempt"], run["created_at"], run["updated_at"], run["conclusion"])
            for run in runs]


def require_reviews(api, repository, pr, head, tested_at=None):
    runs = current_runs(api, repository, pr, head)
    before = attempt_snapshot(runs)
    run = runs[-1]
    if run.get("conclusion") != "success":
        raise ValueError("protected Claude review has not succeeded on this head")
    attempt, run_id = run["run_attempt"], run["id"]
    path = f"/repos/{repository}/actions/runs/{run_id}/attempts/{attempt}/jobs"
    jobs = [job for job in api.records(path, "jobs") if job["name"] == "Claude review"]
    if len(jobs) != 1:
        raise ValueError("missing or ambiguous Claude review job")
    job = jobs[0]
    if (job["run_id"] != run_id or job["run_attempt"] != attempt or job["head_sha"] != run["head_sha"]
            or job["status"] != "completed" or job["conclusion"] != "success"):
        raise ValueError("Claude job identity or outcome differs")
    steps_by_name = {}
    for name in ("PR Review", "Record Claude approval"):
        steps = [step for step in job["steps"] if step["name"] == name]
        if len(steps) != 1 or steps[0]["conclusion"] != "success" or steps[0]["status"] != "completed":
            raise ValueError("Claude did not record an approval in this attempt")
        steps_by_name[name] = steps[0]
    pages = list(review_pages(api, repository, pr["number"], head))
    initial_reviews = review_snapshot(pages)
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
    def history(row):
        return comment_history(api, row)

    deleted = last_provider_deletions(api, repository, pr["number"], head)
    cutoff = max(last_change or "", deleted[native["BOT"]["id"]])
    if native["state"](pages, head, created_after=cutoff, history=history)[0] != "approve":
        raise ValueError("native Codex approval is missing")
    if claude_state(pages, head, repository, runs, steps_by_name["PR Review"], history) != "approve":
        raise ValueError("native Claude approval is missing or conflicting")
    if deleted[CLAUDE["id"]] >= timestamp(steps_by_name["PR Review"]["started_at"]):
        raise ValueError("a new Claude review is required after an unobservable comment deletion")
    if (review_snapshot(review_pages(api, repository, pr["number"], head)) != initial_reviews
            or last_provider_deletions(api, repository, pr["number"], head) != deleted):
        raise ValueError("review evidence changed during verification")
    if attempt_snapshot(current_runs(api, repository, pr, head)) != before:
        raise ValueError("protected Claude attempts changed while reading the reviews")
