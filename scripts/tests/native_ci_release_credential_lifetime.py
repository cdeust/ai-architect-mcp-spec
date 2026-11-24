"""Native OpenSSH integration, run by ci.json regression on a socket-capable runner."""
from pathlib import Path
import os
import subprocess
import tempfile
import textwrap
import unittest

from test_ci_release_credential_lifetime import WORKFLOWS, step


class ReleaseCredentialLifetime(unittest.TestCase):
    def test_signing_identity_is_gone_after_success_and_failure(self):
        for path in WORKFLOWS:
            workflow = path.read_text()
            publish = step(workflow, "Publish declared package tags")
            with self.subTest(path=path):
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
            socket = root / (root / "socket").read_text()
            follow_up = subprocess.run(["ssh-add", "-l"], env={**env, "SSH_AUTH_SOCK": str(socket)},
                                       capture_output=True)
            self.assertEqual(follow_up.returncode, 2, "credential agent remained accessible")
            self.assertFalse(any(key.encode() in p.read_bytes() for p in root.rglob("*") if p.is_file()))
