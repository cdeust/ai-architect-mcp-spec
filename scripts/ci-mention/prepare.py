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


def main():
    scratch = Path(os.environ["RUNNER_TEMP"])
    workspace = Path(os.environ["GITHUB_WORKSPACE"]) / "candidate"
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    issue = event["issue"]
    prompt = json.dumps({"title": issue["title"], "body": issue.get("body"),
                         "request": event.get("comment", {}).get("body", issue.get("body"))})
    broker = HERE / "node_modules/.bin/mcp-server-filesystem"
    cli = CONTROL / ".github/actions/claude-subscription-quota/node_modules/.bin/claude"
    with tempfile.TemporaryDirectory(dir=scratch) as root:
        config = {"mcpServers": {"workspace": {"command": str(broker),
                  "args": ["--confine-roots", str(workspace)]}}}
        command = [
            str(cli), "--print", "--model", "claude-opus-5-5", "--tools", "",
            "--strict-mcp-config", "--mcp-config", json.dumps(config),
            "--setting-sources", "", "--settings", '{"disableAllHooks":true}',
            "--disable-slash-commands", "--permission-mode", "dontAsk",
            "--no-session-persistence", "--allowedTools",
            ",".join("mcp__workspace__" + name for name in TOOLS),
            "--append-system-prompt",
            f"Act on the owner's request in {workspace} using the supplied file tools. "
            "A separate publisher submits your changes for review. Return your reply to the owner.",
        ]
        with (scratch / "proposal/answer.md").open("w") as answer:
            subprocess.run(command, cwd=root, input=prompt, text=True, stdout=answer, check=True,
                           env={"HOME": root, "PATH": os.environ["PATH"],
                                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                                "CLAUDE_CODE_OAUTH_TOKEN": os.environ["CLAUDE_CODE_OAUTH_TOKEN"]})


if __name__ == "__main__":
    main()
