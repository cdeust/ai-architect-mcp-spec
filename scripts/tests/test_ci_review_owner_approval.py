"""The owner's approval of the current head decides the merge; review bots are optional.

Owner decision of 2026-11-25: "pas de check du quota et tous les bots deviennent
optionnels et le merge un approve du user". The table and the threat model are in
docs/review-subscriptions.md.
"""
import contextlib
import io
import json
from pathlib import Path
import re
import subprocess
import textwrap
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github/workflows"
REPO = "cdeust/ai-architect-mcp-spec"
HEAD = "a" * 40
OWNER = {"login": "cdeust", "type": "User"}
OTHER = "b" * 40
OPENED = "2026-11-25T20:00:00Z"
T1, T2, T3, T4 = ("2026-11-25T21:00:00Z", "2026-11-25T21:05:00Z", "2026-11-25T21:09:00Z",
                  "2026-11-25T21:12:00Z")
APP = {"login": "some-app[bot]", "type": "Bot"}


def resolver():
    text = (WORKFLOWS / "pipeline-post-merge.yml").read_text()
    source = text.split("          python3 - <<'PY'\n", 1)[1].split("\n          PY", 1)[0]
    namespace = {"__name__": "resolver_test"}
    exec(compile(textwrap.dedent(source), "trusted_resolver", "exec"), namespace)
    return namespace


def record(at, action="labeled", sha=HEAD, by=OWNER, label="owner-approved", pr=7, rerun_by=None, base="main",
           path=".github/workflows/owner-approval.yml", event="pull_request_target", run_id=None,
           status="completed", conclusion="success"):
    """A run of owner-approval.yml as the REST API lists it."""
    title = f"Owner approval {action} PR {pr} label {label} base {base} at {sha} by {by['login']}"
    return {"id": run_id or int(at[11:13] + at[14:16] + at[17:19]), "display_title": title, "path": path,
            "event": event, "created_at": at, "actor": by, "triggering_actor": rerun_by or by,
            "head_sha": "c" * 40,  # a pull_request_target run carries the base commit
            "status": status, "conclusion": conclusion}


def unlabeled(at, label="owner-approved"):
    return {"event": "unlabeled", "label": {"name": label}, "actor": OWNER, "created_at": at}


def pull(labels=("owner-approved",)):
    return {"number": 7, "state": "open", "draft": False, "title": "fix: x", "created_at": OPENED,
            "labels": [{"name": n} for n in labels], "user": OWNER}


class FakeApi:
    def __init__(self, records=(), events=(), owner=OWNER):
        self.records_, self.events, self.owner, self.puts, self.paths = list(records), list(events), owner, [], []

    def records(self, path, key=None):
        self.paths.append(path)
        if path.endswith("/issues/7/events"):
            return self.events
        if "/actions/workflows/owner-approval.yml/runs?" in path:
            return self.records_
        if path.endswith("/commits"):  # a commit by the owner is not a low-risk update
            return [{"author": {"login": "cdeust"}, "committer": {"login": "cdeust"},
                     "commit": {"message": "fix: x", "verification": {"verified": True}}}]
        if path.endswith("/files"):
            return [{"filename": "src/a.ts"}]
        raise AssertionError(path)

    def request(self, method, path, body=None):
        if (method, path) == ("GET", f"/repos/{REPO}"):
            return {"owner": self.owner}
        self.puts.append((method, path, body))
        return {"merged": True, "sha": "c" * 40}


