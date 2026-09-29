from __future__ import annotations

from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    docs = root / "docs"
    ru = docs / "ru"
    en = docs / "en"
    ru.mkdir(parents=True, exist_ok=True)
    en.mkdir(parents=True, exist_ok=True)

    # Mirror all current top-level docs topics to both language trees.
    for src in docs.rglob("*.md"):
        rel = src.relative_to(docs)
        if not rel.parts:
            continue
        if rel.parts[0] in {"ru", "en"}:
            continue
        text = src.read_text(encoding="utf-8")
        (ru / rel).parent.mkdir(parents=True, exist_ok=True)
        (en / rel).parent.mkdir(parents=True, exist_ok=True)
        (ru / rel).write_text(text, encoding="utf-8")
        (en / rel).write_text(text, encoding="utf-8")

    (ru / "README.md").write_text(
        "\n".join(
            [
                "# Документация Neyra (RU)",
                "",
                "Полный русский набор документации расположен в `docs/ru/**`.",
                "Структура: architecture, setup, ops, api, usage, plugins.",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    (en / "README.md").write_text(
        "\n".join(
            [
                "# Neyra Documentation (EN)",
                "",
                "The complete English documentation set is available under `docs/en/**`.",
                "Structure: architecture, setup, ops, api, usage, plugins.",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    (docs / "README.md").write_text(
        "\n".join(
            [
                "# Neyra Documentation Portal",
                "",
                "- [Русская документация](ru/README.md)",
                "- [English documentation](en/README.md)",
                "",
                "Top-level docs files are preserved for compatibility.",
            ]
        )
        + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
