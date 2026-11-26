"""Exercise the protected resolver, published status and actual GitHub event shapes."""
from copy import deepcopy
from pathlib import Path
import json
import runpy
import unittest

from test_ci_review_required import resolver

ROOT = Path(__file__).resolve().parents[2]
REPO = "owner/spec"
HEAD, OLD_HEAD = "a" * 40, "b" * 40
CLAUDE = {"login": "claude", "id": "BOT_kgDODIGtWg", "__typename": "Bot"}
CODEX = {"login": "chatgpt-codex-connector", "id": "BOT_kgDOC98s_g", "__typename": "Bot"}
PR = {"number": 7, "state": "open", "draft": False, "labels": [], "title": "Review",
      "head": {"sha": HEAD, "repo": {"full_name": REPO}}, "base": {"ref": "main", "repo": {"full_name": REPO}}}
LINK = f"https://github.com/{REPO}/actions/runs/15/attempts/1"
FOOTER = f"Reviewed commit: {HEAD}\n[View job run]({LINK})\nVerdict: approve"
NATIVE = "<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 "


def row(author, body):
    return {"body": body, "author": author, "createdAt": "2026-11-26T00:10:00Z",
            "lastEditedAt": None, "editor": None}


def native(sha=HEAD, status="completed", unresolved=False):
    return row(CODEX, NATIVE + json.dumps({"code_review": {"commit_sha": sha, "status": status,
                 "has_any_findings": unresolved, "has_unresolved_findings": unresolved}}) + " -->")


def done(name):
    return {"name": name, "status": "completed", "conclusion": "success"}


def page(rows, more=False):
    info = {"hasNextPage": more, "endCursor": "second" if more else None}
    return {"data": {"repository": {"pullRequest": {"headRefOid": HEAD, "state": "OPEN",
            "isDraft": False, "baseRefName": "main", "timelineItems": {"nodes": []}, "comments": {"nodes": rows, "pageInfo": info}}}}}


class Api:
    def __init__(self):
        self.pr = deepcopy(PR)
        self.run = {**done("PR Review"), "id": 15, "run_attempt": 1, "head_sha": HEAD, "event": "pull_request_target",
                    "path": ".github/workflows/claude-review.yml", "head_branch": "feature",
                    "head_repository": {"full_name": REPO}, "repository": {"full_name": REPO},
                    "display_title": f"Review PR 7 at {HEAD}", "pull_requests": [deepcopy(PR)]}
        self.run.update(created_at="2026-11-26T00:00:00Z", updated_at="2026-11-26T00:12:00Z")
        self.other_runs = []
        self.job = {**done("Claude review"), "run_id": 15, "run_attempt": 1, "head_sha": HEAD,
                    "steps": [done("PR Review"), done("Record Claude approval")]}
        self.rows = [[row(CLAUDE, FOOTER)], [native()]]
        self.base_changes = []
        self.merged, self.statuses = [], []
        self.pipelines = [{**done("Pipeline"), "id": 61, "head_sha": HEAD, "pull_requests": [PR]}]

    def records(self, path, key):
        prefix = f"/repos/{REPO}/actions/"
        if path == prefix + f"workflows/claude-review.yml/runs?event=pull_request_target&head_sha={HEAD}":
            return [self.run, *self.other_runs]
        if path in [prefix + f"runs/{run['id']}/attempts/{run['run_attempt']}/jobs"
                    for run in [self.run, *self.other_runs]]:
            return [self.job]
        if path == prefix + f"workflows/pipeline.yml/runs?head_sha={HEAD}&event=pull_request&status=success":
            return self.pipelines
        raise AssertionError(path)

    def request(self, method, path, body=None):
        if (method, path) == ("POST", "/graphql"):
            index = int(body["variables"].get("endCursor") == "second")
            result = page(self.rows[index], more=index == 0)
            result["data"]["repository"]["pullRequest"]["timelineItems"]["nodes"] = self.base_changes
            return result
        if (method, path) == ("GET", f"/repos/{REPO}/pulls/7"):
            return self.pr
        if (method, path) == ("PUT", "/merge"):
            self.merged.append(body)
            return {"merged": True, "sha": OLD_HEAD}
        if (method, path) == ("POST", f"/repos/{REPO}/statuses/{HEAD}"):
            self.statuses.append(body)
            return {}
        raise AssertionError((method, path))


