"""Every third-party package a Python file under scripts/ imports is pinned and audited.

The regression job installs scripts/tests/requirements.txt (hashed, wheels only)
in a fresh virtual environment, and the unit job audits the same file on OSV
before any install. A package the runner image happens to provide must not be
imported without a pin: its version would change with the image, unaudited.
"""

import ast
import io
import json
import shlex
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
import ci_python_pins as pins  # noqa: E402

REQUIREMENTS = SCRIPTS / "tests" / "requirements.txt"
# Import name -> distribution name, for the packages whose names differ.
DISTRIBUTIONS = {"yaml": "PyYAML"}
HASH = "a" * 64


def python_files():
    return sorted(path for path in SCRIPTS.rglob("*.py") if "node_modules" not in path.parts)


def imported(path):
    """Top-level names of every absolute import in the file, at any depth of the tree."""
    names = set()
    for node in ast.walk(ast.parse(path.read_text(), str(path))):
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    return names


def local(name, path):
    """A module of this repository: next to the importing file or in scripts/."""
    return any((directory / f"{name}.py").is_file() or (directory / name / "__init__.py").is_file()
               for directory in (path.parent, SCRIPTS))


def unpinned(path, pinned):
    return sorted(name for name in imported(path)
                  if name not in sys.stdlib_module_names and not local(name, path)
                  and DISTRIBUTIONS.get(name, name).lower() not in pinned)


class Response(io.BytesIO):
    def __init__(self, body, status=200):
        super().__init__(body if isinstance(body, bytes) else json.dumps(body).encode())
        self.status = status


def opener(body, status=200, sent=None):
    def open_(request, timeout):
        if sent is not None:
            sent.append((request.full_url, json.loads(request.data), timeout))
        return Response(body, status)
    return open_


class EveryImportIsPinned(unittest.TestCase):
    def test_every_third_party_import_under_scripts_is_pinned(self):
        pinned = {name.lower() for name, _, _ in pins.read_pins(REQUIREMENTS)}
        files = python_files()
        self.assertIn(SCRIPTS / "release" / "prove-release-security.py", files)
        for path in files:
            with self.subTest(path=str(path.relative_to(ROOT))):
                self.assertEqual(unpinned(path, pinned), [], "imported without a pin in scripts/tests/requirements.txt")

    def test_the_check_sees_imports_inside_functions_and_refuses_an_unknown_package(self):
        source = ("import json\nimport ci_python_pins\nimport helper\n\n"
                  "def later():\n    import requests\n    from yaml import safe_load\n")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "probe.py")
            path.write_text(source)
            Path(directory, "helper.py").touch()
            self.assertEqual(unpinned(path, {"pyyaml"}), ["requests"])
            self.assertEqual(unpinned(path, set()), ["requests", "yaml"])

    def test_every_pin_is_used(self):
        used = {DISTRIBUTIONS.get(name, name).lower() for path in python_files() for name in imported(path)}
        for name, _, _ in pins.read_pins(REQUIREMENTS):
            self.assertIn(name.lower(), used, f"{name} is pinned but nothing imports it")


