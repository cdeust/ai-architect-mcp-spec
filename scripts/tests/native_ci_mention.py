"""Exercise the pinned Claude CLI and MCP broker with a loopback model and a dummy key."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
from threading import Thread
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
EXPECTED = {"mcp__candidate_files__" + name for name in (
    "list_directory", "search_files", "read_text_file", "edit_file",
    "write_file", "create_directory", "move_file",
)}


def stream(block):
    tool = block["type"] == "tool_use"
    message = {"id": "msg_fixture", "type": "message", "role": "assistant",
               "model": "claude-opus-5-5", "content": [], "stop_reason": None,
               "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 1}}
    start = {**block, "input": {}} if tool else {"type": "text", "text": ""}
    delta = ({"type": "input_json_delta", "partial_json": json.dumps(block["input"])}
             if tool else {"type": "text_delta", "text": block["text"]})
    events = [
        ("message_start", {"message": message}),
        ("content_block_start", {"index": 0, "content_block": start}),
        ("content_block_delta", {"index": 0, "delta": delta}),
        ("content_block_stop", {"index": 0}),
        ("message_delta", {"delta": {"stop_reason": "tool_use" if tool else "end_turn",
                                    "stop_sequence": None}, "usage": {"output_tokens": 1}}),
        ("message_stop", {}),
    ]
    return "".join(f"event: {name}\ndata: {json.dumps(dict(type=name, **data))}\n\n"
                   for name, data in events).encode()


def exercise(control):
    prepare = runpy.run_path(str(ROOT / "scripts/ci-mention/prepare.py"))["main"]
    catalogs = []
    original = subprocess.run
    with tempfile.TemporaryDirectory() as directory:
        tmp = Path(directory)
        candidate = tmp / "candidate"
        candidate.mkdir()
        (tmp / "proposal").mkdir()
        (tmp / "owner-thread.json").write_text("[]")  # written by request.py resolve
        event = tmp / "event.json"
        event.write_text(json.dumps({"issue": {"title": "fixture", "body": "Write the fixture."}}))
        edited = candidate / "edit.txt"

        class Model(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if self.path.split("?")[0] != "/v1/messages":
                    self.send_error(404)
                    return
                catalogs.append({item["name"] for item in data.get("tools", [])})
                block = ({"type": "tool_use", "id": "toolu_fixture",
                          "name": "mcp__candidate_files__write_file",
                          "input": {"path": str(edited), "content": "fixture edit"}}
                         if len(catalogs) == 1 else {"type": "text", "text": "Fixture complete."})
                body = stream(block)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        with ThreadingHTTPServer(("127.0.0.1", 0), Model) as server:
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()

            def invoke(command, **options):
                env = options["env"]
                env.pop("CLAUDE_CODE_OAUTH_TOKEN")
                env.update(ANTHROPIC_API_KEY="local-fixture-only",
                           ANTHROPIC_BASE_URL=f"http://127.0.0.1:{server.server_port}",
                           HTTP_PROXY="http://127.0.0.1:1", HTTPS_PROXY="http://127.0.0.1:1",
                           NO_PROXY="127.0.0.1", DISABLE_AUTOUPDATER="1", API_TIMEOUT_MS="5000")
                return original(command, **options, timeout=60)

            try:
                with mock.patch.dict(os.environ, GITHUB_WORKSPACE=directory, RUNNER_TEMP=directory,
                                     GITHUB_EVENT_PATH=str(event), CLAUDE_CODE_OAUTH_TOKEN="fixture"), \
                     mock.patch.dict(prepare.__globals__, CONTROL=control, HERE=control / "scripts/ci-mention"), \
                     mock.patch("subprocess.run", side_effect=invoke):
                    prepare()
            finally:
                server.shutdown()
                thread.join()
        if len(catalogs) != 2 or any(catalog != EXPECTED for catalog in catalogs):
            raise AssertionError(f"Unexpected model tool catalogs: {catalogs}")
        if edited.read_text() != "fixture edit" or "Fixture complete." not in (tmp / "proposal/answer.md").read_text():
            raise AssertionError("The model's file operation or its final response did not complete")
        print(f"{len(EXPECTED)} file tools, a successful candidate edit and a final reply.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--control", type=Path, default=ROOT,
                        help="Directory containing the two installed, lockfile-pinned tool packages.")
    exercise(parser.parse_args().control)
