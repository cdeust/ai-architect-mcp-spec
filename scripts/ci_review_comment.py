"""PreToolUse guard for the pinned GitHub MCP's add_issue_comment tool."""

import json
from pathlib import Path
import re
import sys
import unicodedata


def permitted(call, context):
    owner, repo = context["repo"].split("/")
    data = call["tool_input"]
    if (call["tool_name"] != "mcp__github__add_issue_comment"
            or (data["owner"], data["repo"], data["issue_number"]) != (owner, repo, context["pr"])):
        return False
    body = data["body"]
    visible = unicodedata.normalize("NFKC", "".join(c for c in body if unicodedata.category(c) != "Cf"))
    if re.search(r"@[a-zA-Z0-9]|sk-ant-|github_pat_|gh[opsur]_[a-zA-Z0-9]{20,}", visible):
        return False
    link = f"[View job run]({context['link']})"
    lines = body.strip().split("\n")
    return (lines[-3:-1] == [f"Reviewed commit: {context['sha']}", link]
            and lines[-1] in ("Verdict: approve", "Verdict: block")
            and len(re.findall(r"^\s*verdict\s*:", visible, re.I | re.M)) == 1)


def main():
    try:
        context = json.loads(Path("/etc/claude-code/review-context.json").read_bytes())
        allowed = permitted(json.load(sys.stdin), context)
    except (KeyError, OSError, TypeError, ValueError):
        allowed = False
    if not allowed:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
              "permissionDecision": "deny", "permissionDecisionReason": "Use this PR, exact commit and attempt footer, without mentions or credentials."}}))


if __name__ == "__main__":
    main()
