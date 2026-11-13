"""The review command file asks for no permission to load (Cortex ADR-1139).

The review workflow sets `track_progress`, so the prompt does not reach the
CLI as a slash command: the model loads `/review-pr` with the Skill tool. A
command file whose frontmatter carries `allowed-tools` needs an approval for
that call (Cortex ADR-1139, probe of 2026-11-13 on Claude Code 2.1.323: with
the header the Skill call is refused, without it the command loads). The
reviews of #235 and of earlier pull requests of this repository said that the
command had failed to load.

`disable-model-invocation` is refused too: the review of Cortex pull request
1027 names it as a key that keeps the model from loading a command, which
would give the same symptom. Its effect was not measured here. Other
frontmatter keys were not measured either and are not constrained.
"""

import re
import shlex
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COMMAND = ROOT / ".claude/commands/review-pr.md"
REVIEW = ROOT / ".github/workflows/claude-review.yml"
# The three commands the header allowed, which the review still needs.
GH_COMMANDS = ("Bash(gh pr comment:*)", "Bash(gh pr diff:*)", "Bash(gh pr view:*)")


def frontmatter_keys(text):
    """The keys of the YAML frontmatter of a command file."""
    if not text.startswith("---\n"):
        raise AssertionError("the command file has no frontmatter")
    block = text.split("---\n", 2)[1]
    return [m.group(1) for m in re.finditer(r"^([A-Za-z][A-Za-z0-9_-]*):", block, re.M)]


class ReviewCommandLoads(unittest.TestCase):
    def test_the_command_file_carries_no_allowed_tools_header(self):
        self.assertNotIn("allowed-tools", frontmatter_keys(COMMAND.read_text()))

    def test_the_command_file_does_not_forbid_the_model_to_load_it(self):
        self.assertNotIn("disable-model-invocation", frontmatter_keys(COMMAND.read_text()))

    def test_the_command_file_still_describes_itself(self):
        self.assertIn("description", frontmatter_keys(COMMAND.read_text()))

    def test_the_workflow_allows_what_the_header_allowed(self):
        workflow = REVIEW.read_text()
        match = re.search(r'--allowedTools\s+("[^"]*")', workflow)
        self.assertIsNotNone(match, "claude-review.yml passes no --allowedTools")
        allowed = shlex.split(match.group(1))[0].split(",")
        for command in GH_COMMANDS:
            self.assertIn(command, allowed)

    def test_the_reader_of_the_frontmatter_sees_a_header(self):
        keys = frontmatter_keys("---\nallowed-tools: Bash(gh pr view:*)\ndescription: x\n---\nbody\n")
        self.assertEqual(keys, ["allowed-tools", "description"])


if __name__ == "__main__":
    unittest.main()
