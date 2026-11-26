#!/usr/bin/env python3
"""Validation, neutralisation and publication of the advisory Claude security review.

`publish` (called by scripts/ci_security_review.py) validates the model's JSON
(structured_output, schema SCHEMA, the one the engine receives), withholds every finding
that holds the shape of a credential, keeps the findings at or above the confidence bar,
and posts one comment. The model itself publishes nothing.
Paths are shown as ASCII escapes in code spans; prose fields are cut to their bound
after normalisation and shown as one code span each, so nothing the model writes
renders, mentions, references or starts a line. Design: docs/claude-security-review.md.

Source: https://docs.github.com/en/rest/issues/comments#create-an-issue-comment
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ci_review_budget import GH_TIMEOUT_SECONDS, BudgetError, Record  # noqa: E402

MARKER = "Claude security review (advisory)"
# source: the upstream filter keeps confidence 8 or more out of 10
# (claude-code-security-review .claude/commands/security-review.md, step 3).
MIN_CONFIDENCE = 8
# source: size bounds. The model's JSON reaches `publish` as one environment string,
# which Linux caps at MAX_ARG_STRLEN, 128 KiB (execve(2)); at most
# 8 x (3 x 500 + 200 + 80 + 10) + 1000 characters, 6 bytes each once JSON-escaped in
# the worst case, is about 90 KiB, plus about 1 KiB of keys. This holds only if the
# engine enforces the schema's bounds; publish cuts prose to them but cannot shrink an
# environment string that never reached it. The comment stays under COMMENT_LIMIT, below
# GitHub's 65,536 characters, by dropping whole findings (render).
MAX_FINDINGS = 8
MAX_TEXT = 500
MAX_SUMMARY = 1000
MAX_PATH = 200
MAX_CATEGORY = 80
# source: operational bound, far above any source file's line count.
MAX_LINE = 10_000_000
COMMENT_LIMIT = 60_000
# The "N finding(s) not shown" line, added after the room check, is under 100
# characters; twice that keeps the limit with margin (test: the drop-margin sweep).
DROP_NOTE_RESERVE = 200
SEVERITIES = ("HIGH", "MEDIUM")
# A relative path of non-empty segments: no leading "/", "~" or drive letter, no
# "://", no "." or ".." segment, no empty segment, no whitespace at a segment's ends,
# no backslash, backtick, tab or line break ("//" also refuses "://"). Shown as ASCII with
# escapes (display_path), so no look-alike or invisible character can pass for "/" or
# "..". The engine's JSON Schema validator (JavaScript, if it enforces `pattern` at all)
# reads this pattern more loosely around U+2028 and Unicode spaces; publish re-checks
# every path in Python, which is the gate.
PATH_PATTERN = (
    r"^(?![A-Za-z]:)(?!~)(?!/)(?!.*//)(?!.*/$)"
    r"(?!(?:.*/)?\.{1,2}(?:/|$))(?!(?:.*/)?\s)(?!.*\s(?:/|$))[^\\`\n\r\t]+$"
)
CATEGORY_PATTERN = r"^[a-z][a-z0-9_]*$"
# Prose must hold a visible character: the schema says so, and publish refuses the same.
TEXT_PATTERN = r"\S"
# The shape of a credential, read after canonical() and with every space removed, so a
# format character or a space cannot split one: Claude Console keys and OAuth tokens
# (sk-ant-) and GitHub tokens (ghp_, gho_, ghs_, ghu_, ghr_, github_pat_). The rule of
# architect-os's comment guard (PR 146), so the two repositories refuse the same.
# source: https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/
CREDENTIAL = re.compile(r"sk-ant-[A-Za-z0-9_-]{8,}|gh[opsur]_[A-Za-z0-9]{20,}"
                        r"|github_pat_[A-Za-z0-9_]{20,}")
WITHHELD_SUMMARY = "(withheld: the summary held the shape of a credential)"


def _string(limit: int, pattern: str | None = None) -> Record:
    schema = {"type": "string", "minLength": 1, "maxLength": limit}
    if pattern:
        schema["pattern"] = pattern
    return schema


SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["findings", "summary"],
    "properties": {
        "summary": _string(MAX_SUMMARY, TEXT_PATTERN),
        "findings": {
            "type": "array",
            "maxItems": MAX_FINDINGS,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["file", "line", "severity", "category", "description",
                             "exploit_scenario", "recommendation", "confidence"],
                "properties": {
                    "file": _string(MAX_PATH, PATH_PATTERN),
                    "line": {"type": "integer", "minimum": 0, "maximum": MAX_LINE},
                    "severity": {"type": "string", "enum": list(SEVERITIES)},
                    "category": _string(MAX_CATEGORY, CATEGORY_PATTERN),
                    "description": _string(MAX_TEXT, TEXT_PATTERN),
                    "exploit_scenario": _string(MAX_TEXT, TEXT_PATTERN),
                    "recommendation": _string(MAX_TEXT, TEXT_PATTERN),
                    "confidence": {"type": "integer", "minimum": 1, "maximum": 10},
                },
            },
        },
    },
}
# `@codex review` posted by github-actions[bot] is this repository's Codex request
# channel (scripts/ci_review_codex.py); a "Verdict:" line is what the resolver reads.
VERDICT = re.compile(r"^(\s*)Verdict:", re.MULTILINE | re.IGNORECASE)
REFERENCE = re.compile(r"#(?=\d)")
# Every line ending CommonMark or Python's str.splitlines knows, made one "\n".
LINE_BREAKS = re.compile("\r\n|[\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]")
ZERO_WIDTH = "\u200b"


def canonical(text: str) -> str:
    """Prose as the comment will show it: NFKC, one line ending, no control, format,
    combining, surrogate, private-use or unassigned character. Paths never go through
    this: they are shown escaped."""
    text = unicodedata.normalize("NFKC", text)
    text = LINE_BREAKS.sub("\n", text)
    return "".join(ch for ch in text if ch in "\n\t" or unicodedata.category(ch)
                   not in {"Cc", "Cf", "Mn", "Me", "Cs", "Co", "Cn"})


# Characters a path may hold that the comment must not act on (a mention, a reference,
# an entity, HTML, a link): shown as JSON escapes too. A raw backslash is refused in
# paths, so "\u0040" can only be this escape.
PATH_ESCAPES = {ch: f"\\u{ord(ch):04x}" for ch in "@#&<>[]"}


def display_path(path: str) -> str:
    """The path as the comment shows it: ASCII, every character outside printable ASCII
    and every character of PATH_ESCAPES as a JSON escape, so what is shown is what the
    model named, look-alikes included, and nothing in it acts."""
    return "".join(PATH_ESCAPES.get(ch, ch) for ch in json.dumps(path)[1:-1])


def credential(text: str) -> bool:
    """Whether the text holds the shape of a credential, however it is spaced or hidden."""
    return CREDENTIAL.search("".join(canonical(text).split())) is not None


def neutral(text: str) -> str:
    """Text for a code span: no backtick (it would close the span), no mention, no
    `#<digit>` reference and no verdict line, even for a scanner reading the raw body."""
    text = canonical(text).replace("`", "'")
    text = text.replace("@", "@" + ZERO_WIDTH)
    text = REFERENCE.sub("#" + ZERO_WIDTH, text)
    return VERDICT.sub(lambda m: f"{m.group(1)}Verdict{ZERO_WIDTH}:", text)


def prose(text: str, limit: int) -> str:
    """Model prose as one inline code span on one line. Markdown renders nothing inside
    a code span: no link, autolink, `GH-123` or URL reference, image, HTML or emphasis;
    and a line break cannot start a heading or a forged finding."""
    # Bounded after neutralising: NFKC can expand one character into eighteen (U+FDFA).
    flat = " ".join(neutral(text.strip()[:limit]).split())[:limit].rstrip()
    # The cut can separate a trailing "@" from the zero-width space after it. ("#" acts
    # only before a digit, which the cut has removed.)
    flat = flat.rstrip("@")
    return f"`{flat}`" if flat else "`(empty)`"


def _valid(item) -> bool:
    if not isinstance(item, dict) or set(item) != set(
        SCHEMA["properties"]["findings"]["items"]["required"]
    ):
        return False
    path = item["file"]
    line, confidence, category = item["line"], item["confidence"], item["category"]
    return (
        isinstance(path, str)
        and 0 < len(path) <= MAX_PATH
        and re.fullmatch(PATH_PATTERN, path) is not None
        and path.isprintable()
        and type(line) is int
        and 0 <= line <= MAX_LINE
        and type(confidence) is int
        and 1 <= confidence <= 10
        and item["severity"] in SEVERITIES
        and isinstance(category, str)
        and len(category) <= MAX_CATEGORY
        and re.fullmatch(CATEGORY_PATTERN, category) is not None
        and all(isinstance(item[key], str) and item[key].strip()
                for key in ("description", "exploit_scenario", "recommendation"))
    )


def findings(raw: str) -> tuple[list[Record], int, int, str]:
    """The kept findings, the counts of invalid and withheld ones dropped, and the summary.

    A finding any field of which holds the shape of a credential is withheld whole: the
    comment is public, and a key the model read must not reach it in any form."""
    try:
        data = json.loads(raw)
    except (TypeError, ValueError) as error:
        raise BudgetError("the engine returned no structured output") from error
    if (
        not isinstance(data, dict)
        or set(data) != {"findings", "summary"}
        or not isinstance(data["findings"], list)
        or not isinstance(data["summary"], str)
        or not data["summary"].strip()
    ):
        raise BudgetError("schema")
    kept, dropped, withheld = [], 0, 0
    for item in data["findings"][:MAX_FINDINGS]:
        if not _valid(item):
            dropped += 1
            continue
        if any(credential(item[key]) for key in ("file", "category", "description",
                                                 "exploit_scenario", "recommendation")):
            withheld += 1
            continue
        if item["confidence"] < MIN_CONFIDENCE:
            continue
        kept.append(
            {
                "file": display_path(item["file"]),
                "line": item["line"],
                "severity": item["severity"],
                "category": item["category"],
                "confidence": item["confidence"],
                **{key: prose(item[key], MAX_TEXT)
                   for key in ("description", "exploit_scenario", "recommendation")},
            }
        )
    dropped += max(0, len(data["findings"]) - MAX_FINDINGS)
    summary = (f"`{WITHHELD_SUMMARY}`" if credential(data["summary"])
               else prose(data["summary"], MAX_SUMMARY))
    return kept, dropped, withheld, summary


def render(kept: list[Record], dropped: tuple[int, int], summary: str, env) -> str:
    invalid, withheld = dropped
    head = [f"## {MARKER}", "",
            f"Security review {env['ROUND']} of at most {env['CAP']}, head `{env['HEAD_SHA']}`. "
            "Advisory: it neither approves nor blocks.", "", f"Summary: {summary}", ""]
    if invalid:
        head += [f"{invalid} finding(s) did not match the output schema and are not shown.", ""]
    if withheld:
        head += [f"{withheld} finding(s) held the shape of a credential and are withheld.", ""]
    blocks = [] if kept else [["No high-confidence security finding."]]
    for number, item in enumerate(kept, 1):
        blocks.append([
            f"### Vuln {number}: `{item['category']}` in `{item['file']}:{item['line']}`",
            f"* Severity: {item['severity'].title()}",
            f"* Confidence: {item['confidence']}/10",
            f"* Description: {item['description']}",
            f"* Exploit scenario: {item['exploit_scenario']}",
            f"* Recommendation: {item['recommendation']}",
            "",
        ])
    tail = ["", f"[View job run]({env['RUN_URL']})"]
    # Whole findings only: a cut inside a line could leave a code span open and let
    # the text before the cut render.
    room = COMMENT_LIMIT - len("\n".join(tail)) - DROP_NOTE_RESERVE
    lines, shown = list(head), 0
    for block in blocks:
        if len("\n".join(lines + block)) > room:
            break
        lines += block
        shown += 1
    if shown < len(blocks):
        lines += [f"{len(blocks) - shown} finding(s) not shown: the comment would exceed "
                  "GitHub's size limit.", ""]
    return "\n".join(lines) + "\n" + "\n".join(tail)


def publish(gh_input, env) -> str:
    kept, invalid, withheld, summary = findings(env.get("FINDINGS", ""))
    body = render(kept, (invalid, withheld), summary, env)
    gh_input([f"repos/{env['GH_REPO']}/issues/{int(env['PR'])}/comments", "--method", "POST",
              "--input", "-"], json.dumps({"body": body}))
    return body


def gh_post(args: list[str], payload: str) -> str:
    done = subprocess.run(["gh", "api", *args], input=payload, capture_output=True,
                          text=True, check=True, timeout=GH_TIMEOUT_SECONDS)
    return done.stdout
