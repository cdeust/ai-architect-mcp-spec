"""Credential and publication contracts of the owner mention workflow."""
from pathlib import Path
from urllib.parse import unquote
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]


class MentionJobs(unittest.TestCase):
    def test_model_and_publisher_have_distinct_credentials(self):
        workflow = (ROOT / ".github/workflows/claude.yml").read_text()
        jobs = re.split(r"^  (\w+):\s*$", workflow.split("\njobs:\n")[1], flags=re.M)
        by_name = dict(zip(jobs[1::2], jobs[2::2]))
        self.assertEqual(set(by_name), {"prepare", "publish"})
        self.assertIn("CLAUDE_CODE_OAUTH_TOKEN", by_name["prepare"])
        self.assertNotIn(": write", by_name["prepare"])
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", by_name["publish"])
        self.assertIn("id-token: write", by_name["publish"])

    def test_bounded_model_invocation(self):
        import json
        import os
        import runpy
        import tempfile
        from unittest.mock import patch
        module = runpy.run_path(str(ROOT / "scripts/ci-mention/prepare.py"))
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            (tmp / "proposal").mkdir()
            thread = [{"created_at": "2026-11-25T09:00:00Z", "body": "earlier owner correction"}]
            (tmp / "owner-thread.json").write_text(json.dumps(thread))
            event = tmp / "event.json"
            event.write_text(json.dumps({"issue": {"title": "request", "body": "owner message"}}))
            with patch.dict(os.environ, {"GITHUB_EVENT_PATH": str(event), "RUNNER_TEMP": directory,
                            "GITHUB_WORKSPACE": directory, "CLAUDE_CODE_OAUTH_TOKEN": "fixture",
                            "GH_TOKEN": "read-only-fixture", "GITHUB_OUTPUT": "runner-file"}), \
                 patch("subprocess.run") as run:
                module["main"]()
            command, = run.call_args.args
            environment = run.call_args.kwargs["env"]
            prompt = json.loads(run.call_args.kwargs["input"])
            self.assertEqual(prompt["owner_comments"], thread)
            self.assertEqual(prompt["request"], "owner message")
            self.assertEqual(set(environment), {"HOME", "PATH", "CLAUDE_CODE_OAUTH_TOKEN", "ENABLE_TOOL_SEARCH",
                                                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"})
            self.assertEqual(command[command.index("--tools") + 1], "")
            self.assertIn("--strict-mcp-config", command)
            self.assertEqual(environment["ENABLE_TOOL_SEARCH"], "false")
            self.assertTrue(json.loads(command[command.index("--settings") + 1])["disableClaudeAiConnectors"])
            self.assertTrue(json.loads(command[command.index("--settings") + 1])["disableAllHooks"])
            config = json.loads(command[command.index("--mcp-config") + 1])
            self.assertEqual(config["mcpServers"]["candidate_files"]["args"], ["--confine-roots", str(tmp / "candidate")])
            self.assertEqual(command[command.index("--permission-mode") + 1], "dontAsk")
            self.assertEqual(set(command[command.index("--allowedTools") + 1].split(",")), {
                "mcp__candidate_files__" + tool for tool in ("list_directory", "search_files",
                "read_text_file", "edit_file", "write_file", "create_directory", "move_file")})

    def test_only_open_owner_targets_and_same_repo_task_branches(self):
        import runpy
        from unittest.mock import Mock
        resolve = runpy.run_path(str(ROOT / "scripts/ci-mention/request.py"))["target"]
        repo = "owner/spec"
        event = {"repository": {"owner": {"login": "owner"}, "full_name": repo,
                                "default_branch": "main"}, "sender": {"login": "owner"},
                 "issue": {"state": "open", "number": 7, "user": {"login": "owner"}}}
        api = Mock()
        sha = "a" * 40
        self.assertEqual(resolve(event, repo, sha, "12", api).branch, "claude/issue-7-12")
        api.assert_not_called()
        event["issue"]["pull_request"] = {"url": "fixture"}
        pr = {"state": "open", "head": {"repo": {"full_name": repo}, "ref": "feature", "sha": sha},
              "base": {"ref": "main", "repo": {"full_name": repo, "default_branch": "main"}}}
        api.return_value = pr
        self.assertEqual(resolve(event, repo, sha, "12", api).branch, "feature")
        pr["base"]["repo"]["default_branch"] = "feature"
        with self.assertRaises(ValueError):
            resolve(event, repo, sha, "12", api)
        pr["base"]["repo"]["default_branch"] = "main"
        for state, head_repo, branch in [("closed", repo, "feature"), ("open", "fork/spec", "feature"),
                                        ("open", repo, "main"), ("open", repo, "refs/heads/main"),
                                        ("open", None, "feature")]:
            with self.subTest(state=state, head_repo=head_repo, branch=branch):
                pr.update(state=state)
                # head_repo None: a deleted fork, whose head.repo GitHub returns as null.
                pr["head"].update(repo=None if head_repo is None else {"full_name": head_repo}, ref=branch)
                with self.assertRaises(ValueError):
                    resolve(event, repo, sha, "12", api)

    def test_owner_thread_keeps_earlier_owner_comments_only(self):
        import runpy
        thread = runpy.run_path(str(ROOT / "scripts/ci-mention/request.py"))["owner_thread"]

        def row(identity, login, created, body):
            return {"id": identity, "user": {"login": login}, "created_at": created, "body": body}
        pages = {1: [row(i, "owner", f"2026-11-24T00:{i:02d}:00Z", f"note {i}") for i in range(100)],
                 2: [row(200, "someone", "2026-11-25T08:00:00Z", "not the owner"),
                     row(201, "claude[bot]", "2026-11-25T08:30:00Z", "bot reply"),
                     row(202, "owner", "2026-11-25T09:00:00Z", "the correction"),
                     row(203, "owner", "2026-11-25T10:00:00Z", "@claude implement my previous comment"),
                     row(204, "owner", "2026-11-25T11:00:00Z", "written after the request")]}
        calls = []

        def api(path):
            calls.append(path)
            return pages[int(path.rsplit("page=", 1)[1])]
        event = {"repository": {"owner": {"login": "owner"}}, "issue": {"number": 7},
                 "comment": {"id": 203, "created_at": "2026-11-25T10:00:00Z"}}
        kept = thread(event, api)
        self.assertEqual(calls, ["issues/7/comments?per_page=100&page=1", "issues/7/comments?per_page=100&page=2"])
        self.assertEqual(len(kept), 50)
        self.assertEqual(kept[-1], {"created_at": "2026-11-25T09:00:00Z", "body": "the correction"})
        self.assertEqual(kept[0]["body"], "note 51")
        self.assertNotIn("not the owner", [c["body"] for c in kept])

    def test_owner_thread_refuses_what_was_not_there_when_the_owner_asked(self):
        import runpy
        thread = runpy.run_path(str(ROOT / "scripts/ci-mention/request.py"))["owner_thread"]
        rows = [
            {"id": 98, "user": {"login": "owner"}, "created_at": "2026-11-25T09:00:00Z", "body": "kept"},
            {"id": 99, "user": {"login": "owner"}, "created_at": "2026-11-25T09:30:00Z",
             "updated_at": "2026-11-25T10:30:00Z", "body": "edited after the request"},
            {"id": 100, "user": {"login": "owner"}, "created_at": "2026-11-25T10:00:00Z", "body": "@claude do it"},
            {"id": 101, "user": {"login": "owner"}, "created_at": "2026-11-25T10:00:00Z",
             "body": "same second, after the request"},
            {"id": 97, "user": None, "created_at": "2026-11-25T08:00:00Z", "body": "a deleted account"},
            {"id": 96, "user": {"login": "owner"}, "created_at": "2026-11-25T07:00:00Z", "body": None},
        ]
        base = {"repository": {"owner": {"login": "owner"}}, "issue": {"number": 7}}
        trigger = {**base, "comment": {"id": 100, "created_at": "2026-11-25T10:00:00Z"}}
        self.assertEqual([c["body"] for c in thread(trigger, lambda path: rows)], ["kept", ""])
        # An issues event (opened, assigned) has no triggering comment: nothing is passed.
        self.assertEqual(thread(base, lambda path: self.fail("no read on an issues event")), [])

    def test_publisher_applies_only_to_bare_index(self):
        import os
        import runpy
        import subprocess
        import tempfile
        apply = runpy.run_path(str(ROOT / "scripts/ci-mention/request.py"))["apply_patch"]
        env = {**os.environ, "GIT_AUTHOR_NAME": "test", "GIT_COMMITTER_NAME": "test",
               "GIT_AUTHOR_EMAIL": "test@example.invalid", "GIT_COMMITTER_EMAIL": "test@example.invalid"}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = root / "objects.git"
            def git(*args, data=None):
                return subprocess.run(["git", "--git-dir", str(store), *args], input=data,
                                      capture_output=True, check=True, env=env).stdout.strip()
            subprocess.run(["git", "init", "--bare", "-q", str(store)], check=True)
            tree = git("mktree", data=b"").decode()
            revision = git("commit-tree", tree, "-m", "base").decode()
            patch = b"diff --git a/example b/example\nnew file mode 100644\n--- /dev/null\n+++ b/example\n@@ -0,0 +1 @@\n+ok\n"
            commit = apply(store, revision, patch, env)
            self.assertEqual(git("show", commit + ":example"), b"ok")
            self.assertEqual(git("rev-parse", commit + "^").decode(), revision)
            self.assertFalse((root / "example").exists())
            with self.assertRaises(subprocess.CalledProcessError):
                apply(store, revision, b"invalid patch", env)


class MentionPublication(unittest.TestCase):
    """publish() against a real local Git remote: what it writes, and that a refused
    request writes nothing. https://github.com/ is redirected to the fixture remote
    with url.insteadOf through GIT_CONFIG_PARAMETERS, which publish() passes through;
    the code under test is unchanged."""

    REPO = "owner/spec"
    RUN = "42"

    def setUp(self):
        import os
        import runpy
        import subprocess
        import tempfile
        from unittest.mock import patch
        self.module = runpy.run_path(str(ROOT / "scripts/ci-mention/request.py"))
        self.subprocess = subprocess
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.remote = self.root / "hosting" / "owner" / "spec.git"
        self.remote.parent.mkdir(parents=True)
        self.git("init", "-q", "--bare", str(self.remote))
        self.git("-C", str(self.remote), "config", "uploadpack.allowAnySHA1InWant", "true")
        work = self.root / "work"
        self.git("init", "-q", str(work))
        (work / "file").write_text("before\n")
        self.git("-C", str(work), "add", "file")
        self.git("-C", str(work), "-c", "user.name=o", "-c", "user.email=o@o", "commit", "-qm", "base")
        self.revision = self.git("-C", str(work), "rev-parse", "HEAD")
        self.git("-C", str(work), "push", "-q", str(self.remote), "HEAD:refs/heads/main")
        (work / "file").write_text("after\n")
        self.patch_bytes = subprocess.run(["git", "-C", str(work), "diff", "--binary"], check=True,
                                          capture_output=True).stdout
        self.scratch = self.root / "runner"
        (self.scratch / "proposal").mkdir(parents=True)
        self.write_proposal(self.patch_bytes, "Done.")
        environment = {"BASE_SHA": self.revision, "EXPECTED_BRANCH": "claude/issue-7-42",
                       "GITHUB_RUN_ID": self.RUN,
                       "GIT_CONFIG_PARAMETERS": f"'url.file://{self.root / 'hosting'}/.insteadof'='https://github.com/'"}
        patcher = patch.dict(os.environ, environment)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.calls, self.issue_state, self.existing_pulls, self.comments = [], "open", [], []
        self.nodes = {}
        self.repo = {"full_name": self.REPO, "default_branch": "main", "owner": {"login": "owner", "id": 1234}}
        self.pr = None
        self.run = {"id": 42, "actor": {"login": "owner", "id": 1234}, "display_title": "Owner mention on issue #7", "repository": self.repo, "head_repository": self.repo,
                    "path": ".github/workflows/claude.yml", "event": "issue_comment", "head_branch": "main",
                    "head_sha": self.revision, "status": "completed", "conclusion": "success"}


    def git(self, *args):
        return self.subprocess.run(["git", *args], check=True, capture_output=True,
                                   text=True).stdout.strip()

    def write_proposal(self, patch, answer):
        (self.scratch / "proposal" / "change.patch").write_bytes(patch)
        (self.scratch / "proposal" / "answer.md").write_text(answer)

    def api(self, path, method="GET", body=None):
        self.calls.append((method, path, body))
        if path == "":
            return self.repo
        if path == "actions/runs/42":
            return self.run
        if path == "issues/7":
            return {"number": 7, "state": self.issue_state, "user": {"login": "owner"},
                    **({"pull_request": {"url": "pulls/7"}} if self.pr else {})}
        if path == "pulls/7" and self.pr:
            return self.pr
        if path.startswith("git/ref/"):
            ref = "refs/" + unquote(path.removeprefix("git/ref/"))
            return {"ref": ref, "object": {"type": "commit", "sha": self.git("--git-dir", str(self.remote), "rev-parse", ref)}}
        if path.startswith("git/commits/"):
            parent = self.git("--git-dir", str(self.remote), "rev-parse", path.rsplit("/", 1)[-1] + "^")
            return {"sha": path.rsplit("/", 1)[-1], "parents": [{"sha": parent}]}
        if path.startswith("pulls?") and method == "GET":
            return self.existing_pulls
        if path.startswith("issues/7/comments?") and method == "GET":
            return self.comments
        if path == "graphql" and method == "POST":
            return {"data": {"node": self.nodes[body["variables"]["id"]]}}
        if path == "issues/7/comments" and method == "POST":
            node = "IC_" + str(len(self.comments) + 1)
            self.comments.append({"user": {"node_id": self.module["CLAUDE"]["id"]}, "node_id": node, **body})
            self.nodes[node] = {"id": node, "author": self.module["CLAUDE"], "editor": None,
                                "lastEditedAt": None, **body}
            return {}
        raise AssertionError((method, path))

    def candidate(self, branch="claude/issue-7-42", revision=None, pull_request=False):
        return self.module["Target"](branch, revision or self.revision, "main", pull_request)

    def publish(self, candidate):
        event = {"issue": {"number": 7, "title": "Owner request", "state": "open",
                           "created_at": "2026-11-25T10:00:00Z"},
                 "comment": {"created_at": "2026-11-25T10:01:00Z"}}
        self.module["publish"](event, self.REPO, "installation-token", candidate, self.api, self.scratch)

    def branches(self):
        out = self.git("--git-dir", str(self.remote), "for-each-ref", "--format=%(refname)", "refs/heads")
        return set(out.split())

    def writes(self):
        return [call for call in self.calls if call[0] != "GET" and call[1] != "graphql"]

    def assert_refused(self, candidate, message):
        with self.assertRaisesRegex(ValueError, message):
            self.publish(candidate)
        self.assertEqual(self.branches(), {"refs/heads/main"}, "a refused request pushed a branch")
        self.assertEqual(self.writes(), [], "a refused request wrote to GitHub")

    def test_issue_publishes_one_immutable_candidate_for_the_delivery_routine(self):
        self.publish(self.candidate())
        branch = "refs/heads/claude/issue-7-42"
        self.assertEqual(self.branches(), {"refs/heads/main", branch})
        commit = self.git("--git-dir", str(self.remote), "rev-parse", branch)
        self.assertEqual(self.git("--git-dir", str(self.remote), "rev-parse", commit + "^"), self.revision)
        self.assertEqual(self.git("--git-dir", str(self.remote), "show", commit + ":file"), "after")
        # The instant, not Git's spelling of it (Z or +00:00 depends on the version).
        self.assertEqual(self.git("--git-dir", str(self.remote), "log", "-1", "--format=%an %at %cn %ct", commit),
                         "Claude 1795600860 Claude 1795600860")  # 2026-11-25T10:01:00Z
        self.assertEqual([path for _, path, _ in self.writes()], ["issues/7/comments"])
        self.assertIn(f"https://github.com/owner/spec/commit/{commit}", self.comments[0]["body"])
        self.assertEqual(self.inspect(), {"repository": self.REPO, "number": 7, "parent": self.revision,
                         "commit": commit, "base": "main", "target": "claude/issue-7-42", "pr": False,
                         "branch": "claude/issue-7-42", "status": "awaiting verification"})
        self.publish(self.candidate())
        self.assertEqual(len(self.writes()), 1, "a retry repeated the authenticated handoff")

    def inspect(self):
        return self.module["inspect_candidate"](self.REPO, 7, 42, self.api)

    def test_closed_or_already_promoted_candidate_is_never_opened_twice(self):
        self.publish(self.candidate())
        c = self.inspect()
        pr = {"number": 19, "head": {"repo": self.repo, "ref": c["branch"], "sha": c["commit"]},
              "base": {"repo": self.repo, "ref": "main"}}
        for state in ("open", "closed"):
            self.existing_pulls = [{**pr, "state": state}]
            result = self.inspect()
            self.assertEqual((result["status"], result["published_pr"]), ("already published", 19))
        self.existing_pulls[0]["head"]["sha"] = self.revision
        with self.assertRaisesRegex(ValueError, "Pull request for the candidate changed"):
            self.inspect()
        self.assertEqual(len(self.writes()), 1)

    def test_tampered_author_edited_or_copied_handoff_and_wrong_workflow_are_refused(self):
        self.publish(self.candidate())
        comment = self.comments[0]
        original = self.nodes[comment["node_id"]]
        for change in ({"author": {**original["author"], "login": "lookalike"}},
                       {"author": {**original["author"], "id": "different"}},
                       {"editor": original["author"]}, {"lastEditedAt": "2026-11-25T10:02:00Z"},
                       {"body": "changed"}, {"id": "another comment"}):
            with self.subTest(change=change):
                self.nodes[comment["node_id"]] = {**original, **change}
                with self.assertRaisesRegex(ValueError, "authenticated candidate"):
                    self.inspect()
        self.nodes[comment["node_id"]] = original
        self.comments.insert(0, {"user": None, "body": None})
        self.inspect()
        self.run["path"] = ".github/workflows/other.yml"
        with self.assertRaisesRegex(ValueError, "workflow is unverified"):
            self.inspect()

    def test_a_duplicate_authenticated_comment_can_repeat_but_cannot_contradict_the_original(self):
        self.publish(self.candidate())
        original = self.comments[0]
        other = {**original, "node_id": "IC_2"}
        self.comments.append(other)
        self.nodes["IC_2"] = {**self.nodes[original["node_id"]], "id": "IC_2"}
        self.assertEqual(self.inspect()["status"], "awaiting verification")
        other["body"] = "<!-- owner-mention-run 42 -->"
        self.nodes["IC_2"]["body"] = other["body"]
        with self.assertRaisesRegex(ValueError, "unambiguous authenticated candidate"):
            self.inspect()

    def test_workflow_binds_original_owner_subject_and_controller_head(self):
        workflow = (ROOT / ".github/workflows/claude.yml").read_text()
        self.assertIn('run-name: "Owner mention on ${{ github.event.issue.pull_request && \'PR\' || \'issue\' }} #${{ github.event.issue.number }}"', workflow.splitlines())
        self.publish(self.candidate())
        original = dict(self.run)
        for key, value in (("display_title", "Owner mention on PR #7"), ("display_title", "Owner mention on issue #8"),
                           ("actor", {"id": 444, "login": "owner"}), ("head_branch", "candidate"),
                           ("event", "pull_request"), ("head_repository", {"full_name": "fork/spec"}),
                           ("status", "in_progress"), ("conclusion", "failure")):
            with self.subTest(key=key, value=value):
                self.run = {**original, key: value}
                with self.assertRaisesRegex(ValueError, "unverified or incomplete"):
                    self.inspect()
        self.run = {**original, "head_sha": "f" * 40}
        with self.assertRaisesRegex(ValueError, "proposal base changed"):
            self.inspect()
        self.run = original
        self.assertEqual(self.inspect()["status"], "awaiting verification")

    def test_an_advanced_candidate_or_base_is_not_delivered(self):
        self.publish(self.candidate())
        c = self.inspect()
        self.git("--git-dir", str(self.remote), "update-ref", "refs/heads/main", c["commit"])
        with self.assertRaisesRegex(ValueError, "base changed"):
            self.inspect()
        self.git("--git-dir", str(self.remote), "update-ref", "refs/heads/" + c["branch"], self.revision)
        with self.assertRaisesRegex(ValueError, "ref, commit or parent differs"):
            self.inspect()
        with self.assertRaisesRegex(ValueError, "already names another commit"):
            self.publish(self.candidate())
        self.assertEqual(self.git("--git-dir", str(self.remote), "rev-parse", "refs/heads/" + c["branch"]), self.revision)

    def test_pull_request_uses_a_separate_proposal_branch_until_verified(self):
        import os
        os.environ["EXPECTED_BRANCH"] = "feature"
        self.git("--git-dir", str(self.remote), "update-ref", "refs/heads/feature", self.revision)
        self.run["display_title"] = "Owner mention on PR #7"
        self.pr = {"state": "open", "head": {"repo": self.repo, "ref": "feature", "sha": self.revision},
                   "base": {"repo": self.repo, "ref": "main"}}
        self.publish(self.candidate(branch="feature", pull_request=True))
        self.assertEqual(self.git("--git-dir", str(self.remote), "rev-parse", "refs/heads/feature"), self.revision)
        c = self.inspect()
        self.assertEqual((c["target"], c["branch"], c["status"]), ("feature", "claude/issue-7-42", "awaiting verification"))
        self.pr["base"]["ref"] = "another"
        with self.assertRaisesRegex(ValueError, "destination changed"):
            self.inspect()
        self.pr["base"]["ref"] = "main"
        self.pr["head"]["sha"] = "f" * 40
        with self.assertRaisesRegex(ValueError, "pull request head changed"):
            self.inspect()
        self.pr["head"]["sha"] = c["commit"]
        self.assertEqual(self.inspect()["status"], "already published")
        self.assertEqual(len(self.writes()), 1)

    def test_conflicting_retry_leaves_the_first_result_and_the_remote_untouched(self):
        self.write_proposal(b"", "Original answer.")
        self.publish(self.candidate())
        self.write_proposal(self.patch_bytes, "New result.")
        with self.assertRaisesRegex(ValueError, "already published another result"):
            self.publish(self.candidate())
        self.assertEqual(self.branches(), {"refs/heads/main"})
        self.assertEqual(len(self.writes()), 1)

    def test_model_text_cannot_turn_a_plain_answer_into_a_candidate(self):
        self.publish(self.candidate())
        text = self.comments[0]["body"]
        self.comments.clear()
        self.write_proposal(b"", text)
        self.publish(self.candidate())
        with self.assertRaisesRegex(ValueError, "has no candidate"):
            self.inspect()

    def test_changed_branch_is_refused_without_writes(self):
        self.assert_refused(self.candidate(branch="claude/issue-7-43"), "target changed")

    def test_invalid_base_revision_is_refused_without_writes(self):
        import os
        os.environ["BASE_SHA"] = "not-a-sha"
        self.assert_refused(self.candidate(), "target changed")

    def test_closed_request_is_refused_without_writes(self):
        self.issue_state = "closed"
        self.assert_refused(self.candidate(), "closed during preparation")

    def test_advanced_head_is_refused_before_any_push(self):
        self.assert_refused(self.candidate(revision="b" * 40), "advanced during preparation")

    def test_answer_only_request_on_an_advanced_head_is_refused_without_writes(self):
        self.write_proposal(b"", "Only an answer.")
        self.assert_refused(self.candidate(revision="b" * 40), "advanced during preparation")

    def test_answer_only_request_posts_the_answer_and_pushes_nothing(self):
        self.write_proposal(b"", "Only an answer.")
        self.publish(self.candidate())
        self.assertEqual(self.branches(), {"refs/heads/main"})
        self.assertEqual(self.writes(), [("POST", "issues/7/comments",
                                          {"body": "Only an answer.\n\n<!-- owner-mention-run 42 -->"})])
