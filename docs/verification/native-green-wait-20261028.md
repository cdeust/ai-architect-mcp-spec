# Native green-wait discovery, 2026-10-28

This propagation copies exactly two parent-reviewed blobs from canonical commit 6cb9b18d5068fb1ecf510899b52527fae786b163 (PR205) onto remote main df68dfcc9282cc58dad78cae41fa2c553b035042.

Discovery retains a genuine successful merge-pending-review wait before applying the successful-review veto. The full authenticated plan remains the authorizer, including currently unresolved or blocked findings. The regression matrix exercises six actual discovery routes, using current proof and jobs rather than a mocked policy result.

Validation: `python3 -B -m unittest discover -s scripts/tests -p 'test_ci_codex*.py'` passes all 115 tests. Ruff with the actual Cortex pyproject configuration passes for both changed files. The actual Cortex `scripts/craftsmanship_rules.py` scanner returns an empty violation list for each. Changed-file staged source/craft gates and whitespace validation pass. No JavaScript, dependency, generated workflow, model or permission configuration changes are included; no Node installation or local JavaScript suite was repeated. Hosted CI runs the normal checks after publication.

Frozen SHA256 values:

- scripts/ci_codex_review_reconcile.py: 53acd5512f5b49c3ce42fb36b496a9e5c09ca74afa9604878a2d4c2fbb07d58e
- scripts/tests/test_ci_codex_review_proof_first.py: 1b046a129447084575e2260b7eac4175342bfdd4fa9ec339d81fc3fb48348403

Root independently reviewed and explicitly approved these exact production/test bytes before propagation.
