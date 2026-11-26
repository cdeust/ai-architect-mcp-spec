"""Where the Claude subscription token may go, across every workflow of the repository.

Source: docs/claude-security-review.md, "Where the token may go". Two rules hold for
every job, and a third for every job that runs Claude:

- a job that names CLAUDE_CODE_OAUTH_TOKEN declares the environment ENVIRONMENT, which
  admits main only, and no event that runs a pull request's own copy of the workflow
  (pull_request, push to a branch, workflow_dispatch on a branch...) triggers it;
- a job that runs Claude installs the shared managed settings with the exact step of
  claude-security-review.yml, and no Claude run of the repository chooses the auto,
  bypass or accept-edits permission mode.

The workflows that predate these rules are listed in KNOWN with what closes them. The
list may only shrink: a new break, or a listed one that no longer breaks, fails here.
A listed file that is deleted closes its entries.
"""

from __future__ import annotations

import copy
import re
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github/workflows"
# Each secret and the one environment that carries it: the one place the names are
# held. A job that names a listed secret declares its environment.
SECRETS = {"CLAUDE_CODE_OAUTH_TOKEN": "review-subscriptions"}
SECRET = "CLAUDE_CODE_OAUTH_TOKEN"
ENVIRONMENT = SECRETS[SECRET]
# Events GitHub runs from the default branch's copy of the workflow (or, for
# pull_request_target, from the base branch), never from a pull request's head.
# source: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
FROM_DEFAULT_BRANCH = {"workflow_run", "pull_request_target", "issue_comment", "issues", "schedule"}
def names(secret: str) -> re.Pattern:
    return re.compile(rf"secrets\s*(?:\.\s*{secret}\b|\[\s*['\"]{secret}['\"]\s*\])"
                      r"|toJSON\(\s*secrets\s*\)|secrets:\s*inherit")


NAMES_SECRET = names(SECRET)
# A Claude session: the action, the owner-mention runner, or the quota action (which
# signs the CLI in). A job that only installs a CLI lockfile for its tests runs none.
CLAUDE_RUN = re.compile(r"uses: anthropics/claude-code-action@|scripts/ci-mention/prepare\.py"
                        r"|uses: \S*claude-subscription-quota")
LOOSE_MODE = re.compile(r"--permission-mode[\s=]+[\"']?(auto|bypassPermissions|acceptEdits)"
                        r"|--dangerously-skip-permissions|--allow-dangerously-skip-permissions")
INSTALL_STEP = "Install read-only managed settings"
INSTALL_SETTINGS = (
    "set -euo pipefail\n"
    "sudo install -D -m 0444 -o root -g root \\\n"
    "  .github/claude/managed-settings.json \\\n"
    "  /etc/claude-code/managed-settings.json\n"
    "sudo chmod 0555 /etc/claude-code\n"
)
# What breaks today, and what closes it. Shrink it; never grow it.
KNOWN = {
    ("claude-review.yml", "review"): {"no-environment", "pr-head-event", "no-managed-settings",
                                      "loose-mode"},  # the claude-review.yml PR after this one
    ("claude.yml", "prepare"): {"no-environment", "no-managed-settings"},  # same PR
    ("review-subscription.yml", "select"): {"no-managed-settings"},  # deleted by PR 406
}


def on(workflow):
    return workflow.get("on", workflow.get(True)) or {}


def events(workflow) -> dict:
    trigger = on(workflow)
    if isinstance(trigger, str):
        return {trigger: None}
    if isinstance(trigger, list):
        return {name: None for name in trigger}
    return dict(trigger)


def runs_from_default_branch(workflow) -> bool:
    for name, config in events(workflow).items():
        if name in FROM_DEFAULT_BRANCH:
            continue
        if name == "push" and isinstance(config, dict) and set(config) == {"branches"} \
                and config["branches"] == ["main"]:
            continue
        return False
    return True


def environment(job) -> str | None:
    value = job.get("environment")
    return value.get("name") if isinstance(value, dict) else value


def installs_settings(job) -> bool:
    found = [s for s in job.get("steps", []) if s.get("name") == INSTALL_STEP]
    return len(found) == 1 and found[0].get("run") == INSTALL_SETTINGS


def job_breaks(workflow, job) -> set[str]:
    found = set()
    text = yaml.safe_dump(job)
    for secret, carrier in SECRETS.items():
        if names(secret).search(text):
            if environment(job) != carrier:
                found.add("no-environment")
            if not runs_from_default_branch(workflow):
                found.add("pr-head-event")
    if CLAUDE_RUN.search(text):
        if not installs_settings(job):
            found.add("no-managed-settings")
        if LOOSE_MODE.search(text) or (
            "scripts/ci-mention/prepare.py" in text
            and LOOSE_MODE.search((ROOT / "scripts/ci-mention/prepare.py").read_text())
        ):
            found.add("loose-mode")
    return found


def breaks(workflows: dict) -> dict:
    found = {}
    for name, workflow in workflows.items():
        for job_id, job in (workflow.get("jobs") or {}).items():
            broken = job_breaks(workflow, job)
            if broken:
                found[(name, job_id)] = broken
    return found


