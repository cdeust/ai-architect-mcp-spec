"""Select a subscription for GitHub code review, without generating tokens.

OpenAI backend client: codex-rs/backend-client/src/client/rate_limit_resets.rs
in openai/codex. The nullable code_review_rate_limit field was observed on
the subscription endpoint on 2026-11-22. Never substitute the CLI rate_limit.
"""
import http.client
import json
import os
import sys
import time


class QuotaError(ValueError):
    """Only these fixed diagnostics can appear in CI logs."""


def review_remaining(payload, account, now):
    if not account or payload.get("account_id") != account:
        raise QuotaError("OpenAI usage did not identify the configured review account")
    limit = payload.get("code_review_rate_limit")
    if limit is None:
        return None
    if not isinstance(limit, dict):
        raise QuotaError("Invalid OpenAI review limit")
    allowed, reached = limit.get("allowed"), limit.get("limit_reached")
    if type(allowed) is not bool or type(reached) is not bool:
        raise QuotaError("Invalid OpenAI review availability")
    if not allowed or reached:
        return 0
    remaining = []
    for name in ("primary_window", "secondary_window"):
        window = limit.get(name)
        if window is None:
            continue
        if not isinstance(window, dict):
            raise QuotaError("Invalid OpenAI review window")
        used, reset = window.get("used_percent"), window.get("reset_at")
        if type(used) is not int or not 0 <= used <= 100 or type(reset) is not int or reset <= now:
            raise QuotaError("Invalid or stale OpenAI review window")
        remaining.append(100 - used)
    if not remaining:
        return None
    if min(remaining) == 0:
        return 0
    credits = payload.get("credits") or {}
    if (payload.get("plan_type") not in {"plus", "pro", "prolite", "promax"}
            or credits.get("has_credits") is not False or credits.get("unlimited") is not False):
        return None
    return min(remaining)


def openai_remaining(token, account):
    if not token and not account:
        return None
    if not token or not account:
        raise QuotaError("OpenAI quota access requires both the bearer and linked account")
    # Fixed TLS origin. No redirects, model requests, credit purchases or resets.
    connection = http.client.HTTPSConnection("chatgpt.com", timeout=15)
    try:
        connection.request("GET", "/backend-api/wham/usage", headers={
            "Authorization": "Bearer " + token, "ChatGPT-Account-Id": account,
            "Accept": "application/json",
        })
        response = connection.getresponse()
        if response.status != 200:
            raise QuotaError(f"OpenAI usage returned HTTP {response.status}")
        return review_remaining(json.load(response), account, time.time())
    finally:
        connection.close()


def select(claude, eligible, codex):
    if eligible not in {"true", "false"}:
        raise QuotaError("Invalid Claude admission")
    if claude == "unknown":
        if eligible == "true":
            raise QuotaError("Unmeasured Claude quota cannot be eligible")
    else:
        if not claude.isascii() or not claude.isdecimal() or not 0 <= int(claude) <= 100:
            raise QuotaError("Invalid Claude remaining quota")
        if eligible == "true" and int(claude) == 0:
            raise QuotaError("Inconsistent Claude admission")
    # A running or completed native review was already admitted by OpenAI.
    # With no measurable OpenAI percentage it may be reused only when Claude
    # is excluded. Never request new usage or rank an unknown as zero.
    if codex is None:
        if eligible == "false":
            return "codex-existing"
        return "claude"  # The only measured eligible subscription.
    if codex > 0 and (eligible == "false" or codex >= int(claude)):
        return "codex"
    if eligible == "true":
        return "claude"
    raise QuotaError("Neither review subscription is eligible")


def main():
    env = os.environ
    codex = openai_remaining(env.get("CODEX_REVIEW_USAGE_TOKEN"), env.get("CODEX_REVIEW_ACCOUNT_ID"))
    reviewer = select(env["CLAUDE_REMAINING"], env["CLAUDE_ELIGIBLE"], codex)
    with open(env["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        print("reviewer=" + reviewer, file=output)
    print("GitHub reviewer:", reviewer)


if __name__ == "__main__":
    try:
        main()
    except QuotaError as error:
        sys.exit(str(error))
    except (ValueError, TypeError, AttributeError, OSError, http.client.HTTPException):
        sys.exit("Unable to read OpenAI subscription usage")
