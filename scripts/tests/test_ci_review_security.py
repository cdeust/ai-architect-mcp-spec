"""The advisory Claude security review: its workflow contract, budget and prompt.

Source: docs/claude-security-review.md (threat model, one guard per threat) and
scripts/ci_security_review.py. The contract is checked on the parsed workflow,
and every guard is proven live by a mutation that removes it: the mutated
workflow must break the contract under the guard's own name
(SecurityReviewMutationTests).
"""

from __future__ import annotations

import copy
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import ci_security_review as security  # noqa: E402

WORKFLOW = ROOT / ".github/workflows/claude-security-review.yml"
REVIEW = ROOT / ".github/workflows/claude-review.yml"
SETTINGS = ROOT / ".github/claude-security-review/managed-settings.json"
SHA = "a" * 40
PINNED = re.compile(r"^[\w.-]+/[\w./-]+@[0-9a-f]{40}$")
ACTION = "anthropics/claude-code-action@"
JOB = "security-review"
EXPECTED_PERMISSIONS = {
    "contents": "read",
    "pull-requests": "write",
    "id-token": "write",
    "actions": "read",
}
# Steps that must precede the engine, in this order (docs, "Guards").
ORDER = [
    "Checkout trusted default branch",
    "Find the trusted review on the default branch",
    "Count the security reviews this PR already received",
    "Measure Claude subscription quota",
    "Decide whether the review runs",
    "Install read-only managed settings",
    "Prepare the diff and the prompt",
    security.ACTION_STEP,
]
RUN_GATE = "steps.decide.outputs.run == 'true'"


def load():
    return yaml.safe_load(WORKFLOW.read_text())


def on(workflow):
    # PyYAML reads the bare key `on` as the boolean True.
    return workflow.get("on", workflow.get(True))


def steps(workflow):
    return workflow["jobs"][JOB]["steps"]


def step(workflow, name):
    return next(s for s in steps(workflow) if s.get("name") == name)


def engine(workflow):
    return next(s for s in steps(workflow) if s.get("uses", "").startswith(ACTION))


def violations(workflow, raw: str) -> set[str]:
    """Every contract the workflow breaks, by name. Empty for the shipped file."""
    found = set()
    trigger = on(workflow)
    if set(trigger) != {"pull_request"} or trigger["pull_request"] != {
        "types": ["opened", "synchronize", "reopened", "ready_for_review"]
    }:
        found.add("trigger")
    if workflow.get("permissions") != {}:
        found.add("workflow-permissions")
    if list(workflow["jobs"]) != [JOB]:
        found.add("single-job")
    job = workflow["jobs"][JOB]
    if job.get("permissions") != EXPECTED_PERMISSIONS:
        found.add("job-permissions")
    trusted = yaml.safe_load(REVIEW.read_text())["jobs"]["budget"]["if"]
    if " ".join(str(job.get("if", "")).split()) != " ".join(trusted.split()):
        found.add("trusted-authors")
    if not isinstance(job.get("timeout-minutes"), int):
        found.add("timeout")
    if workflow.get("concurrency") != {
        "group": "claude-security-review-${{ github.event.pull_request.number }}",
        "cancel-in-progress": False,
    }:
        found.add("concurrency")
    if workflow.get("name") in workflow_run_listeners():
        found.add("wakes-merge")
    if job.get("name") != security.JOB:
        found.add("job-name")
    for s in steps(workflow):
        if "${{" in s.get("run", ""):
            found.add("expression-in-run")
        uses = s.get("uses", "")
        if uses and not uses.startswith("./") and not PINNED.match(uses):
            found.add("unpinned")
        if uses.startswith("actions/checkout@") and (
            s.get("with", {}).get("ref") != "main"
            or s.get("with", {}).get("persist-credentials") is not False
        ):
            found.add("checkout-main")
    for line in raw.splitlines():
        if re.search(r"uses:\s*[\w.-]+/[\w./-]+@[0-9a-f]{40}\s*$", line):
            found.add("pin-comment")
    names = [s.get("name") for s in steps(workflow)]
    try:
        positions = [names.index(name) for name in ORDER]
    except ValueError:
        found.add("order")
    else:
        if positions != sorted(positions) or steps(workflow)[0]["name"] != ORDER[0]:
            found.add("order")
        if names.index(engine(workflow)["name"]) != positions[-1]:
            found.add("order")
    for name in ORDER[5:]:
        if name in names and step(workflow, name).get("if") != RUN_GATE:
            found.add("gated")
    if "Decide whether the review runs" in names and step(
        workflow, "Decide whether the review runs"
    ).get("if") != "steps.ready.outputs.ready == 'true'":
        found.add("gated")
    secrets = set(re.findall(r"secrets\.([A-Z_]+)", yaml.safe_dump(workflow)))
    if secrets != {"CLAUDE_CODE_OAUTH_TOKEN"}:
        found.add("secrets")
    for s in steps(workflow):
        dumped = yaml.safe_dump(s)
        if "secrets." in dumped and s.get("name") not in {
            "Find the trusted review on the default branch",
            "Measure Claude subscription quota",
            security.ACTION_STEP,
        }:
            found.add("secrets")
    ready = step(workflow, ORDER[1]) if ORDER[1] in names else {}
    if ready.get("env", {}).get("HAS_TOKEN") != "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN != '' }}":
        found.add("token-guard")
    if "head.sha" in yaml.safe_dump(
        [s for s in steps(workflow) if s.get("uses", "").startswith("actions/checkout@")]
    ):
        found.add("checkout-main")
    try:
        args = engine(workflow)["with"]["claude_args"]
    except (StopIteration, KeyError):
        found.add("engine")
    else:
        if "--permission-mode dontAsk" not in args or "Bash" in args:
            found.add("engine-tools")
        if '--allowedTools "Task,mcp__github_inline_comment__create_inline_comment"' not in args:
            found.add("engine-tools")
        if engine(workflow).get("env") != {"CLAUDE_CODE_SUBPROCESS_ENV_SCRUB": "1"}:
            found.add("engine-scrub")
    install = step(workflow, ORDER[5]).get("run", "") if ORDER[5] in names else ""
    if "/etc/claude-code/managed-settings.json" not in install or "-m 0444" not in install:
        found.add("managed-settings")
    return found