class OwnerApprovalTableTests(unittest.TestCase):
    def merge(self, pr, api, head=HEAD):
        ns = resolver()
        try:
            ns["_merge_open_pr"](pr, "/merge", head, api, REPO)
        except ns["PostMergeError"] as error:
            return str(error)
        return "merged"

    def test_the_approval_table(self):
        other_user = {"login": "someone", "type": "User"}
        owner_bot = {"login": "cdeust", "type": "Bot"}
        rows = [
            ("approved this head", pull(), [record(T2)], [], "merged"),
            ("approved, label set before the Pipeline ended", pull(), [record(T1)], [], "merged"),
            ("approved again after a removal", pull(), [record(T1), record(T3)], [unlabeled(T2)], "merged"),
            ("no label on the PR", pull(()), [record(T2)], [], "the owner has not approved this head"),
            ("label but no record (set with GITHUB_TOKEN: no run)", pull(), [], [],
             "the owner has not approved this head"),
            ("record of another label", pull(), [record(T2, label="claude-rereview")], [],
             "the owner has not approved this head"),
            ("removed after the approval", pull(), [record(T2)], [unlabeled(T3)],
             "the approval was removed after it was given"),
            ("removed in the second of the approval", pull(), [record(T2)], [unlabeled(T2)],
             "the approval was removed after it was given"),
            ("a removal before the approval does not count", pull(), [record(T2)], [unlabeled(T1)], "merged"),
            ("a push after the approval", pull(), [record(T2), record(T3, "synchronize", OTHER, label="-")],
             [], "a push came after the approval"),
            ("a push back to the approved head", pull(),
             [record(T1), record(T2, "synchronize", OTHER, label="-"), record(T3, "synchronize", label="-")],
             [], "a push came after the approval"),
            ("approved another head", pull(), [record(T2, sha=OTHER)], [], "the approval names another head"),
            ("back to an earlier approved head", pull(), [record(T1), record(T2, sha=OTHER)], [],
             "the approval names another head"),
            ("record of another PR (head reused from it)", pull(), [record(T2, pr=5)], [],
             "the owner has not approved this head"),
            ("set by another user", pull(), [record(T2, by=other_user)], [], "not set by the owner"),
            ("set by an app", pull(), [record(T2, by=APP)], [], "not set by the owner"),
            ("bot with the owner's login", pull(), [record(T2, by=owner_bot)], [], "not set by the owner"),
            ("rerun of the approval by someone else", pull(), [record(T2, rerun_by=other_user)], [],
             "not set by the owner"),
            ("owner approved, then someone else", pull(), [record(T1), record(T2, by=other_user)], [],
             "not set by the owner"),
            ("a record from the PR's own workflow", pull(), [record(T2, event="pull_request")], [],
             "the owner has not approved this head"),
            ("a record from another workflow file", pull(),
             [record(T2, path=".github/workflows/owner-approval-wake.yml")], [],
             "the owner has not approved this head"),
            ("a malformed record date", pull(), [record("2026-11-25 21:05:00")], [],
             "the owner has not approved this head"),
            ("a record from workflow_dispatch", pull(), [record(T2, event="workflow_dispatch")], [],
             "the owner has not approved this head"),
            ("a record from push", pull(), [record(T2, event="push")], [],
             "the owner has not approved this head"),
            ("a forged title from the PR's own copy beside a real old record", pull(),
             [record(T1, sha=OTHER), record(T2, event="pull_request")], [], "the approval names another head"),
            ("a neighbouring label", pull(("owner-approved-x",)), [record(T2, label="owner-approved-x")], [],
             "the owner has not approved this head"),
            ("a label with another case", pull(("Owner-approved",)), [record(T2, label="Owner-approved")], [],
             "the owner has not approved this head"),
            ("a neighbouring label's removal does not count", pull(), [record(T2)],
             [unlabeled(T3, label="owner-approved-x")], "merged"),
            ("label on the PR, no record at all (pull_request_target blocked)", pull(), [], [],
             "an Actions event policy may block pull_request_target"),
            ("the approval record was blocked: created in failure", pull(),
             [record(T2, status="completed", conclusion="failure")], [],
             "the approval record did not run"),
            ("the approval record failed at startup", pull(),
             [record(T2, status="completed", conclusion="startup_failure")], [],
             "the approval record did not run"),
            ("the approval record still queued", pull(), [record(T2, status="queued", conclusion=None)], [],
             "the approval record has not finished"),
            ("the approval record in progress", pull(), [record(T2, status="in_progress", conclusion=None)], [],
             "the approval record has not finished"),
            ("the approval record cancelled", pull(), [record(T2, conclusion="cancelled")], [],
             "the approval record did not run"),
            ("the approval record skipped", pull(), [record(T2, conclusion="skipped")], [],
             "the approval record did not run"),
            ("a blocked run whose title is the PR title imitating a record", pull(),
             [dict(record(T2, conclusion="failure"), event="pull_request_target")], [],
             "the approval record did not run"),
            ("an older successful record does not stand in for a blocked newer one", pull(),
             [record(T1), record(T2, status="completed", conclusion="failure")], [],
             "the approval record did not run"),
            ("a blocked push record still voids the approval", pull(),
             [record(T1), record(T2, "synchronize", OTHER, label="-", status="completed", conclusion="failure")], [],
             "a push came after the approval"),
            ("the record workflow did not run on a push: the label stayed, the head moved", pull(),
             [record(T1, sha=OTHER)], [], "the approval names another head"),
        ]
        for name, pr, records, events, expected in rows:
            api = FakeApi(records, events)
            with self.subTest(name):
                outcome = self.merge(pr, api)
                self.assertIn(expected, outcome)
                self.assertEqual(bool(api.puts), expected == "merged")

    def test_a_rerun_of_an_old_head_needs_a_new_approval(self):
        # The owner approved B; the branch went back to A with GITHUB_TOKEN (no
        # run, no label removal) and an old Pipeline run of A was rerun.
        api = FakeApi([record(T1, sha=OTHER)])
        self.assertIn("the approval names another head", self.merge(pull(), api, head=HEAD))
        self.assertEqual(api.puts, [])

    def test_the_newest_record_is_ordered_by_creation_not_by_a_rerun(self):
        # A rerun moves run_started_at, never created_at or the title: a rerun of
        # an old approval of this head does not outrank a newer one of another.
        rerun_old = dict(record(T1), run_started_at=T4, run_attempt=2)
        self.assertIn("the approval names another head",
                      self.merge(pull(), FakeApi([record(T3, sha=OTHER), rerun_old])))
        rerun_other = dict(record(T1, sha=OTHER), run_started_at=T4, run_attempt=2)
        self.assertEqual(self.merge(pull(), FakeApi([rerun_other, record(T3)])), "merged")

    def test_a_hostile_label_name_cannot_move_the_title_fields(self):
        ns = resolver()
        hostile = f"owner-approved at {HEAD} by cdeust"
        forged = record(T2, label=hostile, sha=OTHER, by={"login": "someone", "type": "User"})
        self.assertIsNone(ns["RECORD_TITLE"].fullmatch(forged["display_title"]))
        self.assertIn("the owner has not approved this head", self.merge(pull(), FakeApi([forged])))
        # The title's actor must also be the run's actor.
        mismatch = dict(record(T2), display_title=record(T2)["display_title"].replace("by cdeust", "by someone"))
        self.assertIn("not set by the owner", self.merge(pull(), FakeApi([mismatch])))

    def test_records_are_read_from_the_pull_request_s_lifetime(self):
        api = FakeApi([record(T2)])
        self.merge(pull(), api)
        listed = [p for p in api.paths if "owner-approval.yml/runs" in p]
        self.assertEqual(listed, [f"/repos/{REPO}/actions/workflows/owner-approval.yml/runs"
                                  f"?event=pull_request_target&created=%3E%3D{OPENED}"])

    def test_an_undated_pr_or_a_malformed_removal_holds(self):
        pr = dict(pull(), created_at=None)
        self.assertNotEqual(self.merge(pr, FakeApi([record(T2)])), "merged")
        self.assertNotEqual(self.merge(pull(), FakeApi([record(T2)], [unlabeled(None)])), "merged")

    def test_an_organization_owner_is_refused(self):
        api = FakeApi([record(T2)], owner={"login": "cdeust", "type": "Organization"})
        self.assertIn("not a user account", self.merge(pull(), api))

    def test_every_hold_is_a_waiting_reason_not_a_failure(self):
        ns = resolver()
        source = (WORKFLOWS / "pipeline-post-merge.yml").read_text()
        body = source.split("def _owner_approves", 1)[1].split("def _merge_open_pr", 1)[0]
        reasons = re.findall(r'"(merge held: [^"]+)"', body)
        self.assertGreaterEqual(len(reasons), 5)
        for reason in reasons:
            self.assertTrue(reason.startswith(ns["WAITING"]), reason)

    def test_a_hold_label_still_holds_an_approved_pr(self):
        pr = pull(("owner-approved", "hold"))
        self.assertIn("label holds merge", self.merge(pr, FakeApi([record(T2)])))