class RequirementsFile(unittest.TestCase):
    def read(self, text):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "requirements.txt")
            path.write_text(text)
            return pins.read_pins(path)

    def test_the_pins_are_exact_and_hashed(self):
        self.assertEqual(self.read(f"# comment\nPyYAML==6.0.3 \\\n    --hash=sha256:{HASH} \\\n    --hash=sha256:{'b' * 64}\n"),
                         [("PyYAML", "6.0.3", [HASH, "b" * 64])])
        for text in ("PyYAML==6.0.3\n", f"PyYAML>=6.0.3 --hash=sha256:{HASH}\n", f"PyYAML --hash=sha256:{HASH}\n",
                     f"-r other.txt\nPyYAML==6.0.3 --hash=sha256:{HASH}\n", f"PyYAML==6.0.3 --hash=md5:{HASH[:32]}\n",
                     f"--index-url https://example.invalid\nPyYAML==6.0.3 --hash=sha256:{HASH}\n",
                     f"PyYAML==6.0.3 --hash=sha256:{HASH} # trailing\n",
                     f"PyYAML==6.0.3 --hash=sha256:{HASH}\npyyaml==6.0.2 --hash=sha256:{HASH}\n", "# nothing\n"):
            with self.subTest(text=text), self.assertRaises(pins.PinError):
                self.read(text)

    def test_ci_installs_the_file_with_hashes_and_wheels_only_in_a_fresh_environment(self):
        regression = json.loads((ROOT / "ci.json").read_text())["regression"].split(" && ")
        self.assertEqual(regression[:3], [
            'python3 -m venv "$RUNNER_TEMP/test-python"',
            '. "$RUNNER_TEMP/test-python/bin/activate"',
            "python3 -m pip install --require-hashes --only-binary :all: --no-deps -r scripts/tests/requirements.txt",
        ])
        self.assertIn("python3 -B -m unittest discover -s scripts/tests -p 'test_ci_python_pins.py'", regression)

    def test_dependabot_updates_the_file(self):
        import yaml
        updates = yaml.safe_load((ROOT / ".github" / "dependabot.yml").read_text())["updates"]
        self.assertIn(("pip", "/scripts/tests"), [(u["package-ecosystem"], u["directory"]) for u in updates])

    def test_the_unit_job_audits_the_file_before_any_install(self):
        unit = [shlex.split(part) for part in json.loads((ROOT / "ci.json").read_text())["unit"].split(" && ")]
        audit = ["python3", "-I", "scripts/ci_python_pins.py", "scripts/tests/requirements.txt"]
        self.assertIn(audit, unit)
        self.assertLess(unit.index(audit), unit.index(["pnpm", "install", "--frozen-lockfile"]))


class OsvAudit(unittest.TestCase):
    PINS = [("PyYAML", "6.0.3", [HASH]), ("other", "1.0", [HASH])]

    def test_the_query_names_every_pin_on_pypi(self):
        sent = []
        self.assertEqual(pins.advisories(self.PINS, opener({"results": [{}, {}]}, sent=sent)), {})
        url, body, timeout = sent[0]
        self.assertEqual(url, "https://api.osv.dev/v1/querybatch")
        self.assertEqual(body, {"queries": [{"package": {"name": "PyYAML", "ecosystem": "PyPI"}, "version": "6.0.3"},
                                            {"package": {"name": "other", "ecosystem": "PyPI"}, "version": "1.0"}]})
        self.assertEqual(timeout, pins.TIMEOUT_S)

    def test_an_advisory_is_reported(self):
        answer = {"results": [{"vulns": [{"id": "GHSA-8q59-q68h-6hv4"}, {"id": "PYSEC-2021-142"}]}, {}]}
        self.assertEqual(pins.advisories(self.PINS, opener(answer)),
                         {"PyYAML==6.0.3": ["GHSA-8q59-q68h-6hv4", "PYSEC-2021-142"]})

    def test_an_answer_it_cannot_trust_is_an_error(self):
        for body, status in (({"results": [{}]}, 200), ({"results": [{}, {}]}, 500), (b"<html>", 200), ([], 200),
                             ({"results": [{"next_page_token": "x"}, {}]}, 200), ({"results": [[], {}]}, 200),
                             ({"results": [{"vulns": [{"summary": "no id"}]}, {}]}, 200), ({}, 200)):
            with self.subTest(body=body, status=status), self.assertRaises(Exception):
                pins.advisories(self.PINS, opener(body, status))

    def test_main_fails_closed(self):
        def down(request, timeout):
            raise urllib.error.URLError("network down")
        cases = ((down, 1), (opener({"results": [{"vulns": [{"id": "X"}]}]}), 1), (opener({"results": [{}]}), 0))
        for open_, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(pins.main(["ci_python_pins.py", str(REQUIREMENTS)], open_), expected)
        self.assertEqual(pins.main(["ci_python_pins.py"], down), 2)
        self.assertEqual(pins.main(["ci_python_pins.py", str(ROOT / "missing.txt")], opener({"results": [{}]})), 1)


if __name__ == "__main__":
    unittest.main()