def shipped() -> dict:
    return {path.name: yaml.safe_load(path.read_text()) for path in sorted(WORKFLOWS.glob("*.yml"))}


def expected(workflows: dict) -> dict:
    return {key: value for key, value in KNOWN.items() if key[0] in workflows}


class SecretScopeTests(unittest.TestCase):
    def test_only_the_known_jobs_break_and_each_exactly_as_listed(self):
        workflows = shipped()
        self.assertEqual(breaks(workflows), expected(workflows))

    def test_the_security_review_holds_every_rule(self):
        workflows = shipped()
        for name in ("claude-security-review.yml", "claude-security-review-request.yml",
                     "claude-read-boundary.yml"):
            with self.subTest(workflow=name):
                self.assertNotIn(name, {key[0] for key in breaks(workflows)})
        self.assertEqual(environment(workflows["claude-security-review.yml"]["jobs"]
                                     ["security-review"]), ENVIRONMENT)

    def test_a_new_break_or_a_closed_known_one_fails(self):
        mutations = {
            "environment removed": ("claude-security-review.yml", "security-review",
                                    lambda job, wf: job.pop("environment"), "no-environment"),
            "other environment": ("claude-security-review.yml", "security-review",
                                  lambda job, wf: job.__setitem__("environment", "x"),
                                  "no-environment"),
            "back to pull_request": ("claude-security-review.yml", "security-review",
                                     lambda job, wf: wf.__setitem__(True, {"pull_request": {}}),
                                     "pr-head-event"),
            "push to any branch": ("claude-security-review.yml", "security-review",
                                   lambda job, wf: on(wf).__setitem__("push", {}), "pr-head-event"),
            "dispatch": ("claude-security-review.yml", "security-review",
                         lambda job, wf: on(wf).__setitem__("workflow_dispatch", None),
                         "pr-head-event"),
            "settings step removed": ("claude-security-review.yml", "security-review",
                                      lambda job, wf: job.__setitem__("steps", [
                                          s for s in job["steps"] if s.get("name") != INSTALL_STEP]),
                                      "no-managed-settings"),
            "auto mode": ("claude-security-review.yml", "security-review",
                          lambda job, wf: next(s for s in job["steps"] if s.get("id") == "engine")[
                              "with"].__setitem__("claude_args", "--permission-mode auto"),
                          "loose-mode"),
            "secret in the request": ("claude-security-review-request.yml", "request",
                                      lambda job, wf: job["steps"][0]["env"].__setitem__(
                                          "T", "${{ secrets['CLAUDE_CODE_OAUTH_TOKEN'] }}"),
                                      "no-environment"),
            "all secrets in the proof": ("claude-read-boundary.yml", "trial",
                                         lambda job, wf: job["steps"][-1]["env"].__setitem__(
                                             "S", "${{ toJSON(secrets) }}"), "pr-head-event"),
        }
        for label, (name, job_id, edit, contract) in mutations.items():
            with self.subTest(mutation=label):
                workflows = copy.deepcopy(shipped())
                workflow = workflows[name]
                if "on" in workflow:
                    workflow[True] = workflow.pop("on")
                edit(workflow["jobs"][job_id], workflow)
                self.assertIn(contract, breaks(workflows).get((name, job_id), set()))
                self.assertNotEqual(breaks(workflows), expected(workflows))
        # A known break that is fixed without shrinking KNOWN fails too.
        workflows = copy.deepcopy(shipped())
        if "claude.yml" in workflows:
            workflows["claude.yml"]["jobs"]["prepare"]["environment"] = ENVIRONMENT
            self.assertNotEqual(breaks(workflows), expected(workflows))

    def test_the_detectors_see_every_spelling(self):
        for text in (f"${{{{ secrets.{SECRET} }}}}", f"${{{{ secrets[ '{SECRET}' ] }}}}",
                     f'${{{{ secrets["{SECRET}"] }}}}', "${{ toJSON(secrets) }}", "secrets: inherit"):
            with self.subTest(text=text):
                self.assertIsNotNone(NAMES_SECRET.search(text))
        self.assertIsNone(NAMES_SECRET.search("${{ secrets.RELEASE_TAG_SSH_KEY }}"))
        for text in ("--permission-mode auto", "--permission-mode=bypassPermissions",
                     "--permission-mode 'acceptEdits'", "--dangerously-skip-permissions"):
            with self.subTest(text=text):
                self.assertIsNotNone(LOOSE_MODE.search(text))
        self.assertIsNone(LOOSE_MODE.search("--permission-mode dontAsk"))
        self.assertTrue(runs_from_default_branch({True: {"push": {"branches": ["main"]}}}))
        self.assertFalse(runs_from_default_branch({True: {"push": {"branches": ["main", "x"]}}}))
        self.assertFalse(runs_from_default_branch({True: "pull_request"}))
        self.assertFalse(runs_from_default_branch({True: ["issues", "push"]}))


if __name__ == "__main__":
    unittest.main()