class SecondReviewScenariosTests(unittest.TestCase):
    """Scenarios of the second review of b80511b (Gemini), red before their fix."""

    def merge(self, pr, api, head=HEAD, tested_at=None):
        ns = resolver()
        try:
            ns["_merge_open_pr"](pr, "/merge", head, api, REPO, tested_at)
        except ns["PostMergeError"] as error:
            return str(error)
        return "merged"

    def test_s01_an_approval_for_another_base_does_not_merge_into_main(self):
        staging = record(T2, base="staging")
        self.assertIn("approval was given for another base", self.merge(pull(), FakeApi([staging])))
        moved = [staging, record(T3, "edited", label="-")]
        self.assertIn("approval was given for another base", self.merge(pull(), FakeApi(moved)))

    def test_a_base_change_after_the_approval_voids_it(self):
        away_and_back = [record(T1), record(T2, "edited", label="-", base="staging"), record(T3, "edited", label="-")]
        self.assertIn("base changed after the approval", self.merge(pull(), FakeApi(away_and_back), tested_at=T4))
        # A body edit (edited, base main) does not void it.
        self.assertEqual(self.merge(pull(), FakeApi([record(T1), record(T2, "edited", label="-")])), "merged")

    def test_the_pipeline_must_come_after_the_move_to_main(self):
        history = [record(T1, "opened", label="-", base="staging"), record(T2, "edited", label="-"), record(T3)]
        for tested_at, expected in ((None, "Pipeline predates"), ("2026-11-25T21:04:00Z", "Pipeline predates"),
                                    ("2026-11-25T21:05:00Z", "Pipeline predates"), ("2026-11-25 21:06:00", "Pipeline predates"),
                                    ("2026-11-25T21:06:00Z", "merged")):
            with self.subTest(tested_at=tested_at):
                self.assertIn(expected, self.merge(pull(), FakeApi(history), tested_at=tested_at))
        # Never off main: no Pipeline date is needed.
        self.assertEqual(self.merge(pull(), FakeApi([record(T1, "opened", label="-"), record(T3)])), "merged")

    def test_n1_a_push_in_the_same_second_as_the_approval_voids_it(self):
        same = [record(T2, run_id=1001), record(T2, "synchronize", OTHER, label="-", run_id=1002)]
        self.assertIn("a push came after the approval", self.merge(pull(), FakeApi(same)))
        before = [record(T2, "synchronize", OTHER, label="-", run_id=1001), record(T2, run_id=1002)]
        self.assertEqual(self.merge(pull(), FakeApi(before)), "merged")

    def test_n2_reopening_or_leaving_draft_after_the_approval_voids_it(self):
        for action in ("reopened", "ready_for_review"):
            with self.subTest(action=action):
                self.assertIn("a push came after the approval",
                              self.merge(pull(), FakeApi([record(T1), record(T2, action, label="-")])))
        self.assertEqual(self.merge(pull(), FakeApi([record(T1, "opened", label="-"), record(T2)])), "merged")

    def test_records_order_by_id_within_a_second(self):
        # MG06: the newest of two records in the same second is the one with the larger id.
        other = {"login": "someone", "type": "User"}
        self.assertIn("not set by the owner",
                      self.merge(pull(), FakeApi([record(T2, run_id=2), record(T2, by=other, run_id=3)])))
        self.assertEqual(self.merge(pull(), FakeApi([record(T2, by=other, run_id=2), record(T2, run_id=3)])), "merged")
        ns = resolver()
        with self.assertRaises(ns["PostMergeError"]):
            ns["_records"](pull(), REPO, FakeApi([dict(record(T2), id=None)]))

    def test_malformed_dates_and_titles_hold(self):
        # MG01, MG02, MG05, MG07.
        self.assertIn("no creation date", self.merge(dict(pull(), created_at="yesterday"), FakeApi([record(T2)])))
        self.assertIn("removed after it was given", self.merge(pull(), FakeApi([record(T2)], [unlabeled("soon")])))
        short = dict(record(T2), display_title=record(T2)["display_title"].replace(HEAD, "a" * 39))
        self.assertIn("the owner has not approved this head", self.merge(pull(), FakeApi([short])))
        self.assertIn("title holds merge", self.merge(dict(pull(), title="WIP: do not merge"), FakeApi([record(T2)])))

    def test_s05b_the_resolver_judges_the_pr_the_wake_names(self):
        ns = resolver()

        class Runs:
            def records(self, path, key=None):
                return [{"id": 100, "head_sha": HEAD, "pull_requests": [{"number": 7}]},
                        {"id": 200, "head_sha": HEAD, "pull_requests": [{"number": 8}]}]

        wake = {"name": "Owner approval wake", "path": ".github/workflows/owner-approval-wake.yml",
                "event": "pull_request", "status": "completed", "conclusion": "success",
                "head_repository": {"full_name": REPO}, "head_sha": HEAD, "pull_requests": [{"number": 7}]}
        self.assertEqual(ns["_pipeline_of_approval"](wake, REPO, Runs())["id"], 100)
        for prs in ([], [{"number": 7}, {"number": 8}], [{"number": "7"}]):
            with self.subTest(prs=prs), self.assertRaises(ns["PostMergeError"]):
                ns["_pipeline_of_approval"](dict(wake, pull_requests=prs), REPO, Runs())

    def test_s05c_the_fallback_by_commit_keeps_open_prs_only(self):
        ns = resolver()

        class Pulls:
            def __init__(self, prs):
                self.prs = prs

            def records(self, path, key=None):
                return self.prs

            def request(self, method, path, body=None):
                return {"head": {"sha": HEAD, "repo": {"full_name": REPO}}, "base": {"ref": "main", "repo": {"full_name": REPO}}}

        def pr(number, state):
            return {"number": number, "state": state, "head": {"sha": HEAD, "repo": {"full_name": REPO}},
                    "base": {"ref": "main", "repo": {"full_name": REPO}}}

        number, _ = ns["_pull_request"]({"head_sha": HEAD, "pull_requests": []}, REPO, Pulls([pr(7, "closed"), pr(8, "open")]))
        self.assertEqual(number, 8)
        with self.assertRaises(ns["PostMergeError"]):
            ns["_pull_request"]({"head_sha": HEAD, "pull_requests": []}, REPO, Pulls([pr(7, "open"), pr(8, "open")]))


