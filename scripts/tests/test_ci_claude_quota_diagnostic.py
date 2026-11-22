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
    def probe(self, percentage="", counters="", details="", *, auth=None, terminal_error=None, recovers=False):
        screens = iter([
            "Claude Code\nSafe mode:\n❯",
            "Show session cost, plan usage",
            f"Estimated cost\nCurrent week (all models)\n{percentage}\nTotal duration (API): 0s\n{counters}\n{details}",
        ])

        def native(argv, **_kwargs):
            nonlocal terminal_error
            output = ""
            if argv[:3] == ["claude", "auth", "status"]:
                if auth is not None:
                    return auth
                output = json.dumps({"loggedIn": True, "authMethod": "oauth_token", "apiProvider": "firstParty"})
            elif "capture-pane" in argv and terminal_error is not None:
                failure = terminal_error
                if recovers:
                    terminal_error = None
                raise failure
            elif "capture-pane" in argv:
                output = next(screens)
            return subprocess.CompletedProcess(argv, 0, stdout=output)

        captured = io.StringIO()
        with contextlib.ExitStack() as stack:
            scratch = stack.enter_context(tempfile.TemporaryDirectory())
            output_file = Path(scratch) / "action-output"
            new_directory = tempfile.TemporaryDirectory
            stack.enter_context(patch("tempfile.TemporaryDirectory",
                                      side_effect=lambda **kw: new_directory(prefix=kw["prefix"], dir=scratch)))
            with patch.dict(os.environ, GITHUB_SHA="fixture", GITHUB_RUN_ID="fixture", GITHUB_OUTPUT=str(output_file), CLAUDE_CODE_OAUTH_TOKEN="fixture"):
                with patch("subprocess.run", side_effect=native), contextlib.redirect_stdout(captured):
                    with self.assertRaises(SystemExit) as exit_status:
                        runpy.run_path(str(ACTION), run_name="__main__")
            receipt = json.loads(captured.getvalue())
            outputs = dict(line.split("=", 1) for line in output_file.read_text().splitlines())
        self.assertEqual(str(receipt["review_eligible"]).lower(), outputs["eligible"])
        self.assertEqual("unknown" if receipt["remaining_percent"] is None else str(receipt["remaining_percent"]),
                         outputs["remaining"])
        return int(exit_status.exception.code), receipt

    def test_auth_and_terminal_failures_emit_the_refusal_signals(self):
        for kwargs, reason in [
            ({"auth": subprocess.CompletedProcess([], 1, stdout="")}, "authentication_status_failed"),
            ({"auth": subprocess.CompletedProcess([], 0, stdout="bad json")}, "unrecognized_authentication_status"),
            ({"auth": subprocess.CompletedProcess([], 0, stdout='{"loggedIn":false}')}, "expected_first_party_oauth_not_confirmed"),
            ({"terminal_error": OSError("private details")}, "native_cli_or_terminal_failed"),
            ({"terminal_error": subprocess.CalledProcessError(1, "tmux")}, "native_cli_or_terminal_failed"),
            ({"terminal_error": subprocess.TimeoutExpired("tmux", 1)}, "native_cli_or_terminal_failed"),
        ]:
            with self.subTest(reason=reason, failure=kwargs):
                code, receipt = self.probe(**kwargs)
                self.assertNotEqual(code, 0)
                self.assertEqual(receipt["reason"], reason)
                self.assertEqual(receipt["status"], "inconclusive")
                self.assertFalse(receipt["review_eligible"])
                self.assertIsNone(receipt["remaining_percent"])

    def test_a_lost_terminal_can_recover_without_reassigning_the_review(self):
        code, receipt = self.probe("100% used", "0 input, 0 output",
                                   terminal_error=subprocess.CalledProcessError(1, "private command"),
                                   recovers=True)
        self.assertEqual((code, receipt["remaining_percent"], receipt["terminal_attempts"]), (0, 0, 2))
        self.assertEqual(receipt["terminal_failure"], "capture-pane exit 1")

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

    def test_unrecognized_exhaustion_cannot_admit_a_review(self):
        for text in ("100.0% used", "0% used 100% used", "-1% used", "1000% used"):
            with self.subTest(text=text):
                code, receipt = self.probe(text, "0 input, 0 output",
                                           "Current session\n▌ 10% used\nUsage credits are off")
                self.assertNotEqual(0, code)
                self.assertFalse(receipt["review_eligible"])

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

    def test_quota_runs_on_the_default_branch_after_the_review_budget(self):
        trusted = (ROOT / ".github/workflows/review-subscription.yml").read_text()
        self.assertIn("workflow_run:", trusted)
        self.assertLess(trusted.index("ref: ${{ github.sha }}"), trusted.index("uses: ./.github/actions/claude-subscription-quota"))
        self.assertIn("if: steps.budget.outputs.admitted == 'true'", trusted)
        self.assertNotIn("pull_request.head.sha", trusted.split("actions/checkout@", 1)[1])
