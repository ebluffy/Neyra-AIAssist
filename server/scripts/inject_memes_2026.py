#!/usr/bin/env python3
"""
Инъекция справочника мемов Q1 2026 в Chroma через Internal API (POST /v1/memory/add).
Один HTTP-запрос на один мем — гранулярные векторы для RAG.

Запуск (ядро должно быть поднято: main.py --mode core):
  python scripts/inject_memes_2026.py

Токен: internal_api.token в config.yaml или INTERNAL_API_TOKEN / переменные из .env (через load_config).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def load_config_dict() -> dict:
    import yaml

    from core.plugins.config import merge_plugin_configs
    from core.runtime.secrets import apply_env_secrets

    p = ROOT / "config.yaml"
    if not p.is_file():
        print("[FATAL] config.yaml не найден", file=sys.stderr)
        sys.exit(1)
    with p.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        data = {}
    merge_plugin_configs(data, ROOT)
    apply_env_secrets(data)
    return data


def api_base_and_token(cfg: dict) -> tuple[str, str]:
    api = cfg.get("internal_api") or {}
    host = str(api.get("host") or "127.0.0.1").strip()
    port = int(api.get("port") or 8787)
    base = f"http://{host}:{port}".rstrip("/")
    token = str(api.get("token") or "").strip()
    return base, token


# Топ мемов РФ (начало 2026), по открытым подборкам Brand Analytics / ТАСС и др.; по одному документу на мем.
MEMES_2026: list[dict[str, str | dict[str, str]]] = [
    {
        "text": "Мем: 'Можно. А зачем?'. Значение: ответ-подкол из интервью (часто про «можно, но зачем» премиум/нереалистичные ожидания); универсальная отмазка.",
        "metadata": {"type": "knowledge", "category": "meme", "source": "tass_2026"},
    },
    {
        "text": "Мем: 'Фа втфа пепе шнейне'. Значение: абсурдная фраза из рэп/соцсетей (Gunwest и др.), brainrot-реакция без буквального смысла.",
        "metadata": {"type": "knowledge", "category": "meme", "source": "tass_2026"},
    },
    {
        "text": "Мем: 'Мой 2016'. Значение: ностальгия по 2016 году — старые фото, треки, мемы и «атмосфера» как контраст настоящему.",
        "metadata": {"type": "knowledge", "category": "meme", "source": "tass_2026"},
    },
    {
        "text": "Мем: 'Сикс Сэвен' (Six Seven). Значение: короткая Gen Alpha / brainrot-фраза, ритмическая или комическая вставка.",
        "metadata": {"type": "knowledge", "category": "meme", "source": "tass_2026"},
    },
    {
        "text": "Мем: 'Данил Колбасенко'. Значение: образ школьника/«главного героя», имя как нарицательное для неловкого персонажа.",
        "metadata": {"type": "knowledge", "category": "meme", "source": "tass_2026"},
    },
    {
        "text": "Мем: 'Филяй-филяй'. Значение: танцевально-мемный припев с рейв/немецкими отсылками; ответ на веселье и движ.",
        "metadata": {"type": "knowledge", "category": "meme", "source": "tass_2026"},
    },
    {
        "text": "Мем: 'Возьми телефон деткааа'. Значение: вирусная строка из трека (часто связывают с Toksis); «снимай меня», розыгрыш.",
        "metadata": {"type": "knowledge", "category": "meme", "source": "tass_2026"},
    },
    {
        "text": "Мем: 'Шаман и Байкал'. Значение: ироничные отсылки к образу шамана и теме Байкала в медиа и бытовых шутках.",
        "metadata": {"type": "knowledge", "category": "meme", "source": "tass_2026"},
    },
    {
        "text": "Мем: 'Муся, это ты?'. Значение: фраза-узнавание (часто к животному/персонажу), когда кто-то очень похож на отсылку.",
        "metadata": {"type": "knowledge", "category": "meme", "source": "tass_2026"},
    },
    {
        "text": "Мем: 'Дрысясися'. Значение: звукоподражательный brainrot, реакция на абсурдное или смешное.",
        "metadata": {"type": "knowledge", "category": "meme", "source": "tass_2026"},
    },
    {
        "text": "Мем: 'Обезьянка Панч'. Значение: визуальный/мемный панчлайн с обезьянкой; резкая шутка или «бум».",
        "metadata": {"type": "knowledge", "category": "meme", "source": "tass_2026"},
    },
    {
        "text": "Мем: 'Пингвин идущий к горе'. Значение: картинка пингвина к горизонту; символ упорного пути или ироничное «я иду к цели».",
        "metadata": {"type": "knowledge", "category": "meme", "source": "tass_2026"},
    },
    {
        "text": "Мем: 'Ыыыыффф от ЦБ РФ'. Значение: ирония над формулировками и решениями ЦБ; «ыффф» как реакция рынка/людей.",
        "metadata": {"type": "knowledge", "category": "meme", "source": "tass_2026"},
    },
    {
        "text": "Мем: 'Шопинг модный лук'. Значение: ирония про шопинг-влоги, примерки и «модный лук».",
        "metadata": {"type": "knowledge", "category": "meme", "source": "tass_2026"},
    },
    {
        "text": "Мем: 'ЖКХ, вы чё творите?'. Значение: бытовой возмущённый мем про коммунальные сюрпризы, счета и отключения.",
        "metadata": {"type": "knowledge", "category": "meme", "source": "tass_2026"},
    },
]


def main() -> None:
    if sys.platform == "win32" and hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stderr.reconfigure(encoding="utf-8")
        except Exception:
            pass

    parser = argparse.ArgumentParser(description="Inject 2026 meme facts via POST /v1/memory/add")
    parser.add_argument("--dry-run", action="store_true", help="только печать JSON тел, без HTTP")
    args = parser.parse_args()

    cfg = load_config_dict()
    base, token = api_base_and_token(cfg)
    url = f"{base}/v1/memory/add"
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    ok_n = 0
    for i, item in enumerate(MEMES_2026, 1):
        body = {"text": str(item["text"]), "metadata": dict(item["metadata"])}
        if args.dry_run:
            print(f"[dry-run] {i}/15 {json.dumps(body, ensure_ascii=False)[:120]}...")
            ok_n += 1
            continue
        try:
            import httpx

            r = httpx.post(url, headers=headers, json=body, timeout=120.0)
        except Exception as e:
            print(f"[ERR] {i}/15 HTTP: {e}", file=sys.stderr)
            sys.exit(1)
        if r.status_code >= 400:
            print(f"[ERR] {i}/15 {r.status_code} {r.text[:500]}", file=sys.stderr)
            sys.exit(1)
        data = r.json()
        if not data.get("ok"):
            print(f"[ERR] {i}/15 {data}", file=sys.stderr)
            sys.exit(1)
        doc_id = (data.get("data") or {}).get("id", "?")
        print(f"[OK] {i}/15 id={doc_id}")
        ok_n += 1

    print(f"[OK] Готово: {ok_n} документов через {url}")


if __name__ == "__main__":
    main()
