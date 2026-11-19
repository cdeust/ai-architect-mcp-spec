"""ci_review_verdict.py fails a review run whose verdict is not found (#361).

Source: scripts/ci_review_verdict.py. The parity tests run the resolver of
pipeline-post-merge.yml on the same comments, with this run as the only
reviewed run of the head: there the script must read exactly the verdict the
resolver reads. With another reviewed run of the same head, the resolver also
reads that run's verdict and the script does not, as #361 asks for a comment
that links this run; a test pins that gap.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import textwrap
import unittest
import unittest.mock
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import ci_review_verdict as verdict  # noqa: E402

REPO = "cdeust/ai-architect-mcp-spec"
RUN = 44351841638
HEAD = "a" * 40
# The comment run 44351841638 left on #360: the progress list, no verdict line.
PROGRESS_ONLY = (
    "**Claude finished @cdeust's task** —— "
    f"[View job](https://github.com/{REPO}/actions/runs/{RUN})\n\n"
    "- [x] Read the diff\n"
    "- [ ] Review the commits after `9710757` (5 review agents running)\n"
)


def comment(
    body,
    run_id=RUN,
    login="claude[bot]",
    kind="Bot",
    link=True,
    updated="2026-11-18T16:50:55Z",
):
    if link:
        body += f"\n[View job run](https://github.com/{REPO}/actions/runs/{run_id})"
    return {"login": login, "type": kind, "body": body, "updated_at": updated}


def review(text="Blockers: none.\n\nVerdict: approve", **kw):
    """A review comment as the prompt asks: the run link just before the verdict."""
    head, _, last = text.rpartition("\n")
    run_id = kw.pop("run_id", RUN)
    link = f"[View job run](https://github.com/{REPO}/actions/runs/{run_id})"
    return comment(f"{head}\n{link}\n{last}", link=False, **kw)


class VerdictOfRunTests(unittest.TestCase):
    def test_a_review_that_ends_with_approve_or_block_passes(self):
        self.assertEqual(verdict.verdict_of_run([review()], RUN), "approve")
        blocked = review("Blocker: x.\n\nVerdict: block")
        self.assertEqual(verdict.verdict_of_run([blocked], RUN), "block")

    def test_the_progress_list_alone_of_run_44351841638_fails(self):
        rows = [comment(PROGRESS_ONLY, link=False)]
        self.assertIsNone(verdict.verdict_of_run(rows, RUN))

    def test_a_verdict_of_another_run_does_not_count(self):
        earlier = review(run_id=RUN - 1)
        self.assertIsNone(verdict.verdict_of_run([earlier], RUN))
        # A longer run id that starts with this one is another run.
        longer = review(run_id=int(f"{RUN}7"))
        self.assertIsNone(verdict.verdict_of_run([longer], RUN))

    def test_a_verdict_from_anyone_but_the_reviewer_bot_does_not_count(self):
        human = review(login="cdeust", kind="User")
        impostor = review(login="claude[bot]", kind="User")
        other_bot = review(login="chatgpt-codex-connector[bot]")
        rows = [human, impostor, other_bot]
        self.assertIsNone(verdict.verdict_of_run(rows, RUN))

    def test_a_verdict_inside_a_line_does_not_count(self):
        quoted = comment("The prompt asks for `Verdict: approve` at the end.")
        self.assertIsNone(verdict.verdict_of_run([quoted], RUN))

    def test_the_last_verdict_of_the_run_is_reported(self):
        # Same updated_at: the resolver's max() over (updated_at, verdict)
        # picks block whatever the list order (note 1 of review 1 of #362).
        rows = [comment("Verdict: block"), comment("Verdict: approve")]
        self.assertEqual(verdict.verdict_of_run(rows, RUN), "block")
        self.assertEqual(verdict.verdict_of_run(rows[::-1], RUN), "block")
        one = [comment("Verdict: approve\nVerdict: block")]
        edited = [
            comment("Verdict: block", updated="2026-11-18T17:00:00Z"),
            comment("Verdict: approve", updated="2026-11-18T16:00:00Z"),
        ]
        self.assertEqual(verdict.verdict_of_run(edited, RUN), "block")
        self.assertEqual(verdict.verdict_of_run(one, RUN), "block")

    def test_near_miss_verdict_lines_do_not_count(self):
        for line in (
            "Verdict: approved",
            "Verdict: approve, pending CI",
            "verdict: APPROVE",
            "  Verdict: approve",
            "Verdict:approve",
            "Verdict: hold",
        ):
            with self.subTest(line):
                rows = [review(f"x\n\n{line}")]
                self.assertIsNone(verdict.verdict_of_run(rows, RUN))

    def test_trailing_whitespace_and_crlf_still_count_as_the_resolver_reads(self):
        self.assertEqual(
            verdict.verdict_of_run([review("x\n\nVerdict: approve  ")], RUN),
            "approve",
        )
        crlf = comment("x\r\nVerdict: block\r\n")
        self.assertEqual(verdict.verdict_of_run([crlf], RUN), "block")

    def test_only_a_link_to_this_actions_run_counts(self):
        prose = comment(f"Run {RUN} done.\nVerdict: approve", link=False)
        checks = comment(
            f"https://github.com/{REPO}/check-runs/{RUN}\nVerdict: approve",
            link=False,
        )
        prefixed = review(run_id=int(f"1{RUN}"))
        for row in (prose, checks, prefixed):
            self.assertIsNone(verdict.verdict_of_run([row], RUN))

    def test_a_null_body_or_missing_author_fields_count_as_no_verdict(self):
        rows = [{"login": "claude[bot]", "type": "Bot", "body": None}, {}]
        self.assertIsNone(verdict.verdict_of_run(rows, RUN))


class ResolverParityTests(unittest.TestCase):
    """The script fails a run exactly when the resolver finds no verdict in it."""

    def resolver(self):
        text = (ROOT / ".github/workflows/pipeline-post-merge.yml").read_text()
        source = text.split("          python3 - <<'PY'\n", 1)[1].split(
            "\n          PY", 1
        )[0]
        namespace = {"__name__": "resolver_test"}
        exec(compile(textwrap.dedent(source), "trusted_resolver", "exec"), namespace)
        return namespace

    def resolver_reads_a_verdict(self, rows, runs=(RUN,)):
        ns = self.resolver()
        gh_rows = [
            {
                "user": {"login": r["login"], "type": r["type"]},
                "body": r["body"],
                "updated_at": r["updated_at"],
            }
            for r in rows
        ]

        class Api:
            def records(self, path, key=None):
                if "claude-review.yml/runs" in path:
                    return [
                        {"id": run, "head_sha": HEAD, "conclusion": "success"}
                        for run in runs
                    ]
                if path.endswith("/jobs"):
                    step = {"name": "PR Review", "conclusion": "success"}
                    return [{"name": "Claude review", "steps": [step]}]
                return gh_rows

        try:
            ns["_review_approves"](360, HEAD, REPO, Api())
        except ns["PostMergeError"] as error:
            if "has not posted a verdict" in str(error):
                return None
            if "verdict is block" in str(error):
                return "block"
            raise
        return "approve"

    def test_every_case_agrees_with_the_resolver(self):
        cases = {
            "approve": [review()],
            "block": [review("x\n\nVerdict: block")],
            "progress only": [
                comment(PROGRESS_ONLY, link=False)
            ],
            "other run": [review(run_id=RUN - 1)],
            "longer run id": [review(run_id=int(f"{RUN}7"))],
            "human": [review(login="cdeust", kind="User")],
            "inline": [comment("say `Verdict: approve` here")],
            "no comment": [],
            "impostor": [review(login="claude[bot]", kind="User")],
            "other bot": [review(login="chatgpt-codex-connector[bot]")],
            "approved": [review("x\n\nVerdict: approved")],
            "trailing words": [review("x\n\nVerdict: approve, pending CI")],
            "trailing space": [review("x\n\nVerdict: approve  ")],
            "crlf": [comment("x\r\nVerdict: approve\r\n")],
            "lowercase": [review("x\n\nverdict: APPROVE")],
            "indented": [review("x\n\n  Verdict: approve")],
            "no space": [review("x\n\nVerdict:approve")],
            "unknown word": [review("x\n\nVerdict: hold")],
            "id in prose": [
                comment(f"Run {RUN} done.\nVerdict: approve", link=False)
            ],
            "check-runs link": [
                comment(
                    f"https://github.com/{REPO}/check-runs/{RUN}\nVerdict: approve",
                    link=False,
                )
            ],
            "digit before id": [review(run_id=int(f"1{RUN}"))],
            "two verdicts": [comment("Verdict: block\nVerdict: approve")],
            "edited earlier": [
                comment("Verdict: block", updated="2026-11-18T17:00:00Z"),
                comment("Verdict: approve", updated="2026-11-18T16:00:00Z"),
            ],
            "edited later": [
                comment("Verdict: block", updated="2026-11-18T16:00:00Z"),
                comment("Verdict: approve", updated="2026-11-18T17:00:00Z"),
            ],
            "same instant, block first": [
                comment("Verdict: block"),
                comment("Verdict: approve"),
            ],
            "same instant, approve first": [
                comment("Verdict: approve"),
                comment("Verdict: block"),
            ],
        }
        for name, rows in cases.items():
            with self.subTest(name):
                # The verdict itself agrees, not only whether one was found.
                self.assertEqual(
                    verdict.verdict_of_run(rows, RUN),
                    self.resolver_reads_a_verdict(rows),
                )


    def test_a_verdict_of_another_reviewed_run_of_the_head_passes_only_the_resolver(
        self,
    ):
        # Review of #370, note 2: the one case where the two differ.
        rows = [review(run_id=RUN - 1)]
        self.assertEqual(self.resolver_reads_a_verdict(rows, (RUN - 1, RUN)), "approve")
        self.assertIsNone(verdict.verdict_of_run(rows, RUN))


class CommentsTests(unittest.TestCase):
    def test_comments_are_read_one_json_object_per_line(self):
        calls = []

        def gh(args):
            calls.append(args)
            return json.dumps(review()) + "\n\n" + json.dumps(review()) + "\n"

        rows = verdict.comments(gh, REPO, 360)
        self.assertEqual(len(rows), 2)
        self.assertEqual(calls[0][0], f"repos/{REPO}/issues/360/comments?per_page=100")
        self.assertIn("--paginate", calls[0])

    def test_a_line_that_is_not_an_object_is_a_protocol_error(self):
        with self.assertRaises(verdict.VerdictError):
            verdict.comments(lambda args: "[]\n", REPO, 360)

    def test_api_failure_is_not_swallowed(self):
        def boom(args):
            raise subprocess.CalledProcessError(1, "gh")

        with self.assertRaises(subprocess.CalledProcessError):
            verdict.comments(boom, REPO, 360)

    def test_a_body_with_unicode_line_separators_is_read_whole(self):
        # json.dumps escapes "\n" but, with ensure_ascii=False as gh writes,
        # leaves U+0085 and U+2028 raw: one comment must stay one record.
        body = "x\u0085y\u2028z\x1c\nVerdict: approve"
        line = json.dumps(comment(body), ensure_ascii=False)
        self.assertNotIn("\n", line)
        rows = verdict.comments(lambda args: line + "\n", REPO, 360)
        self.assertEqual(len(rows), 1)
        self.assertEqual(verdict.verdict_of_run(rows, RUN), "approve")

    def test_a_mixed_output_is_a_protocol_error(self):
        mixed = json.dumps(review()) + "\n[]\n"
        with self.assertRaises(verdict.VerdictError):
            verdict.comments(lambda args: mixed, REPO, 360)

    def test_a_line_that_is_not_json_is_an_error(self):
        with self.assertRaises(json.JSONDecodeError):
            verdict.comments(lambda args: "not json\n", REPO, 360)


class GhApiTests(unittest.TestCase):
    """gh_api raises on a failed or slow `gh`: a partial page never passes."""

    def test_gh_is_called_with_check_and_a_timeout(self):
        done = subprocess.CompletedProcess([], 0, stdout="out", stderr="")
        with unittest.mock.patch.object(
            verdict.subprocess, "run", return_value=done
        ) as called:
            self.assertEqual(verdict.gh_api(["x"]), "out")
        argv = called.call_args.args[0]
        self.assertEqual(argv[:3], ["gh", "api", "x"])
        kwargs = called.call_args.kwargs
        self.assertIs(kwargs["check"], True)
        self.assertEqual(kwargs["timeout"], verdict.GH_TIMEOUT_SECONDS)

    def test_a_failure_after_the_first_page_propagates_out_of_main(self):
        env = {"GH_REPO": REPO, "PR": "360", "RUN_ID": str(RUN)}
        for error in (
            subprocess.CalledProcessError(1, "gh", output=json.dumps(review())),
            subprocess.TimeoutExpired("gh", 60),
        ):
            with self.subTest(type(error).__name__):
                with (
                    unittest.mock.patch.dict(os.environ, env),
                    unittest.mock.patch.object(
                        verdict.subprocess, "run", side_effect=error
                    ) as run,
                    unittest.mock.patch.object(verdict.time, "sleep") as sleep,
                    self.assertRaises(type(error)),
                ):
                    verdict.main()
                self.assertEqual(run.call_count, verdict.READ_ATTEMPTS)
                self.assertEqual(sleep.call_count, verdict.READ_ATTEMPTS - 1)

    @unittest.skipUnless(shutil.which("jq"), "jq is not installed")
    def test_the_jq_filter_keeps_login_type_and_body(self):
        calls = []
        verdict.comments(lambda a: calls.append(a) or "", REPO, 360)
        expr = calls[0][calls[0].index("--jq") + 1]
        # Distinct created_at and updated_at: the tie-break of verdict_of_run
        # ranks comments by updated_at, so the filter must take that field
        # (note 3 of review 1 of #363).
        raw = [
            {
                "user": {"login": "claude[bot]", "type": "Bot"},
                "body": "b",
                "id": 1,
                "created_at": "2026-11-18T16:00:00Z",
                "updated_at": "2026-11-18T16:50:55Z",
            }
        ]
        done = subprocess.run(
            ["jq", "-c", expr],
            input=json.dumps(raw),
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
        row = json.loads(done.stdout)
        self.assertEqual(
            row,
            {
                "login": "claude[bot]",
                "type": "Bot",
                "body": "b",
                "updated_at": "2026-11-18T16:50:55Z",
            },
        )


class ReadVerdictTests(unittest.TestCase):
    """A verdict listed late or a failed call does not fail the run (note 2 of #362)."""

    def run_reads(self, replies):
        calls, sleeps = [], []

        def read():
            calls.append(1)
            reply = replies[len(calls) - 1]
            if isinstance(reply, BaseException):
                raise reply
            return reply

        with redirect_stdout(StringIO()):
            found, failed = verdict.read_verdict(read, RUN, sleeps.append)
        self.failed = failed
        return found, len(calls), sleeps

    def test_a_verdict_on_the_first_read_is_read_once(self):
        found, calls, sleeps = self.run_reads([[review()]])
        self.assertEqual((found, calls, sleeps), ("approve", 1, []))

    def test_a_verdict_listed_late_is_found_on_a_later_read(self):
        # Note 2 of review 1 of #366: the replies follow READ_ATTEMPTS.
        progress = [comment(PROGRESS_ONLY, link=False)]
        late = [progress] + [[]] * (verdict.READ_ATTEMPTS - 2) + [[review()]]
        found, calls, sleeps = self.run_reads(late)
        self.assertEqual(found, "approve")
        self.assertEqual(calls, verdict.READ_ATTEMPTS)
        retries = verdict.READ_ATTEMPTS - 1
        self.assertEqual(sleeps, [verdict.READ_RETRY_SECONDS] * retries)

    def test_a_failed_or_slow_call_is_read_again(self):
        for error in (
            subprocess.CalledProcessError(1, "gh"),
            subprocess.TimeoutExpired("gh", 60),
        ):
            with self.subTest(type(error).__name__):
                found, calls, _ = self.run_reads([error, [review()]])
                self.assertEqual((found, calls, self.failed), ("approve", 2, 1))

    def test_no_verdict_after_every_read_is_none(self):
        found, calls, sleeps = self.run_reads([[]] * verdict.READ_ATTEMPTS)
        self.assertIsNone(found)
        self.assertEqual(calls, verdict.READ_ATTEMPTS)
        self.assertEqual(len(sleeps), verdict.READ_ATTEMPTS - 1)
        self.assertEqual(self.failed, 0)

    def test_failed_reads_before_an_empty_last_read_are_counted(self):
        # Note 2 of review 1 of #363: every read but the last fails, the last
        # lists nothing.
        # Review of #370, note 3: at READ_ATTEMPTS 2 one read fails, so a count
        # fixed at one (`failed = 1`) would pass; the test sets 3 and 5 itself.
        error = subprocess.CalledProcessError(1, "gh")
        for attempts in (3, 5):
            with self.subTest(attempts=attempts), unittest.mock.patch.object(
                verdict, "READ_ATTEMPTS", attempts
            ):
                reads = [error] * (attempts - 1) + [[]]
                found, calls, _ = self.run_reads(reads)
                expected = (None, attempts, attempts - 1)
                self.assertEqual((found, calls, self.failed), expected)

    def test_a_failed_read_between_two_empty_reads_is_counted_once(self):
        # Note 3 of review 1 of #364: a count taken from the attempt number
        # (`failed = attempt`) reads READ_ATTEMPTS - 1 here.
        # Note 3 of review 1 of #365: the reads follow READ_ATTEMPTS.
        # Note 2 of review 1 of #366: that mutant reads 1 when READ_ATTEMPTS is
        # 2, and there is no empty read before the failure, so the test sets
        # READ_ATTEMPTS itself instead of relying on the shipped value.
        error = subprocess.CalledProcessError(1, "gh")
        for attempts in (3, 5):
            with self.subTest(attempts=attempts), unittest.mock.patch.object(
                verdict, "READ_ATTEMPTS", attempts
            ):
                reads = [[]] * (attempts - 2) + [error, []]
                found, calls, _ = self.run_reads(reads)
                self.assertEqual((found, calls, self.failed), (None, attempts, 1))

    def test_the_last_failure_is_raised(self):
        error = subprocess.CalledProcessError(1, "gh")
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_reads([[]] * (verdict.READ_ATTEMPTS - 1) + [error])

    def test_a_protocol_error_is_not_read_again(self):
        with self.assertRaises(verdict.VerdictError):
            self.run_reads([verdict.VerdictError("protocol"), [review()]])


class CliTests(unittest.TestCase):
    def invoke(self, rows, failures=0):
        env = {"GH_REPO": REPO, "PR": "360", "RUN_ID": str(RUN)}
        left = [failures]

        def gh(args):
            if left[0]:
                left[0] -= 1
                raise subprocess.CalledProcessError(1, "gh")
            return "\n".join(json.dumps(r) for r in rows)
        stdout = StringIO()
        with (
            unittest.mock.patch.dict(os.environ, env),
            unittest.mock.patch.object(verdict, "gh_api", gh),
            unittest.mock.patch.object(verdict.time, "sleep"),
            redirect_stdout(stdout),
        ):
            code = verdict.main()
        return code, stdout.getvalue()

    def test_a_run_with_a_verdict_succeeds(self):
        code, text = self.invoke([review()])
        self.assertEqual(code, 0)
        self.assertIn("approve", text)

    def test_a_run_without_a_verdict_fails_with_an_annotation(self):
        progress = comment(PROGRESS_ONLY, link=False)
        code, text = self.invoke([progress])
        self.assertEqual(code, 1)
        last = text.strip().splitlines()[-1]
        self.assertTrue(last.startswith("::error title=Claude review verdict not found::"))
        self.assertEqual(text.count("reading again"), verdict.READ_ATTEMPTS - 1)
        self.assertIn(str(RUN), text)
        self.assertNotIn("failed (gh api)", last)

    def test_failed_reads_then_nothing_are_named_in_the_annotation(self):
        # The last read succeeded and listed no verdict after N reads; the
        # earlier failures are in the message (note 1 of review 1 of #364 and
        # of review 1 of #365).
        progress = comment(PROGRESS_ONLY, link=False)
        code, text = self.invoke([progress], failures=verdict.READ_ATTEMPTS - 1)
        self.assertEqual(code, 1)
        last = text.strip().splitlines()[-1]
        self.assertTrue(last.startswith("::error title=Claude review verdict not found::"))
        self.assertIn(f"{verdict.READ_ATTEMPTS - 1} of which failed (gh api)", last)


if __name__ == "__main__":
    unittest.main()
