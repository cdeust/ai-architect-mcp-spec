"""SEC-009 phase B: the resolver verifies the protected tested receipt and only reports it.

The fake `gh attestation verify` below keys its answers on the SHA-256 of the file it
is given, as the real command does (the subject digest), and on the certificate
identity it is asked to enforce. A receipt therefore verifies only for the exact
subject bytes the protected signer wrote.
"""
import hashlib
import json
from pathlib import Path
import unittest

from test_ci_review_both import HEAD, OLD_HEAD, REPO, resolver

PRODUCER = f"https://github.com/{REPO}/.github/workflows/tested-receipt.yml@refs/heads/main"
PREDICATE = "https://github.com/cdeust/ai-architect-mcp-spec/tested-receipt/v1"


def signed(subject_bytes, identity, run_id, attempt, predicate=None, predicate_type=PREDICATE, san=None):
    """What `gh attestation verify --format json` returns for one attestation."""
    return {
        "digest": hashlib.sha256(subject_bytes).hexdigest(),
        "identity": identity,
        "result": {
            "attestation": {},
            "verificationResult": {
                "statement": {"predicateType": predicate_type,
                              "predicate": predicate if predicate is not None else json.loads(subject_bytes)},
                "signature": {"certificate": {
                    "subjectAlternativeName": san or identity,
                    "runInvocationURI": f"https://github.com/{REPO}/actions/runs/{run_id}/attempts/{attempt}",
                }},
            },
        },
    }


class Registry:
    """The attestations GitHub stores for the repository, verified like gh does."""

    def __init__(self, *attestations):
        self.attestations = attestations
        self.calls = []

    def __call__(self, path, identity):
        digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
        self.calls.append((digest, identity))
        found = [a["result"] for a in self.attestations if a["digest"] == digest and a["identity"] == identity]
        if not found:
            raise self.error("gh attestation verify refused the receipt")
        return found


class Api:
    def __init__(self, runs):
        self.runs = runs

    def records(self, path, key=None):
        assert "/actions/workflows/tested-receipt-pilot.yml/runs?head_sha=" in path, path
        return self.runs


def receipt_run(run_id=500, attempt=1, sha=HEAD, status="completed"):
    return {"id": run_id, "run_attempt": attempt, "head_sha": sha, "status": status,
            "path": ".github/workflows/tested-receipt-pilot.yml"}


