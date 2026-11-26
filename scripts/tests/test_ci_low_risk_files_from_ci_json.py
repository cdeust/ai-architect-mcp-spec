"""Keep compatibility with the existing CI configuration and its previous validator."""

import json
from pathlib import Path
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github/workflows"
REPO = "owner/any-repository"
# source: the heredoc openers of the resolver and of the ci.json validator in
# .github/workflows/pipeline-post-merge.yml and pipeline.yml.
RESOLVER = "          python3 - <<'PY'\n"
VALIDATOR = "          python3 - \"$GITHUB_WORKSPACE\" --github-output <<'PY'\n"
# source: .github/dependabot.yml of the fleet's repositories (uv, npm, cargo): the
# names Cortex's resolver held before ADR-1131 must no longer be in its source.
ECOSYSTEM_FILES = ("uv.lock", "pyproject.toml", "package.json", "Cargo.lock")


def embedded(workflow, opener):
    text = (WORKFLOWS / workflow).read_text()
    source = text.split(opener, 1)[1].split("\n          PY", 1)[0]
    return textwrap.dedent(source)


def load(workflow, opener):
    namespace = {"__name__": "embedded_test"}
    exec(compile(embedded(workflow, opener), workflow, "exec"), namespace)
    return namespace


class ContractValidatesTheKeyTests(unittest.TestCase):
    def faults(self, *listed):
        """Faults of a valid ci.json whose low_risk_files is listed[0], or absent."""
        document = {key: "true" for key in self.ns["KEYS"]}
        document["version_file"] = "v.json"
        if listed:
            document["low_risk_files"] = listed[0]
        with tempfile.TemporaryDirectory() as root:
            Path(root, "v.json").write_text('{"version": "1.0.0"}')
            Path(root, "ci.json").write_text(json.dumps(document))
            return self.ns["faults"](Path(root))

    def setUp(self):
        self.ns = load("pipeline.yml", VALIDATOR)

    def test_a_list_of_file_names_is_valid_and_so_is_an_empty_one(self):
        self.assertEqual(self.faults(["uv.lock"]), [])
        self.assertEqual(self.faults([]), [])

    def test_a_missing_key_fails_the_contract(self):
        self.assertEqual(self.faults(), ["low_risk_files: missing"])

    def test_a_path_or_a_non_list_fails_the_contract(self):
        for value in ("uv.lock", ["sub/uv.lock"], [""], [1], None):
            with self.subTest(value=value):
                self.assertEqual(
                    self.faults(value),
                    ["low_risk_files: must be a list of file names"],
                )

    def test_both_workflows_embed_the_same_validator(self):
        self.assertEqual(
            embedded("pipeline.yml", VALIDATOR),
            embedded("pipeline-post-merge.yml", VALIDATOR),
        )

    def test_this_repository_s_ci_json_honours_the_contract(self):
        self.assertEqual(self.ns["faults"](ROOT), [])
        listed = json.loads((ROOT / "ci.json").read_text())["low_risk_files"]
        self.assertEqual(listed, ["pnpm-lock.yaml", "package.json"])


if __name__ == "__main__":
    unittest.main()
