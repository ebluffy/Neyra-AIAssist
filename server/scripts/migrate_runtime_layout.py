#!/usr/bin/env python3
"""Migrate ignored Stage 1b runtime files into server/ with size/hash checks.

Default is copy (source kept). Pass --remove-source only after a successful smoke run.
Does not overwrite an existing destination unless --force is set.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SERVER_ROOT = REPO_ROOT / "server"

MOVES: list[tuple[Path, Path]] = [
    (REPO_ROOT / "config.yaml", SERVER_ROOT / "config.yaml"),
    (REPO_ROOT / ".env", SERVER_ROOT / ".env"),
    (REPO_ROOT / "memory", SERVER_ROOT / "data" / "memory"),
    (REPO_ROOT / "logs", SERVER_ROOT / "logs"),
]


def _file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _tree_fingerprint(path: Path) -> tuple[int, int, str]:
    """Return (file_count, total_bytes, sha256 of path+size+hash listing)."""
    if path.is_file():
        digest = _file_sha256(path)
        return 1, path.stat().st_size, digest
    files = sorted(p for p in path.rglob("*") if p.is_file())
    h = hashlib.sha256()
    total = 0
    for p in files:
        rel = p.relative_to(path).as_posix()
        size = p.stat().st_size
        total += size
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(str(size).encode("ascii"))
        h.update(b"\0")
        h.update(_file_sha256(p).encode("ascii"))
        h.update(b"\n")
    return len(files), total, h.hexdigest()


def _rewrite_config_memory_paths(cfg: Path) -> None:
    text = cfg.read_text(encoding="utf-8")
    updated = text.replace("./memory/", "./data/memory/").replace('"./memory"', '"./data/memory"')
    if updated != text:
        cfg.write_text(updated, encoding="utf-8")
        print(f"  rewrote memory paths in {cfg.relative_to(REPO_ROOT)}")


def migrate_one(src: Path, dst: Path, *, force: bool, remove_source: bool) -> bool:
    rel_src = src.relative_to(REPO_ROOT) if src.is_relative_to(REPO_ROOT) else src
    rel_dst = dst.relative_to(REPO_ROOT) if dst.is_relative_to(REPO_ROOT) else dst
    if not src.exists():
        print(f"SKIP missing source: {rel_src}")
        return True
    if dst.exists() and not force:
        print(f"SKIP exists (use --force): {rel_dst}")
        return True

    print(f"MIGRATE {rel_src} -> {rel_dst}")
    src_fp = _tree_fingerprint(src)
    print(f"  source files={src_fp[0]} bytes={src_fp[1]} hash={src_fp[2][:16]}…")

    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() and force:
        if dst.is_dir():
            shutil.rmtree(dst)
        else:
            dst.unlink()

    if src.is_dir():
        shutil.copytree(src, dst)
    else:
        shutil.copy2(src, dst)

    dst_fp = _tree_fingerprint(dst)
    print(f"  dest   files={dst_fp[0]} bytes={dst_fp[1]} hash={dst_fp[2][:16]}…")
    if src_fp != dst_fp:
        print("ERROR: fingerprint mismatch after copy", file=sys.stderr)
        return False

    if dst.name == "config.yaml" and dst.parent == SERVER_ROOT:
        _rewrite_config_memory_paths(dst)

    if remove_source:
        if src.is_dir():
            shutil.rmtree(src)
        else:
            src.unlink()
        print(f"  removed source {rel_src}")
    else:
        print("  source kept (omit --remove-source until smoke is green)")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="overwrite existing destinations")
    parser.add_argument(
        "--remove-source",
        action="store_true",
        help="delete sources after successful fingerprint match",
    )
    args = parser.parse_args()

    ok = True
    for src, dst in MOVES:
        if not migrate_one(src, dst, force=args.force, remove_source=args.remove_source):
            ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