class TestedReceipt(unittest.TestCase):
    def setUp(self):
        self.ns = resolver()
        Registry.error = self.ns["PostMergeError"]

    def subject(self, sha=HEAD, run_id=500, attempt=1, **jobs):
        subject = {"repository": REPO, "tested_sha": sha, "run_id": run_id, "run_attempt": attempt,
                   "jobs": {"unit": "success", "regression": "success", "e2e": "success", **jobs}}
        return json.dumps(subject, sort_keys=True, separators=(",", ":")).encode()

    def observe(self, runs, registry):
        return self.ns["observe_receipt"](REPO, HEAD, Api(runs), verify=registry)

    def test_subject_is_the_signer_bytes(self):
        self.assertEqual(self.ns["receipt_subject"](REPO, HEAD, 500, 1).encode(), self.subject())

    def test_nominal_receipt_is_valid(self):
        registry = Registry(signed(self.subject(), PRODUCER, 500, 1))
        line = self.observe([receipt_run()], registry)
        self.assertEqual(line, f"SEC-009 receipt for {HEAD}: valid, receipt of run 500 attempt 1 verified; not enforced")
        self.assertEqual(registry.calls, [(hashlib.sha256(self.subject()).hexdigest(), PRODUCER)])

    def test_receipt_signed_by_a_workflow_the_pr_can_edit_is_invalid(self):
        for identity in (f"https://github.com/{REPO}/.github/workflows/tested-receipt.yml@refs/pull/7/merge",
                         f"https://github.com/{REPO}/.github/workflows/pipeline.yml@refs/pull/7/merge",
                         f"https://github.com/{REPO}/.github/workflows/tested-receipt-pilot.yml@refs/heads/main"):
            with self.subTest(identity=identity):
                line = self.observe([receipt_run()], Registry(signed(self.subject(), identity, 500, 1)))
                self.assertIn(": invalid (", line)

    def test_failed_receipt_job_is_invalid(self):
        registry = Registry(signed(self.subject(unit="failure"), PRODUCER, 500, 1))
        self.assertIn(": invalid (", self.observe([receipt_run()], registry))

    def test_receipt_of_another_commit_run_or_attempt_is_not_replayable(self):
        for other in (self.subject(sha=OLD_HEAD), self.subject(run_id=499), self.subject(attempt=2)):
            with self.subTest(other=other):
                line = self.observe([receipt_run()], Registry(signed(other, PRODUCER, 500, 1)))
                self.assertIn(": invalid (", line)

    def test_certificate_of_another_run_is_refused(self):
        line = self.observe([receipt_run()], Registry(signed(self.subject(), PRODUCER, 501, 1)))
        self.assertIn(": invalid (receipt does not bind", line)

    def test_another_predicate_type_is_refused(self):
        registry = Registry(signed(self.subject(), PRODUCER, 500, 1, predicate_type="https://slsa.dev/provenance/v1"))
        self.assertIn(": invalid (receipt does not bind", self.observe([receipt_run()], registry))

    def test_a_result_naming_another_signer_is_refused_even_if_gh_returns_it(self):
        """The certificate is checked again, not left to gh's --cert-identity alone."""
        for san in (f"https://github.com/{REPO}/.github/workflows/tested-receipt.yml@refs/pull/7/merge",
                    f"https://github.com/{REPO}/.github/workflows/tested-receipt.yml@refs/heads/main-copy"):
            with self.subTest(san=san):
                registry = Registry(signed(self.subject(), PRODUCER, 500, 1, san=san))
                self.assertIn(": invalid (receipt does not bind", self.observe([receipt_run()], registry))

    def test_predicate_other_than_the_subject_is_refused(self):
        line = self.observe([receipt_run()], Registry(signed(self.subject(), PRODUCER, 500, 1, predicate={})))
        self.assertIn(": invalid (receipt does not bind", line)

    def test_latest_completed_attempt_is_the_one_verified(self):
        runs = [receipt_run(500, 1), receipt_run(500, 2), receipt_run(498, 3),
                receipt_run(600, 1, status="in_progress"), receipt_run(700, 1, sha=OLD_HEAD)]
        registry = Registry(signed(self.subject(attempt=2), PRODUCER, 500, 2))
        self.assertIn(": valid, receipt of run 500 attempt 2", self.observe(runs, registry))

    def test_run_of_another_workflow_is_not_a_receipt_run(self):
        run = dict(receipt_run(), path=".github/workflows/pipeline.yml")
        self.assertIn(": absent (", self.observe([run], Registry(signed(self.subject(), PRODUCER, 500, 1))))

    def test_absent_receipt_is_reported(self):
        line = self.observe([receipt_run(status="in_progress")], Registry())
        self.assertEqual(line, f"SEC-009 receipt for {HEAD}: absent (no completed receipt run); not enforced")

    def test_any_failure_is_reported_never_raised(self):
        class Broken:
            def records(self, path, key=None):
                raise OSError("network down")
        line = self.ns["observe_receipt"](REPO, HEAD, Broken(), verify=Registry())
        self.assertIn(": invalid (network down); not enforced", line)


if __name__ == "__main__":
    unittest.main()


