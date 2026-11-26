"""Exercise the protected resolver, published status and actual GitHub event shapes."""
from copy import deepcopy
from pathlib import Path
from datetime import datetime, timedelta
from itertools import count
import json
import re
import runpy
import unittest

from test_ci_review_required import completed_jobs, resolver

ROOT = Path(__file__).resolve().parents[2]
REPO = "owner/spec"
HEAD, OLD_HEAD = "a" * 40, "b" * 40
CLAUDE = {"login": "claude", "id": "BOT_kgDODIGtWg", "__typename": "Bot"}
CODEX = {"login": "chatgpt-codex-connector", "id": "BOT_kgDOC98s_g", "__typename": "Bot"}
PR = {"number": 7, "state": "open", "draft": False, "labels": [], "title": "Review",
      "created_at": "2026-11-25T12:00:00Z", "head": {"sha": HEAD, "ref": "feature", "repo": {"full_name": REPO, "id": 120}}, "base": {"ref": "main", "repo": {"full_name": REPO}}}
LINK = f"https://github.com/{REPO}/actions/runs/15/attempts/1"
FOOTER = f"Reviewed commit: {HEAD}\n[View job run]({LINK})\nVerdict: approve"
COMMENT_IDS = count()
NATIVE = "<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 "


def row(author, body):
    return {"id": f"IC_{next(COMMENT_IDS)}", "body": body, "author": author, "createdAt": "2026-11-26T00:10:00Z",
            "lastEditedAt": None, "editor": None}


