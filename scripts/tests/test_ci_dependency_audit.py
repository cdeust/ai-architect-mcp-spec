"""Run the repository's unit command against controlled package-manager results."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
MANAGERS = """
npm() {
  echo "npm $*"
  if test "$1" = audit; then
    case "$*" in
      'audit --prefix scripts/ci-mention --omit=dev --audit-level=high') return "$NPM_AUDIT_STATUS" ;;
      'audit --prefix .github/owner-mention-cli --omit=dev --audit-level=high') return "$CLI_AUDIT_STATUS" ;;
      *) return 2 ;;
    esac
  fi
}
pnpm() {
  echo "$*"
  if test "$1" = audit; then
    test "$*" = 'audit --prod --audit-level high' || return 2
    return "$AUDIT_STATUS"
  fi
}
"""


class ProductionAuditGate(unittest.TestCase):
    def run_unit(self, audit_status, npm_audit_status=0, cli_audit_status=0):
        unit = json.loads((ROOT / "ci.json").read_text())["unit"]
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory, "coverage", "cobertura-coverage.xml")
            report.parent.mkdir()
            report.touch()
            return subprocess.run(
                ["bash", "-eo", "pipefail", "-c", MANAGERS + unit],
                cwd=directory,
                env={**os.environ, "AUDIT_STATUS": str(audit_status),
                     "NPM_AUDIT_STATUS": str(npm_audit_status), "CLI_AUDIT_STATUS": str(cli_audit_status)},
                capture_output=True,
                text=True,
            )

    def test_clean_audit_allows_build(self):
        result = self.run_unit(0)
        self.assertEqual(result.returncode, 0, result.stderr)
        steps = result.stdout.splitlines()
        self.assertIn("audit --prod --audit-level high", steps)
        self.assertLess(steps.index("audit --prod --audit-level high"), steps.index("install --frozen-lockfile"))
        mention = "npm audit --prefix scripts/ci-mention --omit=dev --audit-level=high"
        self.assertIn(mention, steps)
        self.assertLess(steps.index(mention), steps.index("install --frozen-lockfile"))
        cli = "npm audit --prefix .github/owner-mention-cli --omit=dev --audit-level=high"
        self.assertIn(cli, steps)
        self.assertLess(steps.index(cli), steps.index("install --frozen-lockfile"))

    def test_failed_audit_stops_the_pipeline_before_build(self):
        result = self.run_unit(1)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("audit --prod --audit-level high", result.stdout.splitlines())
        self.assertNotIn("install --frozen-lockfile", result.stdout.splitlines())
        self.assertNotIn("build", result.stdout.splitlines())


class MentionAuditGate(unittest.TestCase):
    """The owner-mention tools have their own npm lockfile and their own audit."""

    def test_failed_mention_audit_stops_the_pipeline_before_build(self):
        result = ProductionAuditGate.run_unit(self, 0, npm_audit_status=1)
        self.assertEqual(result.returncode, 1, result.stdout)
        steps = result.stdout.splitlines()
        self.assertIn("npm audit --prefix scripts/ci-mention --omit=dev --audit-level=high", steps)
        self.assertNotIn("install --frozen-lockfile", steps)
        self.assertNotIn("build", steps)


class OwnerMentionCliAuditGate(unittest.TestCase):
    """The pinned Claude CLI of the owner-mention tools has its own lockfile and audit."""

    def test_failed_cli_audit_stops_the_pipeline_before_build(self):
        result = ProductionAuditGate.run_unit(self, 0, cli_audit_status=1)
        self.assertEqual(result.returncode, 1, result.stdout)
        steps = result.stdout.splitlines()
        self.assertIn("npm audit --prefix .github/owner-mention-cli --omit=dev --audit-level=high", steps)
        self.assertNotIn("install --frozen-lockfile", steps)
        self.assertNotIn("build", steps)


def check_registry():
    """Optional online proof: compare the real lockfile and a known advisory."""
    audit = ["pnpm", "audit", "--prod", "--audit-level", "high", "--json"]
    subprocess.run(audit, cwd=ROOT, check=True)
    with tempfile.TemporaryDirectory() as directory:
        manifest = {"name": "audit-fixture", "version": "1.0.0", "private": True,
                    "dependencies": {"lodash": "4.17.20"}}
        Path(directory, "package.json").write_text(json.dumps(manifest))
        subprocess.run(["pnpm", "install", "--lockfile-only", "--ignore-scripts",
                        "--ignore-workspace"], cwd=directory, check=True)
        result = subprocess.run(audit, cwd=directory, capture_output=True, text=True)
        advisories = json.loads(result.stdout)["advisories"].values()
        expected = "GHSA-35jh-r3h4-6jhm"
        if result.returncode != 1 or not any(
            entry["github_advisory_id"] == expected and entry["severity"] == "high"
            for entry in advisories
        ):
            raise RuntimeError("registry did not report the expected high advisory")
        print(f"Vulnerable fixture: exit {result.returncode}, {expected}")


if __name__ == "__main__":
    if "--registry" in sys.argv:
        sys.argv.remove("--registry")
        check_registry()
    unittest.main()
