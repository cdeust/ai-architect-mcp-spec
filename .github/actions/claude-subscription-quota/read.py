import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

class Inconclusive(Exception):
    pass


class TerminalUnavailable(Exception):
    """Only the tmux operation name and exit code may be written to the receipt."""


def measure(token, receipt):
    # The first terminal on run 45021598029 failed before returning any
    # measurement. A new terminal on 45021610848 read the weekly window.
    for attempt in (1, 2):
        receipt["terminal_attempts"] = attempt
        try:
            with tempfile.TemporaryDirectory(prefix="quota-", dir="/tmp") as temp:
                return read_usage(Path(temp), token)
        except TerminalUnavailable as error:
            receipt["terminal_failure"] = str(error)
            if attempt == 2:
                raise Inconclusive("native_cli_or_terminal_failed") from None

def read_usage(home, token):
    workspace = home / "empty-workspace"
    workspace.mkdir()
    # The child receives only the existing bot OAuth credential.
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(home),
        "TERM": "xterm-256color",
        "LANG": "C.UTF-8",
        "TZ": "UTC",
        "CLAUDE_CODE_OAUTH_TOKEN": token,
        "DISABLE_AUTOUPDATER": "1",
        "DISABLE_TELEMETRY": "1",
    }
    # Trust is scoped to this empty directory, never to HOME or
    # checked-out code. Claude Code does not persist trust for HOME.
    # https://github.com/anthropics/claude-code/issues/71562
    (home / ".claude.json").write_text(json.dumps({
        "hasCompletedOnboarding": True,
        "theme": "dark",
        "projects": {str(workspace): {"hasTrustDialogAccepted": True}},
    }))
    auth = subprocess.run(
        ["claude", "auth", "status"], cwd=home, env=env,
        capture_output=True, text=True, timeout=20,
    )
    if auth.returncode:
        raise Inconclusive("authentication_status_failed")
    try:
        status = json.loads(auth.stdout)
    except ValueError:
        raise Inconclusive("unrecognized_authentication_status") from None
    if (status.get("loggedIn") is not True
            or status.get("authMethod") != "oauth_token"
            or status.get("apiProvider") != "firstParty"):
        raise Inconclusive("expected_first_party_oauth_not_confirmed")

    socket = str(home / "tmux")

    def tmux(*args):
        try:
            return subprocess.run(
                ["tmux", "-f", "/dev/null", "-S", socket, *args],
                env=env, cwd=workspace, capture_output=True, text=True, check=True,
            ).stdout
        except subprocess.CalledProcessError as error:
            raise TerminalUnavailable(f"{args[0]} exit {error.returncode}") from None

    def wait_for(predicate, reason):
        # A slow or unfamiliar screen is inconclusive.
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            screen = tmux("capture-pane", "-p", "-t", "quota")
            if "API Usage Billing" in screen or "Claude Console" in screen:
                raise Inconclusive("ambiguous_subscription_and_console_billing")
            if predicate(screen):
                return screen
            time.sleep(0.25)
        raise Inconclusive(reason)

    try:
        tmux("new-session", "-d", "-x", "120", "-y", "45", "-s", "quota",
             "claude", "--safe-mode", "--strict-mcp-config", "--mcp-config",
             '{"mcpServers":{}}', "--tools", "", "--setting-sources", "",
             "--settings", '{"disableAllHooks":true}', "--permission-mode", "plan")
        def prompt_ready(screen):
            return ("Claude Code" in screen and "Safe mode:" in screen
                    and any(line.strip() == "❯" for line in screen.splitlines()))

        wait_for(prompt_ready, "native_prompt_not_recognized")
        tmux("send-keys", "-l", "-t", "quota", "/usage")
        wait_for(lambda s: "Show session cost, plan usage" in s,
                 "native_usage_completion_not_recognized")
        tmux("send-keys", "-t", "quota", "Enter")

        def usage_panel(screen):
            if "Refreshing usage" in screen:
                return False
            if ("No usage limits to show for this sign-in." in screen
                    and "https://claude.ai/settings/usage" in screen):
                raise Inconclusive("oauth_sign_in_exposes_no_usage_limits")
            return "Estimated cost" in screen and "Current week (all models)" in screen

        screen = wait_for(
            usage_panel,
            "subscription_usage_panel_missing",
        )
        credits = re.findall(r"Usage credits are (off|on)\b", screen)
        credits_state = credits[0] if len(credits) == 1 else "unknown"
        zero_use = bool(re.search(r"Total duration \(API\):\s+0s\b", screen)
                        and re.search(r"\b0 input, 0 output\b", screen))
        measurement = {
            "usage_credits": credits_state,
            "zero_model_usage_verified": zero_use,
        }
        # Subscription windows and a gateway spend_limit have different meanings.
        # https://code.claude.com/docs/en/statusline#spend-limit-fields
        def window(label):
            lines = re.findall(rf"^ *{re.escape(label)}[^\S\n]*\n([^\n]*)", screen, re.MULTILINE)
            if len(lines) != 1:
                return None
            # The pinned terminal uses Unicode block elements for the progress bar.
            value = re.fullmatch(r"[\s\u2580-\u259f]*([0-9]{1,3})% used\s*", lines[0])
            return int(value[1]) if value and int(value[1]) <= 100 else None

        weekly = window("Current week (all models)")
        if weekly is None:
            return {**measurement, "status": "inconclusive",
                    "reason": "weekly_all_models_percentage_not_recognized"}
        measurement.update(status="weekly_quota_read", weekly_all_models_used_percent=weekly,
                           current_session_used_percent=window("Current session"))
        reset = re.search(
            r"Current week \(all models\)[^\n]*\n[^\n]*% used[^\n]*\n"
            r"[^\S\n]*Resets ([A-Z][a-z]{2} \d{1,2} at \d{1,2}(?::\d{2})?"
            r"(?:am|pm)(?: \([A-Za-z0-9_+/-]+\))?)\s*$",
            screen, re.MULTILINE,
        )
        measurement["weekly_reset_display"] = reset[1] if reset else None
        measurement["charging_guard_passed"] = credits_state == "off" and zero_use
        return measurement
    finally:
        try:
            tmux("kill-server")
        except TerminalUnavailable:
            pass

