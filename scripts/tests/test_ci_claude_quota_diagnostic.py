"""Exercise the workflow's exit status with recorded native panel shapes."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest
from unittest.mock import patch


WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/claude-quota-diagnostic.yml"


class ClaudeQuotaDiagnosticTest(unittest.TestCase):
    def probe(self, percentage, counters):
        program = WORKFLOW.read_text().split("python3 -I - <<'PY'\n", 1)[1].rsplit("          PY", 1)[0]
        screens = iter([
            "Claude Code\nSafe mode:\n❯",
            "Show session cost, plan usage",
            f"Estimated cost\nCurrent week (all models)\n{percentage}\nTotal duration (API): 0s\n{counters}",
        ])

        def native(argv, **_kwargs):
            output = ""
            if argv[:3] == ["claude", "auth", "status"]:
                output = json.dumps({"loggedIn": True, "authMethod": "oauth_token", "apiProvider": "firstParty"})
            elif "capture-pane" in argv:
                output = next(screens)
            return subprocess.CompletedProcess(argv, 0, stdout=output)

        captured = io.StringIO()
        scratch = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch("tempfile.TemporaryDirectory", return_value=contextlib.nullcontext(scratch)))
        with patch.dict(os.environ, GITHUB_SHA="fixture", GITHUB_RUN_ID="fixture", CLAUDE_CODE_OAUTH_TOKEN="fixture"):
            with patch("subprocess.run", side_effect=native), contextlib.redirect_stdout(captured):
                with self.assertRaises(SystemExit) as exit_status:
                    exec(compile(textwrap.dedent(program), str(WORKFLOW), "exec"), {})
        return int(exit_status.exception.code), json.loads(captured.getvalue())

    def test_exhaustion_is_a_successful_read_with_unknown_credits(self):
        code, receipt = self.probe("100% used", "0 input, 0 output")
        self.assertEqual(100, receipt["weekly_all_models_used_percent"])
        self.assertEqual("unknown", receipt["usage_credits"])
        self.assertFalse(receipt["charging_guard_passed"])
        self.assertEqual(0, code)

    def test_missing_measurement_fails(self):
        code, receipt = self.probe("unavailable", "0 input, 0 output")
        self.assertEqual("inconclusive", receipt["status"])
        self.assertNotEqual(0, code)

    def test_evidence_of_model_usage_fails(self):
        code, receipt = self.probe("24% used", "1 input, 1 output")
        self.assertFalse(receipt["zero_model_usage_verified"])
        self.assertNotEqual(0, code)
