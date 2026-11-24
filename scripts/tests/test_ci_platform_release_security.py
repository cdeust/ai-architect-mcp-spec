"""GitHub Actions release runner boundaries, included in ci.json's platform regression suite."""

import hashlib
import io
import os
from pathlib import Path
import re
import stat
import subprocess
import tarfile
import tempfile
import unittest
import zipfile

import yaml

if __package__:
    from .release_shell_policy import check_privileged_script, execution_env
else:
    from release_shell_policy import check_privileged_script, execution_env

DEFAULT_WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/release.yml"
WORKFLOW = Path(os.environ.get("RELEASE_WORKFLOW_PATH", DEFAULT_WORKFLOW))
DOCUMENT = yaml.safe_load(WORKFLOW.read_text())
JOBS = DOCUMENT["jobs"]
BUNDLE = "ai-architect-mcp-spec.mcpb"
SBOM = "ai-architect-mcp-spec.cdx.json"


def named_step(name):
    return next(step for job in JOBS.values() for step in job.get("steps", [])
                if step.get("name") == name)


def workflow_fields(value):
    """Walk jobs, steps and nested action inputs, including reusable workflow calls."""
    if isinstance(value, dict):
        for key, child in value.items():
            yield key, child
            yield from workflow_fields(child)
    elif isinstance(value, list):
        for child in value:
            yield from workflow_fields(child)


def run_step(name, cwd, **env):
    script = named_step(name)["run"]
    if "${{" in script:
        raise AssertionError(f"{name} contains GitHub expressions in shell source")
    return subprocess.run(["bash", "-euo", "pipefail", "-c", script], cwd=cwd,
                          env={"PATH": os.environ["PATH"], **env}, capture_output=True, text=True)


