"""Windows and macOS are validated by the jobs Cortex validates them with (#126).

The workflow files are Cortex's: `environment` and `install` run on
ubuntu-latest, macos-latest and windows-latest under one shell, and what they
run is this repository's `ci.json`. So the platform evidence of this repository
is in two places, and this file pins both:

- the two jobs keep the three runners and the shared shell in both pipelines:
  the Pipeline after merge lists them inline, and the pull request Pipeline
  takes its matrix from the `contract` job, which selects from the same three
  (Cortex ADR-1133; what the selector answers is `test_ci_platform_selection.py`);
- `ci.json` starts the plugin there with node (no bash launcher), and on macOS
  and Windows also runs the test suite and the bundle checks that the `unit`
  and `e2e` jobs run on Linux only.

Standard library only.
"""

import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
PIPELINES = (
    ".github/workflows/pipeline.yml",
    ".github/workflows/pipeline-post-merge.yml",
)
RUNNERS = ["ubuntu-latest", "macos-latest", "windows-latest"]
# source: the matrix line of the two jobs in pipeline.yml since Cortex ADR-1133.
SELECTED = "os: ${{ fromJSON(needs.contract.outputs.platforms) }}"
# source: the output of the `contract` job that carries the selector's answer.
SELECTOR_OUTPUT = "      platforms: ${{ steps.platforms.outputs.platforms }}\n"
# The steps the `unit` and `e2e` commands run on Linux, which the environment
# command repeats on the two other systems.
OFF_LINUX_STEPS = (
    "pnpm install --frozen-lockfile",
    "pnpm build",
    "pnpm test",
    "pnpm bundle",
    "pnpm run test:portable",
    "pnpm run test:portable:runtime",
    "bash scripts/release/smoke-mcpb.sh",
)


def job(workflow: str, name: str) -> str:
    text = (ROOT / workflow).read_text(encoding="utf-8")
    start = text.index(f"\n  {name}:\n")
    following = re.search(r"\n  [a-z0-9_-]+:\n", text[start + 1 :])
    return text[start : start + 1 + following.start()] if following else text[start:]


def selectable_runners(workflow: str) -> list:
    """The systems the `contract` job selects from: the one `RUNNERS = [...]`
    line of the selector embedded in the workflow."""
    text = (ROOT / workflow).read_text(encoding="utf-8")
    found = re.findall(r"\n\s+RUNNERS = \[([^\]]+)\]\n", text)
    if len(found) != 1:
        raise AssertionError(f"{len(found)} RUNNERS lines in {workflow}, expected 1")
    return [item.strip().strip('"') for item in found[0].split(",")]


class PlatformJobsTest(unittest.TestCase):
    def test_environment_and_install_run_on_the_three_systems(self):
        for workflow in PIPELINES:
            for name in ("environment", "install"):
                with self.subTest(workflow=workflow, job=name):
                    body = job(workflow, name)
                    if workflow.endswith("/pipeline.yml"):
                        self.assertIn(SELECTED, body)
                        self.assertIn(SELECTOR_OUTPUT, job(workflow, "contract"))
                        runners = selectable_runners(workflow)
                    else:
                        matrix = re.search(r"\n\s+os: \[([^\]]+)\]", body)
                        self.assertIsNotNone(matrix, "no os matrix")
                        runners = [item.strip() for item in matrix.group(1).split(",")]
                    self.assertEqual(runners, RUNNERS)
                    self.assertIn("runs-on: ${{ matrix.os }}", body)
                    self.assertIn("fail-fast: false", body)

    def test_every_command_runs_under_one_shell(self):
        for workflow in PIPELINES:
            with self.subTest(workflow=workflow):
                text = (ROOT / workflow).read_text(encoding="utf-8")
                self.assertRegex(text, r"\ndefaults:\n  run:\n    shell: bash\n")


class PlatformCommandsTest(unittest.TestCase):
    def setUp(self):
        self.ci = json.loads((ROOT / "ci.json").read_text(encoding="utf-8"))

    def test_the_plugin_is_started_with_node_not_bash(self):
        server = json.loads((ROOT / ".mcp.json").read_text(encoding="utf-8"))
        launch = server["mcpServers"]["prd-gen"]
        self.assertEqual(launch["command"], "node")
        self.assertFalse((ROOT / "bin/ensure-deps.sh").exists())
        self.assertTrue((ROOT / "bin/ensure-deps.mjs").is_file())
        for name in ("environment", "install"):
            with self.subTest(command=name):
                command = self.ci[name]
                self.assertIn("node scripts/check-health-stdio.mjs", command)
                self.assertNotIn("check-health-stdio.sh", command)
                self.assertNotIn("ensure-deps.sh", command)

    def test_environment_starts_from_the_bare_checkout(self):
        # The health check comes first: nothing is installed before the plugin
        # has started from the files `claude plugin install` would copy.
        command = self.ci["environment"]
        self.assertTrue(command.startswith('node scripts/check-health-stdio.mjs "$PWD" && '))

    def test_environment_runs_the_suite_and_the_bundle_checks_off_linux(self):
        command = self.ci["environment"]
        guard = '{ [ "$CI_OS" = linux ] || { '
        self.assertIn(guard, command)
        off_linux = command.split(guard, 1)[1]
        position = 0
        for step in OFF_LINUX_STEPS:
            with self.subTest(step=step):
                found = off_linux.find(step + " ", position)
                if found == -1:
                    found = off_linux.find(step + ";", position)
                self.assertNotEqual(found, -1, f"{step} missing or out of order")
                position = found + len(step)
        # Linux already runs each of them in its own job.
        for step in ("pnpm build", "pnpm bundle", "bash scripts/release/smoke-mcpb.sh"):
            self.assertIn(step, self.ci["e2e"])
        self.assertIn("pnpm test:coverage", self.ci["unit"])


if __name__ == "__main__":
    unittest.main()
