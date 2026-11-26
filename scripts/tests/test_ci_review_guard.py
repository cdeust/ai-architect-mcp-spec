"""The workflows install locked, audited manifests at their current paths."""
import json
import re
from pathlib import Path
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github/workflows"

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
        self.assertIn(("claude.yml", ".github/actions/claude-subscription-quota"), prefixes)  # positive control
        for name, prefix in prefixes:
            with self.subTest(workflow=name, prefix=prefix):
                self.assertTrue((ROOT / prefix / "package.json").is_file())
                self.assertTrue((ROOT / prefix / "package-lock.json").is_file())

    def test_previous_protected_workflow_can_install_the_cli_used_by_the_current_runner(self):
        # The workflow of the pre-merge base installs this prefix on the merged tree.
        prefix = ".github/actions/claude-subscription-quota"
        manifest = json.loads((ROOT / prefix / "package.json").read_text())
        lock = json.loads((ROOT / prefix / "package-lock.json").read_text())
        package = "@anthropic-ai/claude-code"
        self.assertEqual(lock["packages"]["node_modules/" + package]["version"], manifest["dependencies"][package])
        launcher = (ROOT / "scripts/ci-mention/prepare.py").read_text()
        self.assertIn(f'{prefix}/node_modules/.bin/claude', launcher)
        self.assertFalse((ROOT / prefix / "action.yml").exists())
        self.assertFalse((ROOT / prefix / "read.py").exists())

    def test_unrelated_events_cannot_replace_pending_review_status(self):
        workflow = yaml.safe_load((WORKFLOWS / "review-updated.yml").read_text())
        condition = workflow["jobs"]["verify"]["if"].strip()
        group = " ".join(line.strip() for line in workflow["concurrency"]["group"].splitlines())
        self.assertIn("(" + condition + ")", group)
        self.assertIn("format('pr-{0}',", group)
        self.assertIn("|| format('skip-{0}', github.run_id)", group)
        self.assertFalse(workflow["concurrency"]["cancel-in-progress"])

    def test_the_owner_mention_cli_is_updated_and_audited(self):
        dependabot = yaml.safe_load((ROOT / ".github/dependabot.yml").read_text())
        self.assertIn("/.github/actions/claude-subscription-quota", [u["directory"] for u in dependabot["updates"]])
        unit = json.loads((ROOT / "ci.json").read_text())["unit"]
        self.assertIn("npm audit --prefix .github/actions/claude-subscription-quota --omit=dev --audit-level=high", unit)

    def test_model_installation_token_can_only_write_the_review_comment(self):
        workflow = yaml.safe_load((WORKFLOWS / "claude-review.yml").read_text())
        action = next(step for step in workflow["jobs"]["review"]["steps"] if step.get("name") == "PR Review")
        self.assertEqual(yaml.safe_load(action["with"]["additional_permissions"]),
                         {"contents": "read", "pull_requests": "read", "issues": "write"})


if __name__ == "__main__":
    unittest.main()
