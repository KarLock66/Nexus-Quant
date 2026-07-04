"""ADR-0001 — assert the installed environment EQUALS the committed lock.

Run inside the container. Compares `pip freeze` against requirements.lock:
  - every locked package must be installed at the exact locked version;
  - no unexpected third-party package may be present (only the first-party app
    distribution is allowed outside the lock).
Any mismatch is a HARD FAIL (exit 1).
"""

from __future__ import annotations

import re
import subprocess
import sys

# Installed-but-not-in-lock packages that are legitimately allowed.
ALLOWLIST = {"nexus-quant-service"}


def _norm(name: str) -> str:
    return name.lower().replace("_", "-")


def _read_lock(path: str) -> dict[str, str]:
    want: dict[str, str] = {}
    for line in open(path, encoding="utf-8"):
        m = re.match(r"^([A-Za-z0-9_.\-]+)==([^\s;\\]+)", line)
        if m:
            want[_norm(m.group(1))] = m.group(2)
    return want


def _read_installed() -> dict[str, str]:
    out = subprocess.check_output(
        [sys.executable, "-m", "pip", "freeze", "--exclude-editable"], text=True
    )
    have: dict[str, str] = {}
    for line in out.splitlines():
        if "==" in line:
            n, v = line.split("==", 1)
            have[_norm(n)] = v.strip()
    return have


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: verify_locked_env.py <requirements.lock>", file=sys.stderr)
        return 64
    want = _read_lock(sys.argv[1])
    have = _read_installed()
    if not want:
        print("HARD FAIL: lock parsed to zero packages", file=sys.stderr)
        return 1

    missing = {p: want[p] for p in want if have.get(p) != want[p]}
    unexpected = {p: have[p] for p in have if p not in want and p not in ALLOWLIST}

    if missing or unexpected:
        print("DEPENDENCY GRAPH MISMATCH", file=sys.stderr)
        if missing:
            print(f"  not satisfied from lock: {missing}", file=sys.stderr)
        if unexpected:
            print(f"  unexpected installed: {unexpected}", file=sys.stderr)
        return 1

    print(f"locked env verified: {len(want)} pinned packages match")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
