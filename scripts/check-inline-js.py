#!/usr/bin/env python3
"""Syntax-check every inline <script> block of an HTML file with `node --check`.

Usage: python3 scripts/check-inline-js.py markdown-viewer.html [legacy/md_viewer.html ...]

Exits non-zero if any file has no inline script or any block fails to parse. This catches
syntax errors only; runtime behaviour still needs a browser.
"""
import pathlib
import re
import subprocess
import sys
import tempfile

SCRIPT_RE = re.compile(r'<script(?![^>]*\bsrc=)([^>]*)>(.*?)</script>', re.S)


def check(path: str) -> bool:
    blocks = SCRIPT_RE.findall(pathlib.Path(path).read_text())
    ok = 0
    for i, (attrs, body) in enumerate(blocks):
        suffix = '.mjs' if 'module' in attrs else '.js'
        with tempfile.NamedTemporaryFile('w', suffix=suffix, delete=False) as f:
            f.write(body)
        result = subprocess.run(['node', '--check', f.name], capture_output=True, text=True)
        pathlib.Path(f.name).unlink()
        status = 'OK' if result.returncode == 0 else 'FAIL'
        ok += result.returncode == 0
        print(f'  block {i}: {len(body.splitlines())} lines {status} {result.stderr.strip()[:300]}')
    print(f'{path}: {ok}/{len(blocks)} inline blocks parse')
    return bool(blocks) and ok == len(blocks)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    results = [check(p) for p in sys.argv[1:]]
    sys.exit(0 if all(results) else 1)
