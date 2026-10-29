"""Merge eligibility of the post-merge resolver: tests and `merge`, never review.

Owner rule 2026-10-29: the resolver embedded in
.github/workflows/pipeline-post-merge.yml requires contract, unit, regression,
e2e, the exact environment and install matrices and their aggregate `merge`;
the `review` job may fail or be absent (it is continue-on-error in pipeline.yml).
Source: cdeust/ai-architect-mcp-spec PR168 discussion_r4417988428.

The resolver is executed from the workflow text itself, so these tests cover
the bytes CI runs rather than a copy that could drift.
"""

from __future__ import annotations

import copy
import re
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/pipeline-post-merge.yml"
PIPELINE = ROOT / ".github/workflows/pipeline.yml"
REPO = "cdeust/ai-architect-mcp-spec"
SHA = "a" * 40
MERGED = "b" * 40
RUNNERS = ("ubuntu-latest", "macos-latest", "windows-latest")
REQUIRED = (
    "contract", "unit", "regression", "e2e", "merge",
    *(f"{category} ({runner})" for category in ("environment", "install") for runner in RUNNERS),
)


def resolver():
    """Execute the `Resolve protected merge` heredoc and return its namespace."""
    lines = WORKFLOW.read_text(encoding="utf-8").splitlines()
    step = lines.index("      - name: Resolve protected merge")
    start = next(i for i in range(step, len(lines)) if lines[i].endswith("python3 - <<'PY'"))
    end = next(i for i in range(start + 1, len(lines)) if lines[i].strip() == "PY")
    source = textwrap.dedent("\n".join(lines[start + 1:end]))
    namespace = {"__name__": "post_merge_resolver"}
    exec(compile(source, str(WORKFLOW), "exec"), namespace)
    return namespace


RESOLVER = resolver()
PostMergeError = RESOLVER["PostMergeError"]


def run(attempt=1):
    return {
        "id": 50,
        "run_attempt": attempt,
        "name": "Pipeline",
        "path": ".github/workflows/pipeline.yml",
        "event": "pull_request",
        "status": "completed",
        "conclusion": "success",
        "head_sha": SHA,
        "head_branch": "ci/resolver-no-review",
        "head_repository": {"full_name": REPO},
        "pull_requests": [{"number": 168}],
    }


def jobs(attempt=1, names=(*REQUIRED, "review")):
    return [
        {
            "id": attempt * 100 + index,
            "name": name,
            "run_attempt": attempt,
            "run_id": 50,
            "head_sha": SHA,
            "status": "completed",
            "conclusion": "success",
        }
        for index, name in enumerate(names, 1)
    ]


def named(rows, name):
    return next(job for job in rows if job["name"] == name)


class GitHub:
    """The REST calls `resolve` makes, answered from memory; records the merge."""

    def __init__(self, rows, source=None):
        self.source = source or run()
        self.rows = rows
        self.merged = False
        self.puts = []

    def pull(self):
        return {
            "number": 168,
            "state": "open",
            "draft": False,
            "title": "ci: the review job is not a required job to merge",
            "labels": [],
            "merged": self.merged,
            "merge_commit_sha": MERGED if self.merged else None,
            "head": {"sha": SHA, "repo": {"full_name": REPO}},
            "base": {"ref": "main", "repo": {"full_name": REPO}},
        }

    def request(self, method, path, body=None):
        prefix = f"/repos/{REPO}"
        if (method, path) == ("GET", f"{prefix}/actions/runs/50"):
            return copy.deepcopy(self.source)
        if (method, path) == ("GET", f"{prefix}/pulls/168"):
            return self.pull()
        if (method, path) == ("PUT", f"{prefix}/pulls/168/merge"):
            self.puts.append(body)
            self.merged = True
            return {"merged": True, "sha": MERGED}
        raise AssertionError(f"unexpected GitHub call {method} {path}")

    def records(self, path, key=None):
        if path == f"/repos/{REPO}/actions/runs/50/jobs?filter=all" and key == "jobs":
            return iter(copy.deepcopy(self.rows))
        raise AssertionError(f"unexpected GitHub listing {path}")


def resolve(api):
    event = {"repository": {"full_name": REPO}, "workflow_run": copy.deepcopy(api.source)}
    return RESOLVER["resolve"](event, REPO, api)


class ReviewIsNotRequired(unittest.TestCase):
    def assert_merged(self, api):
        result = resolve(api)
        self.assertEqual(result["run_tests"], "true")
        self.assertEqual(result["tested_sha"], MERGED)
        self.assertEqual(api.puts, [{"sha": SHA, "merge_method": "squash"}])

    def test_green_tests_merge(self):
        self.assert_merged(GitHub(jobs()))

    def test_failed_review_does_not_block_merge(self):
        rows = jobs()
        named(rows, "review")["conclusion"] = "failure"
        self.assert_merged(GitHub(rows))

    def test_absent_review_does_not_block_merge(self):
        self.assert_merged(GitHub(jobs(names=REQUIRED)))

    def test_review_job_is_continue_on_error(self):
        # A failed review must not fail the run: the caller fires on success only.
        lines = PIPELINE.read_text(encoding="utf-8").splitlines()
        start = lines.index("  review:")
        end = next(i for i in range(start + 1, len(lines)) if re.match(r"  \S", lines[i]))
        self.assertIn("    continue-on-error: true", lines[start:end])


class TestsAndMergeAreRequired(unittest.TestCase):
    def assert_refused(self, api, message):
        with self.assertRaisesRegex(PostMergeError, re.escape(message)):
            resolve(api)
        self.assertEqual(api.puts, [])

    def test_each_required_job_must_succeed(self):
        for name in REQUIRED:
            for conclusion in ("failure", "skipped", "cancelled"):
                with self.subTest(job=name, conclusion=conclusion):
                    rows = jobs()
                    named(rows, name)["conclusion"] = conclusion
                    self.assert_refused(GitHub(rows), f"requires completed {name}")

    def test_each_required_job_must_be_present(self):
        for name in ("contract", "unit", "regression", "e2e", "merge"):
            with self.subTest(job=name):
                names = [job for job in (*REQUIRED, "review") if job != name]
                self.assert_refused(GitHub(jobs(names=names)), f"exactly one {name} job")

    def test_pending_review_merge_name_is_not_the_merge_job(self):
        # The former "merge pending review" display name no longer stands in for merge.
        names = [("merge pending review" if job == "merge" else job) for job in (*REQUIRED, "review")]
        self.assert_refused(GitHub(jobs(names=names)), "exactly one merge job")

    def test_matrix_must_be_exact(self):
        for category in ("environment", "install"):
            with self.subTest(category=category):
                missing = f"{category} (windows-latest)"
                names = [job for job in (*REQUIRED, "review") if job != missing]
                self.assert_refused(GitHub(jobs(names=names)), f"exact {category} matrix")


class Attempts(unittest.TestCase):
    def rerun(self, first, second):
        rows = jobs(1)
        named(rows, "unit")["conclusion"] = first
        retry = jobs(2, names=("unit", "merge"))
        named(retry, "unit")["conclusion"] = second
        return GitHub(rows + retry, source=run(attempt=2))

    def test_newest_attempt_supersedes_failed_job(self):
        api = self.rerun("failure", "success")
        self.assertEqual(resolve(api)["run_tests"], "true")

    def test_newest_attempt_failure_is_not_outvoted(self):
        api = self.rerun("success", "failure")
        with self.assertRaisesRegex(PostMergeError, "requires completed unit"):
            resolve(api)
        self.assertEqual(api.puts, [])


if __name__ == "__main__":
    unittest.main()
