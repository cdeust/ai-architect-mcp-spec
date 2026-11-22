"""Bind a PR review attempt to one protected default-branch quota decision."""
import json
import os
import re
import subprocess
import sys
import time

ROUTES = {"Select Claude": "claude", "Request Codex": "codex", "Reuse Codex": "codex-existing"}
WORKFLOW = ".github/workflows/review-subscription.yml"
MARKER = "Subscription decision run "


def api(*args):
    return json.loads(subprocess.check_output(["gh", "api", *args], timeout=60))


def attempt_jobs(path, read):
    pages = read(path, "--paginate", "--slurp")
    return {"jobs": [job for page in pages for job in page["jobs"]]}


def matches(run, repo, source, attempt):
    return (type(run.get("id")) is int and run["id"] > 0 and run.get("run_attempt") == 1
            and run.get("path") == WORKFLOW and run.get("event") == "workflow_run"
            and run.get("head_branch") == "main" and run.get("display_title") == f"Route PR Review {source} attempt {attempt}"
            and all((run.get(key) or {}).get("full_name") == repo for key in ("repository", "head_repository")))


def nominate(repo, source, attempt, created, read=api):
    pages = read(f"repos/{repo}/actions/workflows/review-subscription.yml/runs", "--method", "GET",
                 "-f", "event=workflow_run", "-f", "branch=main", "-f", "created=>=" + created,
                 "-f", "per_page=100", "--paginate", "--slurp")
    candidates = [run["id"] for page in pages for run in page["workflow_runs"]
                  if matches(run, repo, source, attempt) and run["status"] != "completed"]
    return min(candidates, default=None)


def decision(repo, source, attempt, selected, read=api):
    prefix = f"repos/{repo}/actions/runs/{selected}"
    run = read(prefix)
    if run.get("id") != selected or not matches(run, repo, source, attempt):
        raise ValueError("Selected quota decision has the wrong identity")
    if run["status"] != "completed":
        return None
    if run["conclusion"] != "success":
        raise ValueError("Selected quota decision did not succeed")
    jobs = attempt_jobs(prefix + "/attempts/1/jobs", read)
    choices = [ROUTES[step["name"]] for job in jobs["jobs"]
               if (job["name"] == "select" and job["run_id"] == selected
                   and job["run_attempt"] == 1 and job["head_sha"] == run["head_sha"]
                   and job["conclusion"] == "success")
               for step in job["steps"] if step["name"] in ROUTES and step["conclusion"] == "success"]
    if len(choices) != 1:
        raise ValueError("Expected exactly one selected provider")
    return choices[0]


def admitted(jobs, source, attempt, selected):
    budgets = [job for job in jobs["jobs"] if job["name"] == "Claude review budget"
               and job["run_id"] == source and job["run_attempt"] == attempt]
    if len(budgets) > 1:
        raise ValueError("Ambiguous review budget")
    if not budgets or budgets[0]["status"] != "completed":
        return None
    job = budgets[0]
    markers = [step for step in job.get("steps", []) if step["name"].startswith(MARKER)]
    return (job["conclusion"] == "success" and len(markers) == 1
            and markers[0]["name"] == f"{MARKER}{selected}" and markers[0]["conclusion"] == "success")


def publish(name, value):
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        print(f"{name}={value}", file=output)


def wait_for(read):
    while (result := read()) is None:
        time.sleep(10)
    return result


def main():
    env = os.environ
    repo = env["GH_REPO"]
    run, attempt = int(env["GITHUB_RUN_ID"]), int(env["GITHUB_RUN_ATTEMPT"])
    if sys.argv[1:] == ["budget"]:
        source, source_attempt = int(env["SOURCE_RUN"]), int(env["SOURCE_ATTEMPT"])
        path = f"repos/{repo}/actions/runs/{source}/attempts/{source_attempt}/jobs"
        authorized = attempt == 1 and wait_for(lambda: admitted(attempt_jobs(path, api), source, source_attempt, run))
        publish("admitted", str(authorized).lower())
    elif sys.argv[1:] == ["nominate"]:
        created = api(f"repos/{repo}/actions/runs/{run}")["created_at"]
        selected = wait_for(lambda: nominate(repo, run, attempt, created))
        publish("id", selected)
    elif not sys.argv[1:] and re.fullmatch(r"[1-9][0-9]*", env.get("ROUTE_RUN", "")):
        selected = int(env["ROUTE_RUN"])
        provider = wait_for(lambda: decision(repo, run, attempt, selected))
        publish("reviewer", provider)
        print("Selected:", provider, "from protected run", selected)
    else:
        raise ValueError("Expected an exact subscription decision run")


if __name__ == "__main__":
    main()
