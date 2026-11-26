"""The Claude review budget: three reviews per PR, counted from run metadata.

Source: ADR-1119 and scripts/ci_review_budget.py. The workflow wiring tests pin
the names the script and claude-review.yml must agree on.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
import unittest.mock

import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import ci_review_budget as budget  # noqa: E402

REVIEW = ROOT / ".github/workflows/claude-review.yml"
SHA = "a" * 40


def run(run_id, day, sha=SHA, conclusion="success", prs=(7,), attempt=1):
    return {
        "id": run_id,
        "run_attempt": attempt,
        "conclusion": conclusion,
        "head_sha": sha,
        "created_at": f"2026-11-0{day}T10:00:00Z",
        "pull_requests": [{"number": n} for n in prs],
    }


def job(run_id, attempt, name="Claude review", *, action="success", counted=True):
    when = f"2026-11-01T10:{attempt:02}:00Z"
    steps = [{"name": budget.ACTION_STEP, "conclusion": action, "completed_at": when}]
    if counted:
        steps.insert(0, {"name": budget.BUDGET_STEP, "conclusion": "success"})
    return {"id": run_id * 100 + 2 * attempt + int(name == budget.BUDGET_JOB), "run_id": run_id,
            "run_attempt": attempt, "name": name, "conclusion": "success", "status": "completed", "steps": steps}


def fake_gh(runs, jobs, past=None):
    """The REST projections for the candidate list and raw slurped job pages."""
    def gh(args):
        if "--slurp" in args and "--jq" in args:
            raise AssertionError("gh rejects --slurp together with --jq")
        if args[0].endswith("/runs") and "claude-review.yml" in args[0]:
            if args[-2:] != ["--paginate", "--slurp"]:
                raise AssertionError(args)
            return json.dumps([{"workflow_runs": runs, "total_count": len(runs)}])
        path = args[0].split("?")[0].split("/")
        if "attempts" in path:
            run_id, attempt = int(path[-3]), int(path[-1])
            return json.dumps({"id": run_id, "run_attempt": attempt, "status": "completed",
                               "conclusion": past[(run_id, attempt)]})
        run_id = int(path[-2])
        if args[1:] != ["--paginate", "--slurp"] or "filter=all" not in args[0]:
            raise AssertionError(args)
        records = jobs[run_id]
        if not records or isinstance(records[0], str):
            records = [job(run_id, 1, budget.BUDGET_JOB)] + [job(run_id, 1, action=action) for action in records]
        return json.dumps([{"total_count": len(records), "jobs": [record]} for record in records])
    return gh


class DecideTests(unittest.TestCase):
    def test_first_review_runs_with_no_previous_commit(self):
        out = budget.decide([], [])
        self.assertEqual(
            out, {"round": 1, "cap": 3, "skip": "false", "reviewed_sha": ""}
        )

    def test_third_review_still_runs_and_names_the_latest_reviewed_commit(self):
        newer, older = "b" * 40, "c" * 40
        out = budget.decide([run(2, 3, newer), run(1, 1, older)], [])
        self.assertEqual((out["round"], out["skip"]), (3, "false"))
        self.assertEqual(out["reviewed_sha"], newer)

    def test_fourth_review_is_skipped(self):
        out = budget.decide([run(1, 1), run(2, 2), run(3, 3)], [])
        self.assertEqual((out["round"], out["skip"]), (4, "true"))

    def test_label_grants_exactly_one_more_review(self):
        label = [budget.BYPASS_LABEL]
        three = [run(i, i) for i in (1, 2, 3)]
        self.assertEqual(budget.decide(three, label)["skip"], "false")
        four = [*three, run(4, 4)]
        out = budget.decide(four, label)
        self.assertEqual((out["round"], out["skip"]), (5, "true"))

    def test_a_malformed_commit_is_a_protocol_error(self):
        with self.assertRaises(budget.BudgetError):
            budget.decide([run(1, 1, "not-a-sha\nskip=false")], [])


class CountTests(unittest.TestCase):
    def count(self, runs, jobs):
        return budget.budget(fake_gh(runs, jobs), "o/r", 7, 99, "feat", [])

    def test_only_successful_runs_of_this_pr_that_ran_the_action_count(self):
        runs = [
            run(1, 1),
            run(2, 2),  # cap run: success, but the action step was skipped
            run(3, 3, "c" * 40, conclusion="failure"),  # review ran but its verdict check failed
            run(4, 4, prs=(8,)),
            run(99, 5),  # the current run
        ]
        jobs = {1: ["success"], 2: ["skipped"], 3: ["success"], 4: ["success"]}
        out = self.count(runs, jobs)
        self.assertEqual((out["round"], out["reviewed_sha"]), (2, SHA))

    def test_three_legacy_codex_only_heads_leave_the_first_claude_round_available(self):
        heads = [char * 40 for char in "abc"]
        previous = [run(i, i, sha) for i, sha in enumerate(heads, 1)]
        jobs = {row["id"]: [] for row in previous}
        self.assertEqual(self.count(previous, jobs),
                         {"round": 1, "cap": 3, "skip": "false", "reviewed_sha": ""})
        result = self.count([*previous, run(4, 4, "d" * 40)], {**jobs, 4: ["success"]})
        self.assertEqual((result["round"], result["reviewed_sha"]), (2, "d" * 40))

    def test_skipped_runs_do_not_move_the_reviewed_commit(self):
        reviewed, skipped = "b" * 40, "c" * 40
        runs = [run(1, 1, reviewed), run(2, 2, skipped)]
        out = self.count(runs, {1: ["success"], 2: ["skipped"]})
        self.assertEqual(out["reviewed_sha"], reviewed)

    def test_api_failure_is_not_swallowed(self):
        def boom(args):
            raise subprocess.CalledProcessError(1, "gh")

        with self.assertRaises(subprocess.CalledProcessError):
            budget.budget(boom, "o/r", 7, 99, "feat", [])


class AttemptHistoryTests(unittest.TestCase):
    def test_paginated_jobs_and_runs_require_the_total_count_and_unique_identities(self):
        for key in ("workflow_runs", "jobs"):
            for records in ([], [{"id": 1}], [{"id": 1}, {"id": 1}]):
                with self.subTest(key=key, records=records), self.assertRaises(budget.BudgetError):
                    budget.page_records(lambda _: json.dumps([{key: records, "total_count": 2}]), [], key)

    def test_only_the_legacy_budget_or_a_successful_in_job_count_admits_an_action(self):
        for name, count, expected in (("Claude review", False, 0), ("Claude review", True, 1),
                                      ("Codex GitHub review", True, 0)):
            with self.subTest(name=name, count=count):
                rows = [job(1, 1, name, counted=count)]
                api = fake_gh([], {1: rows})
                self.assertEqual(len(budget.counted_reviews(api, "o/r", run(1, 1), 1)), expected)
        rows = [job(1, 1, budget.BUDGET_JOB), job(1, 1, counted=False)]
        self.assertEqual(len(budget.counted_reviews(fake_gh([], {1: rows}), "o/r", run(1, 1), 1)), 1)
        rows = [job(1, 1)]
        rows[0]["steps"][0]["conclusion"] = "failure"
        self.assertEqual(budget.counted_reviews(fake_gh([], {1: rows}), "o/r", run(1, 1), 1), [])

    def test_rerun_counts_each_success_before_its_own_attempt(self):
        runs = [run(12, 1, attempt=3, conclusion=None), run(15, 2, "b" * 40, attempt=2)]
        records = {12: [job(12, 1, budget.BUDGET_JOB), job(12, 1, counted=False),
                        job(12, 2, counted=False), job(12, 3)],
                   15: [job(15, 1), job(15, 2)]}
        # Legacy run 12 retried just the review. Run 15 had a failed attempt, then a success.
        past = {(12, 1): "success", (12, 2): "success", (15, 1): "failure"}
        actual = budget.budget(fake_gh(runs, records, past), "o/r", 7, 12, "feat", [], run_attempt=3)
        self.assertEqual((actual["round"], actual["skip"]), (4, "true"))
        with self.assertRaises(budget.BudgetError):
            budget.budget(fake_gh([], {}), "o/r", 7, 12, "feat", [], run_attempt=2)
        records[12] = [job(12, 2)]
        with self.assertRaises(budget.BudgetError):
            budget.budget(fake_gh(runs, records, past), "o/r", 7, 12, "feat", [], run_attempt=3)


class CliTests(unittest.TestCase):
    def invoke(self, runs, jobs, labels="[]"):
        with tempfile.TemporaryDirectory() as tmp:
            out_file = Path(tmp) / "out"
            env = {
                "GH_REPO": "o/r",
                "PR": "7",
                "RUN_ID": "99",
                "RUN_ATTEMPT": "1",
                "HEAD_REF": "feat",
                "LABELS": labels,
                "GITHUB_OUTPUT": str(out_file),
                "RUNNER_TEMP": str(out_file.parent),
            }
            gh = fake_gh(runs, jobs)
            stdout = StringIO()
            with (
                unittest.mock.patch.dict(os.environ, env),
                unittest.mock.patch.object(budget, "gh_api", gh),
                redirect_stdout(stdout),
            ):
                self.assertEqual(budget.main(), 0)
            return out_file.read_text().splitlines(), stdout.getvalue()

    def test_outputs_are_plain_key_value_lines(self):
        lines, text = self.invoke([run(1, 1)], {1: ["success"]})
        self.assertEqual(
            lines, ["round=2", "cap=3", "skip=false", f"reviewed_sha={SHA}"]
        )
        self.assertIn("review 2 of 3", text)

    def test_exhausted_budget_says_what_to_do_instead_of_commenting(self):
        runs = [run(i, i) for i in (1, 2, 3)]
        lines, text = self.invoke(runs, {i: ["success"] for i in (1, 2, 3)})
        self.assertIn("skip=true", lines)
        self.assertIn("Both reviews remain required", text)
        self.assertNotIn("refinement PR", text)
        self.assertIn(budget.BYPASS_LABEL, text)

    def test_the_output_file_must_sit_inside_the_runner_temp(self):
        with tempfile.TemporaryDirectory() as tmp:
            inside = {"RUNNER_TEMP": tmp, "GITHUB_OUTPUT": f"{tmp}/cmd/out"}
            expected = os.path.realpath(inside["GITHUB_OUTPUT"])
            self.assertEqual(budget.output_file(inside), expected)
            for outside in (f"{tmp}-other/out", f"{tmp}/../out", tmp):
                env = {"RUNNER_TEMP": tmp, "GITHUB_OUTPUT": outside}
                with self.subTest(path=outside), self.assertRaises(SystemExit):
                    budget.output_file(env)


class WorkflowWiringTests(unittest.TestCase):
    def setUp(self):
        self.workflow = yaml.safe_load(REVIEW.read_text())
        self.jobs = self.workflow["jobs"]

    def action(self):
        return next(
            step
            for step in self.jobs["review"]["steps"]
            if step.get("uses", "").startswith("anthropics/claude-code-action@")
        )

    def test_claude_is_mandatory_and_records_only_an_explicit_structured_approval(self):
        self.assertNotIn("continue-on-error", self.action())
        record = self.jobs["review"]["steps"][-1]
        self.assertEqual(record["name"], "Record Claude approval")
        self.assertEqual(record["if"], "steps.count.outputs.skip == 'false' && " +
                         "fromJSON(steps.claude.outputs.structured_output).verdict == 'approve'")
        self.assertNotIn("track_progress", self.action()["with"])
        self.assertIn("4411a9e9b0283becf4b924f7bce360fd7756c78c", self.action()["uses"])

    def test_reviews_of_one_pr_are_admitted_one_at_a_time(self):
        concurrency = self.workflow["concurrency"]
        self.assertIs(concurrency["cancel-in-progress"], False)
        group = concurrency["group"]
        self.assertTrue(group.endswith("&& format('pr-{0}', github.event.pull_request.number) || format('skip-{0}', github.run_id) }}"))
        clauses = ("github.event.pull_request.head.repo.full_name == github.repository",
                   "!github.event.pull_request.draft", "github.event.pull_request.user.login != 'dependabot[bot]'",
                   "(github.event.action != 'edited' || github.event.changes.base)")
        for clause in clauses:
            self.assertIn(clause, group)
            self.assertIn(clause, self.jobs["review"]["if"])

    def test_rerunning_a_failed_job_must_admit_the_paid_action_again(self):
        self.assertEqual(set(self.jobs), {"review"})
        job = self.jobs["review"]
        self.assertEqual(job["permissions"], {"contents": "read", "actions": "read", "id-token": "write"})
        checkout, count, prepare, action, validate, record = job["steps"]
        self.assertEqual(count["name"], budget.BUDGET_STEP)
        self.assertEqual(count["id"], "count")
        self.assertEqual(count["env"]["RUN_ATTEMPT"], "${{ github.run_attempt }}")
        self.assertEqual(count["env"]["RUN_ID"], "${{ github.run_id }}")
        self.assertEqual(count["run"], "python3 -I scripts/ci_review_budget.py")
        self.assertNotIn("secrets.", yaml.safe_dump([checkout, count, prepare]))
        self.assertEqual(action, self.action())
        self.assertEqual(action["name"], budget.ACTION_STEP)
        for step in (prepare, action, validate):
            self.assertEqual(step["if"], "steps.count.outputs.skip == 'false'")
        self.assertIn("steps.count.outputs.skip == 'false'", record["if"])

    def test_secret_bearing_workflow_checks_out_only_the_protected_commit(self):
        events = self.workflow[True]
        self.assertEqual(events["pull_request_target"]["branches"], ["main"])
        self.assertIn("edited", events["pull_request_target"]["types"])
        base_edit = "github.event.action != 'edited' || github.event.changes.base"
        self.assertIn(base_edit, self.workflow["run-name"])
        checkout = self.jobs["review"]["steps"][0]["with"]
        self.assertEqual(checkout["ref"], "${{ github.sha }}")
        self.assertFalse(checkout["persist-credentials"])

    def test_target_budget_uses_the_actual_pr_head_from_the_protected_run(self):
        rows = [{"id": n, "created_at": "2026-11-26", "conclusion": "success", "display_title": title}
                for n, title in enumerate((f"Review PR 7 at {SHA}", f"Review PR 8 at {SHA}", "unexpected"), 1)]
        def gh(args):
            self.assertIn("event=pull_request_target", args)
            self.assertIn("--paginate", args)
            return json.dumps([{"workflow_runs": rows, "total_count": len(rows)}])
        self.assertEqual([r["head_sha"] for r in budget.protected_candidates(gh, "o/r", 7, "today")], [SHA])

    def test_cap_is_three(self):
        self.assertEqual(budget.CAP, 3)


if __name__ == "__main__":
    unittest.main()
