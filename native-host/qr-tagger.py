#!/usr/bin/env python3
"""Quick Recorder native messaging host.

Reads a length-prefixed JSON message from stdin: { "path": "...", "tag": "..." }.
Applies the macOS Finder tag via the `tag` CLI (https://github.com/jdberry/tag).
Writes a length-prefixed JSON response: { "ok": true } or { "ok": false, "error": "..." }.

The tag spec follows the format the `tag` CLI accepts:
  "Work"      → tag with no color
  "Work\\n4"  → tag with color blue (digit 0..7 after a literal newline)
"""
import json
import os
import struct
import subprocess
import sys


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len:
        sys.exit(0)
    length = struct.unpack('<I', raw_len)[0]
    body = sys.stdin.buffer.read(length)
    return json.loads(body.decode('utf-8'))


def write_message(obj):
    data = json.dumps(obj).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def find_tag_binary():
    # Common Homebrew install locations (Apple Silicon and Intel).
    for candidate in ('/opt/homebrew/bin/tag', '/usr/local/bin/tag'):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    # Fall back to PATH lookup.
    from shutil import which
    return which('tag')


def main():
    try:
        msg = read_message()
    except Exception as e:
        try:
            write_message({'ok': False, 'error': f'bad message: {e}'})
        except Exception:
            pass
        sys.exit(1)

    path = msg.get('path')
    tag = msg.get('tag')

    if not path or not tag:
        write_message({'ok': False, 'error': 'missing path or tag'})
        return

    if not os.path.isfile(path):
        write_message({'ok': False, 'error': f'file not found: {path}'})
        return

    tag_bin = find_tag_binary()
    if not tag_bin:
        write_message({'ok': False, 'error': "'tag' CLI not installed. Run: brew install tag"})
        return

    try:
        result = subprocess.run(
            [tag_bin, '-a', tag, path],
            capture_output=True, text=True, timeout=10
        )
    except subprocess.TimeoutExpired:
        write_message({'ok': False, 'error': 'tag command timed out'})
        return
    except Exception as e:
        write_message({'ok': False, 'error': f'tag command failed: {e}'})
        return

    if result.returncode == 0:
        write_message({'ok': True, 'tag': tag, 'path': path})
    else:
        err = (result.stderr or result.stdout or 'tag command failed').strip()
        write_message({'ok': False, 'error': err})


if __name__ == '__main__':
    main()
