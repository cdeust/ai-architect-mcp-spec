"""A clean Codex security review closed by a 👍 on the PR, with no receipt.

Fixture: PR165, summary6505735695 (security flags null/null, Completed rows at
2026-11-03T15:15:1x) and the chatgpt-codex-connector +1 at 15:15:19Z, blocked
as codex_security_verdict_missing before this port.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ci_codex_review_comments as comments  # noqa: E402
import ci_codex_review_runtime  # noqa: E402,F401  (resolved lazily by comments)

SHA, REPO, PR = "bd4c7e58ae65f20084e0cc2ce61e317fb0c95e26", "cdeust/ai-architect-mcp-spec", 165
REVIEW = dict(commit_sha=SHA, status="completed", has_any_findings=None,
              has_unresolved_findings=None)
METADATA = dict(repository=REPO, pullRequestNumber=PR, headSha=SHA, status="completed")
BODY = (
    "<!-- codex-pull-request-review-summary -->\n## Codex Review Summary\n\n"
    "| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n"
    '| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="2026-11-03T15:14:02.1Z">'
    "x</relative-time> | `bd4c7e5` | Manual request |\n"
    '| 🔒 **Security Review** | ✅ **Completed** <relative-time datetime="2026-11-03T15:15:17.9Z">'
    "x</relative-time> | `bd4c7e5` | Manual request |\n"
)
PLUS = datetime.fromisoformat("2026-11-03T15:15:19Z")


def verdict(marks, unresolved=False, body=BODY, review=REVIEW):
    with patch.object(comments, "_codex_reactions", return_value=marks), patch.object(
        comments, "_unresolved_findings", return_value=unresolved
    ):
        return comments.reaction_verdict((REPO, PR, SHA), body, review, METADATA)


class ReactionVerdictTests(unittest.TestCase):
    def test_plus_one_after_both_completed_rows_is_clean(self):
        result = verdict({"+1": PLUS})
        self.assertEqual(result["state"], "success")
        self.assertEqual(result["reacted_at"], "2026-11-03T15:15:19Z")

    def test_plus_one_before_the_last_completed_row_proves_nothing(self):
        self.assertIsNone(verdict({"+1": datetime.fromisoformat("2026-11-03T15:15:16Z")}))

    def test_eyes_left_or_no_plus_one_proves_nothing(self):
        self.assertIsNone(verdict({"+1": PLUS, "eyes": PLUS}))
        self.assertIsNone(verdict({}))

    def test_unresolved_finding_thread_voids_the_reaction(self):
        self.assertIsNone(verdict({"+1": PLUS}, unresolved=True))

    def test_finding_text_or_missing_row_voids_the_reaction(self):
        self.assertIsNone(verdict({"+1": PLUS}, body=BODY + "\n### Security findings\n"))
        only_code = BODY.split("| 🔒")[0]
        self.assertIsNone(verdict({"+1": PLUS}, body=only_code))

    def test_rows_for_another_head_prove_nothing(self):
        self.assertIsNone(verdict({"+1": PLUS}, body=BODY.replace("`bd4c7e5`", "`aaaaaaa`")))

    def test_explicit_flags_never_use_the_reaction(self):
        review = dict(REVIEW, has_any_findings=False, has_unresolved_findings=False)
        self.assertIsNone(verdict({"+1": PLUS}, review=review))

    def test_reactions_read_only_the_codex_login(self):
        pages = [[
            dict(content="+1", user=dict(login="writer"), created_at="2026-11-03T15:16:00Z"),
            dict(content="+1", user=dict(login=comments.BOT), created_at="2026-11-03T15:15:19Z"),
        ]]
        with patch.object(comments, "_api", return_value=pages):
            self.assertEqual(comments._codex_reactions(REPO, PR), {"+1": PLUS})


if __name__ == "__main__":
    unittest.main()
