"""Fail-closed policy for the shell of release jobs holding write or OIDC grants.

A narrow recognizer, not a Bash interpreter. It reads the script character by
character as Bash does (quotes, backslashes, comments, substitutions), accepts
only the constructs these scripts use, and refuses everything else.
test_ci_platform_release_security.py checks it against bash itself: every
command bash runs (xtrace) must be one the policy read.

The previous version rewrote the text before splitting it (a backslash-newline
was always removed, a line starting with "#" was always a comment) and guarded
the environment with a deny list. Both let a script run code the policy never
saw; see revues/spec-pr-399-gemini-delta-apres-fusion.md (B1 to B3).
"""

import re


class PolicyError(AssertionError):
    """A privileged script holds a construct the policy does not accept."""


# Variables a privileged script may set, with the only value some may take.
# Any other name, a runner variable such as NODE_OPTIONS or HTTPS_PROXY among
# them, is refused: the list is closed.
FIXED_VALUES = {"archive": "$RUNNER_TEMP/release.zip"}
ASSIGNABLE = {"archive", "endpoint", "run_id", "actual", "assets", "version", "prerelease",
              "commit", "VERSION", "PKG_VERSION", "IDENTIFIER", "ACTUAL", "EXPECTED", "OUTPUT",
              "STATUS", "MAX_ATTEMPTS", "SLEEP_SECONDS"}
# Loop variables and the words their list may hold.
LOOP_LISTS = {"file": re.compile(r"[\w.{},-]+"), "attempt": re.compile(r"\$\(seq 1 \"\$MAX_ATTEMPTS\"\)")}
PARAMETER = re.compile(r"[A-Za-z_]\w*(?:\[@\]|#v|%%\+\*|:-<none>)?")
ARITHMETIC = re.compile(r"\(\(\s*[A-Za-z_]\w* \* [A-Za-z_]\w*\s*\)\)")

class Word:
    """One shell word: its text with quotes removed and expansions kept as written."""

    def __init__(self):
        self.text, self.quoted, self.expands, self.subshells = "", False, False, []
        self.literal = None  # length of the unquoted, unexpanded prefix

    def mark(self):
        if self.literal is None:
            self.literal = len(self.text)

    def plain(self):
        return not self.quoted and not self.expands

    def assignment(self):
        """NAME=... where NAME= itself is unquoted, as Bash requires."""
        match = re.match(r"[A-Za-z_]\w*=", self.text)
        return bool(match) and (self.literal is None or match.end() <= self.literal)


def _expansion(source, i, word):
    """Read the expansion at source[i] == '$'; return the index after it."""
    nxt = source[i + 1:i + 2]
    if nxt == "(" and ARITHMETIC.match(source, i + 1):
        end = ARITHMETIC.match(source, i + 1).end()
        word.text += source[i:end]
    elif nxt == "(":
        # The substitution ends where lex, reading as Bash does (quotes,
        # comments, nested substitutions), finds its closing parenthesis.
        closed = []
        for _ in lex(source, i + 2, closed):
            pass
        if not closed:
            raise PolicyError("Unbalanced substitution in privileged script")
        end = closed[0]
        word.subshells.append(source[i + 2:end - 1])
        word.text += source[i:end]
    elif nxt == "{":
        end = source.index("}", i) + 1
        if not PARAMETER.fullmatch(source[i + 2:end - 1]):
            raise PolicyError(f"Unexpected parameter expansion: {source[i:end]}")
        word.text += source[i:end]
    elif re.match(r"[A-Za-z_?]", nxt):
        end = re.match(r"\?|[A-Za-z_]\w*", source[i + 1:]).end() + i + 1
        word.text += source[i:end]
    elif nxt in ("'", '"') or re.match(r"[\d@*#!$-]", nxt):
        raise PolicyError(f"Unexpected expansion in privileged script: {source[i:i + 2]!r}")
    else:
        word.text += "$"  # a "$" that starts no expansion is literal, as in ^[0-9]+$
        return i + 1
    word.mark()
    word.expands = True
    return end


def _double_quoted(source, i, word):
    """Read "..." starting after the opening quote; return the index after it."""
    while source[i] != '"':
        char = source[i]
        if char == "\\":
            if source[i + 1:i + 2] != "\n":
                raise PolicyError("Escape inside a double-quoted privileged word")
            i += 2
        elif char == "$":
            i = _expansion(source, i, word)
        elif char == "`":
            raise PolicyError("Backquote substitution in privileged script")
        else:
            word.text += char
            i += 1
        if i >= len(source):
            raise PolicyError("Unterminated double quote in privileged script")
    word.quoted = True
    return i + 1


OPERATORS = ("&&", "||", "<<<", ">>", ">&", ">", "|", ";", "\n", "(", ")")


