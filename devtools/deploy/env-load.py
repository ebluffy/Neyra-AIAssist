#!/usr/bin/env python3
"""Печатает .env как NUL-разделённые KEY=VALUE без shell-раскрытия.

Вывод читается bash-циклом `while IFS= read -r -d '' kv; do export "$kv"; done`,
поэтому `$`, пробелы и кавычки в значениях остаются буквальными.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from env_parse import EnvFormatError, read_env  # noqa: E402


def main() -> int:
    path = sys.argv[1]
    out = sys.stdout.buffer
    try:
        values = read_env(path)
    except OSError as exc:
        print(f"не прочитал {path}: {exc}", file=sys.stderr)
        return 1
    except EnvFormatError as exc:
        print(f"{exc}", file=sys.stderr)
        return 1
    for key, value in values.items():
        out.write(f"{key}={value}".encode("utf-8") + b"\0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
