#!/usr/bin/env python3
"""Migrate ignored Stage 1b runtime files into server/ with size/hash checks.

Use --dry-run for a migration table without writes.
Use --report-memory for SQLite Hub / Chroma file counts (before/after on same tree).
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sqlite3
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

FILE_MOVES: list[tuple[Path, Path]] = [
    (
        REPO_ROOT / "interfaces" / "discord" / "lavalink" / "Lavalink.jar",
        SERVER_ROOT / "modules" / "discord" / "lavalink" / "Lavalink.jar",
    ),
]

MODULE_CONFIG_MOVES: list[tuple[Path, Path]] = [
    (
        REPO_ROOT / "interfaces" / "discord" / "config.yaml",
        SERVER_ROOT / "modules" / "discord" / "config.yaml",
    ),
    # Stage 2: API settings live in config/server.yaml (api:/dashboard:), not a module.
    # Legacy interfaces/internal_api/config.yaml is not auto-merged here — copy bind/tokens manually.

    (
        REPO_ROOT / "interfaces" / "local_voice" / "config.yaml",
        SERVER_ROOT / "modules" / "local_voice" / "config.yaml",
    ),
]


def _file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _iter_data_files(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    skip_names = {".gitkeep"}
    return sorted(
        p for p in path.rglob("*") if p.is_file() and p.name not in skip_names
    )


def _tree_fingerprint(path: Path) -> tuple[int, int, str]:
    files = _iter_data_files(path)
    if len(files) == 1 and files[0] == path:
        digest = _file_sha256(path)
        return 1, path.stat().st_size, digest
    h = hashlib.sha256()
    total = 0
    for p in files:
        rel = p.relative_to(path).as_posix() if path.is_dir() else p.name
        size = p.stat().st_size
        total += size
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(str(size).encode("ascii"))
        h.update(b"\0")
        h.update(_file_sha256(p).encode("ascii"))
        h.update(b"\n")
    return len(files), total, h.hexdigest()


def memory_persistence_report(memory_root: Path) -> dict[str, object]:
    """Hub row counts + Chroma artifact file count (no secrets)."""
    out: dict[str, object] = {"memory_root": str(memory_root), "hub_db": "missing", "chroma_files": 0}
    db = memory_root / "neyra_memory.db"
    if db.is_file():
        try:
            conn = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
            tables: dict[str, int] = {}
            for (name,) in conn.execute("SELECT name FROM sqlite_master WHERE type='table'"):
                if name.startswith("sqlite_"):
                    continue
                try:
                    tables[name] = int(conn.execute(f"SELECT COUNT(*) FROM [{name}]").fetchone()[0])
                except sqlite3.Error:
                    tables[name] = -1
            conn.close()
            out["hub_db"] = str(db.name)
            out["hub_tables"] = tables
            out["hub_row_total"] = sum(v for v in tables.values() if v >= 0)
        except sqlite3.Error as e:
            out["hub_error"] = str(e)
    chroma = memory_root / "chroma_db"
    if chroma.is_dir():
        out["chroma_files"] = sum(1 for p in chroma.rglob("*") if p.is_file())
    return out


def _print_memory_report(label: str, memory_root: Path) -> None:
    rep = memory_persistence_report(memory_root)
    print(f"--- memory report ({label}) ---")
    for k, v in rep.items():
        print(f"  {k}: {v}")


def _rewrite_config_memory_paths(cfg: Path) -> None:
    text = cfg.read_text(encoding="utf-8")
    updated = text.replace("./memory/", "./data/memory/").replace('"./memory"', '"./data/memory"')
    if updated != text:
        cfg.write_text(updated, encoding="utf-8")
        print(f"  rewrote memory paths in {cfg.relative_to(REPO_ROOT)}")


def _remove_path(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)
    elif path.is_file():
        path.unlink()


def _dry_run_row(action: str, src: Path, dst: Path) -> None:
    rel_s = src.relative_to(REPO_ROOT) if src.is_relative_to(REPO_ROOT) else src
    rel_d = dst.relative_to(REPO_ROOT) if dst.is_relative_to(REPO_ROOT) else dst
    if not src.exists():
        print(f"| SKIP | {action} | {rel_s} | - | source missing |")
        return
    if src.is_file():
        fp = _tree_fingerprint(src)
        print(f"| PLAN | {action} | {rel_s} | {rel_d} | 1 file, {fp[1]} bytes |")
        return
    fp = _tree_fingerprint(src)
    exists = "overwrite" if dst.exists() else "create"
    print(f"| PLAN | {action} | {rel_s} | {rel_d} | {fp[0]} files, {fp[1]} bytes, dst {exists} |")


def dry_run_table() -> None:
    print("== migrate_runtime_layout dry-run ==")
    print("| status | kind | source | destination | notes |")
    for src, dst in MOVES:
        _dry_run_row("tree/file", src, dst)
    for src, dst in FILE_MOVES:
        _dry_run_row("file", src, dst)
    for src, dst in MODULE_CONFIG_MOVES:
        _dry_run_row("module config", src, dst)
    _print_memory_report("server target", SERVER_ROOT / "data" / "memory")
    if (REPO_ROOT / "memory").exists():
        _print_memory_report("legacy root (if still present)", REPO_ROOT / "memory")


def migrate_one(
    src: Path,
    dst: Path,
    *,
    force: bool,
    remove_source: bool,
    dry_run: bool,
) -> bool:
    rel_src = src.relative_to(REPO_ROOT) if src.is_relative_to(REPO_ROOT) else src
    rel_dst = dst.relative_to(REPO_ROOT) if dst.is_relative_to(REPO_ROOT) else dst
    if not src.exists():
        print(f"SKIP missing source: {rel_src}")
        return True

    if dry_run:
        _dry_run_row("migrate", src, dst)
        return True

    if dst.exists() and not force:
        if remove_source:
            src_fp = _tree_fingerprint(src)
            dst_fp = _tree_fingerprint(dst)
            if src_fp == dst_fp:
                _remove_path(src)
                print(f"REMOVE identical legacy: {rel_src}")
                return True
            print(
                f"SKIP remove {rel_src}: destination {rel_dst} differs "
                f"(src files={src_fp[0]} dst files={dst_fp[0]})",
                file=sys.stderr,
            )
            return False
        print(f"SKIP exists (use --force): {rel_dst}")
        return True

    print(f"MIGRATE {rel_src} -> {rel_dst}")
    src_fp = _tree_fingerprint(src)
    print(f"  source files={src_fp[0]} bytes={src_fp[1]} hash={src_fp[2][:16]}…")

    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists() and force:
        _remove_path(dst)

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
        _remove_path(src)
        print(f"  removed source {rel_src}")
    else:
        print("  source kept (use --remove-source or --cleanup-legacy-root)")
    return True


def cleanup_legacy_root(*, force_memory_logs: bool, dry_run: bool) -> bool:
    ok = True
    if dry_run:
        print("== cleanup-legacy-root (dry-run) ==")
        for src, dst in MODULE_CONFIG_MOVES + [(REPO_ROOT / ".env", SERVER_ROOT / ".env")]:
            if src.exists():
                _dry_run_row("cleanup", src, dst)
        return True

    for src, dst in MODULE_CONFIG_MOVES:
        if not src.exists():
            continue
        if not dst.parent.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
        if not dst.exists():
            shutil.copy2(src, dst)
            print(f"COPY module config {src.relative_to(REPO_ROOT)} -> {dst.relative_to(REPO_ROOT)}")
        src_fp, dst_fp = _tree_fingerprint(src), _tree_fingerprint(dst)
        if src_fp == dst_fp:
            _remove_path(src)
            print(f"REMOVE legacy module config {src.relative_to(REPO_ROOT)}")
        else:
            print(f"WARN module config differs: {src} vs {dst}", file=sys.stderr)
            ok = False

    env_src, env_dst = REPO_ROOT / ".env", SERVER_ROOT / ".env"
    if env_src.exists() and env_dst.exists():
        if _tree_fingerprint(env_src) == _tree_fingerprint(env_dst):
            _remove_path(env_src)
            print("REMOVE legacy root .env")
        else:
            print("ERROR root .env differs from server/.env", file=sys.stderr)
            ok = False

    cfg_src = REPO_ROOT / "config.yaml"
    if cfg_src.exists() and (SERVER_ROOT / "config.yaml").exists():
        _remove_path(cfg_src)
        print("REMOVE legacy root config.yaml (canonical: server/config.yaml)")

    for src, dst in [
        (REPO_ROOT / "memory", SERVER_ROOT / "data" / "memory"),
        (REPO_ROOT / "logs", SERVER_ROOT / "logs"),
    ]:
        if not src.exists():
            continue
        if not dst.exists():
            print(f"ERROR no server copy for {dst.relative_to(REPO_ROOT)}", file=sys.stderr)
            ok = False
            continue
        src_fp, dst_fp = _tree_fingerprint(src), _tree_fingerprint(dst)
        if src_fp == dst_fp or force_memory_logs:
            _remove_path(src)
            print(f"REMOVE legacy {src.relative_to(REPO_ROOT)}")
        else:
            print(
                f"ERROR {src.name} differs: root {src_fp[0]} files vs server {dst_fp[0]} files",
                file=sys.stderr,
            )
            ok = False

    legacy_interfaces = REPO_ROOT / "interfaces"
    if legacy_interfaces.is_dir() and not any(legacy_interfaces.iterdir()):
        legacy_interfaces.rmdir()
        print("REMOVE empty legacy modules tree directory")

    backups = REPO_ROOT / "backups"
    if backups.is_dir():
        files = [p for p in backups.rglob("*") if p.is_file()]
        if not files:
            shutil.rmtree(backups)
            print("REMOVE empty backups/")
        else:
            print(f"KEEP backups/ ({len(files)} files)")

    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="print migration table only")
    parser.add_argument("--report-memory", action="store_true", help="print Hub/Chroma stats for server data/memory")
    parser.add_argument("--force", action="store_true", help="overwrite existing destinations")
    parser.add_argument("--remove-source", action="store_true", help="delete sources after fingerprint match")
    parser.add_argument("--cleanup-legacy-root", action="store_true", help="remove root runtime duplicates")
    parser.add_argument("--force-legacy-dirs", action="store_true", help="drop root memory/logs even if counts differ")
    args = parser.parse_args()

    if args.dry_run:
        dry_run_table()
        return 0

    if args.report_memory:
        _print_memory_report("server/data/memory", SERVER_ROOT / "data" / "memory")
        return 0

    ok = True
    for src, dst in MOVES + FILE_MOVES:
        if not migrate_one(src, dst, force=args.force, remove_source=args.remove_source, dry_run=False):
            ok = False

    if args.cleanup_legacy_root:
        if not cleanup_legacy_root(force_memory_logs=args.force_legacy_dirs, dry_run=False):
            ok = False

    if ok:
        _print_memory_report("post-migrate", SERVER_ROOT / "data" / "memory")

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
