"""Publish the protected review result for the current PR head on GitHub."""

import json
import os
from pathlib import Path
import runpy
import subprocess

proof = runpy.run_path(str(Path(__file__).with_name("ci_review_proof.py")))
CONTEXT = "Claude and Codex reviews"


class GitHub:
    def request(self, method, path, body=None):
        args = ["gh", "api", "--method", method, path]
        if body is not None:
            args.extend(["--input", "-"])
        return json.loads(subprocess.check_output(args, input=json.dumps(body).encode() if body else None))

    def records(self, path, key):
        raw = subprocess.check_output(["gh", "api", "--paginate", "--slurp", path])
        return [row for page in json.loads(raw) for row in page[key]]


def publish(api, repository, number, url):
    pr = api.request("GET", f"/repos/{repository}/pulls/{number}")
    if (pr["state"] != "open" or pr["draft"] or pr["base"]["ref"] != "main"
            or pr["head"]["repo"]["full_name"] != repository or pr["base"]["repo"]["full_name"] != repository):
        return None
    head = pr["head"]["sha"]
    path = f"/repos/{repository}/statuses/{head}"

    def status(state, description):
        api.request("POST", path, {"state": state, "context": CONTEXT, "description": description, "target_url": url})

    status("pending", "Reading both native reviews for this commit")
    try:
        proof["require_reviews"](api, repository, pr, head)
    except ValueError as err:
        status("failure", "Both verified approvals are required")
        print(f"Review held: {err}")
        return False
    except (KeyError, TypeError, subprocess.SubprocessError):
        status("error", "GitHub review evidence could not be verified")
        raise
    status("success", "Claude and Codex approved this exact commit")
    return True


if __name__ == "__main__":
    env = os.environ
    url = f"{env['GITHUB_SERVER_URL']}/{env['GITHUB_REPOSITORY']}/actions/runs/{env['GITHUB_RUN_ID']}"
    result = publish(GitHub(), env["GITHUB_REPOSITORY"], int(env["PR"]), url)
    raise SystemExit(1 if result is False else 0)
