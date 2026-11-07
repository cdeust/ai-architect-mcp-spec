"""A clean Codex security review closed by a 👍 on the PR, with no receipt.

Fixture: cdeust/ai-architect-mcp-spec PR165, summary6505735695 (security flags
null/null, Code row 15:14:02.1Z, Security row 15:15:17.9Z) and the
chatgpt-codex-connector +1 at 15:15:19Z, blocked
as codex_security_verdict_missing before this port.
"""

from __future__ import annotations

from datetime import datetime
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ci_codex_review_comments as comments  # noqa: E402
import ci_codex_review_runtime as runtime  # noqa: E402  (resolved lazily by comments)
import ci_codex_reviews as reviews  # noqa: E402
from test_ci_codex_editor_auth import claude_row  # noqa: E402

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


# Reader level: the fallback must be reached through review_evidence, the
# function the review job runs (Codex finding r4502061312, P1).
BOT_ID = "BOT_kgDOC98s_g"
CLEAN = dict(commit_sha=SHA, status="completed", has_any_findings=False,
             has_unresolved_findings=False)
REACTIONS = f"repos/{REPO}/issues/{PR}/reactions"
# The exact native no-issues receipt (cortex-viz PR213 receipt6491350304).
RECEIPT = (
    "<!-- codex-review-receipt:v1 -->\n\n### \U0001f6e1\ufe0f Codex Security Review\n\n"
    "Security review completed. No security issues were found in this pull request.\n\n"
    "**Reviewed commit:** `" + SHA + "`\n\n"
    "[View security finding report](https://chatgpt.com/codex/cloud/tasks/task_e_0a1b)\n\n"
    "_Only the user who started this review can view the report in Codex._\n\n"
    "<details> <summary>\u2139\ufe0f About Codex security reviews in GitHub</summary>\n"
    "<br/>\n\nThis is an experimental Codex feature. Security reviews are triggered when:\n"
    '- You comment "@codex security review"\n'
    '- A regular code review gets triggered (for example, "@codex review" or when a'
    " PR is opened), and you\u2019re opted in so security review runs alongside code review\n\n"
    "Once complete, Codex will leave suggestions, or a comment if no findings are found.\n\n\n"
    "</details>"
)


def bot_comment(identity, body, stamp="2026-11-03T15:15:17Z"):
    return dict(id=identity, updated_at=stamp, body=body, editor=None, lastEditedAt=None,
                user=dict(login=comments.BOT, type="Bot", node_id=BOT_ID))


def summary():
    state = dict(code_review=CLEAN, security_review=REVIEW)
    body = BODY.replace(
        "\n## Codex Review Summary",
        "\n<!-- codex-review-state:v1 " + json.dumps(state) + " -->\n"
        "<!-- codex-security-review:v1 " + json.dumps(METADATA) + " -->\n## Codex Review Summary",
    )
    return bot_comment(100, body)


def reaction(content="+1", stamp="2026-11-03T15:15:19Z", login=comments.BOT):
    return dict(content=content, user=dict(login=login, type="User"), created_at=stamp)


def threads(*nodes):
    pull = dict(headRefOid=SHA, reviewThreads=dict(
        pageInfo=dict(hasNextPage=False, endCursor=None), nodes=list(nodes)))
    return [dict(data=dict(repository=dict(pullRequest=pull)))]


def finding_thread(resolved=False):
    root = dict(databaseId=4502061312, body=runtime.FINDING + "\nP1",
                author=dict(login="chatgpt-codex-connector", __typename="Bot"))
    resolver = dict(login="cdeust", __typename="User") if resolved else None
    return dict(isResolved=resolved, resolvedBy=resolver, comments=dict(nodes=[root]))