class BothReviews(unittest.TestCase):
    def setUp(self):
        self.ns, self.api = resolver(), Api()

    def merge(self):
        return self.ns["_merge_open_pr"](self.api.pr, "/merge", HEAD, self.api, REPO)

    def held(self):
        with self.assertRaises(self.ns["PostMergeError"]):
            self.merge()
        self.assertEqual(self.api.merged, [])

    def test_real_target_run_and_two_paginated_approvals_merge_only_the_tested_head(self):
        self.assertEqual(self.merge(), OLD_HEAD)
        self.assertEqual(self.api.merged, [{"sha": HEAD, "merge_method": "squash"}])

    def test_wrong_head_base_repository_pr_workflow_or_attempt_never_merges(self):
        for key, value in (("head_sha", OLD_HEAD), ("event", "pull_request"), ("head_repository", {}),
                           ("pull_requests", []), ("path", ".github/workflows/other.yml"),
                           ("pull_requests", [{**PR, "base": {"ref": "feature"}}]),
                           ("display_title", f"Review PR 8 at {HEAD}"), ("conclusion", "skipped")):
            with self.subTest(key=key):
                self.api = Api()
                self.api.run[key] = value
                self.held()
        self.api = Api()
        self.api.job["run_attempt"] = 2
        self.held()

    def test_absent_changed_edited_or_ambiguous_claude_verdict_holds(self):
        cases = [[], [row(CODEX, FOOTER)], [row(CLAUDE, FOOTER.replace(HEAD, OLD_HEAD))],
                 [row(CLAUDE, FOOTER.replace("attempts/1", "attempts/2"))],
                 [row(CLAUDE, FOOTER.replace("approve", "block"))],
                 [row(CLAUDE, FOOTER), row(CLAUDE, FOOTER.replace("approve", "block"))],
                 [{**row(CLAUDE, FOOTER), "lastEditedAt": "2026-11-26T01:00:00Z", "editor": CODEX}]]
        for rows in cases:
            with self.subTest(rows=rows):
                self.api.rows[0] = rows
                self.held()
        self.api.rows[0] = [{**row(CLAUDE, FOOTER), "lastEditedAt": "2026-11-26T01:00:00Z", "editor": CLAUDE}]
        self.assertEqual(self.merge(), OLD_HEAD)

    def test_codex_failure_findings_queue_and_edits_hold_even_with_claude_approval(self):
        for evidence in ([], [native(OLD_HEAD)], [native(status="failed")], [native(unresolved=True)],
                         [native(status="running")], [{**native(), "editor": CLAUDE, "lastEditedAt": "today"}]):
            with self.subTest(evidence=evidence):
                self.api.rows[1] = evidence
                self.held()

    def test_spoofed_approval_without_the_protected_structured_result_is_refused(self):
        self.api.job["steps"][1]["conclusion"] = "skipped"
        self.held()

    def test_retargeted_base_requires_new_review_and_pipeline_even_when_head_is_unchanged(self):
        self.api.base_changes = [{"createdAt": "2026-11-25T00:00:00Z"}]
        self.api.run["created_at"] = "2026-11-24T00:00:00Z"
        self.held()
        self.api.run["created_at"] = "2026-11-26T00:00:00Z"
        self.held()
        merge = self.ns["_merge_open_pr"]
        before, after = "2026-11-24T00:00:00Z", "2026-11-26T00:00:00Z"
        # The connector can edit the security review inside an old combined summary.
        self.api.rows[1] = [{**native(), "createdAt": before, "lastEditedAt": after, "editor": CODEX}]
        with self.assertRaisesRegex(self.ns["PostMergeError"], "Codex approval"):
            merge(self.api.pr, "/merge", HEAD, self.api, REPO, after)
        self.assertEqual(self.api.merged, [])
        self.api.rows[1].append(native())
        self.assertEqual(merge(self.api.pr, "/merge", HEAD, self.api, REPO, after), OLD_HEAD)

    def test_latest_attempt_can_be_a_rerun_of_a_lower_run_id(self):
        old = {**self.api.run, "id": 12, "run_attempt": 2, "updated_at": "2026-11-26T01:02:00Z"}
        self.api.other_runs = [old]
        self.api.job.update(run_id=12, run_attempt=2)
        body = FOOTER.replace("/15/attempts/1", "/12/attempts/2")
        self.api.rows[0].append({**row(CLAUDE, body.replace("approve", "block")),
                                 "createdAt": "2026-11-26T01:01:00Z"})
        publish = runpy.run_path(str(ROOT / "scripts/ci_review_status.py"))["publish"]
        self.assertFalse(publish(self.api, REPO, 7, LINK))
        self.assertEqual(self.api.statuses[-1]["state"], "failure")
        self.held()
        self.api.rows[0][-1]["body"] = body
        self.assertEqual(self.merge(), OLD_HEAD)

    def test_running_or_simultaneously_completed_attempts_hold(self):
        for changes in ({"status": "in_progress"}, {}):
            with self.subTest(changes=changes):
                self.api.other_runs = [{**self.api.run, "id": 12, **changes}]
                self.held()

    def test_later_claude_retraction_on_another_run_revokes_approval(self):
        self.api.other_runs = [{**self.api.run, "id": 12, "updated_at": "2026-11-26T00:05:00Z"}]
        body = FOOTER.replace("/15/attempts/", "/12/attempts/").replace("approve", "block")
        self.api.rows[0].append({**row(CLAUDE, body), "createdAt": "2026-11-26T00:03:00Z"})
        self.assertEqual(self.merge(), OLD_HEAD)
        self.api.merged.clear()
        self.api.rows[0][-1].update(lastEditedAt="2026-11-26T00:15:00Z", editor=CLAUDE)
        self.held()

    def test_late_retraction_of_a_previous_attempt_of_the_same_run_holds(self):
        self.api.run["run_attempt"] = self.api.job["run_attempt"] = 2
        self.api.rows[0][0]["body"] = FOOTER.replace("/attempts/1", "/attempts/2")
        self.api.rows[0].append({**row(CLAUDE, FOOTER.replace("approve", "block")),
                                 "lastEditedAt": "2026-11-26T01:00:00Z", "editor": CLAUDE})
        self.held()

    def test_human_veto_or_changed_pr_during_reviews_prevents_the_merge(self):
        for change in ({"labels": [{"name": "Hold"}]}, {"labels": [{"name": "do-not-merge"}]},
                       {"title": "Do not merge today"}, {"draft": True}, {"state": "closed"},
                       {"head": {**PR["head"], "sha": OLD_HEAD}}, {"labels": None}):
            with self.subTest(change=change):
                self.api = Api()
                initial = deepcopy(self.api.pr)
                read = self.api.request
                def request(method, path, body=None):
                    result = read(method, path, body)
                    if path == "/graphql":
                        self.api.pr.update(change)
                    return result
                self.api.request = request
                with self.assertRaises(self.ns["PostMergeError"]):
                    self.ns["_merge_open_pr"](initial, "/merge", HEAD, self.api, REPO)
                self.assertEqual(self.api.merged, [])

    def test_issue_comment_wakes_only_the_current_pr_pipeline(self):
        wake = {**self.api.run, "name": "Review updated", "event": "issue_comment", "head_branch": "main",
                "head_sha": OLD_HEAD, "display_title": "Review updated PR 7",
                "path": ".github/workflows/review-updated.yml", "pull_requests": []}
        resolve = self.ns["_pipeline_of_review"]
        self.assertEqual(resolve(wake, REPO, self.api)["id"], 61)
        self.assertEqual(resolve(self.api.run, REPO, self.api)["id"], 61)
        self.api.pipelines[0]["pull_requests"] = [{"number": 8}]
        with self.assertRaises(self.ns["PostMergeError"]):
            resolve(wake, REPO, self.api)

    def test_normal_status_producer_replaces_a_success_after_native_approval_is_withdrawn(self):
        publish = runpy.run_path(str(ROOT / "scripts/ci_review_status.py"))["publish"]
        self.assertTrue(publish(self.api, REPO, 7, LINK))
        self.api.rows[1] = []
        self.assertFalse(publish(self.api, REPO, 7, LINK))
        self.assertEqual([s["state"] for s in self.api.statuses], ["pending", "success", "pending", "failure"])
        self.held()
