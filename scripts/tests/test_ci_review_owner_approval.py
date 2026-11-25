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
PUSHED = "2026-11-25T21:00:00Z"  # first Pipeline run of the head
BEFORE, AFTER, LATER = "2026-11-25T20:59:59Z", "2026-11-25T21:05:00Z", "2026-11-25T21:09:00Z"


def resolver():
    text = (WORKFLOWS / "pipeline-post-merge.yml").read_text()
    source = text.split("          python3 - <<'PY'\n", 1)[1].split("\n          PY", 1)[0]
    namespace = {"__name__": "resolver_test"}
    exec(compile(textwrap.dedent(source), "trusted_resolver", "exec"), namespace)
    return namespace


def labeled(at, actor=OWNER, kind="labeled", label="owner-approved"):
    return {"event": kind, "label": {"name": label}, "actor": actor, "created_at": at}


def pull(labels=("owner-approved",)):
    return {"number": 7, "state": "open", "draft": False, "title": "fix: x",
            "labels": [{"name": n} for n in labels], "user": OWNER}


class FakeApi:
    def __init__(self, events=(), runs=(PUSHED,), owner=OWNER):
        self.events, self.runs, self.owner, self.puts = list(events), list(runs), owner, []

    def records(self, path, key=None):
        if path.endswith("/issues/7/events"):
            return self.events
        if "/actions/workflows/pipeline.yml/runs?head_sha=" in path:
            return [{"head_sha": HEAD, "event": "pull_request", "created_at": at, "id": i + 1}
                    for i, at in enumerate(self.runs)]
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
    def merge(self, pr, api):
        ns = resolver()
        try:
            ns["_merge_open_pr"](pr, "/merge", HEAD, api, REPO)
        except ns["PostMergeError"] as error:
            return str(error)
        return "merged"

    def test_the_approval_table(self):
        other_user = {"login": "someone", "type": "User"}
        bot = {"login": "github-actions[bot]", "type": "Bot"}
        owner_bot = {"login": "cdeust", "type": "Bot"}
        rows = [
            ("approved after the head was pushed", pull(), [labeled(AFTER)], "merged"),
            ("label set before the Pipeline ended", pull(), [labeled(PUSHED[:-3] + "01Z")], "merged"),
            ("relabelled after a removal", pull(), [labeled(BEFORE), labeled(BEFORE, kind="unlabeled"),
                                                     labeled(AFTER)], "merged"),
            ("no label", pull(()), [labeled(AFTER)], "the owner has not approved this head"),
            ("label without its event", pull(), [], "the owner has not approved this head"),
            ("last event removed it", pull(), [labeled(AFTER), labeled(LATER, kind="unlabeled")],
             "the owner has not approved this head"),
            ("approval predates a push", pull(), [labeled(BEFORE)], "the approval predates this head"),
            ("approval at the push second", pull(), [labeled(PUSHED)], "the approval predates this head"),
            ("set by another user", pull(), [labeled(AFTER, other_user)], "not set by the owner"),
            ("set by a bot", pull(), [labeled(AFTER, bot)], "not set by the owner"),
            ("bot with the owner's login", pull(), [labeled(AFTER, owner_bot)], "not set by the owner"),
            ("owner first, then someone else", pull(), [labeled(AFTER), labeled(LATER, other_user)],
             "not set by the owner"),
            ("another label's event", pull(), [labeled(AFTER, label="claude-rereview")],
             "the owner has not approved this head"),
        ]
        for name, pr, events, expected in rows:
            api = FakeApi(events)
            with self.subTest(name):
                outcome = self.merge(pr, api)
                self.assertIn(expected, outcome)
                self.assertEqual(bool(api.puts), expected == "merged")

    def test_the_earliest_run_of_the_head_dates_it(self):
        # A rerun of the Pipeline does not move the head's date.
        api = FakeApi([labeled(AFTER)], runs=(LATER, PUSHED))
        self.assertEqual(self.merge(pull(), api), "merged")
        api = FakeApi([labeled(AFTER)], runs=(LATER, "2026-11-25T21:06:00Z"))
        self.assertIn("predates", self.merge(pull(), api))

    def test_an_undated_head_or_a_malformed_date_holds(self):
        for runs, at in (((), AFTER), (("2026-11-25 21:00:00",), AFTER), ((PUSHED,), "2026-11-25T21:05Z"),
                         ((PUSHED,), None)):
            with self.subTest(runs=runs, at=at):
                self.assertNotEqual(self.merge(pull(), FakeApi([labeled(at)], runs=runs)), "merged")

    def test_an_organization_owner_is_refused(self):
        api = FakeApi([labeled(AFTER)], owner={"login": "cdeust", "type": "Organization"})
        self.assertIn("not a user account", self.merge(pull(), api))

    def test_every_hold_is_a_waiting_reason_not_a_failure(self):
        ns = resolver()
        source = (WORKFLOWS / "pipeline-post-merge.yml").read_text()
        body = source.split("def _owner_approves", 1)[1].split("def _merge_open_pr", 1)[0]
        for reason in re.findall(r'"(merge held: [^"]+)"', body):
            self.assertTrue(reason.startswith(ns["WAITING"]), reason)

    def test_a_hold_label_still_holds_an_approved_pr(self):
        pr = pull(("owner-approved", "hold"))
        self.assertIn("label holds merge", self.merge(pr, FakeApi([labeled(AFTER)])))


