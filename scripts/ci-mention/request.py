"""Resolve an owner mention and publish its patch without checking out candidate code."""
from contextlib import contextmanager
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


def request(url, token, method="GET", data=None):
    body = None if data is None else json.dumps(data).encode()
    req = Request(url, body, {"Authorization": f"Bearer {token}",
                              "Content-Type": "application/json"}, method=method)
    with urlopen(req, timeout=30) as response:
        raw = response.read()
        return json.loads(raw) if raw else None


@contextmanager
def installation_token():
    # Same audience, endpoint and installation permissions as the previously pinned
    # anthropics/claude-code-action f431ada, src/github/token.ts. App-authored
    # candidate refs and issue comments need separate writes. Keep this credential here.
    url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"]
    url += ("&" if "?" in url else "?") + urlencode({"audience": "claude-code-github-action"})
    oidc = request(url, os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"])["value"]
    result = request("https://api.anthropic.com/api/github/github-app-token-exchange", oidc,
                     "POST", {"permissions": {"contents": "write", "issues": "write",
                                              "pull_requests": "read"}})
    token = result.get("token") or result["app_token"]
    print(f"::add-mask::{token}", flush=True)
    try:
        yield token
    finally:
        request("https://api.github.com/installation/token", token, "DELETE")


@dataclass(frozen=True)
class Target:
    branch: str
    revision: str
    base: str
    pull_request: bool


def target(event, repository, sha, run, get):
    owner = event["repository"]["owner"]["login"]
    issue = event["issue"]
    if (event["repository"]["full_name"] != repository or event["sender"]["login"] != owner
            or issue["user"]["login"] != owner or issue["state"] != "open"):
        raise ValueError("Owner request is no longer eligible")
    number = int(issue["number"])
    base = event["repository"]["default_branch"]
    if issue.get("pull_request"):
        pr = get(f"pulls/{number}")
        # A deleted fork leaves head.repo null: refuse, do not crash.
        if (pr["state"] != "open" or (pr["head"].get("repo") or {}).get("full_name") != repository
                or (pr["base"].get("repo") or {}).get("full_name") != repository
                or pr["head"]["ref"] in (base, pr["base"]["repo"]["default_branch"])):
            raise ValueError("Publication requires an open, same-repository non-default branch")
        branch, sha, base = pr["head"]["ref"], pr["head"]["sha"], pr["base"]["ref"]
    else:
        branch = proposal_branch(number, int(run))
    if branch == base or branch.startswith("refs/"):
        raise ValueError("Publication requires a non-default branch")
    if not re.fullmatch("[0-9a-f]{40}", sha):
        raise ValueError("Invalid target revision")
    subprocess.run(["git", "check-ref-format", "--branch", branch], check=True,
                   stdout=subprocess.DEVNULL)
    return Target(branch, sha, base, bool(issue.get("pull_request")))


def apply_patch(store, revision, patch, git_env):
    def git(*args, **options):
        return subprocess.run(["git", "--git-dir", str(store), "-c", "core.hooksPath=/dev/null",
                               *args], env=git_env, check=True, capture_output=True, **options).stdout
    git("read-tree", revision)
    git("apply", "--cached", "--binary", "--whitespace=nowarn", "-", input=patch)
    tree = git("write-tree").decode().strip()
    return git("commit-tree", tree, "-p", revision, "-m", "Apply owner-requested Claude changes").decode().strip()


# The previous action passed the owner's comments to the model
# (include_comments_by_actor: repository owner). Only the owner's comments posted
# before the request, and not edited since, are kept, newest last, so a request can
# refer to the discussion above it. GitHub comment IDs grow with creation, so "before"
# is decided by ID, not by a timestamp that two comments can share. An `issues`
# event (opened, assigned) has no triggering comment: its request is the issue
# itself, and no comment is passed.
THREAD_COMMENTS = 50


def owner_thread(event, api):
    trigger = event.get("comment")
    if not trigger:
        return []
    owner = event["repository"]["owner"]["login"]
    comments, page = [], 1
    while True:
        rows = api(f"issues/{int(event['issue']['number'])}/comments?per_page=100&page={page}")
        comments += [{"created_at": row["created_at"], "body": row.get("body") or ""} for row in rows
                     if (row.get("user") or {}).get("login") == owner      # a deleted account is null
                     and int(row["id"]) < int(trigger["id"])
                     and (row.get("updated_at") or row["created_at"]) <= trigger["created_at"]]
        if len(rows) < 100:
            return comments[-THREAD_COMMENTS:]
        page += 1


# GitHub GraphQL Bot identity also used by ci_review_proof.py (architect-os#147, comment 7183310145).
CLAUDE = {"__typename": "Bot", "login": "claude", "id": "BOT_kgDODIGtWg"}
COMMENT = """query($id:ID!) { node(id:$id) { ... on IssueComment {
  id body lastEditedAt author { __typename login ... on Bot { id } }
  editor { __typename login ... on Bot { id } }
} } }"""
CANDIDATE = "<!-- owner-mention-candidate-v1 "
SHA = re.compile(r"[0-9a-f]{40}")


def proposal_branch(number, run):
    return f"claude/issue-{number}-{run}"


def last_marker(body, run):
    # The model may quote any marker in the answer. Only the publisher adds the final line.
    last = (body or "").splitlines()[-1:]
    return last[0] if last and (last[0] == f"<!-- owner-mention-run {run} -->"
                               or last[0].startswith(f"{CANDIDATE}{run} ")) else None


def receipts(api, number, run):
    found, page = [], 1
    while True:
        rows = api(f"issues/{number}/comments?per_page=100&page={page}")
        for row in rows:
            marker = last_marker(row.get("body"), run)
            if not marker or (row.get("user") or {}).get("node_id") != CLAUDE["id"]:
                continue
            graph = api("graphql", "POST", {"query": COMMENT, "variables": {"id": row["node_id"]}})
            if graph.get("errors"):
                raise ValueError("Unable to authenticate publication comment")
            node = graph["data"]["node"]
            if (node and node["id"] == row["node_id"] and node["author"] == CLAUDE
                    and node["editor"] is None and node["lastEditedAt"] is None
                    and node["body"] == row["body"]):
                found.append(marker)
        if len(rows) < 100:
            return set(found)
        page += 1


def branch_tip(api, branch):
    ref = api("git/ref/heads/" + quote(branch, safe="/"))
    if ref["ref"] != "refs/heads/" + branch or ref["object"]["type"] != "commit":
        raise ValueError("Branch identity or object type differs")
    return ref["object"]["sha"]


def inspect_candidate(repository, number, run, api):
    """Return the current, authenticated proposal to the independent delivery routine, read-only."""
    markers = receipts(api, number, run)
    if len(markers) != 1:
        raise ValueError("No unambiguous authenticated candidate")
    marker, = markers
    prefix = f"{CANDIDATE}{run} "
    if not marker.startswith(prefix) or not marker.endswith(" -->"):
        raise ValueError("This request has no candidate")
    receipt = json.loads(marker[len(prefix):-4])
    commit, parent = receipt["commit"], receipt["parent"]
    if not all(isinstance(value, str) and SHA.fullmatch(value) for value in (parent, commit)):
        raise ValueError("Invalid candidate revision")
    branch = proposal_branch(number, run)
    owner = repository.split("/")[0]
    repo = api("")
    issue = api(f"issues/{number}")
    event = {"repository": repo, "issue": issue, "sender": {"login": owner}}
    published = api(f"actions/runs/{run}")
    role = "PR" if issue.get("pull_request") else "issue"
    if (published["id"] != run or published["actor"]["login"] != owner
            or published["actor"]["id"] != repo["owner"]["id"]
            or published["display_title"] != f"Owner mention on {role} #{number}"
            or (role == "PR" and published["event"] != "issue_comment")
            or published["repository"]["full_name"] != repository
            or published["head_repository"]["full_name"] != repository
            or published["path"] != ".github/workflows/claude.yml"
            or published["event"] not in ("issues", "issue_comment")
            or published["head_branch"] != repo["default_branch"]
            or published["status"] != "completed" or published["conclusion"] != "success"):
        raise ValueError("Owner mention workflow is unverified or incomplete")
    target_now = target(event, repository, published["head_sha"], run, api)
    expected = {"repository": repository, "number": number, "base": target_now.base,
                "target": target_now.branch, "pr": target_now.pull_request, "parent": parent, "commit": commit}
    if receipt != expected or issue["number"] != number:
        raise ValueError("The owner request or destination changed")
    obj = api(f"git/commits/{commit}")
    if (branch_tip(api, branch) != commit or obj["sha"] != commit
            or [p["sha"] for p in obj["parents"]] != [parent]):
        raise ValueError("Candidate ref, commit or parent differs")
    if target_now.pull_request:
        if target_now.branch == branch or target_now.revision not in (parent, commit):
            raise ValueError("The pull request head changed")
        applied_pr = number if target_now.revision == commit else None
    else:
        query = urlencode({"state": "all", "head": f"{owner}:{branch}"})
        pulls = api("pulls?" + query)
        if pulls and (len(pulls) != 1 or pulls[0]["head"]["repo"]["full_name"] != repository
                      or pulls[0]["head"]["ref"] != branch or pulls[0]["head"]["sha"] != commit
                      or pulls[0]["base"]["repo"]["full_name"] != repository
                      or pulls[0]["base"]["ref"] != target_now.base):
            raise ValueError("Pull request for the candidate changed")
        applied_pr = pulls[0]["number"] if pulls else None
        if target_now.revision != parent or (applied_pr is None and branch_tip(api, target_now.base) != parent):
            raise ValueError("The proposal base changed")
    if applied_pr is not None:
        return {**receipt, "branch": branch, "status": "already published", "published_pr": applied_pr}
    return {**receipt, "branch": branch, "status": "awaiting verification"}


def publish(event, repository, token, candidate, api, scratch):
    revision = os.environ["BASE_SHA"]
    if candidate.branch != os.environ["EXPECTED_BRANCH"] or not re.fullmatch("[0-9a-f]{40}", revision):
        raise ValueError("The target changed during preparation")
    if api(f"issues/{int(event['issue']['number'])}")["state"] != "open":
        raise ValueError("The request was closed during preparation")
    proposal = scratch / "proposal"
    patch = (proposal / "change.patch").read_bytes()
    answer = (proposal / "answer.md").read_text().strip()
    number, run = int(event["issue"]["number"]), int(os.environ["GITHUB_RUN_ID"])
    marker = f"<!-- owner-mention-run {run} -->"
    existing = receipts(api, number, run) if patch or answer else set()
    if patch:
        branch = proposal_branch(number, run)
        if candidate.pull_request and branch == candidate.branch:
            raise ValueError("Candidate ref equals the pull request head")
        # Only a bare object store is used on the write-capable runner. The index
        # receives patch bytes. No file or hook from the candidate runs here.
        with tempfile.TemporaryDirectory(dir=scratch) as store:
            subprocess.run(["git", "init", "--bare", "--quiet", store], check=True)
            repo_url = f"https://github.com/{repository}.git"
            env = {**os.environ, "GH_TOKEN": token, "GIT_CONFIG_NOSYSTEM": "1",
                   "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_COUNT": "1",
                   "GIT_CONFIG_KEY_0": "credential.https://github.com.helper",
                   "GIT_CONFIG_VALUE_0": "!gh auth git-credential",
                   "GIT_AUTHOR_NAME": "Claude", "GIT_COMMITTER_NAME": "Claude",
                   "GIT_AUTHOR_EMAIL": "claude[bot]@users.noreply.github.com",
                   "GIT_COMMITTER_EMAIL": "claude[bot]@users.noreply.github.com"}
            timestamp = event.get("comment", event["issue"])["created_at"]
            env.update(GIT_AUTHOR_DATE=timestamp, GIT_COMMITTER_DATE=timestamp)
            git = ["git", "--git-dir", store]
            subprocess.run([*git, "fetch", "--no-tags", "--depth=1", repo_url,
                            revision], check=True, env=env)
            commit = apply_patch(store, revision, patch, env)
            if candidate.revision != revision:
                raise ValueError("The target advanced during preparation")
            receipt = {"repository": repository, "number": number, "base": candidate.base,
                       "target": candidate.branch, "pr": candidate.pull_request, "parent": revision, "commit": commit}
            marker = f"{CANDIDATE}{run} {json.dumps(receipt, sort_keys=True)} -->"
            if existing and existing != {marker}:
                raise ValueError("This request already published another result")
            # Existing PR heads are promoted only by their independent delivery session.
            ref = f"refs/heads/{branch}"
            remote = subprocess.run([*git, "ls-remote", "--refs", repo_url, ref],
                                    check=True, env=env, capture_output=True, text=True).stdout.strip()
            if (remote or existing) and remote != f"{commit}\t{ref}":
                raise ValueError("Candidate ref already names another commit")
            if not remote:
                subprocess.run([*git, "push", repo_url, f"{commit}:{ref}"], env=env, check=True)
        answer += (f"\n\nProposed commit [`{commit}`](https://github.com/{repository}/commit/{commit}) "
                   f"on `{branch}` from [run {run}](https://github.com/{repository}/actions/runs/{run}). "
                   "The delivery routine will check this head, record the test counts and obtain "
                   "an independent review before publishing it.")
    elif candidate.revision != revision:
        raise ValueError("The target advanced during preparation")
    if answer:
        if existing == {marker}:
            return
        if existing:
            raise ValueError("This request already published another result")
        api(f"issues/{number}/comments", "POST", {"body": answer.strip() + "\n\n" + marker})



def main(mode):
    if mode == "inspect":
        repository, issue, run = sys.argv[2:]
        def read(path, method="GET", body=None):
            endpoint = "graphql" if path == "graphql" else f"repos/{repository}" + ("/" + path if path else "")
            args = ["gh", "api", endpoint]
            if body is not None:
                args += ["--method", method, "--input", "-"]
            raw = subprocess.run(args, input=None if body is None else json.dumps(body), text=True,
                                 check=True, capture_output=True).stdout
            return json.loads(raw)
        print(json.dumps(inspect_candidate(repository, int(issue), int(run), read), sort_keys=True))
        return
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    repository = os.environ["GITHUB_REPOSITORY"]

    def run(token):
        def api(path, method="GET", body=None):
            endpoint = "graphql" if path == "graphql" else f"repos/{repository}/{path}"
            return request(f"https://api.github.com/{endpoint}", token, method, body)
        candidate = target(event, repository, os.environ["GITHUB_SHA"], os.environ["GITHUB_RUN_ID"], api)
        if mode == "publish":
            publish(event, repository, token, candidate, api, Path(os.environ["RUNNER_TEMP"]))
        else:
            thread = Path(os.environ["RUNNER_TEMP"]) / "owner-thread.json"
            thread.write_text(json.dumps(owner_thread(event, api)))
            with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                print(f"revision={candidate.revision}", file=output)
                print(f"branch={candidate.branch}", file=output)

    if mode == "resolve":
        run(os.environ["GH_TOKEN"])
    elif mode == "publish":
        with installation_token() as token:
            run(token)
    else:
        raise ValueError(mode)


if __name__ == "__main__":
    main(sys.argv[1])
