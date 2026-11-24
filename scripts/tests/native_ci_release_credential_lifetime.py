"""Native OpenSSH proof that the release write key lives only inside its publish step.

ci.json regression runs this module on a socket-capable runner. It executes the real
"Publish declared package tags" step body of each workflow with bash and OpenSSH, and
drives Git's SSH transport (ssh:// URL, GIT_SSH_COMMAND) into a local receiver. Only a
fixture key generated here is ever loaded.

A probe that reports "agent gone" proves nothing unless the same probe first reaches the
live agent: ssh-add -l also answers 2 when the socket path exceeds sun_path (104 bytes on
macOS, 108 on Linux). Every lifetime assertion below is therefore paired with a positive
control taken by the transport, on the same socket path, while the agent is alive.

Cancellation follows actions/runner ProcessInvoker (commit 1060fd3,
src/Runner.Sdk/ProcessInvoker.cs lines 32-33 and 443-464): SIGINT to the step PID alone,
SIGTERM 7.5 s later, then the process tree is killed 2.5 s after that.

RELEASE_CREDENTIAL_WORKFLOWS (paths joined by os.pathsep) replaces the workflows under
test, so the same proof can be run against another repository's revision.
"""
from pathlib import Path
import os
import shutil
import signal
import subprocess
import tempfile
import textwrap
import time
import unittest

from test_ci_release_credential_lifetime import WORKFLOWS as REPOSITORY_WORKFLOWS, step

WORKFLOWS = tuple(Path(p) for p in os.environ.get("RELEASE_CREDENTIAL_WORKFLOWS", "").split(os.pathsep) if p) \
    or REPOSITORY_WORKFLOWS
TAG = "v0.0.0-fixture"
SUN_PATH_BYTES = 104  # the smaller of the two platform limits, terminating NUL included
RUNNER_SIGINT_WINDOW_S = 7.5
RUNNER_SIGTERM_WINDOW_S = 2.5
TRANSPORT_EXIT_S = 1.0
OPENSSH_PARENT_CHECK_S = 10  # ssh-agent.c: parent_alive_interval for a command-scoped agent

HOSTILE_SSH_CONFIG = """Host *
  ProxyCommand /usr/bin/false
  IdentitiesOnly yes
  IdentityFile ~/.ssh/host-identity
  BatchMode no
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
"""

SSH_WRAPPER = """#!/bin/sh
# Stand-in for the ssh client Git runs. Records the effective client configuration and
# the agent it was given, then serves the Git command against the local receiver.
set -u
log="$FIXTURE_LOG/ssh.$$"
"$FIXTURE_REAL_SSH" -G "$@" > "$log.config" 2>&1
{
  echo "pid=$$"
  echo "arguments=$*"
  echo "parent=$PPID"
  echo "socket=${SSH_AUTH_SOCK-}"
  echo "agent=${SSH_AGENT_PID-}"
  echo "key_in_environment=${SSH_KEY+yes}"
  ssh-add -l >/dev/null 2>&1; echo "list=$?"
  ssh-add -T "$FIXTURE_PUBLIC_KEY" >/dev/null 2>&1; echo "signed=$?"
} > "$log.env"
[ -z "${FIXTURE_RECORD_AGENT-}" ] || printf '%s' "$SSH_AGENT_PID" > "$FIXTURE_LOG/agent-pid"
: > "$log.ready"
# A blocked transport hangs until Git goes away, then ends as a real client would.
if [ -n "${FIXTURE_BLOCK-}" ]; then
  while kill -0 "$PPID" 2>/dev/null; do sleep 0.05; done
  exit 255
fi
grep -qx signed=0 "$log.env" || exit 255
for command; do :; done
exec sh -c "$command"
"""

AGENT_WRAPPER = """#!/bin/sh
printf '%s\n' "${1-}" >> "$FIXTURE_LOG/agent-starts"  # one line per call
exec "$FIXTURE_REAL_AGENT" "$@"
"""


