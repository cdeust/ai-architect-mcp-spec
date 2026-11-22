"""Observable routing, dispatch and receipt contracts for the native integration."""
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + ".py"))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


quota = module("ci_review_subscription")
proof = module("ci_native_verdict")
native = module("ci_review_codex")
route = module("ci_review_route")
SHA = "a" * 40


def response():
    return {"account_id": "owner", "plan_type": "prolite", "credits": {"has_credits": False, "unlimited": False},
            "rate_limit": {"allowed": True, "primary_window": {"used_percent": 0}},
            "code_review_rate_limit": {"allowed": True, "limit_reached": False,
                "primary_window": {"used_percent": 25, "reset_at": 101}, "secondary_window": None}}


def pages(status="completed", any_findings=False, unresolved=False, sha=SHA):
    record = {"code_review": {"status": status, "commit_sha": sha, "has_any_findings": any_findings,
                              "has_unresolved_findings": unresolved}}
    row = {"body": proof.SUMMARY + "\n" + proof.PREFIX + json.dumps(record) + " -->",
           "author": proof.BOT, "editor": proof.BOT, "lastEditedAt": "2026-11-22T10:57:59Z"}
    return [{"data": {"repository": {"pullRequest": {"headRefOid": SHA, "state": "OPEN", "isDraft": False,
                                                        "comments": {"pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": [row]}}}}}]


class SubscriptionTests(unittest.TestCase):
    def test_rank_remaining_including_ties(self):
        for claude, codex, winner in (("61", 60, "claude"), ("60", 60, "codex"), ("21", 78, "codex"),
                                      ("2", 0, "claude")):
            self.assertEqual(quota.select(claude, "true", codex), winner)
        self.assertEqual(quota.select("0", "false", 2), "codex")
        self.assertEqual(quota.select("unknown", "false", 2), "codex")
        self.assertEqual(quota.select("0", "false", None), "codex-existing")
        self.assertEqual(quota.select("2", "true", None), "claude")
        with self.assertRaises(ValueError):
            quota.select("0", "false", 0)

    def test_first_party_read_does_not_fall_back_to_general_quota(self):
        data = response()
        self.assertEqual(quota.review_remaining(data, "owner", 100), 75)
        data["code_review_rate_limit"]["secondary_window"] = {"used_percent": 97, "reset_at": 101}
        self.assertEqual(quota.review_remaining(data, "owner", 100), 3)
        data["code_review_rate_limit"] = None
        self.assertIsNone(quota.review_remaining(data, "owner", 100))
        with self.assertRaises(ValueError):
            quota.review_remaining(data, "wrong-account", 100)

    def test_inconsistent_stale_or_uncovered_usage_cannot_request(self):
        for bad in (-1, True, 101, "0"):
            data = response()
            data["code_review_rate_limit"]["primary_window"]["used_percent"] = bad
            with self.assertRaises(ValueError):
                quota.review_remaining(data, "owner", 100)
        with self.assertRaises(ValueError):
            quota.review_remaining(response(), "owner", 101)
        data = response()
        data["credits"]["has_credits"] = True
        self.assertIsNone(quota.review_remaining(data, "owner", 100))
        data["code_review_rate_limit"]["limit_reached"] = True
        self.assertEqual(quota.review_remaining(data, "owner", 100), 0)

    def test_only_the_nominated_wakeup_can_measure(self):
        job = {"name": "Claude review budget", "run_id": 42, "run_attempt": 2, "status": "in_progress",
               "conclusion": "success", "steps": [{"name": "Subscription decision run 45", "conclusion": "success"}]}
        jobs = {"jobs": [job]}
        self.assertIsNone(route.admitted(jobs, 42, 2, 45))
        job["status"] = "completed"
        self.assertEqual([route.admitted(jobs, 42, 2, n) for n in (44, 45, 46)], [False, True, False])
        self.assertIsNone(route.admitted(jobs, 42, 3, 45))
        job["steps"].append(dict(job["steps"][0]))
        self.assertFalse(route.admitted(jobs, 42, 2, 45))
        job["steps"].clear()
        self.assertFalse(route.admitted(jobs, 42, 2, 45))

    def test_a_second_budget_on_a_later_page_cannot_nominate_a_workflow(self):
        budget = {"name": "Claude review budget", "run_id": 42, "run_attempt": 1,
                  "status": "completed", "conclusion": "success",
                  "steps": [{"name": "Subscription decision run 45", "conclusion": "success"}]}
        def read(*args):
            self.assertEqual(args, ("jobs", "--paginate", "--slurp"))
            return [{"jobs": [budget]}, {"jobs": [dict(budget)]}]
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            route.admitted(route.attempt_jobs("jobs", read), 42, 1, 45)

    def test_nomination_and_decision_cannot_switch_after_a_failed_measurement(self):
        run = {"id": 45, "run_attempt": 1, "display_title": "Route PR Review 42 attempt 2",
               "path": route.WORKFLOW, "event": "workflow_run", "head_branch": "main",
               "repository": {"full_name": "o/r"}, "head_repository": {"full_name": "o/r"},
               "head_sha": SHA, "status": "in_progress", "conclusion": None}
        copies = [dict(run, id=n) for n in (47, 46)]
        pages = [{"workflow_runs": [dict(run, id=9, head_branch="candidate"), *copies, run]}]
        self.assertEqual(route.nominate("o/r", 42, 2, "date", lambda *args: pages), 45)
        self.assertIsNone(route.nominate("o/r", 42, 1, "date", lambda *args: pages))
        def read(path, *options):
            if path.endswith("/runs/45"):
                return run
            self.assertTrue(path.endswith("/runs/45/attempts/1/jobs"))
            self.assertEqual(options, ("--paginate", "--slurp"))
            return [{"jobs": [{"name": "select", "run_id": 45, "run_attempt": 1, "head_sha": SHA,
                               "conclusion": "success", "steps": [{"name": "Reuse Codex", "conclusion": "success"}]}]}]
        self.assertIsNone(route.decision("o/r", 42, 2, 45, read))
        run.update(status="completed", conclusion="failure")
        with self.assertRaisesRegex(ValueError, "did not succeed"):
            route.decision("o/r", 42, 2, 45, read)
        run.update(conclusion="success")
        self.assertEqual(route.decision("o/r", 42, 2, 45, read), "codex-existing")
        for key, other in (("run_attempt", 2), ("display_title", "Route PR Review 42 attempt 1"),
                           ("event", "pull_request"), ("head_branch", "feature"), ("id", 47)):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "identity"):
                route.decision("o/r", 42, 2, 45, lambda path: dict(run, **{key: other}))


