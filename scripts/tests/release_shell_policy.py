"""Check the small set of shell operations allowed on release runners with write access.

This is a fail-closed policy for this workflow, not a general Bash interpreter.
Inspect command substitutions, pipelines and conditional branches without running them.
"""

import re
import shlex


def execution_env(name):
    return re.match(r"(?:PATH$|IFS$|ENV$|SHELLOPTS$|BASH|LD_|DYLD_|GITHUB_|GIT_CONFIG|GH_CONFIG|GH_HOST$)", name)


def check_command(words):
    words = list(words)
    while words and words[0] in {"if", "then", "else", "do", "{", "!"}:
        words.pop(0)
    while words and re.fullmatch(r"[A-Za-z_]\w*=.*", words[0], re.S):
        name = words.pop(0).partition("=")[0]
        if execution_env(name):
            raise AssertionError(f"Privileged shell changes its execution environment: {name}")
    if not words:
        return
    command, *args = words
    if command in {"}", "done", "fi"} and not args:
        return
    if command == "for" and len(args) >= 2 and args[1] == "in":
        return
    # A data reader must not be able to overwrite the publisher or a runner
    # startup file that a later command will execute.
    for i, arg in enumerate(args):
        if arg in {">", ">>"}:
            destination = args[i+1] if i+1 < len(args) else ""
            if not (destination == "/dev/null"
                    or (command, arg, destination) in (
                        ("gh", ">", "$archive"), ("gh", ">", "server.json"),
                        ("unzip", ">", "./$file"), ("jq", ">", "server.runtime.json"),
                        ("echo", ">>", "$GITHUB_OUTPUT"), ("printf", ">>", "$GITHUB_OUTPUT"))):
                raise AssertionError(f"Unexpected privileged output: {words}")
        elif arg == ">&" and args[i + 1:i + 2] not in (["1"], ["2"]):
            raise AssertionError(f"Unexpected descriptor redirection: {words}")
    if command == "set" and args in (["-e"], ["+e"], ["-euo", "pipefail"], ["-euxo", "pipefail"]):
        return
    if command == "printf" and args and not args[0].startswith("-"):
        return
    if command in {"[", "[[", "cat", "cmp", "cut", "echo", "exit", "grep",
                   "seq", "sha256sum", "shasum", "sleep"}:
        return
    if command == "jq" and args and args[0] in {"-r", "-ej", "--arg"} and not any(
        arg.startswith(("-f", "--from-file", "-L", "--run-tests")) for arg in args
    ):
        return
    if command == "awk" and args == ["{print $1}"]:
        return
    if command == "unzip" and args[:1] == ["-p"]:
        return
    if command == "gh" and args:
        if args[:2] == ["release", "download"]:
            if args[2:5] == ["$TAG", "--repo", "$REPOSITORY"] and args[5:] == [
                "--pattern", "ai-architect-mcp-spec.mcpb", "--pattern", "ai-architect-mcp-spec.mcpb.sha256",
            ]:
                return
            raise AssertionError(f"Unexpected public release downloads: {words}")
        if (args[0] == "api" or args[:2] == ["attestation", "verify"]
                or (args[0] == "release" and len(args) >= 2
                    and args[1] in {"create", "edit", "upload", "view"})):
            return
    if command == "curl" and args in (
        ["-fsSLO", "https://github.com/modelcontextprotocol/registry/releases/download/"
                   "${MCP_PUBLISHER_VERSION}/mcp-publisher_linux_amd64.tar.gz"],
        ["-fsSL", "https://registry.modelcontextprotocol.io/v0/servers?search=ai-architect-mcp-spec"],
    ):
        return
    if command == "tar" and args == ["xzf", "mcp-publisher_linux_amd64.tar.gz", "mcp-publisher"]:
        return
    if command == "chmod" and args == ["+x", "mcp-publisher"]:
        return
    if command == "./mcp-publisher" and args in (
        ["login", "github-oidc"], ["publish", "server.runtime.json", "2", ">&", "1"],
    ):
        return
    raise AssertionError(f"Unexpected command on a privileged release runner: {words}")


def check_privileged_script(source):
    source = source.replace("\\\n", "")
    source = "\n".join(line for line in source.splitlines() if not line.lstrip().startswith("#"))
    # A literal Bash array is data. Leave any other parentheses visible below.
    source = re.sub(r"(?m)^(\s*\w+)=\(([\w.,{}-]+)\)$", r"\1=\2", source)
    lexer = shlex.shlex(source, posix=True, punctuation_chars="();|&<>\n")
    lexer.whitespace = " \t"
    lexer.whitespace_split = True
    lexer.commenters = ""
    command = []
    for word in lexer:
        # A substitution within a quoted word would be opaque to shlex. The
        # only arithmetic expansion here is the numeric retry window in a log.
        literal = re.sub(r"\$\(\(\w+ \* \w+\)\)", "", word)
        if "$(" in literal or chr(96) in literal:
            raise AssertionError(f"Opaque shell expansion in privileged command: {word}")
        if re.fullmatch(r"[();|&<>\n]+", word) and re.search("[<>]", word) and word not in {">", ">>", ">&", "<<<"}:
            raise AssertionError(f"Unexpected privileged shell redirection: {word}")
        if word == "&&" and "[[" in command and "]]" not in command:
            command.append(word)
        elif re.fullmatch(r"[();|&\n]+", word):
            check_command(command)
            command = []
        else:
            command.append(word)
    check_command(command)
