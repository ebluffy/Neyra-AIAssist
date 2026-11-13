#!/usr/bin/env python3
"""Печатает .env как NUL-разделённые KEY=VALUE без shell-раскрытия.

Вывод читается bash-циклом `while IFS= read -r -d '' kv; do export "$kv"; done`,
поэтому `$`, пробелы и кавычки в значениях остаются буквальными.
"""
from __future__ import annotations

import re
import sys


def main() -> int:
    path = sys.argv[1]
    out = sys.stdout.buffer
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                stripped = line.strip()
                if not stripped or stripped.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
                    continue
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                    value = value[1:-1]
                out.write(f"{key}={value}".encode("utf-8") + b"\0")
    except OSError as exc:
        print(f"не прочитал {path}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
