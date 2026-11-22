"""Read the decision for this exact PR event from the trusted base workflow."""
import json
import os
import subprocess
import sys
import time

ROUTES = {"Select Claude": "claude", "Request Codex": "codex", "Reuse Codex": "codex-existing"}


def api(*args):
    return json.loads(subprocess.check_output(["gh", "api", *args], timeout=60))


def decision(repo, run_id, attempt, created, read=api):
    title = f"Route PR Review {run_id} attempt {attempt}"
    path = f"repos/{repo}/actions"
    pages = read(f"{path}/workflows/review-subscription.yml/runs", "--method", "GET",
                 "-f", "event=workflow_run", "-f", "branch=main",
                 "-f", "created=>=" + created, "-f", "per_page=100", "--paginate", "--slurp")
    runs = [run for page in pages for run in page["workflow_runs"] if run["display_title"] == title
            and run["event"] == "workflow_run" and run["head_branch"] == "main"
            and run["head_repository"]["full_name"] == repo]
    if not runs:
        return None
    run = max(runs, key=lambda value: value["id"])
    if run["status"] != "completed":
        return None
    if run["conclusion"] != "success":
        raise ValueError("Trusted quota decision did not succeed")
    jobs = read(f"{path}/runs/{run['id']}/attempts/{run['run_attempt']}/jobs")
    choices = [ROUTES[step["name"]] for job in jobs["jobs"] if job["conclusion"] == "success"
               for step in job["steps"] if step["name"] in ROUTES and step["conclusion"] == "success"]
    if len(choices) != 1:
        raise ValueError("Expected exactly one trusted quota decision")
    return choices[0]


def admitted(jobs):
    for job in jobs["jobs"]:
        if job["name"] == "Claude review budget" and job["status"] == "completed":
            return job["conclusion"] == "success" and any(
                step["name"] == "Admit a subscription review round" and step["conclusion"] == "success"
                for step in job.get("steps", []))
    return None


def publish(name, value):
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        print(f"{name}={value}", file=output)


def main():
    repo = os.environ["GH_REPO"]
    if sys.argv[1:] == ["budget"]:
        run, attempt = int(os.environ["SOURCE_RUN"]), int(os.environ["SOURCE_ATTEMPT"])
        path = f"repos/{repo}/actions/runs/{run}/attempts/{attempt}/jobs"
        while (result := admitted(api(path))) is None:
            time.sleep(10)
        publish("admitted", str(result).lower())
        return
    run_id, attempt = int(os.environ["GITHUB_RUN_ID"]), int(os.environ["GITHUB_RUN_ATTEMPT"])
    source = api(f"repos/{repo}/actions/runs/{run_id}")
    while (provider := decision(repo, run_id, attempt, source["created_at"])) is None:
        time.sleep(10)
    publish("reviewer", provider)
    print("Selected:", provider)


if __name__ == "__main__":
    main()
