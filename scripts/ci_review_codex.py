"""Dispatch and verify native Codex GitHub reviews. No model or local account.

Source for the connector identity and the versioned summary:
https://github.com/cdeust/ai-architect-mcp-spec/pull/391#issuecomment-7078116054
"""
import json
import os
from pathlib import Path
import re
import subprocess
import time

# -I deliberately excludes the working directory. Only import the renderer-
# supplied verifier beside this trusted checkout's script.
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ci_native_verdict import QUERY, state


def inspect(repo, pr, sha):
    owner, name = repo.split("/")
    raw = subprocess.check_output(["gh", "api", "graphql", "--paginate", "--slurp",
        "-f", "query=" + QUERY, "-f", "owner=" + owner, "-f", "repo=" + name, "-F", f"pr={pr}"], timeout=60)
    return state(json.loads(raw), sha)


def run(repo, pr, sha, mode, observe=inspect, post=subprocess.run, wait=time.sleep):
    if mode not in ("codex", "codex-existing") or not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("Invalid Codex assignment")
    sent = False
    while True:  # bounded by the workflow job timeout
        status, requested = observe(repo, pr, sha)
        if status in ("approve", "block"):
            if not sent:
                print("Native Codex receipt reused; this run did not send a request.")
            return status
        if status is None and mode == "codex" and not (requested or sent):
            result = post(["gh", "api", f"repos/{repo}/issues/{pr}/comments", "--method", "POST",
                  "-f", f"body=@codex review\n\n<!-- ci-codex-review {sha} -->", "--jq",
                  "{id, author: .user.login, type: .user.type, html_url}"],
                  timeout=60, check=True, capture_output=True, text=True)
            comment = json.loads(result.stdout)
            expected = f"https://github.com/{repo}/pull/{pr}#issuecomment-{comment['id']}"
            if (type(comment["id"]) is not int or comment["html_url"] != expected
                    or comment["author"] != "github-actions[bot]" or comment["type"] != "Bot"):
                raise ValueError("GitHub did not confirm the Actions review request")
            print("Native Codex request sent by this run:", expected, flush=True)
            sent = True
        wait(15)


if __name__ == "__main__":
    env = os.environ
    sha = env["HEAD_SHA"]
    verdict = run(env["GH_REPO"], int(env["PR"]), sha, env["REVIEWER"])
    print("Codex GitHub code review:", verdict, sha)
    with open(env["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        print("verdict=" + verdict, file=output)
