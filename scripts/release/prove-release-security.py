"""Replay release security checks against an already published tag, without publishing.

Usage: python3 -B scripts/release/prove-release-security.py v0.9.0 --baseline a685397
Requires PyYAML, actionlint 1.7.12, zizmor 1.31.1, Bash, gh, jq, and a read-only
GitHub session. Temporary files honor TMPDIR.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import yaml


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/release.yml"
JOBS = yaml.safe_load(WORKFLOW.read_text())["jobs"]
REPOSITORY = "cdeust/ai-architect-mcp-spec"
BUNDLE = "ai-architect-mcp-spec.mcpb"
SBOM = "ai-architect-mcp-spec.cdx.json"
TEST_MODULE = "test_ci_platform_release_security"


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def production_step(job, name, work, **env):
    step = next(step for step in JOBS[job]["steps"] if step.get("name") == name)
    script = step["run"]
    if "${{" in script:
        raise ValueError(f"Refusing to evaluate a GitHub expression in {name}")
    run("bash", "-euo", "pipefail", "-c", script, cwd=work, env={**os.environ, **env})


def check_baseline(revision, work):
    baseline = work / "baseline.yml"
    commit = run("git", "rev-parse", "--verify", "--end-of-options", revision + "^{commit}",
                 capture_output=True, cwd=ROOT).stdout.strip()
    baseline.write_text(run("git", "show", f"{commit}:.github/workflows/release.yml",
                            capture_output=True, cwd=ROOT).stdout)
    # Inspect the old policy and templates without executing any old workflow code.
    for method, diagnostic in [("test_no_expression_is_compiled_into_shell_source", "unexpectedly found"),
                               ("test_build_has_only_read_access_and_checkout_does_not_persist", "persisted checkout")]:
        result = subprocess.run([sys.executable, "-B", "-m", "unittest", f"{TEST_MODULE}.ReleaseSecurity.{method}"],
                                cwd=ROOT / "scripts/tests", env={**os.environ, "RELEASE_WORKFLOW_PATH": str(baseline)},
                                text=True, capture_output=True)
        if result.returncode != 1 or diagnostic not in result.stderr:
            raise ValueError(f"Expected baseline failure for {method}, got {result.returncode}: {result.stderr}")
        print(f"Baseline {revision}: {method} failed as expected (exit 1)", flush=True)


def verify_public_release(tag, work):
    output = work / "output"
    env = dict(TAG=tag, REPOSITORY=REPOSITORY, GITHUB_OUTPUT=str(output))
    production_step("target", "Resolve target tag", work, EVENT_NAME="workflow_dispatch",
                    DISPATCH_TAG=tag, REF_NAME="main", **env)
    production_step("publish_registry", "Verify server.json version matches the tag being published", work, **env)
    fields = dict(line.split("=", 1) for line in output.read_text().splitlines())
    production_step("publish_registry", "Download and verify the public .mcpb asset", work,
                    COMMIT=fields["commit"], **env)
    fields = dict(line.split("=", 1) for line in output.read_text().splitlines())
    production_step("publish_registry", "Patch fileSha256 into a runtime copy of server.json", work,
                    DIGEST=fields["digest"])
    manifest = json.loads((work / "server.runtime.json").read_text())
    if manifest["packages"][0]["fileSha256"] != hashlib.sha256((work / BUNDLE).read_bytes()).hexdigest():
        raise ValueError("Registry manifest digest differs from the public bundle")
    run("gh", "release", "download", tag, "--repo", REPOSITORY,
        "--pattern", SBOM, "--pattern", SBOM + ".sha256", cwd=work)
    digest = hashlib.sha256((work / SBOM).read_bytes()).hexdigest()
    if (work / (SBOM + ".sha256")).read_text().strip() != digest:
        raise ValueError("Public SBOM checksum differs")
    if json.loads((work / SBOM).read_text())["bomFormat"] != "CycloneDX":
        raise ValueError("Public SBOM is not CycloneDX")
    run("gh", "attestation", "verify", SBOM, "--repo", REPOSITORY, "--signer-workflow",
        REPOSITORY + "/.github/workflows/release.yml", "--source-ref", "refs/tags/" + tag,
        "--source-digest", fields["commit"], cwd=work)
    print(f"Public release {tag} at {fields['commit']}: MCPB {fields['digest']}, SBOM {digest}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("published_tag")
    parser.add_argument("--baseline", help="pre-fix Git revision for the two negative contract checks")
    args = parser.parse_args()
    for tool, flag, version in [("actionlint", "-version", "1.7.12"),
                                ("zizmor", "--version", "zizmor 1.31.1")]:
        banner = run(tool, flag, capture_output=True).stdout.splitlines()
        if not banner or banner[0] != version:
            raise SystemExit(f"Expected {tool} version banner {version!r}, got {banner!r}")
    run("actionlint", str(WORKFLOW), cwd=ROOT)
    run("zizmor", "--offline", "--no-ignores", str(WORKFLOW), cwd=ROOT)
    run(sys.executable, "-B", "-m", "unittest", "discover", "-s", "scripts/tests",
        "-p", TEST_MODULE + ".py", "-v", cwd=ROOT)
    with tempfile.TemporaryDirectory(prefix="release-proof-") as directory:
        work = Path(directory)
        if args.baseline:
            check_baseline(args.baseline, work)
        verify_public_release(args.published_tag, work)


if __name__ == "__main__":
    main()
