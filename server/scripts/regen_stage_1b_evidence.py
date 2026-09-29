#!/usr/bin/env python3
"""Regenerate docs/stage-1b-evidence.md from local machine (no secrets)."""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PY = ROOT / ".venv_win" / "Scripts" / "python.exe"
if not PY.is_file():
    PY = Path(sys.executable)
MEM = ROOT / "server" / "data" / "memory"


def run(args: list[str], cwd: Path | None = None) -> str:
    r = subprocess.run(
        [str(PY), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=str(cwd or ROOT),
    )
    return ((r.stdout or "") + (r.stderr or "")).strip()


def tree_fp(path: Path) -> tuple[int, int, str]:
    files = sorted(p for p in path.rglob("*") if p.is_file() and p.name != ".gitkeep")
    h = hashlib.sha256()
    total = 0
    for p in files:
        rel = p.relative_to(path).as_posix()
        size = p.stat().st_size
        total += size
        hh = hashlib.sha256()
        with p.open("rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                hh.update(chunk)
        h.update(rel.encode())
        h.update(b"\0")
        h.update(str(size).encode())
        h.update(b"\0")
        h.update(hh.hexdigest().encode())
        h.update(b"\n")
    return len(files), total, h.hexdigest()


def remap_smoke() -> str:
    env = dict(os.environ)
    env["NEYRA_DATA_DIR"] = str((ROOT / "server" / "_tmp_data").resolve())
    code = (
        "import os,sys; from pathlib import Path; "
        "sys.path.insert(0,'server'); "
        "from core.runtime.paths import apply_resolved_memory_paths; "
        "root=Path('server').resolve(); "
        "cfg={'memory':{'sqlite_path':'./data/memory/neyra_memory.db',"
        "'chroma_db_path':'./data/memory/chroma_db'}}; "
        "apply_resolved_memory_paths(cfg, root); "
        "print('sqlite=', cfg['memory']['sqlite_path']); "
        "print('chroma=', cfg['memory']['chroma_db_path']); "
        "assert str(root/'_tmp_data'/'memory') in cfg['memory']['sqlite_path']; "
        "print('OK remapped')"
    )
    r = subprocess.run(
        [str(PY), "-c", code],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=str(ROOT),
        env=env,
    )
    return ((r.stdout or "") + (r.stderr or "")).strip()


def main() -> int:
    n, total, digest = tree_fp(MEM)
    parts = [
        "# Stage 1b verification log",
        "",
        "See also: [stage-1b-acceptance.md](stage-1b-acceptance.md)",
        "",
        "## Honesty note (before/after)",
        "",
        "Migrate on the developer machine happened **before** `--dry-run` existed.",
        "Root `memory/` / `logs/` / `config.yaml` / `.env` are already gone, so dry-run shows `SKIP | source missing`.",
        "Hub/Chroma numbers and the tree fingerprint below are the **post-migrate acceptance baseline**, not a pre-migrate snapshot.",
        "",
        f"- memory files: {n}",
        f"- memory bytes: {total}",
        f"- memory tree fingerprint (sha256): `{digest}`",
        "",
        "## migrate --dry-run (post-migrate; sources already removed)",
        "",
        "```text",
        run(["server/scripts/migrate_runtime_layout.py", "--dry-run"]) or "(ok)",
        "```",
        "",
        "## migrate --report-memory (post-migrate Hub/Chroma)",
        "",
        "```text",
        run(["server/scripts/migrate_runtime_layout.py", "--report-memory"]) or "(ok)",
        "```",
        "",
        "## verify --strict-memory",
        "",
        "```text",
        run(["server/scripts/verify_stage_1b.py", "--strict-memory"]) or "(ok)",
        "```",
        "",
        "## paths / NEYRA_DATA_DIR remapping smoke",
        "",
        "```text",
        remap_smoke() or "(ok)",
        "```",
        "",
        "## compileall",
        "",
        "```text",
        run(["-m", "compileall", "-q", "server", "devtools/mcp_server"]) or "exit=0 (no output)",
        "```",
        "",
        "## healthcheck",
        "",
        "```text",
        run(["scripts/healthcheck.py", "--mode", "core", "--skip-http"], cwd=ROOT / "server") or "(ok)",
        "```",
        "",
        "## docker compose config",
        "",
        "Run from repo root: `docker compose config` (do not commit output if secrets interpolate).",
        "",
    ]
    out = ROOT / "docs" / "stage-1b-evidence.md"
    out.write_text("\n".join(parts), encoding="utf-8")
    print(f"wrote {out.relative_to(ROOT)} fingerprint={digest[:16]}…")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