class ApprovalWorkflowsTests(unittest.TestCase):
    def test_a_label_before_green_waits_for_the_pipeline(self):
        # The wake run comes before the Pipeline succeeded: held, green, and the
        # Pipeline's own completion merges without a new label.
        ns = resolver()

        class NoGreen:
            def records(self, path, key=None):
                return []

        wake = {"name": "Owner approval wake", "path": ".github/workflows/owner-approval-wake.yml",
                "event": "pull_request", "status": "completed", "conclusion": "success",
                "head_repository": {"full_name": REPO}, "head_sha": HEAD, "pull_requests": [{"number": 7}]}
        with self.assertRaises(ns["PostMergeError"]) as held:
            ns["_pipeline_of_approval"](wake, REPO, NoGreen())
        self.assertTrue(str(held.exception).startswith(ns["WAITING"]))

    def test_the_record_runs_from_main_and_its_title_matches_the_resolver(self):
        ns = resolver()
        workflow = yaml.safe_load((WORKFLOWS / "owner-approval.yml").read_text())
        self.assertEqual(list(workflow[True]), ["pull_request_target"])
        self.assertEqual(workflow[True]["pull_request_target"]["types"],
                         ["labeled", "synchronize", "opened", "reopened", "edited", "ready_for_review"])
        self.assertEqual(workflow["permissions"], {})
        for job in workflow["jobs"].values():
            for step in job["steps"]:
                self.assertNotIn("uses", step)  # no checkout, no action of the pull request
        rendered = (workflow["run-name"].replace("${{ github.event.action }}", "labeled")
                    .replace("${{ github.event.pull_request.number }}", "7")
                    .replace("${{ github.event.label.name || '-' }}", "owner-approved")
                    .replace("${{ github.event.pull_request.base.ref }}", "main")
                    .replace("${{ github.event.pull_request.head.sha }}", HEAD)
                    .replace("${{ github.actor }}", "cdeust"))
        self.assertTrue(ns["RECORD_TITLE"].fullmatch(rendered), rendered)
        self.assertEqual(ns["RECORD_PATH"], ".github/workflows/owner-approval.yml")

    def test_the_record_workflow_keeps_the_form_its_policy_exception_allows(self):
        # The Actions event policy that allows pull_request_target is scoped to this
        # file; it is defensible only while the file runs nothing of the PR.
        text = (WORKFLOWS / "owner-approval.yml").read_text()
        workflow = yaml.safe_load(text)
        for forbidden in ("uses:", "actions/checkout", "secrets.", "artifact", "run-id", "head.ref", "${{ github.event.pull_request.title"):
            self.assertNotIn(forbidden, text)
        self.assertEqual(workflow["permissions"], {})
        self.assertEqual(set(workflow["jobs"]), {"clear", "record"})
        self.assertEqual(workflow["jobs"]["clear"]["permissions"], {"pull-requests": "write"})
        self.assertNotIn("permissions", workflow["jobs"]["record"])
        self.assertEqual(workflow["jobs"]["clear"]["steps"][0]["env"]["PR"], "${{ github.event.pull_request.number }}")
        self.assertEqual(workflow["jobs"]["record"]["steps"], [
            {"name": "The title of this run is the record", "run": "echo \"Read by the resolver from the run title\""}])

    def test_the_record_clears_a_stale_label_on_every_push(self):
        clear = yaml.safe_load((WORKFLOWS / "owner-approval.yml").read_text())["jobs"]["clear"]
        self.assertEqual(clear["if"], "(github.event.action == 'synchronize' || github.event.changes.base != null) "
                                      "&& contains(github.event.pull_request.labels.*.name, 'owner-approved')")
        self.assertEqual(clear["steps"][0]["env"], {"GH_TOKEN": "${{ github.token }}", "GH_REPO": "${{ github.repository }}",
                                                    "PR": "${{ github.event.pull_request.number }}"})
        self.assertEqual(clear["permissions"], {"pull-requests": "write"})
        self.assertEqual(clear["steps"][0]["run"], 'gh pr edit "$PR" --remove-label owner-approved')

    def test_the_wake_waits_for_the_very_title_the_record_writes(self):
        wake_script = module_at(ROOT / "scripts/ci_owner_approval_wake.py")
        record_title = yaml.safe_load((WORKFLOWS / "owner-approval.yml").read_text())["run-name"]
        rendered = (record_title.replace("${{ github.event.action }}", "labeled")
                    .replace("${{ github.event.pull_request.number }}", "7")
                    .replace("${{ github.event.label.name || '-' }}", "owner-approved")
                    .replace("${{ github.event.pull_request.base.ref }}", "main")
                    .replace("${{ github.event.pull_request.head.sha }}", HEAD)
                    .replace("${{ github.actor }}", "cdeust"))
        self.assertEqual(wake_script.title(7, "main", HEAD, "cdeust"), rendered)
        self.assertTrue(wake_script.RECORD.fullmatch(rendered))
        self.assertTrue(resolver()["RECORD_TITLE"].fullmatch(rendered))
        workflow = yaml.safe_load((WORKFLOWS / "owner-approval-wake.yml").read_text())
        wake = workflow["jobs"]["wake"]
        self.assertEqual(wake["if"], "github.event.label.name == 'owner-approved'")
        self.assertEqual(wake["permissions"], {"actions": "read"})
        self.assertEqual(wake["steps"][0]["with"], {"persist-credentials": False})
        self.assertEqual(wake["steps"][-1]["run"], "python3 -I scripts/ci_owner_approval_wake.py")
        self.assertEqual(wake["steps"][-1]["env"]["BASE"], "${{ github.event.pull_request.base.ref }}")
        self.assertGreater(wake["timeout-minutes"] * 60, wake_script.DEADLINE_SECONDS)
        self.assertEqual(workflow["concurrency"], {"group": "owner-approval-wake-${{ github.event.pull_request.number }}",
                                                   "cancel-in-progress": True})


