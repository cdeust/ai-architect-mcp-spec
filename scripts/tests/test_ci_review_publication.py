"""Run the native-comment guard and the workflow's immutable Git diff input."""
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[2]
GUARD = runpy.run_path(str(ROOT / "scripts/ci_review_comment.py"))
SHA = "f" * 40
LINK = "https://github.com/owner/spec/actions/runs/15/attempts/2"
CONTEXT = {"repo": "owner/spec", "sha": SHA, "pr": 7, "link": LINK}
BODY = f"Findings checked.\nReviewed commit: {SHA}\n[View job run]({LINK})\nVerdict: approve"


class Publication(unittest.TestCase):
    def call(self, body=BODY, **changes):
        payload = {"owner": "owner", "repo": "spec", "issue_number": 7, "body": body, **changes}
        return {"tool_name": "mcp__github__add_issue_comment", "tool_input": payload}

    def test_native_tool_only_accepts_this_pr_and_attempt(self):
        self.assertTrue(GUARD["permitted"](self.call(), CONTEXT))
        self.assertTrue(GUARD["permitted"](self.call(BODY.replace("approve", "block")), CONTEXT))
        for call in (self.call(issue_number=8), self.call(repo="another"),
                     self.call(BODY.replace(SHA, "e"*40)), self.call(BODY.replace("attempts/2", "attempts/1")),
                     self.call("Verdict: approve\n" + BODY), self.call("@someone\n" + BODY),
                     {**self.call(), "tool_name": "other"}):
            with self.subTest(call=call):
                self.assertFalse(GUARD["permitted"](call, CONTEXT))

    def test_preparation_reads_two_commits_without_checking_out_the_candidate(self):
        workflow = yaml.safe_load((ROOT / ".github/workflows/claude-review.yml").read_text())
        step = next(s for s in workflow["jobs"]["review"]["steps"] if s.get("name", "").startswith("Prepare "))
        prepare, _, _ = step["run"].partition("sudo install")
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            source, workspace, runtime = [base / name for name in ("source", "workspace", "runtime")]
            repo = source / "owner/spec.git"
            repo.mkdir(parents=True)
            workspace.mkdir()
            runtime.mkdir()
            def git(*args):
                return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()
            git("init", "-q")
            git("config", "user.name", "Fixture")
            git("config", "user.email", "fixture@example.org")
            tracked = repo / "feature.txt"
            tracked.write_text("before\n")
            git("add", ".")
            git("commit", "-qm", "base")
            before = git("rev-parse", "HEAD")
            tracked.write_text("candidate\n")
            git("commit", "-qam", "candidate")
            after = git("rev-parse", "HEAD")
            tracked.write_text("newer head\n")
            git("commit", "-qam", "newer")
            env = dict(os.environ, GITHUB_SERVER_URL=source.as_uri(), GITHUB_REPOSITORY="owner/spec",
                       BASE_SHA=before, HEAD_SHA=after, RUNNER_TEMP=str(runtime))
            subprocess.run(["bash", "-c", prepare], cwd=workspace, env=env, check=True,
                           capture_output=True, text=True)
            diff = (workspace / "review-input/pr.diff").read_text()
            self.assertIn("+candidate", diff)
            self.assertNotIn("+newer head", diff)
            self.assertFalse((workspace / "feature.txt").exists())
            self.assertTrue((runtime / "review.git/objects").is_dir())
