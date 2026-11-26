"""The owner's approval of the current head decides the merge; review bots are optional.

Owner decision of 2026-11-25: "pas de check du quota et tous les bots deviennent
optionnels et le merge un approve du user". The table and the threat model are in
docs/review-subscriptions.md.
"""
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


def record(at, action="labeled", sha=HEAD, by=OWNER, label="owner-approved", pr=7, rerun_by=None,
           path=".github/workflows/owner-approval.yml", event="pull_request_target", run_id=None,
           status="completed", conclusion="success"):
    """A run of owner-approval.yml as the REST API lists it."""
    title = f"Owner approval {action} PR {pr} label {label} at {sha} by {by['login']}"
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
                "head_repository": {"full_name": REPO}, "head_sha": HEAD}
        with self.assertRaises(ns["PostMergeError"]) as held:
            ns["_pipeline_of_approval"](wake, REPO, NoGreen())
        self.assertTrue(str(held.exception).startswith(ns["WAITING"]))

    def test_the_record_runs_from_main_and_its_title_matches_the_resolver(self):
        ns = resolver()
        workflow = yaml.safe_load((WORKFLOWS / "owner-approval.yml").read_text())
        self.assertEqual(list(workflow[True]), ["pull_request_target"])
        self.assertEqual(workflow[True]["pull_request_target"]["types"], ["labeled", "synchronize"])
        self.assertEqual(workflow["permissions"], {})
        for job in workflow["jobs"].values():
            for step in job["steps"]:
                self.assertNotIn("uses", step)  # no checkout, no action of the pull request
        rendered = (workflow["run-name"].replace("${{ github.event.action }}", "labeled")
                    .replace("${{ github.event.pull_request.number }}", "7")
                    .replace("${{ github.event.label.name || '-' }}", "owner-approved")
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
        self.assertEqual(clear["if"], "github.event.action == 'synchronize' "
                                      "&& contains(github.event.pull_request.labels.*.name, 'owner-approved')")
        self.assertEqual(clear["permissions"], {"pull-requests": "write"})
        self.assertEqual(clear["steps"][0]["run"], 'gh pr edit "$PR" --remove-label owner-approved')

    def test_the_wake_waits_for_the_very_title_the_record_writes(self):
        record_title = yaml.safe_load((WORKFLOWS / "owner-approval.yml").read_text())["run-name"]
        wake = yaml.safe_load((WORKFLOWS / "owner-approval-wake.yml").read_text())["jobs"]["wake"]
        waited = wake["steps"][0]["env"]["TITLE"]
        self.assertEqual(record_title.replace("${{ github.event.action }}", "labeled")
                         .replace("${{ github.event.label.name || '-' }}", "owner-approved"), waited)
        self.assertEqual(wake["permissions"], {"actions": "read"})
        self.assertIn("exit 0", wake["steps"][0]["run"])

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
        self.assertIn("_owner_approves(pr, head, repository, api)", post)
        for rendered in ("render-ci: native-verdict begin", "_selected_review_approves", "REVIEW_WORKFLOW_NAME",
                         "_review_approves("):
            self.assertNotIn(rendered, post)
        self.assertNotIn("workflows: [Pipeline, PR Review]", after)


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
                   "gh api --method PUT repos/cdeust/x/issues/7/labels",
                   "gh label create owner-approved",
                   "echo ok && gh pr edit 7 --add-label owner-approved",
                   "gh -R o/r pr edit 7 --add-label owner-approved",
                   "gh pr create --label owner-approved",
                   "gh api -X PATCH repos/o/r/issues/7 -f 'labels[]=owner-approved'",
                   "gh api graphql -f query='mutation{addLabelsToLabelable(input:{}){clientMutationId}}'",
                   "env -i gh pr edit 7 --add-label owner-approved",
                   "/usr/local/bin/gh pr edit 7 --add-label owner-approved",
                   "gh pr edit 7 --add-label $L",
                   "gh alias set ok 'pr edit --add-label owner-approved'",
                   "gh -R o/r pr merge 7"]
        allowed = ["gh pr edit 7 --add-label claude-rereview", "gh pr view 7 --json labels",
                   "gh pr edit 7 --remove-label owner-approved", "gh api repos/cdeust/x/issues/7/labels",
                   "gh label list", "gh -R o/r pr view 7", "gh api repos/o/r/issues/7"]
        decided = self.decisions(refused + allowed)
        for command in refused:
            with self.subTest(command=command):
                self.assertEqual(decided[command], "refuse")
        for command in allowed:  # positive control
            with self.subTest(command=command):
                self.assertEqual(decided[command], "allow")


if __name__ == "__main__":
    unittest.main()