class ApprovalWakesTheResolverTests(unittest.TestCase):
    def test_a_label_before_green_waits_for_the_pipeline(self):
        # The approval run wakes the resolver before the Pipeline succeeded: held,
        # green, and the Pipeline's own completion merges without a new label.
        ns = resolver()

        class NoGreen:
            def records(self, path, key=None):
                return []

        approval = {"name": "Owner approval", "path": ".github/workflows/owner-approval.yml",
                    "event": "pull_request", "status": "completed", "conclusion": "success",
                    "head_repository": {"full_name": REPO}, "head_sha": HEAD}
        with self.assertRaises(ns["PostMergeError"]) as held:
            ns["_pipeline_of_approval"](approval, REPO, NoGreen())
        self.assertTrue(str(held.exception).startswith(ns["WAITING"]))

    def test_the_approval_workflow_clears_a_stale_label_on_every_push(self):
        workflow = yaml.safe_load((WORKFLOWS / "owner-approval.yml").read_text())
        self.assertEqual(workflow[True]["pull_request"]["types"], ["labeled", "synchronize"])
        self.assertEqual(workflow["permissions"], {})
        clear = workflow["jobs"]["clear"]
        self.assertIn("github.event.action == 'synchronize'", clear["if"])
        self.assertEqual(clear["permissions"], {"pull-requests": "write"})
        self.assertIn("--remove-label owner-approved", clear["steps"][0]["run"])
        approval = workflow["jobs"]["approval"]
        self.assertIn("github.event.label.name == 'owner-approved'", approval["if"])
        self.assertNotIn("permissions", approval)  # inherits permissions: {}


class BotsAreOptionalTests(unittest.TestCase):
    def test_the_resolver_reads_no_bot_verdict(self):
        source = (WORKFLOWS / "pipeline-post-merge.yml").read_text().split("  close-issues:", 1)[0]
        for needle in ("claude[bot]", "chatgpt-codex-connector", "claude-review.yml", "Verdict:",
                       "review-subscription"):
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
        self.assertEqual(caller[True]["workflow_run"]["workflows"], ["Pipeline", "Owner approval"])

    def test_no_workflow_requests_or_verifies_a_bot_review(self):
        for path in WORKFLOWS.glob("*.yml"):
            text = path.read_text()
            with self.subTest(path=path.name):
                self.assertNotIn("@codex review", text if path.name != "native-review-acceptance.yml" else "")
                self.assertNotIn("ci_review_verdict.py", text)
                self.assertNotIn("claude-subscription-quota", text)
        self.assertFalse((WORKFLOWS / "review-subscription.yml").exists())


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
                   "echo ok && gh pr edit 7 --add-label owner-approved"]
        allowed = ["gh pr edit 7 --add-label claude-rereview", "gh pr view 7 --json labels",
                   "gh pr edit 7 --remove-label owner-approved", "gh api repos/cdeust/x/issues/7/labels",
                   "gh label list"]
        decided = self.decisions(refused + allowed)
        for command in refused:
            with self.subTest(command=command):
                self.assertEqual(decided[command], "refuse")
        for command in allowed:  # positive control
            with self.subTest(command=command):
                self.assertEqual(decided[command], "allow")


if __name__ == "__main__":
    unittest.main()