def workflow_run_listeners() -> set[str]:
    names = set()
    for path in (ROOT / ".github/workflows").glob("*.yml"):
        trigger = on(yaml.safe_load(path.read_text())) or {}
        if isinstance(trigger, dict) and "workflow_run" in trigger:
            names.update(trigger["workflow_run"].get("workflows", []))
    return names


class SecurityReviewContractTests(unittest.TestCase):
    def test_the_shipped_workflow_keeps_every_contract(self):
        self.assertEqual(violations(load(), WORKFLOW.read_text()), set())

    def test_the_merge_resolver_never_reads_this_workflow(self):
        # The review is advisory: no merge path waits for it or reads its comments.
        for path in (ROOT / ".github/workflows").glob("*.yml"):
            if path != WORKFLOW:
                with self.subTest(path=path.name):
                    self.assertNotIn("claude-security-review", path.read_text())
        self.assertNotIn("Claude Security Review", workflow_run_listeners())

    def test_the_ready_guard_lists_every_file_the_job_reads_from_main(self):
        run = step(load(), ORDER[1])["run"]
        for path in (security.SCAN, security.FALSE_POSITIVES, SETTINGS,
                     ROOT / "scripts/ci_security_review.py"):
            with self.subTest(path=path.name):
                self.assertTrue(path.is_file())
                self.assertIn(str(path.relative_to(ROOT)), run)

    def test_the_engine_step_is_the_one_the_budget_counts(self):
        self.assertEqual(engine(load())["name"], security.ACTION_STEP)
        self.assertEqual(load()["jobs"][JOB]["name"], security.JOB)

    def test_managed_settings_deny_shell_writes_network_hooks_and_secret_files(self):
        settings = json.loads(SETTINGS.read_text())
        self.assertIs(settings["disableAllHooks"], True)
        self.assertIs(settings["allowManagedHooksOnly"], True)
        self.assertEqual(settings["permissions"]["disableBypassPermissionsMode"], "disable")
        deny = set(settings["permissions"]["deny"])
        for rule in ("Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch",
                     "WebSearch", "Read(//proc/**)", "Read(//home/runner/work/_temp/**)",
                     "Read(**/.git/config)", "Read(~/.claude/**)"):
            with self.subTest(rule=rule):
                self.assertIn(rule, deny)
        self.assertNotIn("allow", settings["permissions"])