def lex(source, start=0, closed=None):
    """Yield Word objects and operator strings, as Bash would split the script.

    With a list as closed, read the body of a command substitution opened just
    before start: stop at its closing parenthesis and append the index after it.
    """
    i, word = start, None
    while i < len(source):
        char = source[i]
        if char in " \t":
            if word is not None:
                yield word
                word = None
            i += 1
        elif char == "#" and word is None:
            i = source.find("\n", i) if "\n" in source[i:] else len(source)
        elif char == "\\":
            if source[i + 1:i + 2] != "\n":
                raise PolicyError("Unquoted escape in privileged script")
            i += 2  # a line continuation, and nothing else
        elif char == "'":
            end = source.find("'", i + 1)
            if end < 0:
                raise PolicyError("Unterminated single quote in privileged script")
            word = word or Word()
            word.mark()
            word.text, word.quoted, i = word.text + source[i + 1:end], True, end + 1
        elif char == '"':
            word = word or Word()
            word.mark()
            i = _double_quoted(source, i + 1, word)
        elif char == "$":
            word = word or Word()
            i = _expansion(source, i, word)
        elif char == "`":
            raise PolicyError("Backquote substitution in privileged script")
        elif char in "&|;<>()\n":
            operator = next((op for op in OPERATORS if source.startswith(op, i)), None)
            if operator is None:
                raise PolicyError(f"Unexpected shell operator: {source[i:i + 3]!r}")
            if word is not None and operator in (">", ">>", ">&") and re.fullmatch(r"\d", word.text) and word.plain():
                word = None  # an I/O number (2>&1) belongs to its redirection, checked below
            if word is not None:
                yield word
                word = None
            if closed is not None and operator == ")":
                # The first ")" closes it: inside, "(" can only open an array
                # literal, which commands() then finds unclosed and refuses.
                closed.append(i + 1)
                return
            yield operator
            i += len(operator)
        else:
            word = word or Word()
            word.text += char
            i += 1
    if word is not None:
        yield word


RESERVED = {"if", "then", "else", "elif", "fi", "do", "done", "{", "}", "!"}
REDIRECTIONS = {">", ">>", ">&", "<<<"}
# (command, operator, destination) a data reader may write. $archive and ./$file
# are safe only because their values are fixed (FIXED_VALUES, LOOP_LISTS).
OUTPUTS = {("gh", ">", "$archive"), ("gh", ">", "server.json"), ("unzip", ">", "./$file"),
           ("jq", ">", "server.runtime.json"), ("echo", ">>", "$GITHUB_OUTPUT"),
           ("printf", ">>", "$GITHUB_OUTPUT")}


def commands(tokens):
    """Group tokens into simple commands: (words, redirections, array literal)."""
    words, redirects, pending, in_test = [], [], None, False
    tokens = list(tokens)
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if isinstance(token, Word):
            if pending:
                redirects.append((pending, token))
                pending = None
            else:
                in_test = in_test or (token.plain() and token.text == "[[")
                in_test = in_test and not (token.plain() and token.text == "]]")
                words.append(token)
        elif token in REDIRECTIONS:
            pending = token
        elif token in ("&&", "||") and in_test:
            words.append(Word())
            words[-1].text = token
        elif token == "(":
            if not (words and words[-1].assignment() and words[-1].text.endswith("=")):
                raise PolicyError("Subshell or grouping in privileged script")
            if ")" not in tokens[i:]:
                raise PolicyError("Unclosed array literal in privileged script")
            end = tokens.index(")", i)
            words[-1].array = tokens[i + 1:end]
            i = end
        elif token == ")":
            raise PolicyError("Unbalanced parenthesis in privileged script")
        else:
            if pending:
                raise PolicyError("Redirection without a destination in privileged script")
            yield words, redirects
            words, redirects = [], []
        i += 1
    if pending:
        raise PolicyError("Redirection without a destination in privileged script")
    yield words, redirects


def check_assignment(word):
    name, _, value = word.text.partition("=")
    if name not in ASSIGNABLE:
        raise PolicyError(f"Privileged shell sets a variable outside its list: {name}")
    if name in FIXED_VALUES and value != FIXED_VALUES[name]:
        raise PolicyError(f"Privileged shell gives {name} another value: {value}")
    for element in getattr(word, "array", []):
        if not (isinstance(element, Word) and re.fullmatch(r"[\w.{},-]+", element.text)):
            raise PolicyError(f"Unexpected array element: {element}")


def check_loop(words):
    """for NAME in LIST: the name is a loop variable and the list its fixed words."""
    if len(words) < 3 or words[2].text != "in" or words[1].text not in LOOP_LISTS:
        raise PolicyError(f"Unexpected loop in privileged script: {[w.text for w in words]}")
    for item in words[3:]:
        if not LOOP_LISTS[words[1].text].fullmatch(item.text):
            raise PolicyError(f"Unexpected loop list: {item.text}")


