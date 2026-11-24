"""Run with python3 -B -m unittest discover -s scripts/tests -p test_release_security.py."""

import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
import zipfile

import yaml


WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/release.yml"
DOCUMENT = yaml.safe_load(WORKFLOW.read_text())
JOBS = DOCUMENT["jobs"]
BUNDLE = "ai-architect-mcp-spec.mcpb"
SBOM = "ai-architect-mcp-spec.cdx.json"


def named_step(name):
    return next(step for job in JOBS.values() for step in job["steps"]
                if step.get("name") == name)


def run_step(name, cwd, **env):
    script = named_step(name)["run"]
    if "${{" in script:
        raise AssertionError(f"{name} contains GitHub expressions in shell source")
    return subprocess.run(["bash", "-euo", "pipefail", "-c", script], cwd=cwd,
                          env={"PATH": os.environ["PATH"], **env}, capture_output=True, text=True)


class ReleaseSecurity(unittest.TestCase):
    def test_no_expression_is_compiled_into_shell_source(self):
        for job, spec in JOBS.items():
            for step in spec["steps"]:
                with self.subTest(job=job, step=step.get("name")):
                    self.assertNotIn("${{", step.get("run", ""))

    def test_build_has_only_read_access_and_checkout_does_not_persist(self):
        jobs_running_build = []
        for job, spec in JOBS.items():
            permissions = spec.get("permissions", DOCUMENT["permissions"])
            for step in spec["steps"]:
                action = step.get("uses", "").partition("@")[0]
                if action == "actions/checkout":
                    self.assertIs(step["with"].get("persist-credentials"), False)
                if re.search(r"\b(?:pnpm|npx|npm|scripts/)\b", step.get("run", "")) or action == "actions/checkout":
                    jobs_running_build.append(job)
                    self.assertEqual(permissions, {"contents": "read"}, job)
            if "write" in permissions.values():
                actions = {s["uses"].partition("@")[0] for s in spec["steps"] if "uses" in s}
                self.assertLessEqual(actions, {"actions/attest-build-provenance"})
        self.assertTrue(jobs_running_build)

    def test_event_selects_and_validates_the_tag_before_export(self):
        self.assertEqual(named_step("Resolve target tag")["env"], {
            "EVENT_NAME": "${{ github.event_name }}", "REF_NAME": "${{ github.ref_name }}",
            "DISPATCH_TAG": "${{ inputs.tag }}",
        })
        cases = [("v1.2.3", True), ("v0.0.0-rc.1+build.8", True),
                 ("v1.2.3+sha-1", True), ("", False), ("main", False),
                 ("v01.2.3", False), ("v1.2.3-01", False), ("v1.2.3-", False),
                 ("v1.2.3$( )", False), ('v1.2.3"', False), ("v1.2.3;", False),
                 ("v1.2.3\nother=value", False)]
        for event in ["push", "workflow_dispatch"]:
            for value, valid in cases:
                with self.subTest(event=event, value=value), tempfile.TemporaryDirectory() as directory:
                    output = Path(directory, "output")
                    output.touch()
                    result = run_step("Resolve target tag", directory, EVENT_NAME=event,
                                      REF_NAME=value if event == "push" else "main",
                                      DISPATCH_TAG=value if event == "workflow_dispatch" else "",
                                      GITHUB_OUTPUT=str(output))
                    self.assertEqual(result.returncode == 0, valid, result.stderr)
                    self.assertEqual(output.read_text(), f"tag={value}\n" if valid else "")

    def test_verified_archive_is_read_as_data_before_attestation_or_publication(self):
        job = JOBS["release"]
        steps = job["steps"]
        verify = named_step("Verify and read release artifact")
        self.assertEqual(steps.index(verify), 0)
        self.assertIn("build", job["needs"])
        self.assertEqual(verify["env"]["ARCHIVE_SHA256"], "${{ needs.build.outputs.digest }}")
        self.assertEqual(verify["env"]["ARTIFACT_ID"], "${{ needs.build.outputs.id }}")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "input.zip"
            with zipfile.ZipFile(archive, "w") as z:
                for file in [BUNDLE, SBOM, "release-notes.md"]:
                    z.writestr(file, file.encode())
                    if file != "release-notes.md":
                        z.writestr(file + ".sha256", hashlib.sha256(file.encode()).hexdigest() + "\n")
                z.writestr("unrequested", b"must stay inside the archive")
            gh = root / "gh"
            gh.write_text('#!/bin/sh\ncase "$2" in */zip) cat "$FIXTURE";; *) echo 42;; esac\n')
            gh.chmod(0o755)
            env = dict(PATH=str(root) + os.pathsep + os.environ["PATH"], FIXTURE=str(archive),
                       ARTIFACT_ID="23", REPOSITORY="owner/repo", RUNNER_TEMP=directory,
                       GITHUB_RUN_ID="42")
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            foreign = run_step(verify["name"], root, **{**env, "GITHUB_RUN_ID": "43"}, ARCHIVE_SHA256=digest)
            self.assertNotEqual(foreign.returncode, 0)
            self.assertIn("different workflow run", foreign.stdout)
            bad = run_step(verify["name"], root, **env, ARCHIVE_SHA256="0" * 64)
            self.assertNotEqual(bad.returncode, 0)
            self.assertFalse((root / BUNDLE).exists())
            good = run_step(verify["name"], root, **env, ARCHIVE_SHA256=digest)
            self.assertEqual(good.returncode, 0, good.stderr + good.stdout)
            self.assertEqual((root / BUNDLE).read_bytes(), BUNDLE.encode())
            self.assertEqual((root / SBOM).read_bytes(), SBOM.encode())
            self.assertFalse((root / "unrequested").exists())

    def test_release_command_creates_and_updates_the_four_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            gh = root / "gh"
            gh.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> commands\n'
                          'if [ "$2" = view ]; then exit "$VIEW"; fi\n')
            gh.chmod(0o755)
            for exists, tag, prerelease in [(False, "v1.2.3", "false"), (True, "v1.2.3-rc.1", "true")]:
                with self.subTest(exists=exists):
                    result = run_step("Create or update the GitHub Release", root,
                                      PATH=str(root) + os.pathsep + os.environ["PATH"], TAG=tag,
                                      VIEW="0" if exists else "1")
                    self.assertEqual(result.returncode, 0, result.stderr)
                    log = root / "commands"
                    commands = log.read_text().splitlines()
                    log.unlink()
                    self.assertTrue(commands[1].startswith(f"release {'upload' if exists else 'create'} {tag} "))
                    for asset in [BUNDLE, SBOM, BUNDLE + ".sha256", SBOM + ".sha256"]:
                        self.assertIn(asset, commands[1].split())
                    self.assertIn("--notes-file release-notes.md", commands[-1])
                    self.assertIn(f"--prerelease={prerelease}", commands[-1])

    def test_registry_duplicate_is_recoverable_only_for_manual_dispatch(self):
        with tempfile.TemporaryDirectory() as directory:
            publisher = Path(directory, "mcp-publisher")
            publisher.write_text('#!/bin/sh\necho "duplicate version"; exit 7\n')
            publisher.chmod(0o755)
            for event, code in [("push", 7), ("workflow_dispatch", 0)]:
                with self.subTest(event=event):
                    result = run_step("Publish server.json to the MCP Registry", directory,
                                      EVENT_NAME=event, TAG="v1.2.3")
                    self.assertEqual(result.returncode, code)
            publisher.write_text('#!/bin/sh\necho "service unavailable"; exit 7\n')
            result = run_step("Publish server.json to the MCP Registry", directory,
                              EVENT_NAME="workflow_dispatch", TAG="v1.2.3")
            self.assertEqual(result.returncode, 7)


if __name__ == "__main__":
    unittest.main()
