"""Exercise the workflow's exit status with recorded native panel shapes."""
import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
ACTION = ROOT / ".github/actions/claude-subscription-quota/read.py"


class ClaudeQuotaDiagnosticTest(unittest.TestCase):
    def probe(self, percentage, counters, details=""):
        screens = iter([
            "Claude Code\nSafe mode:\n❯",
            "Show session cost, plan usage",
            f"Estimated cost\nCurrent week (all models)\n{percentage}\nTotal duration (API): 0s\n{counters}\n{details}",
        ])

        def native(argv, **_kwargs):
            output = ""
            if argv[:3] == ["claude", "auth", "status"]:
                output = json.dumps({"loggedIn": True, "authMethod": "oauth_token", "apiProvider": "firstParty"})
            elif "capture-pane" in argv:
                output = next(screens)
            return subprocess.CompletedProcess(argv, 0, stdout=output)

        captured = io.StringIO()
        with contextlib.ExitStack() as stack:
            scratch = stack.enter_context(tempfile.TemporaryDirectory())
            output_file = Path(scratch) / "action-output"
            stack.enter_context(patch("tempfile.TemporaryDirectory", return_value=contextlib.nullcontext(scratch)))
            with patch.dict(os.environ, GITHUB_SHA="fixture", GITHUB_RUN_ID="fixture", GITHUB_OUTPUT=str(output_file), CLAUDE_CODE_OAUTH_TOKEN="fixture"):
                with patch("subprocess.run", side_effect=native), contextlib.redirect_stdout(captured):
                    with self.assertRaises(SystemExit) as exit_status:
                        runpy.run_path(str(ACTION), run_name="__main__")
            receipt = json.loads(captured.getvalue())
            outputs = dict(line.split("=", 1) for line in output_file.read_text().splitlines())
        self.assertEqual(str(receipt["review_eligible"]).lower(), outputs["eligible"])
        return int(exit_status.exception.code), receipt

    def test_exhaustion_is_a_successful_read_with_unknown_credits(self):
        code, receipt = self.probe("100% used", "0 input, 0 output")
        self.assertEqual(100, receipt["weekly_all_models_used_percent"])
        self.assertEqual("unknown", receipt["usage_credits"])
        self.assertFalse(receipt["charging_guard_passed"])
        self.assertEqual(0, code)
        self.assertEqual(0, receipt["remaining_percent"])
        self.assertFalse(receipt["review_eligible"])

    def test_missing_measurement_fails(self):
        code, receipt = self.probe("unavailable", "0 input, 0 output")
        self.assertEqual("inconclusive", receipt["status"])
        self.assertNotEqual(0, code)

    def test_evidence_of_model_usage_fails(self):
        code, receipt = self.probe("24% used", "1 input, 1 output")
        self.assertFalse(receipt["zero_model_usage_verified"])
        self.assertNotEqual(0, code)

    def test_only_positive_covered_windows_and_subscription_billing_admit_claude(self):
        for session, credits, remaining, eligible in [
            ("52% used", "off", 48, True), ("0% used", "off", 76, True),
            ("100% used", "off", 0, False), ("missing", "off", None, False),
            ("10% used", "on", 76, False), ("10% used", "unknown", 76, False),
        ]:
            with self.subTest(session=session, credits=credits):
                code, receipt = self.probe("24% used", "0 input, 0 output",
                                           f"Current session\n{session}\nUsage credits are {credits}")
                self.assertEqual(0, code)
                self.assertEqual(remaining, receipt["remaining_percent"])
                self.assertEqual(eligible, receipt["review_eligible"])

    def test_review_depends_on_trusted_admission_after_budget(self):
        workflow = (ROOT / ".github/workflows/claude-review.yml").read_text()
        admission, review = workflow.split("  admission:\n", 1)[1].split("  review:\n", 1)
        self.assertIn("needs: budget", admission)
        self.assertIn("if: needs.budget.outputs.skip == 'false'", admission)
        self.assertLess(admission.index("ref: main"), admission.index("uses: ./.github/actions/claude-subscription-quota"))
        self.assertIn("needs: [budget, admission]", review)
        self.assertIn("needs.admission.outputs.reviewer == 'claude'", review)
