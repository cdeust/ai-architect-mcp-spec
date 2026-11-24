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
            event = tmp / "event.json"
            event.write_text(json.dumps({"issue": {"title": "request", "body": "owner message"}}))
            with patch.dict(os.environ, {"GITHUB_EVENT_PATH": str(event), "RUNNER_TEMP": directory,
                            "GITHUB_WORKSPACE": directory, "CLAUDE_CODE_OAUTH_TOKEN": "fixture",
                            "GH_TOKEN": "read-only-fixture", "GITHUB_OUTPUT": "runner-file"}), \
                 patch("subprocess.run") as run:
                module["main"]()
            command, = run.call_args.args
            environment = run.call_args.kwargs["env"]
            self.assertEqual(set(environment), {"HOME", "PATH", "CLAUDE_CODE_OAUTH_TOKEN",
                                                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"})
            self.assertEqual(command[command.index("--tools") + 1], "")
            self.assertIn("--strict-mcp-config", command)
            self.assertTrue(json.loads(command[command.index("--settings") + 1])["disableAllHooks"])
            config = json.loads(command[command.index("--mcp-config") + 1])
            self.assertEqual(config["mcpServers"]["workspace"]["args"], ["--confine-roots", str(tmp / "candidate")])
            self.assertEqual(command[command.index("--permission-mode") + 1], "dontAsk")
            self.assertEqual(set(command[command.index("--allowedTools") + 1].split(",")), {
                "mcp__workspace__" + tool for tool in ("list_directory", "search_files",
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
              "base": {"repo": {"full_name": repo}}}
        api.return_value = pr
        self.assertEqual(resolve(event, repo, sha, "12", api).branch, "feature")
        for state, head_repo, branch in [("closed", repo, "feature"), ("open", "fork/spec", "feature"),
                                        ("open", repo, "main")]:
            with self.subTest(state=state, head_repo=head_repo, branch=branch):
                pr.update(state=state)
                pr["head"].update(repo={"full_name": head_repo}, ref=branch)
                with self.assertRaises(ValueError):
                    resolve(event, repo, sha, "12", api)

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
