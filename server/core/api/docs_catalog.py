"""Markdown docs catalog for dashboard (safe path resolve under docs trees)."""

from __future__ import annotations

from pathlib import Path
from typing import Any


_LEGACY_ALIASES: dict[str, tuple[str, ...]] = {
    "readme-ru": ("README-RU.md",),
    "readme-en": ("README.md",),
    "help-ru": ("modules", "000EXAMPLE", "HELP-RU.md"),
    "help-en": ("modules", "000EXAMPLE", "HELP.md"),
    "docs-ru-index": ("docs", "ru", "README.md"),
    "docs-en-index": ("docs", "en", "README.md"),
}

_SECTION_TITLES = {
    "ru": "Документация (RU)",
    "en": "Документация (EN)",
    "api-ru": "API (RU)",
    "api-en": "API (EN)",
    "root": "Обзор",
    "plugins": "Плагины / SDK",
}

_SECTION_ORDER = ("root", "ru", "en", "api-ru", "api-en", "plugins")


def docs_search_roots(server_root: Path) -> list[Path]:
    """Prefer server/docs (deploy), else repo docs/ next to server/."""
    out: list[Path] = []
    for cand in (server_root / "docs", server_root.parent / "docs"):
        if cand.is_dir() and cand not in out:
            out.append(cand.resolve())
    return out


def _title_from_path(rel: Path) -> str:
    name = rel.stem.replace("-", " ").replace("_", " ")
    return name[:1].upper() + name[1:] if name else rel.name


def _safe_under(base: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(base.resolve())
        return True
    except ValueError:
        return False


def build_docs_catalog(server_root: Path) -> dict[str, Any]:
    """Catalog for dashboard: RU / EN / API RU|EN / root help."""
    server_root = server_root.resolve()
    sections: dict[str, dict[str, Any]] = {
        key: {"id": key, "title": _SECTION_TITLES[key], "items": []} for key in _SECTION_ORDER
    }

    # Legacy / overview files on server root
    for doc_id, parts in _LEGACY_ALIASES.items():
        path = server_root.joinpath(*parts)
        if not path.is_file():
            continue
        if doc_id.startswith("help"):
            sec = "plugins"
        elif doc_id.startswith("readme"):
            sec = "root"
        elif "ru" in doc_id:
            sec = "ru"
        else:
            sec = "en"
        sections[sec]["items"].append(
            {
                "id": doc_id,
                "title": path.stem,
                "path": str(Path(*parts)).replace("\\", "/"),
            }
        )

    for docs_root in docs_search_roots(server_root):
        for lang in ("ru", "en"):
            lang_dir = docs_root / lang
            if not lang_dir.is_dir():
                continue
            for md in sorted(lang_dir.rglob("*.md")):
                if not md.is_file():
                    continue
                rel = md.relative_to(docs_root)
                doc_id = rel.as_posix().removesuffix(".md")
                # Skip duplicates of index already as legacy
                if doc_id in ("ru/README", "en/README") and any(
                    i["id"] == f"docs-{lang}-index" for i in sections[lang]["items"]
                ):
                    continue
                item = {
                    "id": doc_id,
                    "title": _title_from_path(rel),
                    "path": rel.as_posix(),
                    "lang": lang,
                }
                if "/api/" in f"/{rel.as_posix()}" or rel.parts[:2] == (lang, "api"):
                    sections[f"api-{lang}"]["items"].append(item)
                else:
                    sections[lang]["items"].append(item)

    ordered = []
    for key in _SECTION_ORDER:
        sec = sections[key]
        seen: set[str] = set()
        uniq = []
        for it in sec["items"]:
            if it["id"] in seen:
                continue
            seen.add(it["id"])
            uniq.append(it)
        sec["items"] = uniq
        if uniq:
            ordered.append(sec)
    return {"sections": ordered}


def resolve_doc_path(server_root: Path, doc_id: str) -> Path | None:
    """Resolve doc_id under docs trees or legacy allowlist only. No arbitrary server_root read."""
    server_root = server_root.resolve()
    rid = (doc_id or "").strip().replace("\\", "/").lstrip("/")
    if not rid or ".." in rid.split("/"):
        return None

    # Legacy aliases (README, HELP, docs index)
    if rid.lower() in _LEGACY_ALIASES:
        path = server_root.joinpath(*_LEGACY_ALIASES[rid.lower()])
        return path if path.is_file() else None

    # id like ru/architecture/web-ui → docs/.../ru/architecture/web-ui.md
    if not rid.endswith(".md"):
        candidates_rel = [Path(f"{rid}.md"), Path(rid) / "README.md"]
    else:
        candidates_rel = [Path(rid)]

    for docs_root in docs_search_roots(server_root):
        for crel in candidates_rel:
            cand = (docs_root / crel).resolve()
            if _safe_under(docs_root, cand) and cand.is_file():
                return cand

    return None


_KEEP_ATTRIBUTION_IDS = frozenset({"readme-ru", "readme-en"})
_BADGE_COMMENT = "<!-- co-authored-cursor-badge -->"
_BADGE_PREFIX = "[![Cursor AI assist]"
_SUB_PREFIXES = ("<sub>Соавторство:", "<sub>Co-authored with")


def sanitize_markdown_text(text: str, *, doc_id: str = "") -> str:
    """Drop Cursor badge / co-author sub lines except root README aliases."""
    if (doc_id or "").strip().lower() in _KEEP_ATTRIBUTION_IDS:
        return text
    lines = text.splitlines(True)
    out: list[str] = []
    i = 0
    while i < len(lines):
        s = lines[i].strip()
        if (
            s == _BADGE_COMMENT
            or s.startswith(_BADGE_PREFIX)
            or any(s.startswith(p) for p in _SUB_PREFIXES)
        ):
            i += 1
            while i < len(lines) and lines[i].strip() == "":
                i += 1
            if i < len(lines) and lines[i].strip() == "---":
                i += 1
                while i < len(lines) and lines[i].strip() == "":
                    i += 1
            continue
        out.append(lines[i])
        i += 1
    return "".join(out)