class GuardScriptTests(unittest.TestCase):
    """The shell of the two decision steps, executed as the runner would."""

    def execute(self, name, env, files=()):
        script = step(load(), name)["run"]
        with tempfile.TemporaryDirectory() as tmp:
            for rel in files:
                (Path(tmp) / rel).parent.mkdir(parents=True, exist_ok=True)
                (Path(tmp) / rel).write_text("x")
            out, summary = Path(tmp) / "out", Path(tmp) / "summary"
            subprocess.run(
                ["bash", "-e", "-c", script],
                cwd=tmp,
                check=True,
                capture_output=True,
                env={"PATH": os.environ["PATH"], "GITHUB_OUTPUT": str(out),
                     "GITHUB_STEP_SUMMARY": str(summary), **env},
            )
            return out.read_text(), summary.read_text() if summary.exists() else ""

    ALL = (
        "scripts/ci_security_review.py",
        ".github/claude-security-review/scan-instructions.txt",
        ".github/claude-security-review/false-positive-filtering.txt",
        ".github/claude-security-review/managed-settings.json",
    )

    def test_ready_when_the_token_and_every_file_are_there(self):
        out, summary = self.execute(ORDER[1], {"HAS_TOKEN": "true"}, self.ALL)
        self.assertEqual(out, "ready=true\n")
        self.assertEqual(summary, "")

    def test_a_missing_token_skips_green_and_says_so(self):
        out, summary = self.execute(ORDER[1], {"HAS_TOKEN": "false"}, self.ALL)
        self.assertEqual(out, "ready=false\n")
        self.assertIn("CLAUDE_CODE_OAUTH_TOKEN secret is not configured", summary)

    def test_a_file_missing_on_main_skips_green_and_names_it(self):
        for missing in self.ALL:
            with self.subTest(missing=missing):
                present = [f for f in self.ALL if f != missing]
                out, summary = self.execute(ORDER[1], {"HAS_TOKEN": "true"}, present)
                self.assertEqual(out, "ready=false\n")
                self.assertIn(missing, summary)

    def test_the_review_runs_only_inside_the_budget_and_the_quota(self):
        cases = [
            ({"SKIP": "false", "ELIGIBLE": "true"}, "run=true\n", ""),
            ({"SKIP": "true", "ELIGIBLE": ""}, "run=false\n", "budget"),
            ({"SKIP": "false", "ELIGIBLE": "false", "REMAINING": "3"}, "run=false\n",
             "remaining: 3"),
            ({"SKIP": "false", "ELIGIBLE": ""}, "run=false\n", "remaining: unknown"),
            ({"SKIP": "", "ELIGIBLE": "true"}, "run=false\n", "budget"),
        ]
        for env, expected, said in cases:
            with self.subTest(env=env):
                out, summary = self.execute("Decide whether the review runs", env)
                self.assertEqual(out, expected)
                self.assertIn(said, summary)


def run(run_id, day, sha=SHA, conclusion="success", prs=(7,)):
    return {"id": run_id, "conclusion": conclusion, "head_sha": sha,
            "created_at": f"2026-11-0{day}T10:00:00Z", "prs": list(prs)}


def fake_gh(runs, jobs, calls=None):
    def gh(args):
        if calls is not None:
            calls.append(args)
        if args[0].endswith(f"/{security.WORKFLOW}/runs"):
            return "\n".join(json.dumps(r) for r in runs)
        return json.dumps(jobs[int(args[0].split("/")[-2])])

    return gh


