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
from urllib.parse import urlencode
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
    # pushes trigger the normal PR checks. Keep this credential in this process.
    url = os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"]
    url += ("&" if "?" in url else "?") + urlencode({"audience": "claude-code-github-action"})
    oidc = request(url, os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"])["value"]
    result = request("https://api.anthropic.com/api/github/github-app-token-exchange", oidc,
                     "POST", {"permissions": {"contents": "write", "issues": "write",
                                              "pull_requests": "write"}})
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
        if (pr["state"] != "open" or pr["head"]["repo"]["full_name"] != repository
                or pr["base"]["repo"]["full_name"] != repository
                or pr["head"]["ref"] in (base, pr["base"]["repo"]["default_branch"])):
            raise ValueError("Publication requires an open, same-repository non-default branch")
        branch, sha = pr["head"]["ref"], pr["head"]["sha"]
    else:
        branch = f"claude/issue-{number}-{int(run)}"
    if branch == base:
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


def publish(event, repository, token, candidate, api, scratch):
    revision = os.environ["BASE_SHA"]
    if candidate.branch != os.environ["EXPECTED_BRANCH"] or not re.fullmatch("[0-9a-f]{40}", revision):
        raise ValueError("The target changed during preparation")
    if api(f"issues/{int(event['issue']['number'])}")["state"] != "open":
        raise ValueError("The request was closed during preparation")
    proposal = scratch / "proposal"
    patch = (proposal / "change.patch").read_bytes()
    answer = (proposal / "answer.md").read_text().strip()
    number = int(event["issue"]["number"])
    if patch:
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
            if candidate.revision not in {revision, commit}:
                raise ValueError("The target advanced during preparation")
            subprocess.run([*git, "push", repo_url, f"{commit}:refs/heads/{candidate.branch}"],
                           env=env, check=True)
        if not candidate.pull_request:
            query = urlencode({"state": "all", "head": f"{repository.split('/')[0]}:{candidate.branch}",
                               "base": candidate.base})
            existing = api("pulls?" + query)
            pr = existing[0] if existing else api("pulls", "POST", {"head": candidate.branch, "base": candidate.base,
                     "title": event["issue"]["title"], "body": f"Requested in #{number}.",
                     "draft": True})
            answer += f"\n\nDraft pull request: {pr['html_url']}"
    elif candidate.revision != revision:
        raise ValueError("The target advanced during preparation")
    if answer:
        marker = f"<!-- owner-mention-run {int(os.environ['GITHUB_RUN_ID'])} -->"
        path = f"issues/{number}/comments"
        page = 1
        while True:
            comments = api(f"{path}?per_page=100&page={page}")
            if any(comment["user"]["login"] == "claude[bot]" and
                   comment["body"].endswith(marker) for comment in comments):
                return
            if len(comments) < 100:
                break
            page += 1
        api(path, "POST", {"body": answer + "\n\n" + marker})


def main(mode):
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    repository = os.environ["GITHUB_REPOSITORY"]

    def run(token):
        def api(path, method="GET", body=None):
            return request(f"https://api.github.com/repos/{repository}/{path}", token, method, body)
        candidate = target(event, repository, os.environ["GITHUB_SHA"], os.environ["GITHUB_RUN_ID"], api)
        if mode == "publish":
            publish(event, repository, token, candidate, api, Path(os.environ["RUNNER_TEMP"]))
        else:
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