class ObservationNeverDecides(unittest.TestCase):
    """Phase B: the receipt is reported after the decision and never used to make it."""

    def setUp(self):
        import os
        import tempfile
        from unittest.mock import patch
        self.ns = resolver()
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.dir = Path(temp.name)
        event = self.dir / "event.json"
        event.write_text(json.dumps({"workflow_run": {"head_sha": HEAD}}))
        self.summary = self.dir / "summary.md"
        env = {"GITHUB_EVENT_PATH": str(event), "GITHUB_REPOSITORY": REPO, "GH_TOKEN": "fixture",
               "GITHUB_STEP_SUMMARY": str(self.summary)}
        patcher = patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_resolve_itself_never_reads_the_receipt(self):
        def forbidden(*_):
            raise AssertionError("resolve() consulted the receipt")
        merged = []
        self.ns.update(
            _source_run=lambda *_: {"head_sha": HEAD, "reduced_matrix": False},
            _pull_request=lambda *_: (7, {"merged": False}),
            _merge_open_pr=lambda *_: merged.append(True) or "b" * 40,
            _confirm_pr_merge=lambda *_: None,
            observe_receipt=forbidden,
        )
        result = self.ns["resolve"]({}, REPO, None)
        self.assertEqual((result["run_tests"], merged), ("true", [True]))

    def test_main_returns_the_decision_whatever_the_observation_does(self):
        class Raising:
            def __init__(self, *_, **__):
                pass

            def records(self, *_):
                raise OSError("network down")
        class OneRun:
            """A completed pilot run, so the attestation check is really reached."""
            def __init__(self, *_, **__):
                pass

            def records(self, *_):
                return [receipt_run()]

        def timed_out(*_):
            raise __import__("subprocess").TimeoutExpired("gh", 20)
        reached = []
        cases = {
            "api raises": dict(GitHub=Raising),
            "verifier times out": dict(GitHub=OneRun, gh_attestation_verify=lambda *a: reached.append(1) or timed_out()),
            "summary unwritable": dict(GitHub=OneRun, gh_attestation_verify=lambda *_: [],
                                       _report=lambda *_: (_ for _ in ()).throw(PermissionError("read-only"))),
            "observation itself raises": dict(observe_receipt=lambda *_: (_ for _ in ()).throw(RuntimeError("bug"))),
        }
        for name, overrides in cases.items():
            for decision in (0, 1):
                with self.subTest(case=name, decision=decision):
                    ns = resolver()
                    ns.update(_decide=lambda decision=decision: decision, **overrides)
                    self.assertEqual(ns["main"](), decision)
        self.assertEqual(len(reached), 2, "the bounded verifier was reached")

    def test_a_valid_receipt_is_published_after_the_decision(self):
        order = []
        self.ns.update(_decide=lambda: order.append("decide") or 0,
                       observe_receipt=lambda *_: order.append("observe") or "SEC-009 receipt: valid; not enforced")
        self.assertEqual(self.ns["main"](), 0)
        self.assertEqual(order, ["decide", "observe"])
        self.assertEqual(self.summary.read_text(), "SEC-009 receipt: valid; not enforced\n")

    def test_observation_reads_are_bounded_and_decision_reads_are_not(self):
        built = []
        original = self.ns["GitHub"]

        class Recording(original):
            def __init__(self, token, timeout=None):
                built.append(timeout)
                super().__init__(token, timeout)
        self.ns.update(GitHub=Recording, _decide=lambda: 0, observe_receipt=lambda *_: "line")
        self.ns["main"]()
        self.assertEqual(built, [self.ns["RECEIPT_TIMEOUT_S"]])
        self.assertIsNone(original("t").timeout)


class ReceiptWorkflows(unittest.TestCase):
    ROOT = Path(__file__).resolve().parents[2] / ".github/workflows"

    def jobs(self, text):
        import re
        body = text.split("\njobs:\n", 1)[1]
        parts = re.split(r"^  ([a-z0-9_-]+):\s*$", body, flags=re.M)
        return dict(zip(parts[1::2], parts[2::2]))

    def test_the_pilot_calls_the_producer_of_the_default_branch_by_its_full_path(self):
        pilot = (self.ROOT / "tested-receipt-pilot.yml").read_text()
        self.assertRegex(pilot, r"\n    uses: cdeust/ai-architect-mcp-spec/\.github/workflows/tested-receipt\.yml@main"
                                r" # zizmor: ignore\[unpinned-uses\]\n")
        self.assertNotIn("uses: ./", pilot)
        self.assertNotIn("with:", pilot, "no input: nothing the caller passes can shape the receipt")
        self.assertNotIn("secrets:", pilot)

    def test_only_the_signer_can_sign_and_it_runs_nothing_of_the_tested_commit(self):
        producer = (self.ROOT / "tested-receipt.yml").read_text()
        self.assertIn("\npermissions: {}\n", producer)
        jobs = self.jobs(producer)
        self.assertEqual(set(jobs), {"recipes", "unit", "regression", "e2e", "sign"})
        for name, job in jobs.items():
            signing = "id-token: write" in job or "attestations: write" in job
            self.assertEqual(signing, name == "sign", name)
        sign = jobs["sign"]
        self.assertNotIn("actions/checkout", sign)
        self.assertNotIn("download-artifact", sign)
        uses = [line.strip() for line in sign.splitlines() if line.strip().startswith(("uses:", "- uses:"))]
        self.assertEqual([u.split("@")[0].split()[-1] for u in uses], ["actions/attest"])
        self.assertRegex(uses[0], r"@[0-9a-f]{40} ")

    def test_the_recipes_come_from_the_default_branch(self):
        recipes = self.jobs((self.ROOT / "tested-receipt.yml").read_text())["recipes"]
        self.assertIn('gh api "repos/$GITHUB_REPOSITORY/contents/ci.json"', recipes)
        self.assertNotIn("?ref=", recipes)
        self.assertNotIn("actions/checkout", recipes)

    def test_the_resolver_expects_exactly_the_producer_test_jobs(self):
        ns = resolver()
        jobs = set(self.jobs((self.ROOT / "tested-receipt.yml").read_text())) - {"recipes", "sign"}
        self.assertEqual(set(ns["RECEIPT_JOBS"]), jobs)

    def test_merge_commits_get_their_receipt_from_the_post_merge_chain_only(self):
        after = (self.ROOT / "pipeline-after-merge.yml").read_text()
        receipt = self.jobs(after)["receipt"]
        self.assertIn("needs: pipeline", receipt)
        self.assertIn("if: needs.pipeline.outputs.run_tests == 'true'", receipt)
        self.assertIn("uses: cdeust/ai-architect-mcp-spec/.github/workflows/tested-receipt.yml@main", receipt)
        self.assertIn("tested_sha: ${{ needs.pipeline.outputs.tested_sha }}", receipt)
        post = (self.ROOT / "pipeline-post-merge.yml").read_text()
        self.assertIn("tested_sha:\n        value: ${{ jobs.resolve.outputs.tested_sha }}", post)
        pilot = (self.ROOT / "tested-receipt-pilot.yml").read_text()
        self.assertNotIn("push:", pilot, "a resolver merge (GITHUB_TOKEN) starts no push workflow")
        subject = self.jobs((self.ROOT / "tested-receipt.yml").read_text())["recipes"]
        self.assertIn('[ "$CALLER" = "$GITHUB_REPOSITORY/.github/workflows/pipeline-after-merge.yml@refs/heads/main" ]',
                      subject)
        self.assertIn("CALLER: ${{ github.workflow_ref }}", subject)
        self.assertIn('[ -z "$MERGED" ] || { echo "::error::a pull request receipt takes no tested_sha"; exit 1; }',
                      subject)
        self.assertIn('compare/$sha...main', subject)

    def test_the_pilot_cannot_wake_or_hold_the_merge_resolver(self):
        after = (self.ROOT / "pipeline-after-merge.yml").read_text()
        self.assertIn("workflows: [Pipeline, PR Review, Review updated]", after)
        self.assertNotIn("Tested receipt", after)


