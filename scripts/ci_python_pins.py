"""Read the pinned third-party packages of the Python tests and audit them on OSV.

Usage: python3 -I scripts/ci_python_pins.py scripts/tests/requirements.txt

The requirements file holds only `NAME==VERSION` lines, each followed by its
`--hash=sha256:...` options; CI installs it with pip `--require-hashes
--only-binary :all: --no-deps`. This audit asks OSV (https://osv.dev, the
advisory database pip-audit also reads) about every pin and fails closed: any
advisory, any network or format error, anything it cannot read stops the job.
That is stricter than the `high` threshold of the npm audits: the Python test
dependencies are few, and none has a reason to carry a known advisory.

pip-audit was weighed and not taken: it needs 29 more packages (pip, requests,
urllib3, rich among them), each to pin, hash and audit in turn, to audit one.
"""

import json
import re
import sys
import urllib.request
from pathlib import Path

OSV_QUERYBATCH = "https://api.osv.dev/v1/querybatch"
TIMEOUT_S = 20
PIN = re.compile(r"([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9.+!-]+)((?:\s+--hash=sha256:[0-9a-f]{64})+)")


class PinError(Exception):
    """The requirements file or the audit answer is not what this tool accepts."""


def read_pins(path):
    """Return [(name, version, hashes)]; refuse any line that is not a hashed exact pin."""
    pins = []
    text = Path(path).read_text().replace("\\\n", " ")
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = PIN.fullmatch(line)
        if not match:
            raise PinError(f"{path}: not a hashed exact pin: {line[:80]}")
        name, version, hashes = match.groups()
        pins.append((name, version, re.findall(r"[0-9a-f]{64}", hashes)))
    if not pins:
        raise PinError(f"{path}: no pin")
    names = [name.lower().replace("_", "-") for name, _, _ in pins]
    if len(set(names)) != len(names):
        raise PinError(f"{path}: a package is pinned twice")
    return pins


def advisories(pins, opener=urllib.request.urlopen, timeout=TIMEOUT_S):
    """Return {"name==version": [advisory ids]} for the pins OSV reports."""
    queries = [{"package": {"name": name, "ecosystem": "PyPI"}, "version": version}
               for name, version, _ in pins]
    request = urllib.request.Request(OSV_QUERYBATCH, data=json.dumps({"queries": queries}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
    with opener(request, timeout=timeout) as response:
        if response.status != 200:
            raise PinError(f"OSV answered HTTP {response.status}")
        answer = json.loads(response.read())
    results = answer.get("results") if isinstance(answer, dict) else None
    if not isinstance(results, list) or len(results) != len(queries):
        raise PinError("OSV answer does not hold one result per pin")
    found = {}
    for (name, version, _), result in zip(pins, results):
        if not isinstance(result, dict):
            raise PinError(f"OSV result for {name} is not an object")
        if result.get("next_page_token"):
            raise PinError(f"OSV paged the advisories of {name}=={version}; not all were read")
        vulns = result.get("vulns", [])
        if not isinstance(vulns, list) or not all(isinstance(v, dict) and v.get("id") for v in vulns):
            raise PinError(f"OSV advisories of {name} are unreadable")
        if vulns:
            found[f"{name}=={version}"] = sorted(v["id"] for v in vulns)
    return found


def main(argv, opener=urllib.request.urlopen):
    if len(argv) != 2:
        print("usage: ci_python_pins.py REQUIREMENTS", file=sys.stderr)
        return 2
    try:
        pins = read_pins(argv[1])
        found = advisories(pins, opener)
    except Exception as error:  # every failure stops the job: the audit fails closed
        print(f"Python dependency audit failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    for pin, ids in found.items():
        print(f"{pin}: {', '.join(ids)}", file=sys.stderr)
    if found:
        return 1
    print(f"Python dependency audit: {len(pins)} pin(s), no advisory")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
