"""Run the model with file operations confined to the credential-free candidate."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
CONTROL = HERE.parents[1]
TOOLS = (
    "list_directory", "search_files", "read_text_file", "edit_file",
    "write_file", "create_directory", "move_file",
)


# --allowedTools pre-approves calls. The pinned CLI removes denied tools from
# the advertised catalog. The filesystem broker version is locked in this directory.
UNUSED_TOOLS = (
    "append_file", "copy_file", "directory_tree", "get_file_info",
    "list_allowed_directories", "list_directory_with_sizes", "read_file",
    "read_media_file", "read_multiple_files",
)


def main():
    scratch = Path(os.environ["RUNNER_TEMP"])
    workspace = Path(os.environ["GITHUB_WORKSPACE"]) / "candidate"
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    issue = event["issue"]
    # Earlier owner comments, read with the read-only token before this step.
    thread = json.loads((scratch / "owner-thread.json").read_text())
    prompt = json.dumps({"title": issue["title"], "body": issue.get("body"), "owner_comments": thread,
                         "request": event.get("comment", {}).get("body", issue.get("body"))})
    broker = HERE / "node_modules/.bin/mcp-server-filesystem"
    cli = CONTROL / ".github/actions/claude-subscription-quota/node_modules/.bin/claude"
    with tempfile.TemporaryDirectory(dir=scratch) as root:
        config = {"mcpServers": {"candidate_files": {"command": str(broker),
                  "args": ["--confine-roots", str(workspace)]}}}
        command = [
            str(cli), "--print", "--model", "claude-opus-5-5", "--tools", "",
            "--strict-mcp-config", "--mcp-config", json.dumps(config),
            "--setting-sources", "", "--settings", '{"disableAllHooks":true,"disableClaudeAiConnectors":true}',
            "--disable-slash-commands", "--permission-mode", "dontAsk",
            "--no-session-persistence", "--allowedTools",
            ",".join("mcp__candidate_files__" + name for name in TOOLS),
            "--disallowedTools", ",".join("mcp__candidate_files__" + name for name in UNUSED_TOOLS),
            "--append-system-prompt",
            f"Act on the owner's request in {workspace} using the supplied file tools. "
            "A separate publisher submits your changes for review. Return your reply to the owner.",
        ]
        with (scratch / "proposal/answer.md").open("w") as answer:
            subprocess.run(command, cwd=root, input=prompt, text=True, stdout=answer, check=True,
                           env={"HOME": root, "PATH": os.environ["PATH"],
                                "ENABLE_TOOL_SEARCH": "false",
                                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                                "CLAUDE_CODE_OAUTH_TOKEN": os.environ["CLAUDE_CODE_OAUTH_TOKEN"]})


if __name__ == "__main__":
    main()