def native(sha=HEAD, status="completed", unresolved=False, completed="2026-11-26T00:09:00.123456Z"):
    summary = NATIVE + json.dumps({"code_review": {"commit_sha": sha, "status": status,
              "has_any_findings": unresolved, "has_unresolved_findings": unresolved}}) + " -->"
    if status == "completed":
        summary += (f'\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="{completed}">'
                    f'{completed}</relative-time> | `{sha[:7]}` | New commits |')
    elif status == "running":
        summary += (f'\n| 📝 **Code Review** | 🔄 **Running** since <relative-time datetime="{completed}">'
                    f'{completed}</relative-time> | `{sha[:7]}` | New commits |')
    return row(CODEX, summary)


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
        self.job["steps"][0].update(started_at="2026-11-26T00:07:00Z", completed_at="2026-11-26T00:11:00Z")
        self.rows = [[row(CLAUDE, FOOTER)], [native()]]
        self.edit_pages = None
        self.claude_edits = {}
        self.deletions = [[]]
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
            if "COMMENT_DELETED_EVENT" in body["query"]:
                index = int(body["variables"].get("after", 0))
                more = index + 1 < len(self.deletions)
                return {"data": {"repository": {"pullRequest": {"headRefOid": HEAD, "baseRefName": "main",
                        "timelineItems": {"totalCount": sum(map(len, self.deletions)),
                        "nodes": [{"id": f"DE_{index}_{n}", **event} for n, event in enumerate(self.deletions[index])],
                        "pageInfo": {
                            "hasNextPage": more, "endCursor": str(index + 1) if more else None}}}}}}
            if "id" in body["variables"]:
                comment = next(row for page in self.rows for row in page if row.get("id") == body["variables"]["id"])
                if comment["author"] == CLAUDE:
                    def revision(at):
                        return {"diff": comment["body"], "editor": CLAUDE, "deletedAt": None, "editedAt": at}
                    pages = self.claude_edits.get(comment["id"], [[revision(comment["lastEditedAt"]),
                                                                  revision(comment["createdAt"])]])
                elif self.edit_pages is not None:
                    pages = self.edit_pages
                else:
                    when = re.search(r'datetime="([^"]+)"', comment["body"])[1]
                    before = datetime.fromisoformat(when.replace("Z", "+00:00")) - timedelta(seconds=2)
                    start = before.strftime("%Y-%m-%dT%H:%M:%SZ")
                    pages = [[{"diff": native(status="running", completed=start)["body"], "editor": CODEX,
                               "deletedAt": None, "editedAt": start}]]
                index = int(body["variables"]["after"] or 0)
                more = index + 1 < len(pages)
                edits = [{"id": f"EDIT_{index}_{i}", **edit} for i, edit in enumerate(pages[index])]
                return {"data": {"node": {**comment, "userContentEdits": {"nodes": edits,
                        "totalCount": sum(map(len, pages)), "pageInfo": {
                            "hasNextPage": more, "endCursor": str(index + 1) if more else None}}}}}
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

    def check_both_entrypoints(self, allowed, tested_at="2026-11-26T00:00:00Z"):
        publish = runpy.run_path(str(ROOT / "scripts/ci_review_status.py"))["publish"]
        self.assertEqual(publish(self.api, REPO, 7, LINK), allowed)
        self.assertEqual(self.api.statuses[-1]["state"], "success" if allowed else "failure")
        merge = self.ns["_merge_open_pr"]
        args = (self.api.pr, "/merge", HEAD, self.api, REPO, tested_at)
        self.api.merged.clear()
        if allowed:
            self.assertEqual(merge(*args), OLD_HEAD)
        else:
            with self.assertRaises(self.ns["PostMergeError"]):
                merge(*args)
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
        self.held()

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
        self.api.rows[1] = [{**native(completed=before), "createdAt": before, "lastEditedAt": after, "editor": CODEX}]
        with self.assertRaisesRegex(self.ns["PostMergeError"], "Codex approval"):
            merge(self.api.pr, "/merge", HEAD, self.api, REPO, after)
        self.assertEqual(self.api.merged, [])
        self.api.rows[1].append(native())
        self.assertEqual(merge(self.api.pr, "/merge", HEAD, self.api, REPO, after), OLD_HEAD)

    def test_latest_attempt_can_be_a_rerun_of_a_lower_run_id(self):
        old = {**self.api.run, "id": 12, "run_attempt": 2, "updated_at": "2026-11-26T01:02:00Z"}
        self.api.other_runs = [old]
        self.api.job.update(run_id=12, run_attempt=2)
        self.api.job["steps"][0].update(started_at="2026-11-26T00:59:00Z", completed_at=old["updated_at"])
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

    def test_still_unresolved_codex_summary_is_never_lost_at_retarget(self):
        old = "2026-11-24T00:00:00Z"
        adverse = {**native(unresolved=True, completed=old), "createdAt": old,
                   "lastEditedAt": "2026-11-26T00:11:00Z", "editor": CODEX}
        for retarget in ([], [{"createdAt": "2026-11-25T00:00:00Z"}]):
            for rows in ([adverse, native()], [native(), adverse], [native(status="running"), native()]):
                with self.subTest(retarget=retarget, rows=rows):
                    self.api = Api()
                    self.api.base_changes = retarget
                    self.api.rows = [[row(CLAUDE, FOOTER), rows[0]], [rows[1]]]
                    self.check_both_entrypoints(False)

    def test_only_an_unambiguous_fresh_native_code_completion_recovers_an_old_summary(self):
        before = "2026-11-24T12:00:00Z"
        change = "2026-11-25T09:00:00Z"
        issued = "2026-11-26T00:10:00Z"
        self.api.base_changes = [{"createdAt": change}]
        def use(summary):
            self.api.rows[1] = [{**summary, "createdAt": before, "lastEditedAt": issued, "editor": CODEX}]
        use(native(completed=before))
        self.check_both_entrypoints(False)
        good = native(completed="2026-11-25T09:00:06.123456Z")
        code_line = good["body"].splitlines()[-1]
        for line in (code_line.replace("Code Review", "Security Review"), code_line.replace(HEAD[:7], OLD_HEAD[:7]),
                     code_line.replace("09:00:06", "09:00:00"), code_line.replace("2026-11-25", "2026-11-27"),
                     code_line + "\n" + code_line, code_line.replace("Completed", "Queued")):
            with self.subTest(line=line):
                use({**good, "body": good["body"].replace(code_line, line)})
                self.check_both_entrypoints(False)
        use(good)
        self.check_both_entrypoints(True)
        use(native(unresolved=True))
        self.check_both_entrypoints(False)

    def test_codex_completion_on_an_old_diff_cannot_outlast_the_base_change(self):
        change = "2026-11-26T00:05:00Z"
        self.api.base_changes = [{"createdAt": change}]
        self.api.run["created_at"] = "2026-11-26T00:06:00Z"
        summary = self.api.rows[1][0]
        completed = {"diff": summary["body"], "editor": CODEX, "deletedAt": None,
                     "editedAt": "2026-11-26T00:10:00Z"}
        def running(start):
            return {**completed, "diff": native(status="running", completed=start)["body"],
                    "editedAt": "2026-11-26T00:08:00Z"}
        after = running("2026-11-26T00:07:00Z")
        cases = [([], False), ([[completed], [after]], True), ([[after, after]], True),
                 ([[after, running("2026-11-26T00:07:00.5Z")]], False),
                 ([[running("2026-11-26T00:03:00Z")]], False),
                 ([[running(change)]], False), ([[{**after, "editor": CLAUDE}]], False),
                 ([[{**after, "deletedAt": after["editedAt"]}]], False)]
        for pages, allowed in cases:
            with self.subTest(pages=pages):
                self.api.edit_pages = pages or [[]]
                self.check_both_entrypoints(allowed, tested_at="2026-11-26T00:06:00Z")

    def test_unlisted_claude_run_or_new_attempt_blocks_even_beside_a_valid_receipt(self):
        for verdict in ("approve", "block"):
            for run in ("15/attempts/2", "16/attempts/1"):
                with self.subTest(verdict=verdict, run=run):
                    self.api = Api()
                    self.api.rows[1].append(row(CLAUDE, FOOTER.replace("15/attempts/1", run)
                                                               .replace("approve", verdict)))
                    self.check_both_entrypoints(False)

    def test_block_requires_a_new_claude_review_started_strictly_after_it(self):
        self.api.other_runs = [{**self.api.run, "id": 12, "updated_at": "2026-11-26T00:05:00Z"}]
        previous = FOOTER.replace("/15/attempts/", "/12/attempts/").replace("approve", "block")
        block = {**row(CLAUDE, previous), "createdAt": "2026-11-26T00:03:00Z",
                 "lastEditedAt": "2026-11-26T00:08:00Z", "editor": CLAUDE}
        self.api.rows[1].append(block)
        # A late edit cannot turn an older approval into evidence of a fresh review.
        self.api.rows[0][0].update(lastEditedAt="2026-11-26T00:11:00Z", editor=CLAUDE)
        self.check_both_entrypoints(False)
        self.api.rows[0][0] = row(CLAUDE, FOOTER)
        for started, allowed in (("00:07:00", False), ("00:08:00", False), ("00:09:00", True)):
            with self.subTest(started=started):
                self.api.job["steps"][0]["started_at"] = f"2026-11-26T{started}Z"
                self.check_both_entrypoints(allowed)

    def test_rewriting_or_removing_a_block_footer_cannot_restore_an_older_approval(self):
        self.api.other_runs = [{**self.api.run, "id": 12, "updated_at": "2026-11-26T00:05:00Z"}]
        earlier = FOOTER.replace("/15/attempts/", "/12/attempts/")
        created, blocked, edited = ["2026-11-26T00:" + minute + ":00Z" for minute in ("03", "08", "09")]
        earlier_row = {**row(CLAUDE, earlier), "createdAt": created, "lastEditedAt": edited, "editor": CLAUDE}
        self.api.rows[1].append(earlier_row)
        def history(at, body):
            return {"editedAt": at, "diff": body, "deletedAt": None, "editor": CLAUDE}
        for latest in (earlier, "Summary withdrawn", earlier.replace(HEAD, OLD_HEAD)):
            with self.subTest(latest=latest):
                earlier_row["body"] = latest
                original = history(created, earlier)
                adverse = history(blocked, earlier.replace("approve", "block"))
                revisions = [[history(edited, latest)], [adverse, original]]
                self.api.claude_edits[earlier_row["id"]] = revisions
                for started, allowed in (("07", False), ("08", False), ("09", True)):
                    self.api.job["steps"][0]["started_at"] = f"2026-11-26T00:{started}:00Z"
                    self.check_both_entrypoints(allowed)
                for pages in ([[revisions[0][0]], [adverse]], [[], []], [[adverse, original]],
                              [[revisions[0][0], {**adverse, "deletedAt": edited}, original]],
                              [[revisions[0][0], {**adverse, "editor": CODEX}, original]],
                              [[revisions[0][0], original, adverse]],
                              [[{**revisions[0][0], "id": "same"}, {**adverse, "id": "same"}, original]]):
                    self.api.claude_edits[earlier_row["id"]] = pages
                    self.check_both_entrypoints(False)

    def test_whole_claude_comment_deletion_requires_a_later_review(self):
        other = {"__typename": "User", "login": "maintainer"}
        for author, at, allowed in ((CLAUDE, "06", True), (CLAUDE, "07", False), (CLAUDE, "08", False),
                                    (None, "08", False), ({}, "08", False), (other, "08", True),
                                    (CODEX, "08", True), (CODEX, "09", False)):
            with self.subTest(author=author, at=at):
                self.api.deletions = [[], [{"createdAt": f"2026-11-26T00:{at}:00Z", "deletedCommentAuthor": author}]]
                self.check_both_entrypoints(allowed)

    def test_withdrawals_during_verification_hold_both_consumers(self):
        class Changing(Api):
            def __init__(self, withdrawal):
                super().__init__()
                self.withdrawal, self.reads = withdrawal, 0

            def request(self, method, path, body=None):
                if path == "/graphql" and "COMMENT_DELETED_EVENT" in body["query"]:
                    self.reads += 1
                    if self.reads == 1:
                        if self.withdrawal == "edit":
                            self.rows[0][0]["body"] = FOOTER.replace("approve", "block")
                    if self.reads == 2 and self.withdrawal == "deletion":
                        self.deletions = [[{"createdAt": "2026-11-26T00:10:30Z", "deletedCommentAuthor": CLAUDE}]]
                return deepcopy(super().request(method, path, body))

        publish = runpy.run_path(str(ROOT / "scripts/ci_review_status.py"))["publish"]
        for withdrawal in ("edit", "deletion"):
            with self.subTest(withdrawal=withdrawal):
                self.api = Changing(withdrawal)
                self.held()
                self.assertFalse(publish(Changing(withdrawal), REPO, 7, LINK))

    def test_new_attempt_during_comment_collection_invalidates_each_consumer(self):
        class Changing(Api):
            def __init__(self):
                super().__init__()
                self.reads = 0
            def records(self, path, key):
                rows = super().records(path, key)
                if "workflows/claude-review.yml" in path:
                    self.reads += 1
                    if self.reads % 2 == 0:
                        return [{**self.run, "run_attempt": 2, "status": "in_progress"}]
                return rows
        self.api = Changing()
        self.check_both_entrypoints(False)

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

    def test_direct_and_review_wakes_require_the_same_historical_pipeline_pr(self):
        # PR 8 can use exactly the same commit after PR 7 closes. A search of
        # current PRs by commit cannot tell which PR had the successful Pipeline.
        other = {**PR, "number": 8}
        pipeline = {**done("Pipeline"), "id": 61, "run_attempt": 1, "head_branch": "feature",
                    "head_sha": HEAD, "event": "pull_request", "path": ".github/workflows/pipeline.yml",
                    "head_repository": {"full_name": REPO, "id": 120}, "created_at": "2026-11-26T01:00:00Z",
                    "pull_requests": [PR]}
        wake = {**self.api.run, "name": "Review updated", "event": "issue_comment", "head_branch": "main",
                "head_sha": OLD_HEAD, "display_title": "Review updated PR 7",
                "path": ".github/workflows/review-updated.yml", "pull_requests": []}
        class Records(Api):
            def request(self, method, path, body=None):
                if (method, path) == ("GET", f"/repos/{REPO}/actions/runs/61"):
                    return self.reloaded
                return super().request(method, path, body)
            def records(self, path, key=None):
                if path == f"/repos/{REPO}/pulls?state=all&head=owner%3Afeature&sort=created&direction=asc":
                    return self.history
                if path == f"/repos/{REPO}/actions/runs/61/jobs?filter=all":
                    return [{**job, "id": i, "run_id": 61, "run_attempt": 1, "head_sha": HEAD}
                            for i, job in enumerate(completed_jobs(), 1)]
                return super().records(path, key)
        api = Records()
        api.pipelines = [pipeline]
        api.history = [PR]
        def source(event):
            return self.ns["_source_run"]({"repository": {"full_name": REPO}, "workflow_run": event}, REPO, api)
        for event in (pipeline, wake, self.api.run):
            with self.subTest(wake=event["name"]):
                api.reloaded = dict(pipeline)
                run = source(event)
                self.assertEqual(self.ns["_pull_request"](run, REPO, api), (7, PR))
                for association in ([], [PR, other], [other], [{"number": 7}],
                                    [{**PR, "head": {"sha": OLD_HEAD}}], [{**PR, "base": {"ref": "dev"}}]):
                    api.reloaded = {**pipeline, "pull_requests": association}
                    with self.assertRaises(self.ns["PostMergeError"]):
                        source(event)
        api.reloaded = {**pipeline, "pull_requests": [other]}
        with self.assertRaises(self.ns["PostMergeError"]):
            source({**pipeline, "pull_requests": []})
        # Both live API reads agree on PR 7, but only PR 8 existed when the run
        # began. Also exercise delivery after PR 7 reopened, when the first PR is
        # already closed and the API again lists PR 7 on both reads.
        replacement = {**PR, "created_at": "2026-11-26T01:00:01Z"}
        closed = {**other, "state": "closed", "closed_at": "2026-11-25T23:30:00Z"}
        for history in ([closed, replacement], [closed, PR], [], [{**PR, "head": {**PR["head"], "repo": None}}],
                        [{**PR, "head": {**PR["head"], "ref": "renamed"}}]):
            api.history, api.reloaded = history, pipeline
            for event in (pipeline, self.api.run, wake):
                with self.subTest(history=history, wake=event["name"]), self.assertRaises(self.ns["PostMergeError"]):
                    source(event)
        # An unrelated PR created later cannot retroactively lose the original's test.
        api.history = [PR, {**other, "created_at": replacement["created_at"]}]
        for event in (pipeline, self.api.run, wake):
            self.assertEqual(source(event)["tested_pr_number"], 7)
        # The association's nested head is a live field; GitHub can advance it
        # while the original head_sha remains fixed (architect-os#152).
        updated = {**PR, "head": {**PR["head"], "sha": OLD_HEAD}}
        api.pipelines = [dict(pipeline, pull_requests=[updated])]
        api.reloaded = api.pipelines[0]
        for event in (api.reloaded, self.api.run, wake):
            with self.assertRaises(self.ns["PostMergeError"]):
                source(event)
        # The live PR read must return the historically tested PR itself.
        api.pr = other
        with self.assertRaises(self.ns["PostMergeError"]):
            self.ns["_pull_request"](pipeline, REPO, api)
        with self.assertRaises(self.ns["PostMergeError"]):
            self.ns["_pull_request"]({**pipeline, "pull_requests": []}, REPO, api)

    def test_normal_status_producer_replaces_a_success_after_native_approval_is_withdrawn(self):
        publish = runpy.run_path(str(ROOT / "scripts/ci_review_status.py"))["publish"]
        self.assertTrue(publish(self.api, REPO, 7, LINK))
        self.api.rows[1] = []
        self.assertFalse(publish(self.api, REPO, 7, LINK))
        self.assertEqual([s["state"] for s in self.api.statuses], ["pending", "success", "pending", "failure"])
        self.held()