class BudgetTests(unittest.TestCase):
    def budget(self, runs, jobs, calls=None):
        return security.budget(fake_gh(runs, jobs, calls), "o/r", 7, 99, "feat")

    def test_first_review_runs(self):
        self.assertEqual(self.budget([], {}),
                         {"round": 1, "cap": 3, "skip": "false", "reviewed_sha": ""})

    def test_only_successful_runs_whose_action_step_succeeded_count(self):
        runs = [run(1, 1), run(2, 2, conclusion="failure"), run(3, 3), run(4, 4, prs=(8,)),
                run(99, 5)]
        jobs = {1: ["success"], 3: ["skipped"]}
        self.assertEqual(self.budget(runs, jobs)["round"], 2)

    def test_the_cap_stops_the_fourth_review(self):
        runs = [run(i, i, sha=str(i) * 40) for i in (1, 2, 3)]
        result = self.budget(runs, {i: ["success"] for i in (1, 2, 3)})
        self.assertEqual(result["skip"], "true")
        self.assertEqual(result["reviewed_sha"], "3" * 40)

    def test_the_queries_name_this_workflow_job_and_step(self):
        calls = []
        self.budget([run(1, 1)], {1: ["success"]}, calls)
        self.assertEqual(calls[0][0], f"repos/o/r/actions/workflows/{security.WORKFLOW}/runs")
        self.assertIn("branch=feat", calls[0])
        self.assertIn("event=pull_request", calls[0])
        jq = calls[1][calls[1].index("--jq") + 1]
        # The job and its action step share one name: both selections must be there.
        self.assertEqual(
            jq,
            f'[.jobs[] | select(.name == "{security.JOB}") | .steps[]? '
            f'| select(.name == "{security.ACTION_STEP}") | .conclusion]',
        )

    def test_a_protocol_error_is_not_a_silent_review(self):
        with self.assertRaises(security.BudgetError):
            security.budget(lambda args: "[1]" if "jobs" not in args[0] else "{}",
                            "o/r", 7, 99, "feat")


