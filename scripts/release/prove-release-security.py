"""Replay release security checks against an already published tag, without publishing.

Usage: python3 -B scripts/release/prove-release-security.py v0.9.0
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


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def production_step(job, name, work, **env):
    step = next(step for step in JOBS[job]["steps"] if step.get("name") == name)
    script = step["run"]
    if "${{" in script:
        raise ValueError(f"Refusing to evaluate a GitHub expression in {name}")
    run("bash", "-euo", "pipefail", "-c", script, cwd=work, env={**os.environ, **env})


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
    tag = parser.parse_args().published_tag
    for tool, flag, version in [("actionlint", "-version", "1.7.12"),
                                ("zizmor", "--version", "zizmor 1.31.1")]:
        banner = run(tool, flag, capture_output=True).stdout.splitlines()
        if not banner or banner[0] != version:
            raise SystemExit(f"Expected {tool} version banner {version!r}, got {banner!r}")
    run("actionlint", str(WORKFLOW), cwd=ROOT)
    run("zizmor", "--offline", "--no-ignores", str(WORKFLOW), cwd=ROOT)
    run(sys.executable, "-B", "-m", "unittest", "discover", "-s", "scripts/tests",
        "-p", "test_release_security.py", "-v", cwd=ROOT)
    with tempfile.TemporaryDirectory(prefix="release-proof-") as directory:
        verify_public_release(tag, Path(directory))


if __name__ == "__main__":
    main()
