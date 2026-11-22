"""Exercise the installed PR-to-merge entry point with recorded GitHub API shapes."""
import unittest

from test_ci_review_dictates_merge import HEAD, OLD_HEAD, REPO, resolver
from test_ci_review_subscription import pages


PR = {"number": 7, "state": "open", "draft": False, "title": "Review fixture", "labels": []}
BASE = "/repos/" + REPO
MERGE = BASE + "/pulls/7/merge"
TIME = "2026-11-22T12:18:20Z"


def step(name):
    return {"name": name, "status": "completed", "conclusion": "success"}


def workflow(identity, workflow_file, event, head, branch):
    return {"id": identity, "path": ".github/workflows/" + workflow_file, "event": event,
            "head_sha": head, "head_branch": branch, "repository": {"full_name": REPO},
            "head_repository": {"full_name": REPO}, "run_attempt": 1, "status": "completed",
            "conclusion": "success", "created_at": TIME}


def job(run, name, identity, *steps):
    return {**step(name), "id": identity, "run_id": run["id"], "run_attempt": 1,
            "head_sha": run["head_sha"], "steps": [step(name) for name in steps]}


class ReviewApi:
    def __init__(self, provider):
        self.source = workflow(100, "claude-review.yml", "pull_request", HEAD, "feature")
        self.source["pull_requests"] = [{"number": 7}]
        self.route = workflow(200, "review-subscription.yml", "workflow_run", OLD_HEAD, "main")
        self.route["display_title"] = "Route PR Review 100 attempt 1"
        self.selection = job(self.route, "select", 201, "Select Claude" if provider == "claude" else "Reuse Codex")
        self.budget = job(self.source, "Claude review budget", 101,
                          "Admit a subscription review round", "Subscription decision run 200")
        if provider == "claude":
            self.review = job(self.source, "Claude review", 102, "PR Review")
            self.verifier = job(self.source, "Verify Claude review verdict", 103, "Verify the verdict for this run")
        else:
            self.review = job(self.source, "Codex GitHub review", 102, "PR Review")
            self.verifier = job(self.source, "Verify native Codex review verdict", 103,
                                "Read the OpenAI verdict from GitHub again", "Enforce the code review")
        self.jobs = [self.budget, self.review, self.verifier]
        self.comments = [{"user": {"login": "claude[bot]", "type": "Bot"}, "updated_at": TIME,
                          "body": f"[View job run](https://github.com/{REPO}/actions/runs/100/attempts/1)\nVerdict: approve"}]
        self.page = pages()[0]
        self.merges = []

    def records(self, path, key=None):
        if path.startswith(BASE + "/actions/workflows/claude-review.yml/runs?"):
            return [self.source]
        if path == BASE + "/actions/runs/200/attempts/1/jobs":
            return [self.selection]
        if path == BASE + "/actions/runs/100/attempts/1/jobs":
            return self.jobs
        if path == BASE + "/issues/7/comments":
            return self.comments
        raise AssertionError(path)

    def request(self, method, path, body=None):
        if (method, path) == ("GET", BASE + "/actions/runs/200"):
            return self.route
        if (method, path) == ("POST", "/graphql"):
            return self.page
        if (method, path) == ("PUT", MERGE):
            self.merges.append(body)
            return {"merged": True, "sha": OLD_HEAD}
        raise AssertionError((method, path))


class SelectedReviewMergeTests(unittest.TestCase):
    def setUp(self):
        self.ns = resolver()

    def merge(self, api):
        return self.ns["_merge_open_pr"](PR, MERGE, HEAD, api, REPO)

    def held(self, api):
        with self.assertRaises(self.ns["PostMergeError"]):
            self.merge(api)
        self.assertEqual(api.merges, [])

    def test_both_providers_can_authorize_one_merge_of_the_reviewed_head(self):
        for provider in ("claude", "codex"):
            with self.subTest(provider=provider):
                api = ReviewApi(provider)
                self.assertEqual(self.merge(api), OLD_HEAD)
                self.assertEqual(api.merges, [{"sha": HEAD, "merge_method": "squash"}])

    def test_admission_must_bind_source_attempt_head_and_trusted_default_branch(self):
        for field, value in (("display_title", "Route PR Review 100 attempt 2"),
                             ("head_branch", "feature"), ("conclusion", "failure")):
            with self.subTest(field=field):
                api = ReviewApi("codex")
                api.route[field] = value
                self.held(api)
        api = ReviewApi("codex")
        api.budget["steps"].pop()
        self.held(api)
        api = ReviewApi("codex")
        api.source["head_sha"] = OLD_HEAD
        self.held(api)

    def test_failed_reviews_and_missing_independent_verifiers_hold_both_providers(self):
        for provider in ("claude", "codex"):
            for defect in ("review failed", "verifier absent", "proof failed"):
                with self.subTest(provider=provider, defect=defect):
                    api = ReviewApi(provider)
                    if defect == "review failed":
                        api.review["conclusion"] = "failure"
                    elif defect == "verifier absent":
                        api.jobs.remove(api.verifier)
                    else:
                        api.verifier["steps"][0]["conclusion"] = "failure"
                    self.held(api)

    def test_block_pending_and_wrong_attempt_cannot_merge(self):
        for page in (pages(any_findings=True, unresolved=True), pages(status="running"), pages(sha=OLD_HEAD)):
            api = ReviewApi("codex")
            api.page = page[0]
            self.held(api)
        for old, new in (("approve", "block"), ("attempts/1", "attempts/2")):
            api = ReviewApi("claude")
            api.comments[0]["body"] = api.comments[0]["body"].replace(old, new)
            self.held(api)
