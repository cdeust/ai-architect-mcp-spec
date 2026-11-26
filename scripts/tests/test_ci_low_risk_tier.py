"""All dependency updates require the same authenticated reviews as other changes."""

import base64
import json
from pathlib import Path
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
REPO = "cdeust/ai-architect-mcp-spec"
HEAD = "a" * 40
MINOR = "version-update:semver-minor"
PATCH = "version-update:semver-patch"
MAJOR = "version-update:semver-major"
# source: ci.json at the repository root, `low_risk_files` (ADR-1131).
LISTED = json.loads((ROOT / "ci.json").read_text())["low_risk_files"]


def resolver():
    text = (ROOT / ".github/workflows/pipeline-post-merge.yml").read_text()
    source = text.split("          python3 - <<'PY'\n", 1)[1].split(
        "\n          PY", 1
    )[0]
    namespace = {"__name__": "resolver_test"}
    exec(compile(textwrap.dedent(source), "trusted_resolver", "exec"), namespace)
    return namespace


def commit(
    updates=(PATCH,), author="dependabot[bot]", verified=True, committer="web-flow"
):
    lines = "".join(f"- dependency-name: x\n  update-type: {u}\n" for u in updates)
    return {
        "author": {"login": author},
        "committer": {"login": committer},
        "commit": {
            "message": f"deps: bump x\n\n---\nupdated-dependencies:\n{lines}...\n",
            "verification": {"verified": verified},
        },
    }


def pull(login="dependabot[bot]", kind="Bot"):
    return {
        "number": 7,
        "state": "open",
        "draft": False,
        "title": "deps: bump x",
        "labels": [],
        "user": {"login": login, "type": kind},
    }


class FakeApi:
    def __init__(self, commits, files):
        self.commits, self.files, self.puts = commits, files, []

    def records(self, path, key=None):
        if path.endswith("/commits"):
            return self.commits
        if path.endswith("/files"):
            return [
                name if isinstance(name, dict) else {"filename": name}
                for name in self.files
            ]
        return []  # no review run, no comment: the reviewed path holds

    def request(self, method, path, body=None):
        if (method, path) == ("GET", f"/repos/{REPO}/contents/ci.json"):
            content = json.dumps({"low_risk_files": LISTED}).encode()
            return {"encoding": "base64", "content": base64.b64encode(content).decode()}
        self.puts.append((method, path, body))
        return {"merged": True, "sha": "c" * 40}


class LowRiskTierTests(unittest.TestCase):
    def test_dependency_updates_also_require_both_reviews(self):
        ns = resolver()
        for files in (("pnpm-lock.yaml",), (".github/workflows/pipeline.yml",)):
            with self.subTest(files=files):
                api = FakeApi([commit()], files)
                with self.assertRaisesRegex(ns["PostMergeError"], "protected Claude review"):
                    ns["_merge_open_pr"](pull(), "/merge", HEAD, api, REPO)
                self.assertEqual(api.puts, [])

    def test_a_hold_label_still_holds_a_low_risk_pr(self):
        ns = resolver()
        pr = {**pull(), "labels": [{"name": "hold"}]}
        api = FakeApi([commit()], ("pnpm-lock.yaml",))
        with self.assertRaises(ns["PostMergeError"]):
            ns["_merge_open_pr"](pr, "/merge", HEAD, api, REPO)
        self.assertEqual(api.puts, [])


if __name__ == "__main__":
    unittest.main()
