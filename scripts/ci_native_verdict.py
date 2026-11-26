"""Read native Codex code review state from complete GitHub GraphQL pages.

Connector identity and summary schema:
https://github.com/cdeust/ai-architect-mcp-spec/pull/391#issuecomment-7078116054
"""

from datetime import datetime
import json
import re

STAMP = re.compile(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ")


def timestamp(value):
    if not isinstance(value, str) or not STAMP.fullmatch(value):
        raise ValueError("unverified review timestamp")
    datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value


BOT = {"login": "chatgpt-codex-connector", "__typename": "Bot", "id": "BOT_kgDOC98s_g"}
SUMMARY = "<!-- codex-pull-request-review-summary -->"
PREFIX = "<!-- codex-review-state:v1 "
QUERY = """query($owner:String!, $repo:String!, $pr:Int!, $endCursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$pr) {
      headRefOid state isDraft baseRefName
      timelineItems(last:1, itemTypes:[BASE_REF_CHANGED_EVENT]) {
        nodes { ... on BaseRefChangedEvent { createdAt } }
      }
      comments(first:100, after:$endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id body createdAt lastEditedAt author { __typename login ... on Bot { id } }
                editor { __typename login ... on Bot { id } } }
      }
    }
  }
}"""


def native_comments(page, sha, *, allow_draft_read=False):
    if page.get("errors"):
        raise ValueError("Unable to authenticate GitHub review")
    pull = page["data"]["repository"]["pullRequest"]
    if pull["headRefOid"] != sha or pull["state"] != "OPEN":
        raise ValueError("PR closed or head changed")
    if type(pull["isDraft"]) is not bool or (pull["isDraft"] and not allow_draft_read):
        raise ValueError("PR is a draft or draft state is unverified")
    return pull["comments"]


# Three live examples: Spec #406, #413 and #414. The connector timestamps code
# and security separately. GitHub keeps the native running row in the edit history.
CODE_ROW = re.compile(
    r'\| 📝 \*\*Code Review\*\* \| (?P<label>✅ \*\*Completed\*\*|🔄 \*\*Running\*\* since) '
    r'<relative-time datetime="(?P<instant>(?P<seconds>[0-9T:-]+)(?:\.[0-9]{1,6})?Z)">'
    r'(?P=instant)</relative-time> \| `(?P<short_sha>[0-9a-f]{7})` \| [^|]+ \|'
)


def code_time(body, sha, status):
    rows = [line for line in body.splitlines() if line.startswith("| 📝 **Code Review**")]
    match = CODE_ROW.fullmatch(rows[0]) if len(rows) == 1 else None
    label = {"running": "🔄 **Running** since", "completed": "✅ **Completed**"}[status]
    if not match or match["label"] != label or match["short_sha"] != sha[:7]:
        raise ValueError("ambiguous native code review date or identity")
    # GitHub dates changes of target and comment edits to the second.
    return timestamp(match["seconds"] + "Z"), match["instant"]


def code_state(body):
    if not body.startswith(SUMMARY + "\n"):
        raise ValueError("missing native Codex summary")
    line = body.split("\n", 2)[1]
    if not line.startswith(PREFIX) or not line.endswith(" -->"):
        raise ValueError("native Codex review schema changed")
    return json.loads(line[len(PREFIX):-4])["code_review"]


def fresh_code_review(row, sha, changed, history):
    completed, completion_id = code_time(row["body"], sha, "completed")
    published = timestamp(row["lastEditedAt"] or row["createdAt"])
    if completed > published or published < timestamp(row["createdAt"]):
        raise ValueError("inconsistent native code review timestamps")
    if completed <= changed:
        return False
    # Walk newest first through security edits of this very completion. The
    # preceding code state must be a native start for the same head after retarget.
    # Completion alone could have finished a review begun against the old base.
    next_edit, start_id = published, None
    for edit in history(row):
        at = timestamp(edit["editedAt"])
        if edit["editor"] != BOT or edit["deletedAt"] is not None or at > next_edit:
            raise ValueError("unverified native code review history")
        next_edit = at
        if at <= changed and start_id is None:
            return False
        body = edit["diff"]
        review = code_state(body)
        if not review or review["commit_sha"] != sha:
            break
        if review["status"] == "running":
            started, this_start = code_time(body, sha, "running")
            if not changed < started <= at < completed or (start_id is not None and this_start != start_id):
                return False
            start_id = this_start
        elif start_id is not None:
            break
        elif (review["status"] != "completed" or code_time(body, sha, "completed")[1] != completion_id
              or at < completed):
            return False
    return start_id is not None


def state(pages, sha, *, allow_draft_read=False, created_after=None, history=None):
    """Return the authenticated exact-head verdict and whether CI requested it."""
    states = []
    requested = False
    more = True
    marker = f"@codex review\n\n<!-- ci-codex-review {sha} -->"
    for page in pages:
        if not more:
            raise ValueError("Unexpected native review page")
        comments = native_comments(page, sha, allow_draft_read=allow_draft_read)
        more = comments["pageInfo"]["hasNextPage"]
        if type(more) is not bool:
            raise ValueError("Invalid native review pagination")
        for row in comments["nodes"]:
            author, body = row["author"], row["body"]
            if author and author["__typename"] == "Bot" and author["login"] == "github-actions" and body == marker:
                requested = True
            if author != BOT or not body.startswith(SUMMARY + "\n"):
                continue
            expected_editor = None if row["lastEditedAt"] is None else BOT
            if row["editor"] != expected_editor:
                raise ValueError("Unverified editor of native Codex summary")
            review = code_state(body)
            if review is None or review["commit_sha"] != sha:
                continue
            status = review["status"]
            if status == "completed":
                flags = review.get("has_any_findings"), review.get("has_unresolved_findings")
                if any(type(flag) is not bool for flag in flags) or flags == (False, True):
                    raise ValueError("Invalid Codex findings")
                status = "block" if flags[1] else "approve"
            elif status not in {"running", "queued"}:
                raise ValueError("Codex did not complete a code review")
            # Unresolved, queued and running code reviews always count. Freshness
            # only determines whether a favourable verdict may authorise a merge.
            if status == "approve" and created_after and not fresh_code_review(row, sha, created_after, history):
                continue
            states.append(status)
    if more:
        raise ValueError("Incomplete native review pagination")
    if "block" in states:
        return "block", requested
    if len(states) > 1:
        raise ValueError("Ambiguous Codex review summaries")
    return (states[0] if states else None), requested