class ReleaseSecurity(unittest.TestCase):
    def test_no_expression_is_compiled_into_shell_source(self):
        for job, spec in JOBS.items():
            for step in spec.get("steps", []):
                with self.subTest(job=job, step=step.get("name")):
                    self.assertNotIn("${{", step.get("run", ""))

    def test_trigger_data_enters_through_environment_only(self):
        for field, value in workflow_fields(DOCUMENT):
            if field == "if":
                # Conditions are expressions even without the ${{ }} wrapper.
                for expr in [value, *re.findall(r"\$\{\{(.*?)\}\}", value, re.S)]:
                    condition = re.sub(r"'(?:[^']|'')*'", "", expr)
                    for name in re.findall(r"[A-Za-z_][\w.-]*", condition):
                        self.assertRegex(name, r"^(?:github\.event_name|needs\.[\w-]+\.result|cancelled)$")
            elif field in {"name", "run-name", "with"}:
                for item in value.values() if isinstance(value, dict) else (value,):
                    for expr in re.findall(r"\$\{\{(.*?)\}\}", str(item), re.S):
                        self.assertEqual(expr.strip(), "github.run_attempt", field)

    def test_build_has_only_read_access_and_checkout_does_not_persist(self):
        for job, spec in JOBS.items():
            for step in spec.get("steps", []):
                action = step.get("uses", "").partition("@")[0]
                if action == "actions/checkout":
                    with self.subTest(job=job, control="checkout"):
                        self.assertIs(step["with"].get("persist-credentials"), False, f"{job}: persisted checkout")
                        self.assertEqual(spec.get("permissions", DOCUMENT["permissions"]), {"contents": "read"})

    def test_actions_are_immutable_and_package_caches_are_disabled(self):
        for key, action in workflow_fields(DOCUMENT):
            if key == "uses":
                self.assertRegex(action, r"^[\w.-]+/[\w.-]+(?:/[\w.-]+)*@[a-fA-F0-9]{40}\Z")
                self.assertNotRegex(action, r"^actions/cache(?:/|@)")
        for job in JOBS.values():
            for step in job.get("steps", []):
                action = step.get("uses", "").partition("@")[0]
                inputs = step.get("with", {})
                if action == "actions/setup-node":
                    self.assertIs(inputs.get("package-manager-cache"), False)
                    self.assertNotIn("cache", inputs)
                if action == "pnpm/action-setup":
                    self.assertIs(inputs.get("cache", False), False)

    def test_privileged_command_policy_fails_closed_on_unreviewed_executables(self):
        # Policy inputs only. None of these snippets is passed to a shell.
        for script in ("node --version", "sh release-notes.md", "bash release-notes.md",
                       "python3 local.py", "curl --config release-notes.md", "./tool",
                       "echo ok && other-tool", "if [ -f input ]; then other-tool; fi",
                       "value=$(other-tool)", 'echo "$(other-tool)"'):
            with self.subTest(script=script), self.assertRaises(AssertionError):
                check_privileged_script(script)

    def test_permissions_and_release_dependencies(self):
        self.assertEqual(DOCUMENT["permissions"], {})
        self.assertEqual(JOBS["target"].get("permissions", DOCUMENT["permissions"]), {})
        self.assertEqual(JOBS["build"]["permissions"], {"contents": "read"})
        self.assertEqual(JOBS["build"]["needs"], "target")
        self.assertEqual(JOBS["build"].get("if"), "github.event_name == 'push'")
        self.assertEqual(JOBS["release"]["permissions"], {
            "actions": "read", "contents": "write", "attestations": "write", "id-token": "write",
        })
        registry = JOBS["publish_registry"]
        self.assertEqual(registry["permissions"], {
            "contents": "read", "attestations": "read", "id-token": "write",
        })
        self.assertEqual(set(registry["needs"]), {"target", "release"})
        install = named_step("Install mcp-publisher (checksum-verified)")
        self.assertIn(install, registry["steps"])
        self.assertEqual(" ".join(registry.get("if", "").split()),
                         "!cancelled() && needs.target.result == 'success' && "
                         "(github.event_name == 'workflow_dispatch' || needs.release.result == 'success')")
        for name, job in JOBS.items():
            with self.subTest(job=name):
                grants = job.get("permissions", DOCUMENT["permissions"])
                self.assertIsInstance(grants, dict)
                if name not in {"release", "publish_registry"}:
                    for scope, mode in grants.items():
                        self.assertIn(mode, ("read", "none"))
                        if scope in {"id-token", "attestations"}:
                            self.assertEqual(mode, "none")
                if "write" in grants.values():
                    self.assertNotIn("uses", job)
                    self.assertNotIn("container", job)
                    self.assertNotIn("services", job)
                    for options in (DOCUMENT, job):
                        self.assertFalse(options.get("defaults", {}).get("run"))
                    for options in (DOCUMENT, job, *job["steps"]):
                        for variable in options.get("env", {}):
                            self.assertFalse(execution_env(variable), variable)
                    for step in job["steps"]:
                        self.assertNotIn("if", step, "a privileged verification step could be skipped")
                        self.assertIs(step.get("continue-on-error", False), False)
                        if "uses" in step:
                            self.assertEqual(step["uses"].partition("@")[0], "actions/attest-build-provenance")
                        else:
                            self.assertNotIn("shell", step)
                            self.assertNotIn("working-directory", step)
                            check_privileged_script(step["run"])
                            if "./mcp-publisher" in step["run"]:
                                self.assertEqual(name, "publish_registry")
                                self.assertLess(job["steps"].index(install), job["steps"].index(step))
        attest = named_step("Attest build provenance (.mcpb + SBOM)")
        self.assertEqual(set(attest["with"]["subject-path"].split()), {BUNDLE, SBOM})

    def test_event_selects_and_validates_the_tag_before_export(self):
        self.assertEqual(named_step("Resolve target tag")["env"], {
            "EVENT_NAME": "${{ github.event_name }}", "REF_NAME": "${{ github.ref_name }}",
            "DISPATCH_TAG": "${{ inputs.tag }}",
        })
        cases = [("v1.2.3", True), ("v0.0.0-rc.1+build.8", True),
                 ("v1.2.3+sha-1", True), ("", False), ("main", False),
                 ("v01.2.3", False), ("v1.2.3-01", False), ("v1.2.3-", False),
                 ("v1.2.3$( )", False), ('v1.2.3"', False), ("v1.2.3;", False),
                 ("--flag=v1.2.3", False), ("prefix\nv1.2.3", False),
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
        check_privileged_script(verify["run"])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "input.zip"
            with zipfile.ZipFile(archive, "w") as z:
                for file in [BUNDLE, SBOM]:
                    z.writestr(file, file.encode())
                    z.writestr(file + ".sha256", hashlib.sha256(file.encode()).hexdigest() + "\n")
                link = zipfile.ZipInfo("release-notes.md")
                link.create_system = 3  # Unix ZIP entry
                link.external_attr = (stat.S_IFLNK | 0o777) << 16
                z.writestr(link, "local-note.txt")
                z.writestr("unrequested", b"must stay inside the archive")
            gh = root / "gh"
            gh.write_text('#!/bin/sh\necho called >> api-calls\n'
                          'case "$2" in */zip) cat "$FIXTURE";; *) echo 42;; esac\n')
            gh.chmod(0o755)
            env = dict(PATH=str(root) + os.pathsep + os.environ["PATH"], FIXTURE=str(archive),
                       ARTIFACT_ID="23", REPOSITORY="owner/repo", RUNNER_TEMP=directory,
                       GITHUB_RUN_ID="42")
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            for field, invalid in [("ARTIFACT_ID", "23/other"), ("ARTIFACT_ID", ""),
                                   ("ARCHIVE_SHA256", "z" * 64), ("ARCHIVE_SHA256", digest[:-1])]:
                with self.subTest(field=field, invalid=invalid):
                    malformed = {**env, "ARCHIVE_SHA256": digest, field: invalid}
                    self.assertNotEqual(run_step(verify["name"], root, **malformed).returncode, 0)
                    self.assertFalse((root / "api-calls").exists(), "invalid input reached GitHub")
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
            notes = root / "release-notes.md"
            self.assertTrue(stat.S_ISREG(notes.lstat().st_mode), "archive link must be read as plain bytes")
            self.assertEqual(notes.read_bytes(), b"local-note.txt")
            self.assertFalse((root / "unrequested").exists())
            with zipfile.ZipFile(archive, "w") as z:
                for file in [BUNDLE, SBOM, "release-notes.md"]:
                    z.writestr(file, b"modified")
                    if file != "release-notes.md":
                        z.writestr(file + ".sha256", "0" * 64)
            wrong_companion = run_step(verify["name"], root, **env,
                                       ARCHIVE_SHA256=hashlib.sha256(archive.read_bytes()).hexdigest())
            self.assertNotEqual(wrong_companion.returncode, 0)
            self.assertIn("Checksum mismatch", wrong_companion.stdout)

    def test_publisher_archive_is_checked_before_extracting_the_executable(self):
        step = named_step("Install mcp-publisher (checksum-verified)")
        self.assertRegex(step["env"]["MCP_PUBLISHER_SHA256"], r"^[0-9a-f]{64}\Z")
        self.assertRegex(step["env"]["MCP_PUBLISHER_VERSION"], r"^v\d+\.\d+\.\d+\Z")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = root / "fixture.tar.gz"
            data = b"test publisher archive member\n"
            with tarfile.open(fixture, "w:gz") as archive:
                member = tarfile.TarInfo("mcp-publisher")
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            curl = root / "curl"
            curl.write_text('#!/bin/sh\ncp "$FIXTURE" mcp-publisher_linux_amd64.tar.gz\n')
            curl.chmod(0o755)
            env = {**step["env"], "FIXTURE": str(fixture), "PATH": str(root) + os.pathsep + os.environ["PATH"]}
            result = run_step(step["name"], root, **env)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / "mcp-publisher").exists(), "unverified executable was extracted")
            env["MCP_PUBLISHER_SHA256"] = hashlib.sha256(fixture.read_bytes()).hexdigest()
            result = run_step(step["name"], root, **env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / "mcp-publisher").read_bytes(), data)

    def test_registry_digest_export_requires_attestation_for_the_release_commit(self):
        step = named_step("Download and verify the public .mcpb asset")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = b"public bundle fixture\n"
            digest = hashlib.sha256(data).hexdigest()
            (root / BUNDLE).write_bytes(data)
            (root / (BUNDLE + ".sha256")).write_text(digest + "\n")
            gh = root / "gh"
            gh.write_text('#!/bin/sh\ncase "$1 $2" in\n'
                          '  "release download") exit 0;;\n'
                          '  "attestation verify") printf "%s\\n" "$@" > verified-args; exit "$VERDICT";;\n'
                          '  *) exit 99;;\nesac\n')
            gh.chmod(0o755)
            output = root / "output"
            output.touch()
            repo, tag, commit = "owner/repo", "v1.2.3", "a" * 40
            env = dict(PATH=str(root) + os.pathsep + os.environ["PATH"], REPOSITORY=repo,
                       TAG=tag, COMMIT=commit, GITHUB_OUTPUT=str(output))
            rejected = run_step(step["name"], root, **env, VERDICT="41")
            self.assertEqual(rejected.returncode, 41)
            self.assertEqual(output.read_bytes(), b"", "digest exported after attestation failure")
            accepted = run_step(step["name"], root, **env, VERDICT="0")
            self.assertEqual(accepted.returncode, 0, accepted.stderr)
            self.assertEqual(output.read_text(), f"digest={digest}\n")
            args = (root / "verified-args").read_text().splitlines()
            self.assertEqual(args[:3], ["attestation", "verify", BUNDLE])
            self.assertEqual(dict(zip(args[3::2], args[4::2], strict=True)), {
                "--repo": repo, "--signer-workflow": repo + "/.github/workflows/release.yml",
                "--source-ref": "refs/tags/" + tag, "--source-digest": commit,
            })

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