def check_redirects(command, redirects):
    for operator, destination in redirects:
        if operator == ">&" and destination.text in ("1", "2") and destination.plain():
            continue
        if operator == "<<<" and command == "grep":
            continue
        if destination.text != "/dev/null" and (command, operator, destination.text) not in OUTPUTS:
            raise PolicyError(f"Unexpected privileged output: {command} {operator} {destination.text}")


def check_simple(words, redirects):
    """One simple command; returns its command name, or None for a bare keyword."""
    while words and words[0].plain() and words[0].text in RESERVED:
        words = words[1:]
    while words and words[0].assignment():
        check_assignment(words[0])
        words = words[1:]
    if not words:
        check_redirects(None, redirects)
        return None
    if not words[0].plain():
        raise PolicyError(f"Unexpected command word in privileged script: {words[0].text}")
    command, args = words[0].text, [w.text for w in words[1:]]
    if command == "for":
        check_loop(words)
        return command
    check_redirects(command, redirects)
    if not allowed(command, args):
        raise PolicyError(f"Unexpected command on a privileged release runner: {[command, *args]}")
    return command


PLAIN_COMMANDS = {"[", "[[", "cat", "cmp", "cut", "echo", "exit", "seq", "sha256sum", "shasum", "sleep"}
CURL = (["-fsSLO", "https://github.com/modelcontextprotocol/registry/releases/download/"
                   "${MCP_PUBLISHER_VERSION}/mcp-publisher_linux_amd64.tar.gz"],
        ["-fsSL", "https://registry.modelcontextprotocol.io/v0/servers?search=ai-architect-mcp-spec"])
ATTESTATION_FLAGS = {"--repo", "--signer-workflow", "--source-ref", "--source-digest"}


def allowed_jq(args):
    """jq reads a filter and data files; no option may load a program or a file."""
    i = 0
    while i < len(args) and args[i].startswith("-"):
        if args[i] == "--arg" and i + 2 < len(args):
            i += 3
        elif args[i] in ("-r", "-e", "-j", "-ej"):
            i += 1
        else:
            return False
    return i < len(args) and not any(arg.startswith("-") for arg in args[i:])


def allowed_gh(args):
    if args[:2] == ["release", "download"]:
        return args[2:] == ["$TAG", "--repo", "$REPOSITORY", "--pattern", "ai-architect-mcp-spec.mcpb",
                            "--pattern", "ai-architect-mcp-spec.mcpb.sha256"]
    if args[:1] == ["api"]:
        # Read only: no method, field or input option, one endpoint, Accept and --jq.
        rest = args[1:]
        if rest[:2] == ["-H", "Accept: application/vnd.github.raw+json"]:
            rest = rest[2:]
        if len(rest) == 3 and rest[1] == "--jq":
            rest = rest[:1]
        return len(rest) == 1 and not rest[0].startswith("-")
    if args[:2] == ["attestation", "verify"]:
        flags = args[3::2]
        return len(args) % 2 == 1 and set(flags) <= ATTESTATION_FLAGS and not args[2].startswith("-")
    return args[:1] == ["release"] and args[1:2] in (["create"], ["edit"], ["upload"], ["view"])


def allowed(command, args):
    if command in PLAIN_COMMANDS:
        return True
    if command == "set":
        return args in (["-e"], ["+e"], ["-euo", "pipefail"], ["-euxo", "pipefail"])
    if command == "printf":
        return bool(args) and not args[0].startswith("-")
    if command == "grep":
        return args[:1] == ["-qi"] and len(args) == 2
    if command == "jq":
        return allowed_jq(args)
    if command == "awk":
        return args == ["{print $1}"]
    if command == "unzip":
        return args == ["-p", "$archive", "$file"]
    if command == "gh":
        return allowed_gh(args)
    if command == "curl":
        return args in CURL
    if command == "tar":
        return args == ["xzf", "mcp-publisher_linux_amd64.tar.gz", "mcp-publisher"]
    if command == "chmod":
        return args == ["+x", "mcp-publisher"]
    if command == "./mcp-publisher":
        return args in (["login", "github-oidc"], ["publish", "server.runtime.json"])
    return False


def check_privileged_script(source):
    """Refuse the script unless every command in it, substitutions included, is allowed.

    Returns the names of the commands read, for the differential check against bash.
    """
    names = []
    for words, redirects in commands(lex(source)):
        for word in [*words, *(destination for _, destination in redirects)]:
            for inner in word.subshells:
                names += check_privileged_script(inner)
        name = check_simple(words, redirects)
        if name:
            names.append(name)
    return names