class NativeTests(unittest.TestCase):
    def test_only_authenticated_terminal_code_review_of_current_head_counts(self):
        self.assertEqual(native.state(pages(), SHA), ("approve", False))
        self.assertEqual(native.state(pages(any_findings=True, unresolved=True), SHA), ("block", False))
        self.assertEqual(native.state(pages(status="running", any_findings=None, unresolved=None), SHA)[0], "running")
        self.assertEqual(native.state(pages(status="queued"), SHA)[0], "queued")
        self.assertEqual(native.state(pages(any_findings=True), SHA)[0], "approve")
        draft = pages()
        draft[0]["data"]["repository"]["pullRequest"]["isDraft"] = True
        with self.assertRaisesRegex(ValueError, "draft"):
            native.state(draft, SHA)
        self.assertIsNone(native.state(pages(sha="b" * 40), SHA)[0])
        with self.assertRaises(ValueError):
            native.state(pages(), "b" * 40)
        with self.assertRaises(ValueError):
            native.state(pages(any_findings=None), SHA)
        with self.assertRaises(ValueError):
            native.state(pages() + pages(), SHA)

    def test_forged_or_edited_summary_cannot_pass(self):
        for prop in ("author", "editor"):
            result = copy.deepcopy(pages())
            row = result[0]["data"]["repository"]["pullRequest"]["comments"]["nodes"][0]
            row[prop] = dict(proof.BOT, id="wrong")
            if prop == "editor":
                with self.assertRaises(ValueError):
                    native.state(result, SHA)
            else:
                self.assertIsNone(native.state(result, SHA)[0])

    def test_no_duplicate_requests_or_dispatch_on_unmeasured_account(self):
        for mode, observations, count in (
            ("codex", [(None, False), (None, False), ("running", False), ("approve", False)], 1),
            ("codex", [(None, True), ("block", True)], 0),
            ("codex-existing", [(None, False), ("running", False), ("approve", False)], 0)):
            observations = iter(observations)
            posts = []
            def post(args, **kwargs):
                posts.append(args)
                return SimpleNamespace(stdout=json.dumps({"id": 123, "author": "github-actions[bot]",
                    "type": "Bot", "html_url": "https://github.com/o/r/pull/7#issuecomment-123"}))
            verdict = native.run("o/r", 7, SHA, mode, lambda *_: next(observations),
                                 post, lambda _: None)
            self.assertIn(verdict, ("approve", "block"))
            self.assertEqual(len(posts), count)
            if posts:
                self.assertIn("repos/o/r/issues/7/comments", posts[0])


if __name__ == "__main__":
    unittest.main()
