"""The live acceptance probe must demonstrate a fresh GitHub Actions dispatch."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[2]
JOBS = yaml.safe_load((ROOT / ".github/workflows/native-review-acceptance.yml").read_text())["jobs"]
SHA = "1" * 40


class MoreEvidenceNeeded(Exception):
    pass


class NativeAcceptanceTest(unittest.TestCase):
    def run_probe(self, reaction, status):
        step = JOBS["receipt"]["steps"][-1]["run"]
        program = step.split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
        result = {"code_review": {"commit_sha": SHA, "status": status,
                                  "has_any_findings": False, "has_unresolved_findings": False}}
        bot = {"login": "chatgpt-codex-connector", "__typename": "Bot", "id": "BOT_kgDOC98s_g"}
        summary = "<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 " + json.dumps(result) + " -->"
        comment = {"author": bot, "editor": None, "lastEditedAt": None, "body": summary}
        pull = {"headRefOid": SHA, "isDraft": True, "state": "OPEN",
                "comments": {"pageInfo": {"hasNextPage": False}, "nodes": [comment]}}

        def github(argv, **kwargs):
            if argv[2] == "repos/o/r/issues/comments/123/reactions":
                return json.dumps([[{"user": {"node_id": reaction}, "content": "eyes"}]])
            self.assertEqual(argv[2], "graphql")
            return json.dumps([{"data": {"repository": {"pullRequest": pull}}}])

        with contextlib.chdir(ROOT), patch.dict(os.environ, GH_REPO="o/r", PR="9", SHA=SHA, REQUEST_ID="123"):
            with patch.object(subprocess, "check_output", side_effect=github), patch("time.sleep", side_effect=MoreEvidenceNeeded):
                with contextlib.redirect_stdout(io.StringIO()) as out:
                    exec(compile(program, "hosted-receipt", "exec"), {})
                    return out.getvalue()

    def test_requires_bot_acknowledgement_of_this_comment_and_completed_head(self):
        for reaction, status in (("unrelated", "completed"), ("BOT_kgDOC98s_g", "running")):
            with self.assertRaises(MoreEvidenceNeeded):
                self.run_probe(reaction, status)
        self.assertIn("comment 123", self.run_probe("BOT_kgDOC98s_g", "completed"))

    def test_only_the_checkout_free_request_job_can_write(self):
        self.assertEqual(JOBS["request"]["permissions"], {"pull-requests": "write"})
        self.assertFalse(any("uses" in step for step in JOBS["request"]["steps"]))
        self.assertEqual(JOBS["receipt"]["permissions"], {"contents": "read", "pull-requests": "read"})
        send = JOBS["request"]["steps"][0]["run"]
        self.assertLess(send.index('if [[ "$previous" != 0 ]]'), send.index("--method POST"))