class PromptTests(unittest.TestCase):
    ENV = {"PR": "7", "GH_REPO": "o/r", "ROUND": "1", "CAP": "3",
           "RUN_URL": "https://github.com/o/r/actions/runs/5/attempts/1"}

    def test_the_prompt_carries_both_versioned_instruction_files(self):
        text = security.prompt(self.ENV)
        self.assertIn(security.SCAN.read_text().strip(), text)
        self.assertIn(security.FALSE_POSITIVES.read_text().strip(), text)
        self.assertIn(security.PR_DIFF, text)
        self.assertIn("first security review", text)

    def test_the_review_is_advisory_and_links_its_run(self):
        text = security.prompt(self.ENV)
        self.assertIn('never writes a line starting with "Verdict:"', text)
        self.assertIn(security.MARKER, text)
        self.assertIn(f"[View job run]({self.ENV['RUN_URL']})", text)
        self.assertIn("untrusted data", text)

    def test_a_later_round_reviews_only_what_changed(self):
        text = security.prompt({**self.ENV, "ROUND": "2", "REVIEWED_SHA": SHA})
        self.assertIn(SHA, text)
        self.assertIn(security.SINCE_DIFF, text)

    def test_the_output_is_a_delimited_multiline_value(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {"RUNNER_TEMP": tmp, "GITHUB_OUTPUT": f"{tmp}/cmd/out"}
            Path(tmp, "cmd").mkdir()
            security.write_output(env, "prompt", "a\nb")
            lines = Path(env["GITHUB_OUTPUT"]).read_text().splitlines()
        self.assertRegex(lines[0], r"^prompt<<EOF_[0-9a-f]{32}$")
        self.assertEqual(lines[1:3], ["a", "b"])
        self.assertEqual(lines[3], lines[0].split("<<")[1])


class DiffTests(unittest.TestCase):
    def test_the_diffs_are_written_inside_git_and_read_with_the_diff_media_type(self):
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            paths = security.diffs(lambda a: calls.append(a) or "diff\n", "o/r", 7,
                                   "b" * 40, SHA, Path(tmp))
            self.assertEqual([p.relative_to(tmp).as_posix() for p in paths],
                             [security.PR_DIFF, security.SINCE_DIFF])
            self.assertTrue(all(p.read_text() == "diff\n" for p in paths))
        self.assertEqual(calls[0][0], "repos/o/r/pulls/7")
        self.assertEqual(calls[1][0], f"repos/o/r/compare/{SHA}...{'b' * 40}")
        self.assertTrue(all("Accept: application/vnd.github.diff" in c for c in calls))

    def test_a_refused_diff_becomes_a_note(self):
        def refuse(args):
            raise subprocess.CalledProcessError(1, "gh")

        with tempfile.TemporaryDirectory() as tmp:
            (path,) = security.diffs(refuse, "o/r", 7, SHA, "", Path(tmp))
            self.assertIn("Diff unavailable", path.read_text())

    def test_a_malformed_reviewed_sha_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp, self.assertRaises(security.BudgetError):
            security.diffs(lambda a: "", "o/r", 7, SHA, "main; rm", Path(tmp))


def mutate(edit):
    workflow = load()
    raw = WORKFLOW.read_text()
    result = edit(copy.deepcopy(workflow), raw)
    return result if isinstance(result, tuple) else (result, raw)


def job(w):
    return w["jobs"][JOB]


def set_in(w, name, key, value):
    step(w, name)[key] = value
    return w


def trigger_key(w):
    return True if True in w else "on"


MUTATIONS = {
    "trigger": lambda w, r: w.__setitem__(trigger_key(w), {"pull_request_target": {}}) or w,
    "workflow-permissions": lambda w, r: w.__setitem__("permissions", {"contents": "write"}) or w,
    "job-permissions": lambda w, r: job(w)["permissions"].__setitem__("contents", "write") or w,
    "trusted-authors": lambda w, r: job(w).__setitem__(
        "if", "github.event.pull_request.head.repo.full_name == github.repository") or w,
    "timeout": lambda w, r: job(w).pop("timeout-minutes") and w,
    "concurrency": lambda w, r: w.pop("concurrency") and w,
    "wakes-merge": lambda w, r: w.__setitem__("name", "PR Review") or w,
    "job-name": lambda w, r: job(w).__setitem__("name", "security") or w,
    "expression-in-run": lambda w, r: set_in(
        w, "Decide whether the review runs", "run", 'echo "${{ github.event.pull_request.title }}"'),
    "unpinned": lambda w, r: engine(w).__setitem__(
        "uses", "anthropics/claude-code-action@main") or w,
    "pin-comment": lambda w, r: (w, r.replace(" # v1.0.283", "", 1)),
    "checkout-main": lambda w, r: steps(w)[0]["with"].__setitem__(
        "ref", "${{ github.event.pull_request.head.sha }}") or w,
    "order": lambda w, r: job(w).__setitem__(
        "steps", [steps(w)[0], engine(w), *[s for s in steps(w)[1:] if s is not engine(w)]]) or w,
    "gated": lambda w, r: engine(w).pop("if") and w,
    "secrets": lambda w, r: step(w, "Prepare the diff and the prompt")["env"].__setitem__(
        "LEAK", "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}") or w,
    "token-guard": lambda w, r: step(w, ORDER[1])["env"].pop("HAS_TOKEN") and w,
    "engine-tools": lambda w, r: engine(w)["with"].__setitem__(
        "claude_args", engine(w)["with"]["claude_args"].replace(
            "--permission-mode dontAsk", "--permission-mode auto")) or w,
    "engine-scrub": lambda w, r: engine(w).pop("env") and w,
    "managed-settings": lambda w, r: job(w).__setitem__(
        "steps", [s for s in steps(w) if s.get("name") != ORDER[5]]) or w,
}


class SecurityReviewMutationTests(unittest.TestCase):
    """Each guard has a mutation that removes it; the contract must name the break."""

    def test_every_mutation_is_caught_by_its_own_contract(self):
        for name, edit in MUTATIONS.items():
            with self.subTest(guard=name):
                workflow, raw = mutate(edit)
                self.assertIn(name, violations(workflow, raw))

    def test_the_extra_mutations_are_caught(self):
        extra = {
            "bash-allowed": ("engine-tools", lambda w, r: engine(w)["with"].__setitem__(
                "claude_args", engine(w)["with"]["claude_args"].replace(
                    "Task,", "Task,Bash(gh pr comment:*),")) or w),
            "fork-allowed": ("trusted-authors", lambda w, r: job(w).__setitem__("if", "true") or w),
            "second-secret": ("secrets", lambda w, r: engine(w)["with"].__setitem__(
                "anthropic_api_key", "${{ secrets.ANTHROPIC_API_KEY }}") or w),
            "decide-ungated": ("gated", lambda w, r: step(
                w, "Decide whether the review runs").pop("if") and w),
            "settings-writable": ("managed-settings", lambda w, r: set_in(
                w, ORDER[5], "run", step(w, ORDER[5])["run"].replace("0444", "0666"))),
            "head-checkout-added": ("checkout-main", lambda w, r: job(w)["steps"].insert(
                1, {"uses": steps(w)[0]["uses"], "with": {"ref": "refs/pull/1/head",
                                                          "persist-credentials": False}}) or w),
        }
        for label, (contract, edit) in extra.items():
            with self.subTest(mutation=label):
                workflow, raw = mutate(edit)
                self.assertIn(contract, violations(workflow, raw))


if __name__ == "__main__":
    unittest.main()
