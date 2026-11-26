"""Credential and publication contracts of the owner mention workflow."""
from pathlib import Path
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
              "base": {"repo": {"full_name": repo, "default_branch": "main"}}}
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

    def git(self, *args):
        return self.subprocess.run(["git", *args], check=True, capture_output=True,
                                   text=True).stdout.strip()

    def write_proposal(self, patch, answer):
        (self.scratch / "proposal" / "change.patch").write_bytes(patch)
        (self.scratch / "proposal" / "answer.md").write_text(answer)

    def api(self, path, method="GET", body=None):
        self.calls.append((method, path, body))
        if path == "issues/7":
            return {"state": self.issue_state}
        if path.startswith("pulls?") and method == "GET":
            return self.existing_pulls
        if path == "pulls" and method == "POST":
            return {"html_url": "https://github.com/owner/spec/pull/9"}
        if path.startswith("issues/7/comments?") and method == "GET":
            return self.comments
        if path == "issues/7/comments" and method == "POST":
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
        return [call for call in self.calls if call[0] != "GET"]

    def assert_refused(self, candidate, message):
        with self.assertRaisesRegex(ValueError, message):
            self.publish(candidate)
        self.assertEqual(self.branches(), {"refs/heads/main"}, "a refused request pushed a branch")
        self.assertEqual(self.writes(), [], "a refused request wrote to GitHub")

    def test_issue_request_pushes_the_patch_opens_a_ready_pr_and_answers_once(self):
        self.publish(self.candidate())
        branch = "refs/heads/claude/issue-7-42"
        self.assertEqual(self.branches(), {"refs/heads/main", branch})
        commit = self.git("--git-dir", str(self.remote), "rev-parse", branch)
        self.assertEqual(self.git("--git-dir", str(self.remote), "rev-parse", commit + "^"), self.revision)
        self.assertEqual(self.git("--git-dir", str(self.remote), "show", commit + ":file"), "after")
        # The instant, not Git's spelling of it (Z or +00:00 depends on the version).
        self.assertEqual(self.git("--git-dir", str(self.remote), "log", "-1", "--format=%an %at %cn %ct", commit),
                         "Claude 1795600860 Claude 1795600860")  # 2026-11-25T10:01:00Z
        pulls = [body for method, path, body in self.writes() if path == "pulls"]
        self.assertEqual(pulls, [{"head": "claude/issue-7-42", "base": "main", "title": "Owner request",
                                  "body": "Requested in #7.", "draft": False}])
        comments = [body["body"] for method, path, body in self.writes() if path == "issues/7/comments"]
        self.assertEqual(comments, ["Done.\n\nPull request: https://github.com/owner/spec/pull/9"
                                    "\n\n<!-- owner-mention-run 42 -->"])

    def test_a_deleted_account_among_the_answers_does_not_stop_publication(self):
        self.comments = [{"user": None, "body": None},
                         {"user": {"login": "claude[bot]"}, "body": "earlier\n\n<!-- owner-mention-run 42 -->"}]
        self.publish(self.candidate())
        self.assertNotIn("issues/7/comments", [path for method, path, body in self.writes()])

    def test_an_existing_pr_is_reused_and_an_existing_answer_is_not_repeated(self):
        self.existing_pulls = [{"html_url": "https://github.com/owner/spec/pull/5"}]
        self.comments = [{"user": {"login": "claude[bot]"}, "body": "earlier\n\n<!-- owner-mention-run 42 -->"}]
        self.publish(self.candidate())
        self.assertIn("refs/heads/claude/issue-7-42", self.branches())
        self.assertEqual(self.writes(), [])

    def test_pull_request_target_receives_the_commit_and_no_new_pull_request(self):
        import os
        os.environ["EXPECTED_BRANCH"] = "feature"
        self.publish(self.candidate(branch="feature", pull_request=True))
        self.assertIn("refs/heads/feature", self.branches())
        self.assertEqual([path for method, path, body in self.writes()], ["issues/7/comments"])

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
