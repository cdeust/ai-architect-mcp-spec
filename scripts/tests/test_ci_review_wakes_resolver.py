"""Review receipts wake the protected resolver in either completion order."""

from pathlib import Path
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github/workflows"
REPO = "cdeust/ai-architect-mcp-spec"
HEAD = "a" * 40


def resolver():
    text = (WORKFLOWS / "pipeline-post-merge.yml").read_text()
    source = text.split("          python3 - <<'PY'\n", 1)[1].split(
        "\n          PY", 1
    )[0]
    namespace = {"__name__": "resolver_test"}
    exec(compile(textwrap.dedent(source), "trusted_resolver", "exec"), namespace)
    return namespace


class ReviewWakesResolverTests(unittest.TestCase):
    def test_a_pr_merged_before_the_review_ended_is_not_tested_twice(self):
        text = (WORKFLOWS / "pipeline-post-merge.yml").read_text()
        body = text.split("def resolve(run", 1)[1].split("def main", 1)[0]
        held = body.split('run.get("woken_by_review")', 1)[1].split("return {", 2)[1]
        self.assertIn('"run_tests": "false"', held)
        self.assertLess(
            body.index('run.get("woken_by_review")'),
            body.index('"run_tests": "true"'),
        )

    def test_both_workflows_wake_the_resolver(self):
        caller = (WORKFLOWS / "pipeline-after-merge.yml").read_text()
        self.assertIn("workflows: [Pipeline, PR Review, Review updated]", caller)
        approval_name = (WORKFLOWS / "review-updated.yml").read_text().splitlines()[0]
        self.assertEqual(approval_name, "name: Review updated")
        publisher = __import__("yaml").safe_load((WORKFLOWS / "review-updated.yml").read_text())
        self.assertIn("in_progress", publisher[True]["workflow_run"]["types"])
        self.assertIn("github.event.action == 'completed' || github.event.workflow_run.name == 'PR Review'",
                      publisher["jobs"]["verify"]["if"])


if __name__ == "__main__":
    unittest.main()