def alive(pid):
    """A zombie has released its memory, sockets and keys: it is not alive."""
    out = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
    return out.returncode == 0 and out.stdout.strip() != "" and not out.stdout.strip().startswith("Z")


def processes():
    rows = subprocess.run(["ps", "-Ao", "pid=,pgid=,stat=,args="], capture_output=True, text=True,
                          check=True).stdout.splitlines()
    return [row.split(None, 3) for row in rows if len(row.split(None, 3)) == 4]


def git(*args, **kwargs):
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True, **kwargs)


class Fixture:
    def __init__(self, root, publish_body, key=None):
        self.root = root
        # The step's TMPDIR holds the agent socket; sun_path forbids a deep directory.
        self.socket_base = Path(tempfile.mkdtemp(prefix="rc", dir="/tmp"))
        keys = root / "keys"
        keys.mkdir()
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "fixture", "-f", keys / "id"],
                       check=True)
        self.private = (keys / "id").read_text()
        (keys / "id").unlink()
        self.secret_body = self.private.splitlines()[1]
        self.public = keys / "id.pub"
        self.runner_temp = root / "runner"
        self.runner_temp.mkdir()
        (self.runner_temp / "release-known-hosts").write_text(
            "github.invalid " + self.public.read_text().split(" ", 2)[0] + " " +
            self.public.read_text().split(" ", 2)[1] + "\n")
        self.log = root / "log"
        self.log.mkdir()
        home = root / "home"
        (home / ".ssh").mkdir(parents=True)
        (home / ".ssh" / "config").write_text(HOSTILE_SSH_CONFIG)
        bin_dir = root / "bin"
        bin_dir.mkdir()
        for name, body in (("ssh", SSH_WRAPPER), ("ssh-agent", AGENT_WRAPPER)):
            (bin_dir / name).write_text(body)
            (bin_dir / name).chmod(0o700)
        work = root / "work"
        git("init", "-q", str(work))
        (work / "file").write_text("release fixture\n")
        git("-C", str(work), "add", "file")
        git("-C", str(work), "-c", "user.name=f", "-c", "user.email=f@f", "commit", "-q", "-m", "fixture")
        self.sha = git("-C", str(work), "rev-parse", "HEAD").stdout.strip()
        self.remote = root / "remote.git"
        git("init", "-q", "--bare", str(self.remote))
        self.repo = self.runner_temp / "release-repo"
        git("init", "-q", "--bare", str(self.repo))
        git("-C", str(self.repo), "fetch", "-q", str(work), self.sha)
        git("-C", str(self.repo), "remote", "add", "origin", "ssh://git@github.invalid" + str(self.remote))
        self.commands = {name: root / name for name in ("github-env", "github-output", "github-path")}
        for path in self.commands.values():
            path.touch()
        self.script = root / "step.sh"
        self.script.write_text(publish_body)
        self.env = {
            "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
            "HOME": str(home),
            "TMPDIR": str(self.socket_base),
            "LANG": "C",
            "GIT_CONFIG_NOSYSTEM": "1",
            "RUNNER_TEMP": str(self.runner_temp),
            "SSH_KEY": self.private if key is None else key,
            "RELEASE_TAGS": '["' + TAG + '"]',
            "TESTED_SHA": self.sha,
            "GITHUB_ENV": str(self.commands["github-env"]),
            "GITHUB_OUTPUT": str(self.commands["github-output"]),
            "GITHUB_PATH": str(self.commands["github-path"]),
            "GITHUB_STEP_SUMMARY": str(root / "summary"),
            "FIXTURE_LOG": str(self.log),
            "FIXTURE_PUBLIC_KEY": str(self.public),
            "FIXTURE_REAL_SSH": shutil.which("ssh"),
            "FIXTURE_REAL_AGENT": shutil.which("ssh-agent"),
        }
        self.runner_entries = set(os.listdir(self.runner_temp))
        self.process = None

    def start(self, block=False):
        env = dict(self.env, **({"FIXTURE_BLOCK": "1"} if block else {}))
        # actions/runner runs `shell: bash` as: bash --noprofile --norc -eo pipefail {0}
        self.process = subprocess.Popen(["bash", "--noprofile", "--norc", "-eo", "pipefail", str(self.script)],
                                        cwd=self.repo, env=env, start_new_session=True,
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        return self.process

    def finish(self, timeout=60):
        output, _ = self.process.communicate(timeout=timeout)
        return self.process.returncode, output

    def transports(self):
        result = []
        for env_file in sorted(self.log.glob("ssh.*.env")):
            record = dict(line.split("=", 1) for line in env_file.read_text().splitlines())
            config = Path(str(env_file)[:-len(".env")] + ".config").read_text().splitlines()
            record["config"] = {k: v for k, _, v in (line.partition(" ") for line in config)}
            result.append(record)
        return result

    def wait_ready(self, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if list(self.log.glob("ssh.*.ready")):
                return
            if self.process.poll() is not None:
                raise AssertionError("step exited before its transport started: " + self.process.stdout.read())
            time.sleep(0.05)
        raise AssertionError("transport never started")

    def remote_tag(self):
        out = subprocess.run(["git", "--git-dir", str(self.remote), "rev-parse", "--verify", "-q",
                              "refs/tags/" + TAG + "^{}"], capture_output=True, text=True)
        return out.stdout.strip() or None

    def cleanup(self):
        if self.process is not None:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.stdout.close()
        # An agent outside the step's group, or a stopped one that never checks its
        # parent again, is found through what the transport recorded, then removed
        # with its socket directory wherever the workflow under test put it.
        agents = [record["agent"] for record in self.transports() if record.get("agent")]
        if (self.log / "agent-pid").exists():
            agents.append((self.log / "agent-pid").read_text())
        for pid in agents:
            try:
                os.kill(int(pid), signal.SIGKILL)
            except (ProcessLookupError, ValueError):
                pass
        for record in self.transports():
            directory = (self.repo / record["socket"]).parent
            owned = directory.name.startswith("release-agent.") or any(
                directory != base and base in directory.parents for base in (self.root, self.socket_base))
            if record["socket"] and owned and directory not in (self.repo, self.runner_temp):
                shutil.rmtree(directory, ignore_errors=True)
        for pid, _, _, args in processes():
            if (str(self.root) in args or str(self.socket_base) in args) and int(pid) != os.getpid():
                try:
                    os.kill(int(pid), signal.SIGKILL)
                except ProcessLookupError:
                    pass


def publish_body(path):
    return textwrap.dedent(step(path.read_text(), "Publish declared package tags").split("        run: |\n", 1)[1])


class ReleaseCredentialLifetime(unittest.TestCase):
    def fixture(self, path, key=None):
        temp = Path(tempfile.mkdtemp(prefix="rc"))
        self.addCleanup(shutil.rmtree, temp, True)
        fixture = Fixture(temp, publish_body(path), key)
        self.addCleanup(shutil.rmtree, fixture.socket_base, True)
        self.addCleanup(fixture.cleanup)
        return fixture

    def assert_released(self, fixture):
        """Nothing that could still use the key outlives the step."""
        starts = (fixture.log / "agent-starts").read_text().splitlines() \
            if (fixture.log / "agent-starts").exists() else []
        starts = [first for first in starts if first != "-k"]
        self.assertEqual(len(starts), 1, "exactly one signing agent is started: %r" % starts)
        for record in fixture.transports():
            self.assertEqual(record["list"], "0", "positive control: the transport reached the live agent")
            socket = fixture.repo / record["socket"]  # a relative socket resolves from the step directory
            self.assertLess(len(record["socket"].encode()), SUN_PATH_BYTES, "the agent can bind its path as given")
            self.assertNotIn(socket.parent, (fixture.repo, fixture.runner_temp),
                             "the socket lives in a directory created for it alone")
            self.assertFalse(alive(int(record["agent"])), "the signing agent outlived the step")
            self.assertFalse(socket.exists(), "the agent socket outlived the step")
            self.assertFalse(socket.parent.exists(), "the socket directory outlived the step")
            probe = subprocess.run(["ssh-add", "-l"], cwd=fixture.repo, capture_output=True,
                                   env=dict(fixture.env, SSH_AUTH_SOCK=record["socket"]))
            self.assertEqual(probe.returncode, 2, "the same probe that reached the agent no longer does")
            # Git and its ssh client end on their own once the publisher is gone, as a
            # real client does on EOF; they get TRANSPORT_EXIT_S, the agent gets nothing.
            deadline = time.monotonic() + TRANSPORT_EXIT_S
            for pid in (record["pid"], record["parent"]):
                while alive(int(pid)) and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertFalse(alive(int(pid)), "a transport process outlived the step")
        leftovers = [row for row in processes() if not row[2].startswith("Z")
                     and (str(fixture.root) in row[3] or str(fixture.socket_base) in row[3])]
        self.assertEqual(leftovers, [], "a process of the step outlived it")
        group = [row for row in processes() if row[1] == str(fixture.process.pid) and not row[2].startswith("Z")]
        self.assertEqual(group, [], "a child of the step outlived it")
        self.assertEqual(set(os.listdir(fixture.runner_temp)), fixture.runner_entries,
                         "the step left files in RUNNER_TEMP")
        self.assertEqual(os.listdir(fixture.socket_base), [], "the step left files in TMPDIR")
        for name, path in fixture.commands.items():
            self.assertEqual(path.read_text(), "", name + " must not carry anything from this step")
        for path in fixture.root.rglob("*"):
            if path.is_file() and not path.is_symlink():
                self.assertNotIn(fixture.secret_body.encode(), path.read_bytes(), str(path))

    def assert_transport_isolated(self, record, fixture):
        config = record["config"]
        self.assertEqual(record["key_in_environment"], "", "the raw key reached the transport")
        self.assertEqual(record["signed"], "0", "the agent signs with the release identity")
        self.assertEqual(config.get("identityfile"), "none")
        self.assertEqual(config.get("identitiesonly"), "no")
        self.assertEqual(config.get("batchmode"), "yes")
        self.assertEqual(config.get("stricthostkeychecking"), "true")
        self.assertEqual(config.get("globalknownhostsfile"), "/dev/null")
        self.assertEqual(config.get("userknownhostsfile"), str(fixture.runner_temp / "release-known-hosts"))
        self.assertNotIn("proxycommand", config, "the host's ssh configuration reached the transport")

    def each_workflow(self, check):
        for path in WORKFLOWS:
            with self.subTest(workflow=str(path)):
                check(path)

    def test_success_publishes_through_git_ssh_and_releases_the_key(self):
        def check(path):
            fixture = self.fixture(path)
            fixture.start()
            status, output = fixture.finish()
            self.assertEqual(status, 0, output)
            self.assertEqual(fixture.remote_tag(), fixture.sha, output)
            transports = fixture.transports()
            self.assertTrue(transports, "Git never ran the configured ssh transport")
            for record in transports:
                self.assert_transport_isolated(record, fixture)
            self.assert_released(fixture)
        self.each_workflow(check)

    def test_rejected_push_fails_and_releases_the_key(self):
        def check(path):
            fixture = self.fixture(path)
            hook = fixture.remote / "hooks" / "pre-receive"
            hook.write_text("#!/bin/sh\necho refused by fixture >&2\nexit 1\n")
            hook.chmod(0o700)
            fixture.start()
            status, output = fixture.finish()
            self.assertEqual(status, 1, output)
            self.assertIsNone(fixture.remote_tag())
            self.assertTrue(fixture.transports(), output)
            self.assert_released(fixture)
        self.each_workflow(check)

    def test_unusable_key_fails_before_any_transport(self):
        def check(path):
            fixture = self.fixture(path, key="not a private key\n")
            fixture.start()
            status, output = fixture.finish()
            self.assertNotEqual(status, 0, output)
            self.assertEqual(fixture.transports(), [], output)
            self.assert_released(fixture)
        self.each_workflow(check)

    def cancel(self, path, sig, window):
        fixture = self.fixture(path)
        fixture.start(block=True)
        fixture.wait_ready()
        os.kill(fixture.process.pid, sig)  # the runner signals the step PID, not its group
        try:
            status, output = fixture.finish(timeout=window)
        except subprocess.TimeoutExpired:
            self.fail("the step did not stop within the runner's %.1f s window" % window)
        self.assertEqual(status, 128 + sig, output)
        self.assertIsNone(fixture.remote_tag())
        self.assert_released(fixture)

    def test_runner_cancellation_sigint_releases_the_key_within_its_window(self):
        def check(path):
            self.cancel(path, signal.SIGINT, RUNNER_SIGINT_WINDOW_S)
        self.each_workflow(check)

    def test_sigterm_releases_the_key_within_the_runner_window(self):
        def check(path):
            self.cancel(path, signal.SIGTERM, RUNNER_SIGTERM_WINDOW_S)
        self.each_workflow(check)

    def test_second_signal_during_release_does_not_cut_it_short(self):
        """The runner follows SIGINT with SIGTERM; a terminal may send two SIGINTs."""
        def check(path):
            fixture = self.fixture(path)
            fixture.start(block=True)
            fixture.wait_ready()
            os.kill(fixture.process.pid, signal.SIGINT)
            time.sleep(0.05)
            os.kill(fixture.process.pid, signal.SIGTERM)
            status, output = fixture.finish(timeout=RUNNER_SIGINT_WINDOW_S)
            self.assertEqual(status, 128 + signal.SIGINT, output)
            self.assert_released(fixture)
        self.each_workflow(check)

    def test_agent_that_ignores_sigterm_is_killed_and_fails_the_step(self):
        def check(path):
            fixture = self.fixture(path)
            hook = fixture.remote / "hooks" / "pre-receive"
            # A stopped agent cannot act on SIGTERM; SIGKILL still ends it.
            hook.write_text("#!/bin/sh\nkill -STOP \"$(cat \"$FIXTURE_LOG/agent-pid\")\"\nexit 0\n")
            hook.chmod(0o700)
            fixture.env["FIXTURE_RECORD_AGENT"] = "1"
            started = time.monotonic()
            fixture.start()
            status, output = fixture.finish()
            self.assertLess(time.monotonic() - started, RUNNER_SIGINT_WINDOW_S,
                            "the release must fit in the runner's cancellation window")
            self.assertEqual(status, 1, output)
            self.assertIn("::error::the signing agent did not stop on SIGTERM", output)
            self.assert_released(fixture)
        self.each_workflow(check)

    def test_killed_step_leaves_an_agent_that_stops_by_itself(self):
        """No step code runs after SIGKILL. The agent must be bound to the step's command."""
        def check(path):
            fixture = self.fixture(path)
            fixture.start(block=True)
            fixture.wait_ready()
            record = fixture.transports()[0]
            self.assertEqual(record["list"], "0")
            os.kill(fixture.process.pid, signal.SIGKILL)
            # The publisher and Git survive as orphans until the runner kills the tree;
            # fixture.cleanup plays that part. Only the agent must not wait for it.
            fixture.process.wait(timeout=5)
            deadline = time.monotonic() + OPENSSH_PARENT_CHECK_S + 2
            while alive(int(record["agent"])) and time.monotonic() < deadline:
                time.sleep(0.1)
            self.assertFalse(alive(int(record["agent"])), "the agent kept the key after the step was killed")
            probe = subprocess.run(["ssh-add", "-l"], capture_output=True,
                                   env=dict(fixture.env, SSH_AUTH_SOCK=record["socket"]))
            self.assertEqual(probe.returncode, 2)
        self.each_workflow(check)


if __name__ == "__main__":
    unittest.main()
