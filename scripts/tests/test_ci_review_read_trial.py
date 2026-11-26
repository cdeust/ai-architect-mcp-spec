"""The read-boundary trial's own logic: what it asks, how it judges each arm.

Source: scripts/ci_claude_read_trial.py. The trial itself runs in CI on Linux
(claude-read-boundary.yml); these tests hold that it asks for every read the review
named, that a blind control fails it, and that any leak, hook, unanswered call or unexpected
engine tool fails the engine arm.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import ci_claude_read_trial as trial  # noqa: E402

PLANT = trial.Plant(Path("/home/runner"), Path("/home/runner/work/r/r"), 9)


def body(first, results=0, tools=("Read",)):
    messages = [{"role": "user", "content": [{"type": "text", "text": first}]}]
    for n in range(results):
        messages += [{"role": "assistant", "content": [{"type": "tool_use", "id": f"toolu_main_{n}"}]},
                     {"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"toolu_main_{n}",
                                                   "content": f"result {n}", "is_error": n % 2 == 1}]}]
    return {"messages": messages, "tools": [{"name": name} for name in tools]}


class ProbeTests(unittest.TestCase):
    def test_every_read_the_review_named_is_asked(self):
        asked = {p.input.get("file_path") for p in trial.probes(PLANT)}
        for path in ("/proc/self/environ", "/./proc/self/environ", "/proc/self/cmdline",
                     "/home/runner/work/r/r/.git/config", "/home/runner/.env",
                     "/home/runner/.git-credentials", "/run/trial-canary", "/root/trial-canary",
                     "/home/runner/work/r/r/.trial-links/link-out",
                     "/home/runner/work/r/r/.trial-links/link-proc"):
            with self.subTest(path=path):
                self.assertIn(path, asked)
        self.assertTrue(any(p and p.endswith("/proc/self/environ") and "/../" in p for p in asked))
        tools = {p.tool for p in trial.probes(PLANT)}
        self.assertEqual(tools, {"Read", "Grep", "Glob", "Bash", "WebFetch"})

    def test_no_probe_names_a_leak_marker(self):
        # An error message echoes the path it refused: no probe may carry a marker.
        for probe in trial.probes(PLANT):
            with self.subTest(probe=probe.label):
                self.assertFalse(trial.leaked(json.dumps(probe.input)))

    def test_the_engine_arm_is_the_workflow_s_own(self):
        workflow = yaml.safe_load(trial.WORKFLOW.read_text())
        engine = trial.engine_step(workflow)
        self.assertEqual(engine["name"], "Claude security review")
        self.assertIn("/etc/claude-code/managed-settings.json", trial.install_script(workflow))
        self.assertNotIn("--setting-sources", " ".join(trial.CONTROL_ARGS).replace(
            "--setting-sources local", ""))


class ModelTests(unittest.TestCase):
    def test_requests_are_sorted_into_conversations(self):
        self.assertEqual(trial.conversation(body(trial.MAIN)), "main")
        self.assertEqual(trial.conversation(body("Write a title")), "side")
        self.assertEqual(trial.conversation(body(trial.MAIN, tools=())), "side")

    def test_one_probe_per_turn_then_the_structured_output_then_the_end(self):
        main = trial.probes(PLANT)[:2]
        model = trial.Model()
        model.main = main
        (block,), stop = model.answer(body(trial.MAIN))
        self.assertEqual((block["name"], block["input"], stop), (main[0].tool, main[0].input, "tool_use"))
        (block,), _ = model.answer(body(trial.MAIN, 1))
        self.assertEqual(block["input"], main[1].input)
        (block,), _ = model.answer(body(trial.MAIN, 2, tools=("Read", "StructuredOutput")))
        self.assertEqual(block["name"], "StructuredOutput")
        (block,), stop = model.answer(body(trial.MAIN, 3, tools=("Read", "StructuredOutput")))
        self.assertEqual((block["type"], stop), ("text", "end_turn"))
        recorded = [r for r in model.log if "probe" in r]
        self.assertEqual([(r["probe"], r["is_error"]) for r in recorded],
                         [(main[0].label, False), (main[1].label, True)])

    def test_side_requests_get_no_tool_call(self):
        model = trial.Model()
        model.main = trial.probes(PLANT)
        (block,), stop = model.answer(body("Summarize", tools=()))
        self.assertEqual((block["type"], stop), ("text", "end_turn"))

    def test_the_stream_carries_the_tool_input_whole(self):
        found = trial.events("m", [{"type": "tool_use", "id": "a", "name": "Read",
                                    "input": {"file_path": "/x"}}], "tool_use")
        names = [name for name, _ in found]
        self.assertEqual(names, ["message_start", "content_block_start", "content_block_delta",
                                 "content_block_stop", "message_delta", "message_stop"])
        self.assertEqual(json.loads(found[2][1]["delta"]["partial_json"]), {"file_path": "/x"})


def row(conv, probe, text="refused", error=True):
    return trial.result_evidence(conv, probe, {"is_error": error, "content": text})


class VerdictTests(unittest.TestCase):
    MAIN = trial.probes(PLANT)

    def answered(self):
        return [row("main", p, trial.REVIEW_TEXT, error=False) if p.label == trial.REVIEW_INPUT
                else row("main", p) for p in self.MAIN] + [
            {"conv": "main", "tools": ["Read", "StructuredOutput"], "results": 0}]

    def test_restricted_engine_accepts_the_complete_record(self):
        self.assertEqual(trial.verdict("engine", self.answered(), self.MAIN, False), [])

    def test_engine_rejects_a_leak_a_hook_or_a_missing_answer(self):
        log = self.answered()
        log[0] = row("main", self.MAIN[0], trial.TOKEN)
        log.pop(1)
        failures = trial.verdict("engine", log, self.MAIN, True)
        self.assertIn(f"leak: main: {self.MAIN[0].label}", failures)
        self.assertIn(f"unanswered: {self.MAIN[1].label}", failures)
        self.assertIn("a project hook ran under the managed settings", failures)

    def test_engine_requires_read_and_rejects_every_unexpected_offer(self):
        for name in ("Agent", "Grep", "UnrecognizedTool"):
            for conv in ("main", "side"):
                with self.subTest(name=name, conv=conv):
                    log = self.answered()
                    log[-1] = {"conv": conv, "tools": [name], "results": 0}
                    failures = trial.verdict("engine", log, self.MAIN, False)
                    self.assertIn("unproven: the engine never offered Read", failures)
                    self.assertIn(f"unexpected tools: ['{name}']", failures)

    def control(self):
        return [row("main", p, "repositoryformatversion" if p.label == "Read .git/config"
                    else trial.TOKEN, error=False) for p in self.MAIN if p.leaks_in_control] + [
                    row("main", self.MAIN[-1], trial.REVIEW_TEXT, error=False)]

    def test_control_requires_its_own_target_and_a_successful_result(self):
        log = self.control()
        self.assertEqual(trial.verdict("control", log, self.MAIN, True), [])
        git = next(r for r in log if r["probe"] == "Read .git/config")
        git.update(row("main", next(p for p in self.MAIN if p.label == "Read .git/config"),
                       trial.TOKEN, error=False))
        log[0]["is_error"] = True
        failures = trial.verdict("control", log, self.MAIN, False)
        self.assertIn("blind: Read .git/config did not leak without the settings", failures)
        self.assertIn(f"blind: {log[0]['probe']} did not leak without the settings", failures)
        self.assertIn("blind: the project hook did not run without the settings", failures)

    def test_long_results_are_judged_before_reporting_in_both_arms(self):
        probe = self.MAIN[0]
        model = trial.Model()
        model.main = [probe]
        message = body(trial.MAIN, 1)
        result = message["messages"][-1]["content"][0]
        # One result with valid content beyond the old 2,000-character excerpt.
        result["content"] = ("0123456789" * 201) + trial.TOKEN
        model.answer(message)
        entry = model.log[-1]
        self.assertTrue(entry["leaked"])
        self.assertTrue(entry["expected"])
        self.assertNotIn(trial.TOKEN, trial.table("control", model.log))
        engine = self.answered()
        engine[0] = entry
        self.assertIn(f"leak: main: {probe.label}", trial.verdict("engine", engine, self.MAIN, False))
        control = self.control()
        control[0] = entry
        self.assertEqual(trial.verdict("control", control, self.MAIN, True), [])
        result["tool_use_id"] = "different-call"
        model.answer(message)
        self.assertIn(f"unmatched result: {probe.label}", trial.verdict("engine", model.log, self.MAIN, False))

    def test_read_must_return_usable_workspace_content_in_both_arms(self):
        for arm, log in (("engine", self.answered()), ("control", self.control())):
            with self.subTest(arm=arm):
                result = next(r for r in log if r.get("probe") == trial.REVIEW_INPUT)
                result["is_error"] = True
                self.assertIn("unproven: Read did not return the workspace review instructions",
                              trial.verdict(arm, log, self.MAIN, arm == "control"))
        self.assertIn(trial.REVIEW_TEXT, (ROOT / ".github/claude-security-review/scan-instructions.txt").read_text())

    def test_the_control_must_leak_the_reads_the_settings_close(self):
        must = {p.label for p in self.MAIN if p.leaks_in_control}
        self.assertEqual(must, {"Read file outside the checkout", "Read ../ out of the checkout",
                                "Read link out of the checkout", "Read .git/config",
                                "Grep outside the checkout", "Glob outside the checkout",
                                "Bash cat"})


if __name__ == "__main__":
    unittest.main()
