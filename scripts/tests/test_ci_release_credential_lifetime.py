"""Check credential placement in the offline gate. CI also exercises the real SSH agent."""
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = tuple(ROOT / ".github/workflows" / name
                  for name in ("pipeline.yml", "pipeline-post-merge.yml"))


def step(workflow, title):
    section = workflow.split("      - name: " + title + "\n", 1)[1]
    return section.split("\n      - ", 1)[0]


class ReleaseCredentialScope(unittest.TestCase):
    def test_only_publication_receives_the_deploy_key(self):
        for path in WORKFLOWS:
            with self.subTest(path=path):
                job = path.read_text().split("\n  tag:\n", 1)[1]
                publish = step(job, "Publish declared package tags")
                guard = step(job, "Guard, skip cleanly when RELEASE_TAG_SSH_KEY is missing")
                self.assertIn("permissions:\n      contents: read", job)
                self.assertIn("SSH_KEY: ${{ secrets.RELEASE_TAG_SSH_KEY }}", publish)
                self.assertIn("HAS_DEPLOY_KEY: ${{ secrets.RELEASE_TAG_SSH_KEY != '' }}", guard)
                self.assertNotIn("secrets.RELEASE_TAG_SSH_KEY", job.replace(publish, "").replace(guard, ""))

    def test_required_regression_collects_the_native_agent_test(self):
        from fnmatch import fnmatchcase
        from shlex import split
        regression = json.loads((ROOT / "ci.json").read_text())["regression"]
        native = "native_ci_release_credential_lifetime.py"
        self.assertTrue((Path(__file__).parent / native).is_file())
        self.assertTrue(any(
            tokens[:8] == ["python3", "-B", "-m", "unittest", "discover", "-s", "scripts/tests", "-p"]
            and len(tokens) == 9 and fnmatchcase(native, tokens[8])
            for tokens in (split(part) for part in regression.split(" && "))
        ))