def remaining_percent(receipt):
    """A full window excludes the account even if another applicable window is unknown."""
    if receipt.get("status") != "weekly_quota_read" or not receipt["zero_model_usage_verified"]:
        return None
    windows = [receipt["weekly_all_models_used_percent"], receipt["current_session_used_percent"]]
    if 100 in windows:
        return 0
    if None in windows:
        return None
    return 100 - max(windows)


def main():
    receipt = {
        "sha": os.environ["GITHUB_SHA"],
        "run_id": os.environ["GITHUB_RUN_ID"],
        "cli_version": "2.1.328",
    }
    try:
        token = os.environ.pop("CLAUDE_CODE_OAUTH_TOKEN", "")
        if not token:
            raise Inconclusive("missing_ci_oauth_secret")
        receipt.update(measure(token, receipt))
    except Inconclusive as failure:
        receipt.update(status="inconclusive", reason=str(failure))
    except (OSError, subprocess.SubprocessError):
        receipt.update(status="inconclusive", reason="native_cli_or_terminal_failed")
    remaining = remaining_percent(receipt)
    receipt["remaining_percent"] = remaining
    eligible = remaining is not None and remaining > 0 and receipt["charging_guard_passed"]
    receipt["review_eligible"] = eligible
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        print("remaining=" + ("unknown" if remaining is None else str(remaining)), file=output)
        print(f"eligible={str(eligible).lower()}", file=output)
    print(json.dumps(receipt, sort_keys=True))
    # This job measures quota before generation. Review admission is a separate decision.
    raise SystemExit(receipt["status"] != "weekly_quota_read" or not receipt["zero_model_usage_verified"])


if __name__ == "__main__":
    main()
