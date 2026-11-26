"""The installed manifests and session command guard retained from #406."""
import json
import re
from pathlib import Path
import subprocess
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
                   "gh label create owner-approved",
                   "timeout 30 gh pr edit 7 --add-label owner-approved",
                   "gh pr --repo o/r edit 7 --add-label owner-approved",
                   "\\gh pr edit 7 --add-label owner-approv\\ed",
                   "$(which gh) pr edit 7 --add-label owner-approved",
                   "gh api repos/o/r/issues/7/ -X PATCH -f labels[]=owner-approved",
                   "gh pr edit 7 --remove-label owner-approved",
                   "echo ok && gh pr edit 7 --add-label owner-approved",
                   "gh -R o/r pr edit 7 --add-label owner-approved",
                   "gh pr create --label owner-approved",
                   "gh api -X PATCH repos/o/r/issues/7 -f 'labels[]=owner-approved'",
                   "gh api graphql -f query='mutation{addLabelsToLabelable(input:{}){clientMutationId}}'",
                   "env -i gh pr edit 7 --add-label owner-approved",
                   "/usr/local/bin/gh pr edit 7 --add-label owner-approved",
                   "gh alias set ok 'pr edit --add-label owner-approved'",
                   "gh -R o/r pr merge 7"]
        # A label built at run time, or a body-less write, names nothing the guard
        # can read: the contract declares them out of reach (docs/review-subscriptions.md).
        allowed = ["gh pr edit 7 --add-label claude-rereview", "gh pr view 7 --json labels",
                   "gh api repos/cdeust/x/issues/7/labels", "gh pr list --label owner-approved",
                   "gh label list", "gh -R o/r pr view 7", "gh api repos/o/r/issues/7",
                   "gh api --method PUT repos/cdeust/x/issues/7/labels"]
        refused.append("gh pr edit 7 --add-label $L")  # a label value it cannot read
        decided = self.decisions(refused + allowed)
        for command in refused:
            with self.subTest(command=command):
                self.assertEqual(decided[command], "refuse")
        for command in allowed:  # positive control
            with self.subTest(command=command):
                self.assertEqual(decided[command], "allow")


if __name__ == "__main__":
    unittest.main()