class BoundedVerifier(unittest.TestCase):
    def setUp(self):
        self.ns = resolver()

    def test_github_reads_carry_their_timeout_to_urlopen(self):
        seen = []

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def read(self):
                return b"{}"
        self.ns["urlopen"] = lambda request, timeout=None: seen.append(timeout) or Response()
        self.ns["GitHub"]("t", timeout=self.ns["RECEIPT_TIMEOUT_S"]).request("GET", "/x")
        self.ns["GitHub"]("t").request("GET", "/x")
        self.assertEqual(seen, [self.ns["RECEIPT_TIMEOUT_S"], None])

    def test_gh_verifies_the_exact_identity_issuer_predicate_and_runner(self):
        import os
        from unittest.mock import patch
        calls = []

        class Done:
            returncode, stdout = 0, '[{"ok": true}]'
        with patch("subprocess.run", lambda *a, **k: calls.append((a, k)) or Done()), \
                patch.dict(os.environ, {"GITHUB_REPOSITORY": REPO}):
            self.assertEqual(self.ns["gh_attestation_verify"]("/tmp/subject", PRODUCER), [{"ok": True}])
        (argv,), options = calls[0]
        self.assertEqual(argv, ["gh", "attestation", "verify", "/tmp/subject", "--repo", REPO,
                                "--cert-identity", PRODUCER,
                                "--cert-oidc-issuer", "https://token.actions.githubusercontent.com",
                                "--predicate-type", PREDICATE, "--deny-self-hosted-runners", "--format", "json"])
        self.assertEqual(options["timeout"], self.ns["RECEIPT_TIMEOUT_S"])

    def test_a_refused_or_unreadable_verification_is_an_error(self):
        import os
        from unittest.mock import patch
        # A refusal is an error even when gh still prints well-formed JSON.
        for code, out in ((1, '[{"verificationResult": {}}]'), (1, ""), (0, "not json")):
            class Done:
                returncode, stdout = code, out
            with patch("subprocess.run", lambda *a, Done=Done, **k: Done()), \
                    patch.dict(os.environ, {"GITHUB_REPOSITORY": REPO}), \
                    self.assertRaises(self.ns["PostMergeError"]):
                self.ns["gh_attestation_verify"]("/tmp/subject", PRODUCER)


class SignerContract(unittest.TestCase):
    def test_the_signer_attests_failures_too_and_creates_no_storage_record(self):
        producer = (Path(__file__).resolve().parents[2] / ".github/workflows/tested-receipt.yml").read_text()
        sign = producer.split("\n  sign:\n", 1)[1]
        self.assertIn("    if: ${{ !cancelled() && needs.recipes.result == 'success' }}\n", sign)
        self.assertIn("          create-storage-record: false\n", sign)
