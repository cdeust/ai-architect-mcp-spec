"""The calibration frozen baseline is provenance: nothing is decided from a commit.

Owner rule 2026-10-29: no gate makes a decision depend on the identity of a hash,
the tip or the content of main. `frozen_baseline_commit` (HEAD at run time) is
recorded by `packages/benchmark/calibration/frozen-baseline.ts` and refused on
nothing. The plan and the sources must not bring back a rule that requires it to
"match the merge-base hash" or an ancestry assertion that aborts a run. The
SHA-256 of the `pipeline-kpis.ts` file being measured, checked by
`calibrate-gates.ts`, identifies the instrument and stays.

Standard library only. Companion of `test_no_main_comparison.py`, which this repository
receives from render-ci and which is not edited here.
"""

from pathlib import Path
import re
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCANNED = ("docs", "packages/benchmark/calibration")
SUFFIXES = (".md", ".ts")
FORBIDDEN = (
    "must match the merge-base" + " hash",
    "merge-base --is-ancestor <" + "frozen",
)
PATTERN = re.compile("|".join(re.escape(m) for m in FORBIDDEN), re.IGNORECASE)
SKIP_DIRS = {"node_modules", "dist", ".git"}


def _candidates(root: Path):
    for rel in SCANNED:
        base = root / rel
        paths = sorted(base.rglob("*")) if base.is_dir() else []
        for path in paths:
            if path.suffix in SUFFIXES and not SKIP_DIRS & set(path.parts):
                yield path


def _hits(path: Path, root: Path) -> list[str]:
    found = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        match = PATTERN.search(line)
        if match:
            found.append(f"{path.relative_to(root)}:{number}: {match.group(0)}")
    return found


def find_violations(root: Path) -> list[str]:
    hits: list[str] = []
    for path in _candidates(root):
        hits.extend(_hits(path, root))
    return hits


class FrozenBaselineIsProvenanceTests(unittest.TestCase):
    def test_plan_and_sources_carry_no_commit_gate(self) -> None:
        self.assertTrue((ROOT / "docs" / "PHASE_4_PLAN.md").is_file(), str(ROOT))
        self.assertEqual(find_violations(ROOT), [])

    def test_guard_detects_every_forbidden_marker(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            docs = Path(tmp) / "docs"
            docs.mkdir()
            for index, marker in enumerate(FORBIDDEN):
                (docs / f"p{index}.md").write_text(f"- {marker}\n", encoding="utf-8")
            self.assertEqual(len(find_violations(Path(tmp))), len(FORBIDDEN))


if __name__ == "__main__":
    unittest.main()