def module_at(path):
    import importlib.util
    spec = importlib.util.spec_from_file_location(path.stem, path)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


STARTED = 1_764_000_000.0  # 2025-11-24T16:00:00Z, when the wake run was created


class WakeNeverEndsInSilenceTests(unittest.TestCase):
    """scripts/ci_owner_approval_wake.py: it waits for its own event's record, and fails with a reason."""

    def setUp(self):
        self.wake = module_at(ROOT / "scripts/ci_owner_approval_wake.py")
        self.title = self.wake.title(7, "main", HEAD, "cdeust")

    def run_wait(self, observations):
        state = {"now": STARTED + 5, "reads": 0, "sleeps": 0}
        observed = iter(observations)

        def read(path):
            self.assertIn("/actions/workflows/owner-approval.yml/runs?event=pull_request_target&created=%3E%3D", path)
            state["reads"] += 1
            return next(observed)

        def sleep(seconds):
            state["sleeps"] += 1
            state["now"] += seconds

        result = self.wake.wait("o/r", 7, "main", HEAD, "cdeust", STARTED, read, lambda: state["now"], sleep)
        return result, state

    def page(self, *runs):
        return [{"workflow_runs": list(runs)}]

    def run_(self, status="completed", conclusion="success", title=None, created="2025-11-24T16:00:01Z", id=10):
        return {"display_title": title or self.title, "status": status, "conclusion": conclusion,
                "created_at": created, "id": id}

    def test_it_waits_until_the_record_finishes_then_wakes(self):
        (ok, message), state = self.run_wait([self.page(), self.page(self.run_(status="queued", conclusion=None)),
                                              self.page(self.run_(status="in_progress", conclusion=None)),
                                              self.page(self.run_())])
        self.assertTrue(ok)
        self.assertEqual((state["reads"], state["sleeps"]), (4, 3))
        self.assertIn("resolver is woken", message)

    def test_a_newer_record_in_progress_outranks_an_older_finished_one(self):
        # S12a and S12b (second review of b80511b): after a removal and a new label,
        # an older record of the same title must not decide.
        for old_conclusion in ("failure", "success"):
            old = self.run_(conclusion=old_conclusion, created="2025-11-24T16:00:01Z", id=10)
            running = self.run_(status="in_progress", conclusion=None, created="2025-11-24T16:00:02Z", id=11)
            done = dict(running, status="completed", conclusion="success")
            with self.subTest(old=old_conclusion):
                (ok, message), state = self.run_wait([self.page(old, running), self.page(old, done)])
                self.assertTrue(ok)
                self.assertEqual(state["reads"], 2)

    def test_it_looks_back_only_to_just_before_its_own_run(self):
        seen = []
        self.wake.wait("o/r", 7, "main", HEAD, "cdeust", STARTED,
                       lambda path: seen.append(path) or self.page(self.run_()), lambda: STARTED, lambda _: None)
        self.assertEqual(seen, ["repos/o/r/actions/workflows/owner-approval.yml/runs"
                                "?event=pull_request_target&created=%3E%3D2025-11-24T15:59:30Z&per_page=100"])
        from unittest.mock import patch
        with patch.object(self.wake.subprocess, "check_output", return_value=b"[]") as call:
            self.assertEqual(self.wake.gh_pages("p"), [])
        self.assertEqual(call.call_args.args[0], ["gh", "api", "--paginate", "--slurp", "p"])

    def test_a_record_that_did_not_run_fails_and_names_the_gesture(self):
        for conclusion in ("failure", "startup_failure", "cancelled"):
            with self.subTest(conclusion=conclusion):
                (ok, message), _ = self.run_wait([self.page(self.run_(conclusion=conclusion))])
                self.assertFalse(ok)
                self.assertIn("Actions event policy", message)
                self.assertIn(self.wake.AGAIN, message)

    def test_a_blocked_run_with_another_title_is_recognised(self):
        # A run GitHub blocks may carry the default title (a commit message).
        blocked = self.run_(conclusion="failure", title="fix: something")
        (ok, message), state = self.run_wait([self.page(blocked)])
        self.assertFalse(ok)
        self.assertIn("blocked before it ran", message)
        self.assertIn("Actions event policy", message)
        self.assertEqual(state["reads"], 1)
        # Positive control: a failed record of another PR with a record title is not ours.
        other = self.run_(conclusion="failure", title=self.wake.title(8, "main", HEAD, "cdeust"))
        (ok, message), _ = self.run_wait([self.page(other)] * 100)
        self.assertIn("after 10 minutes", message)
        # A running run with another title is not yet a block.
        unknown = self.run_(status="in_progress", conclusion=None, title="fix: something")
        (ok, message), _ = self.run_wait([self.page(unknown)] * 100)
        self.assertIn("after 10 minutes", message)

    def test_no_record_in_ten_minutes_fails_and_names_the_policy_and_the_gesture(self):
        (ok, message), state = self.run_wait([self.page()] * 100)
        self.assertFalse(ok)
        self.assertIn("after 10 minutes", message)
        self.assertIn("Actions event policy", message)
        self.assertIn(self.wake.AGAIN, message)
        self.assertEqual(state["sleeps"], self.wake.DEADLINE_SECONDS // self.wake.POLL_SECONDS)

    def test_only_the_record_of_this_label_base_head_and_actor_counts(self):
        others = [self.run_(title=self.wake.title(8, "main", HEAD, "cdeust")),
                  self.run_(title=self.wake.title(7, "staging", HEAD, "cdeust")),
                  self.run_(title=self.wake.title(7, "main", "b" * 40, "cdeust")),
                  self.run_(title=self.wake.title(7, "main", HEAD, "someone"))]
        (ok, message), _ = self.run_wait([self.page(*others)] * 100)
        self.assertFalse(ok)
        self.assertIn("after 10 minutes", message)

    def test_the_newest_record_decides_across_all_pages_with_id_as_tie_break(self):
        old = self.run_(conclusion="failure", created="2025-11-24T16:00:01Z", id=1)
        new = self.run_(conclusion="success", created="2025-11-24T16:00:05Z", id=2)
        (ok, _), _ = self.run_wait([[{"workflow_runs": [old]}, {"workflow_runs": [new]}]])
        self.assertTrue(ok)
        (ok, _), _ = self.run_wait([[{"workflow_runs": [new]}, {"workflow_runs": [dict(old, created_at="2025-11-24T16:00:09Z")]}]])
        self.assertFalse(ok)
        same_second = "2025-11-24T16:00:05Z"
        (ok, _), _ = self.run_wait([self.page(dict(old, created_at=same_second, id=3), dict(new, created_at=same_second, id=2))])
        self.assertFalse(ok)
        (ok, _), _ = self.run_wait([self.page(dict(old, created_at=same_second, id=2), dict(new, created_at=same_second, id=3))])
        self.assertTrue(ok)

    def run_main(self, read):
        import os
        import tempfile
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp:
            summary = Path(tmp) / "summary"
            env = {"GH_REPO": "o/r", "PR": "7", "BASE": "main", "HEAD_SHA": HEAD, "ACTOR": "cdeust",
                   "GITHUB_RUN_ID": "99", "GITHUB_STEP_SUMMARY": str(summary)}
            state = {"now": STARTED + 5}

            def sleep(seconds):
                state["now"] += seconds

            def reads(path):
                if path == "repos/o/r/actions/runs/99":
                    return [{"created_at": "2025-11-24T16:00:00Z"}]
                return read(path)

            with patch.dict(os.environ, env), contextlib.redirect_stdout(io.StringIO()) as out:
                code = self.wake.main(reads, lambda: state["now"], sleep)
            self.assertEqual(out.getvalue().strip(), summary.read_text().strip())
            return code, summary.read_text()

    def test_main_ends_with_a_code_and_a_summary_for_every_outcome(self):
        done = lambda conclusion: (lambda path: self.page(self.run_(conclusion=conclusion)))  # noqa: E731
        code, text = self.run_main(done("success"))
        self.assertEqual((code, "resolver is woken" in text), (0, True))
        code, text = self.run_main(done("failure"))
        self.assertEqual(code, 1)
        self.assertIn("Actions event policy", text)
        self.assertIn(self.wake.AGAIN, text)
        code, text = self.run_main(lambda path: self.page())
        self.assertEqual(code, 1)
        self.assertIn("after 10 minutes", text)
        self.assertIn(self.wake.AGAIN, text)

        def broken(path):
            raise subprocess.CalledProcessError(1, ["gh", "api"])

        code, text = self.run_main(broken)
        self.assertEqual(code, 1)
        self.assertIn("Reading the approval records failed (CalledProcessError)", text)
        self.assertIn(self.wake.AGAIN, text)

    def test_main_dates_its_wait_by_its_own_run(self):
        seen = []
        self.run_main(lambda path: seen.append(path) or self.page(self.run_()))
        self.assertIn("created=%3E%3D2025-11-24T15:59:30Z", seen[0])

    def test_the_gesture_starts_again_the_resolver_accepts_a_new_label(self):
        # Removing and setting the label again records a newer approval of this
        # head, which the resolver accepts after the removal.
        api = FakeApi([record(T1), record(T3)], [unlabeled(T2)])
        ns = resolver()
        ns["_merge_open_pr"](pull(), "/merge", HEAD, api, REPO)
        self.assertEqual(len(api.puts), 1)

    def test_a_hostile_wake_cannot_cause_a_merge(self):
        # The wake runs the PR's code. Whatever it reports, the resolver reads the
        # record of owner-approval.yml from main: a successful wake with no record,
        # or with a record of the PR's own workflow, merges nothing.
        ns = resolver()
        wake = {"name": "Owner approval wake", "path": ".github/workflows/owner-approval-wake.yml",
                "event": "pull_request", "status": "completed", "conclusion": "success",
                "head_repository": {"full_name": REPO}, "head_sha": HEAD, "display_title": "approved, merge"}
        for records in ([], [wake], [dict(record(T2), event="pull_request",
                                          path=".github/workflows/owner-approval-wake.yml")]):
            api = FakeApi(records)
            with self.subTest(records=len(records)), self.assertRaises(ns["PostMergeError"]):
                ns["_merge_open_pr"](pull(), "/merge", HEAD, api, REPO)
            self.assertEqual(api.puts, [])

    def test_the_wake_decides_nothing(self):
        # It runs from the pull request: whatever it becomes, the resolver reads
        # the record of owner-approval.yml from main and the label's events.
        workflow = yaml.safe_load((WORKFLOWS / "owner-approval-wake.yml").read_text())
        self.assertEqual(workflow[True], {"pull_request": {"types": ["labeled"]}})
        self.assertEqual(workflow["permissions"], {})
        source = (WORKFLOWS / "pipeline-post-merge.yml").read_text()
        body = source.split("def _owner_approves", 1)[1].split("def _merge_open_pr", 1)[0]
        self.assertNotIn("owner-approval-wake", body)
        self.assertNotIn("_pipeline_of_approval", body)


class BotsAreOptionalTests(unittest.TestCase):
    def test_the_resolver_reads_no_bot_verdict(self):
        source = (WORKFLOWS / "pipeline-post-merge.yml").read_text().split("  close-issues:", 1)[0]
        for needle in ("claude[bot]", "chatgpt-codex-connector", "claude-review.yml", "Verdict:",
                       "review-subscription.yml"):
            self.assertNotIn(needle, source)

    def test_a_failed_or_absent_review_job_does_not_fail_the_merge_gate(self):
        ns = resolver()
        names = ["contract", "unit", "regression", "e2e", "merge"]
        names += [f"{k} ({os})" for k in ("environment", "install")
                  for os in ("ubuntu-latest", "macos-latest", "windows-latest")]
        green = [{"name": n, "status": "completed", "conclusion": "success"} for n in names]
        for review in ([], [{"name": "Claude review", "status": "completed", "conclusion": "failure"}],
                       [{"name": "Claude review", "status": "completed", "conclusion": "skipped"}]):
            with self.subTest(review=review):
                ns["_validate_jobs"](green + review)
        # Positive control: a failed required job still holds.
        with self.assertRaises(ns["PostMergeError"]):
            ns["_validate_jobs"]([dict(j, conclusion="failure") if j["name"] == "unit" else j for j in green])

    def test_codex_out_of_usage_neither_reddens_a_check_nor_holds_an_approved_merge(self):
        # Run 45719916984 (#407, 2026-11-26) and #400 (run 45694083586): the
        # connector answered "You have reached your Codex usage limits for code
        # reviews", the CI raised "Codex did not complete a code review", and the
        # PR could not merge. Now no workflow asks for or waits on a Codex review,
        # and the resolver reads no PR comment, so the native summary marked
        # failed and the usage-limit reply change nothing.
        for path in WORKFLOWS.glob("*.yml"):
            text = path.read_text()
            with self.subTest(workflow=path.name):
                self.assertNotIn("ci_review_codex.py", text)
                self.assertNotIn("Codex GitHub review", text)
                self.assertNotIn("ci_native_verdict", text if path.name != "native-review-acceptance.yml" else "")
        self.assertFalse((ROOT / "scripts/ci_review_codex.py").exists())

        class WithCodexComments(FakeApi):
            def records(self, path, key=None):
                if path.endswith("/issues/7/comments"):
                    raise AssertionError("the resolver read a PR comment")
                return super().records(path, key)

        api = WithCodexComments([record(T2)])
        ns = resolver()
        ns["_merge_open_pr"](pull(), "/merge", HEAD, api, REPO)
        self.assertEqual([put[0] for put in api.puts], ["PUT"])
        self.assertFalse(any("comments" in path for path in api.paths))

    def test_review_bots_do_not_wake_the_resolver(self):
        caller = yaml.safe_load((WORKFLOWS / "pipeline-after-merge.yml").read_text())
        self.assertEqual(caller[True]["workflow_run"]["workflows"], ["Pipeline", "Owner approval wake"])

    def test_no_workflow_requests_or_verifies_a_bot_review(self):
        for path in WORKFLOWS.glob("*.yml"):
            text = path.read_text()
            with self.subTest(path=path.name):
                self.assertNotIn("@codex review", text if path.name != "native-review-acceptance.yml" else "")
                self.assertNotIn("ci_review_verdict.py", text)
                self.assertNotIn("claude-subscription-quota", text)
        self.assertFalse((WORKFLOWS / "review-subscription.yml").exists())


class GeneratorDivergenceTests(unittest.TestCase):
    """zetetic-team-subagents render-ci still renders the bot verdict gate.

    The owner paused that repository on 2026-11-25, so the template is not
    changed yet. A re-render would silently bring the old gate back.
    """

    def test_a_re_render_of_the_old_resolver_fails_here(self):
        post = (WORKFLOWS / "pipeline-post-merge.yml").read_text()
        after = (WORKFLOWS / "pipeline-after-merge.yml").read_text()
        for text in (post, after):
            self.assertIn("KNOWN DIVERGENCE (owner decision of 2026-11-25)", text)
        self.assertIn("_owner_approves(pr, head, repository, api, tested_at)", post)
        for rendered in ("render-ci: native-verdict begin", "_selected_review_approves", "REVIEW_WORKFLOW_NAME",
                         "_review_approves("):
            self.assertNotIn(rendered, post)
        self.assertNotIn("workflows: [Pipeline, PR Review]", after)


class InstalledManifestsTests(unittest.TestCase):
    """Each `npm ci --prefix <dir>` of a workflow, and of ci.json, names a locked manifest.

    PR #406 removed .github/actions/claude-subscription-quota while #402 on main
    started to install the pinned CLI from it: the texts merged, the workflows broke.
    """

    PREFIX = re.compile(r"npm (?:ci|audit) --prefix (\S+)")

    def prefixes(self):
        found = []
        for path in sorted(WORKFLOWS.glob("*.yml")) + [ROOT / "ci.json"]:
            for prefix in self.PREFIX.findall(path.read_text()):
                prefix = prefix.strip('"').removeprefix("$GITHUB_WORKSPACE/").removeprefix("control/")
                self.assertNotIn("$", prefix, f"{path.name}: {prefix}")
                found.append((path.name, prefix))
        return found

    def test_every_installed_prefix_has_a_locked_manifest(self):
        prefixes = self.prefixes()
        self.assertIn(("claude.yml", ".github/owner-mention-cli"), prefixes)  # positive control
        for name, prefix in prefixes:
            with self.subTest(workflow=name, prefix=prefix):
                self.assertTrue((ROOT / prefix / "package.json").is_file())
                self.assertTrue((ROOT / prefix / "package-lock.json").is_file())

    def test_the_owner_mention_cli_is_updated_and_audited(self):
        dependabot = yaml.safe_load((ROOT / ".github/dependabot.yml").read_text())
        self.assertIn("/.github/owner-mention-cli", [u["directory"] for u in dependabot["updates"]])
        unit = json.loads((ROOT / "ci.json").read_text())["unit"]
        self.assertIn("npm audit --prefix .github/owner-mention-cli --omit=dev --audit-level=high", unit)


class AgentsDoNotApproveTests(unittest.TestCase):
    """The session guard of delivery-gate.json, through its own guardDecision."""

    def decisions(self, commands):
        script = (
            "import {guardDecision} from './scripts/gate/gate-lib.mjs';"
            "import {readFileSync} from 'node:fs';"
            "const guard = JSON.parse(readFileSync('delivery-gate.json', 'utf8')).guard;"
            "const commands = JSON.parse(process.argv[1]);"
            "console.log(JSON.stringify(commands.map((command) =>"
            " guardDecision({tool_name: 'Bash', tool_input: {command}}, guard).kind)));"
        )
        out = subprocess.run(["node", "--input-type=module", "-e", script, json.dumps(commands)],
                             cwd=ROOT, capture_output=True, text=True, timeout=60, check=True)
        return dict(zip(commands, json.loads(out.stdout)))

    def test_the_session_guard_refuses_setting_the_approval_label(self):
        refused = ["gh pr edit 7 --add-label owner-approved",
                   "gh pr edit 7 --add-label bug,owner-approved",
                   "gh pr edit 7 --add-label=owner-approved",
                   "gh pr edit 7 --add-label 'owner-approved'",
                   "GH_TOKEN=x gh issue edit 7 --add-label owner-approved",
                   "gh api repos/cdeust/x/issues/7/labels -f 'labels[]=owner-approved'",
                   "gh api -X POST repos/cdeust/x/issues/7/labels --input body.json",
                   "gh label create owner-approved",
                   "timeout 30 gh pr edit 7 --add-label owner-approved",
                   "gh pr --repo o/r edit 7 --add-label owner-approved",
                   "\\gh pr edit 7 --add-label owner-approv\\ed",
                   "$(which gh) pr edit 7 --add-label owner-approved",
                   "gh api repos/o/r/issues/7/ -X PATCH -f labels[]=owner-approved",
                   "gh pr edit 7 --remove-label owner-approved",
                   "echo ok && gh pr edit 7 --add-label owner-approved",
                   "gh -R o/r pr edit 7 --add-label owner-approved",
                   "gh pr create --label owner-approved",
                   "gh api -X PATCH repos/o/r/issues/7 -f 'labels[]=owner-approved'",
                   "gh api graphql -f query='mutation{addLabelsToLabelable(input:{}){clientMutationId}}'",
                   "env -i gh pr edit 7 --add-label owner-approved",
                   "/usr/local/bin/gh pr edit 7 --add-label owner-approved",
                   "gh alias set ok 'pr edit --add-label owner-approved'",
                   "gh -R o/r pr merge 7"]
        # A label built at run time, or a body-less write, names nothing the guard
        # can read: the contract declares them out of reach (docs/review-subscriptions.md).
        allowed = ["gh pr edit 7 --add-label claude-rereview", "gh pr view 7 --json labels",
                   "gh api repos/cdeust/x/issues/7/labels", "gh pr list --label owner-approved",
                   "gh label list", "gh -R o/r pr view 7", "gh api repos/o/r/issues/7",
                   "gh api --method PUT repos/cdeust/x/issues/7/labels"]
        refused.append("gh pr edit 7 --add-label $L")  # a label value it cannot read
        decided = self.decisions(refused + allowed)
        for command in refused:
            with self.subTest(command=command):
                self.assertEqual(decided[command], "refuse")
        for command in allowed:  # positive control
            with self.subTest(command=command):
                self.assertEqual(decided[command], "allow")


if __name__ == "__main__":
    unittest.main()