class Server:
    """GitHub stand-in behind the single runtime._api both new calls reach."""

    def __init__(self, reactions=None, graphql=None):
        self.reactions = [[reaction()]] if reactions is None else reactions
        self.graphql = threads() if graphql is None else graphql
        self.calls = []

    def __call__(self, endpoint, *, paginate=False, fields=None):
        self.calls.append(endpoint)
        answer = {REACTIONS: self.reactions, "graphql": self.graphql}[endpoint]
        if isinstance(answer, Exception):
            raise answer
        return answer


def evidence(server, extra=()):
    rows = [summary(), *extra, claude_row(SHA)]
    with patch.object(runtime, "_api", side_effect=server):
        return reviews.review_evidence(rows, SHA, REPO, PR)


class ReaderFallbackTests(unittest.TestCase):
    def test_plus_one_without_receipt_passes_the_reader(self):
        result = evidence(Server())
        self.assertEqual(result["state"], "success", result)
        self.assertEqual(
            result["security_review"]["resolution"],
            {"source": "github_reaction", "reacted_at": "2026-11-03T15:15:19Z"},
        )

    def test_no_plus_one_keeps_the_missing_verdict(self):
        result = evidence(Server(reactions=[[]]))
        self.assertEqual(result["state"], "blocked")
        self.assertEqual(result["reason"], "codex_security_verdict_missing")
        self.assertEqual(result["security_review"]["resolution"]["source"],
                         "codex_security_receipt")

    def test_a_receipt_decides_and_reactions_are_never_read(self):
        server = Server()
        result = evidence(server, [bot_comment(101, RECEIPT)])
        self.assertEqual(result["state"], "success", result)
        self.assertEqual(result["security_review"]["resolution"],
                         {"source": "codex_security_receipt", "receipt_ids": [101]})
        self.assertNotIn(REACTIONS, server.calls)

    def test_an_unrecognized_receipt_is_not_overridden_by_a_plus_one(self):
        odd = RECEIPT.replace("No security issues were found", "Issues were found")
        server = Server()
        result = evidence(server, [bot_comment(101, odd)])
        self.assertEqual(result["reason"], "codex_security_receipt_unrecognized")
        self.assertNotIn(REACTIONS, server.calls)

    def test_an_unresolved_native_finding_thread_blocks_the_reaction(self):
        result = evidence(Server(graphql=threads(finding_thread())))
        self.assertEqual(result["reason"], "codex_security_verdict_missing")
        resolved = evidence(Server(graphql=threads(finding_thread(resolved=True))))
        self.assertEqual(resolved["state"], "success", resolved)

    def test_api_failures_block_with_their_category(self):
        for server in (
            Server(reactions=runtime.APIError("rate_limited")),
            Server(graphql=runtime.APIError("rate_limited")),
        ):
            result = evidence(server)
            self.assertEqual(
                (result["state"], result["reason"], result["api_category"],
                 result["reviews_complete"]),
                ("blocked", "api", "rate_limited", False),
            )

    def test_malformed_reactions_block_as_protocol(self):
        for pages in (
            {"not": "a list"},
            [{"not": "a page"}],
            [["not a row"]],
            [[dict(content="+1", user="codex", created_at="2026-11-03T15:15:19Z")]],
            [[reaction(stamp="2026-11-03 15:15:19")]],
            [[reaction(stamp="2026-13-03T15:15:19Z")]],
        ):
            result = evidence(Server(reactions=pages))
            self.assertEqual((result["state"], result["reason"]), ("blocked", "protocol"),
                             pages)

    def test_plus_one_in_the_same_second_as_the_last_row_counts(self):
        # The Security row is at 15:15:17.9Z; reactions carry whole seconds.
        same = evidence(Server(reactions=[[reaction(stamp="2026-11-03T15:15:17Z")]]))
        self.assertEqual(same["state"], "success", same)
        early = evidence(Server(reactions=[[reaction(stamp="2026-11-03T15:15:16Z")]]))
        self.assertEqual(early["reason"], "codex_security_verdict_missing")


if __name__ == "__main__":
    unittest.main()
