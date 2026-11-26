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
        self.assertIn(("claude.yml", ".github/owner-mention-cli"), prefixes)  # positive control
        for name, prefix in prefixes:
            with self.subTest(workflow=name, prefix=prefix):
                self.assertTrue((ROOT / prefix / "package.json").is_file())
                self.assertTrue((ROOT / prefix / "package-lock.json").is_file())

    def test_the_owner_mention_cli_is_updated_and_audited(self):
        dependabot = yaml.safe_load((ROOT / ".github/dependabot.yml").read_text())
        self.assertIn("/.github/owner-mention-cli", [u["directory"] for u in dependabot["updates"]])
        unit = json.loads((ROOT / "ci.json").read_text())["unit"]
        self.assertIn("npm audit --prefix .github/owner-mention-cli --omit=dev --audit-level=high", unit)


if __name__ == "__main__":
    unittest.main()
