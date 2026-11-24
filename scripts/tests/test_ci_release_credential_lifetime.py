"""The job supplies the deploy key to one step and stops its agent on exit."""
from pathlib import Path
import os
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]


def step(workflow, title):
    section = workflow.split("      - name: " + title + "\n", 1)[1]
    return section.split("\n      - ", 1)[0]


class ReleaseCredentialLifetime(unittest.TestCase):
    def test_signing_identity_is_gone_after_success_and_failure(self):
        candidates = [ROOT / ".github/workflows" / name
                      for name in ("pipeline.yml", "pipeline-post-merge.yml")]
        for path in candidates:
            workflow = path.read_text()
            publish = step(workflow, "Publish declared package tags")
            fetch = step(workflow, "Fetch the tested commit into a bare repository")
            with self.subTest(path=path):
                self.assertNotIn("secrets.RELEASE_TAG_SSH_KEY", fetch)
                self.assertIn("SSH_KEY: ${{ secrets.RELEASE_TAG_SSH_KEY }}", publish)
                for status in (0, 1):
                    self.exercise(textwrap.dedent(publish.split("        run: |\n", 1)[1]), status)

    def exercise(self, script, status):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            identity = root / "test-key"
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", identity], check=True)
            key = identity.read_text()
            identity.unlink()
            (root / "release-known-hosts").touch()
            witness = root / "python3"
            witness.write_text(
                '#!/bin/sh\nset -eu\nssh-add -l > "$RUNNER_TEMP/identities"\n'
                'printf "%s" "$SSH_AUTH_SOCK" > "$RUNNER_TEMP/socket"\n'
                'test -z "${SSH_KEY-}"\nexit "$SIMULATED_STATUS"\n'
            )
            witness.chmod(0o700)
            env = {**os.environ, "PATH": temp + os.pathsep + os.environ["PATH"],
                   "SSH_KEY": key, "RUNNER_TEMP": temp, "SIMULATED_STATUS": str(status)}
            env.pop("SSH_AUTH_SOCK", None)
            result = subprocess.run(["bash", "-eo", "pipefail", "-c", script],
                                    cwd=root, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, status, result.stderr)
            self.assertIn("ED25519", (root / "identities").read_text())
            socket = (root / "socket").read_text()
            follow_up = subprocess.run(["ssh-add", "-l"], env={**env, "SSH_AUTH_SOCK":socket},
                                       capture_output=True)
            self.assertEqual(follow_up.returncode, 2, "credential agent remained accessible")
            self.assertFalse(any(key.encode() in p.read_bytes() for p in root.rglob("*") if p.is_file()))
