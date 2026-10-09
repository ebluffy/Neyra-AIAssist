from __future__ import annotations

import json
from pathlib import Path


def test_read_jsonl_tail_returns_newest_first(tmp_path: Path):
    from core.api.app import _read_jsonl_tail

    path = tmp_path / "audit.jsonl"
    rows = [{"i": i, "op": f"op{i}"} for i in range(50)]
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")

    got = _read_jsonl_tail(path, 5)
    assert [r["i"] for r in got] == [49, 48, 47, 46, 45]


def test_read_jsonl_tail_skips_bad_lines_and_handles_large_file(tmp_path: Path):
    from core.api.app import _read_jsonl_tail

    path = tmp_path / "big.jsonl"
    # Build a file larger than one chunk so seek/chunk path is exercised.
    pad = "x" * 80
    lines: list[str] = []
    for i in range(2000):
        if i % 17 == 0:
            lines.append("not-json " + pad)
        else:
            lines.append(json.dumps({"i": i, "pad": pad}))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    assert path.stat().st_size > 8_192

    got = _read_jsonl_tail(path, 10, chunk_size=4096)
    assert len(got) == 10
    assert all(isinstance(r, dict) and "i" in r for r in got)
    assert got[0]["i"] == 1999
    assert got[0]["i"] > got[-1]["i"]


def test_read_jsonl_tail_empty_or_missing(tmp_path: Path):
    from core.api.app import _read_jsonl_tail

    missing = tmp_path / "nope.jsonl"
    assert _read_jsonl_tail(missing, 5) == []
    empty = tmp_path / "empty.jsonl"
    empty.write_text("", encoding="utf-8")
    assert _read_jsonl_tail(empty, 5) == []
    assert _read_jsonl_tail(empty, 0) == []


def test_read_jsonl_tail_skips_trailing_garbage_to_reach_limit(tmp_path: Path):
    from core.api.app import _read_jsonl_tail

    path = tmp_path / "dirty_tail.jsonl"
    good = [json.dumps({"i": i}) for i in range(10)]
    bad = ["not-json"] * 100
    path.write_text("\n".join(good + bad) + "\n", encoding="utf-8")

    got = _read_jsonl_tail(path, 5, chunk_size=256)
    assert len(got) == 5
    assert [r["i"] for r in got] == [9, 8, 7, 6, 5]
