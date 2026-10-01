#!/usr/bin/env python3
"""Offline checks: Discord snowflake JSON safety + reply garbage strip."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

SNOW = 1498032547970683112
CORRUPT = 1498032547970683100  # typical browser JSON.parse of unquoted SNOW


def _test_json_safe_stringifies_snowflake() -> None:
    from core.runtime.snowflake import json_safe_config

    cfg = {"channel_ids": [SNOW], "mention_only": False, "proactive": {"channel_id": SNOW}}
    safe = json_safe_config(cfg)
    assert safe["channel_ids"] == [str(SNOW)]
    assert safe["proactive"]["channel_id"] == str(SNOW)
    assert safe["mention_only"] is False
    # Round-trip through stdlib json must not change the digits.
    again = json.loads(json.dumps(safe))
    assert again["channel_ids"] == [str(SNOW)]


def _test_parse_snowflake_prefers_string() -> None:
    from core.runtime.snowflake import parse_snowflake, parse_snowflake_list

    assert parse_snowflake(str(SNOW)) == SNOW
    assert parse_snowflake(SNOW) == SNOW
    assert parse_snowflake_list([str(SNOW), CORRUPT]) == [SNOW, CORRUPT]
    assert parse_snowflake(None) is None
    assert parse_snowflake("nope") is None
    assert parse_snowflake_list("x") == []


def _test_strip_cjk_and_end_tokens() -> None:
    from core.agent.reply_postprocess import extract_sound_tags

    body = (
        "На картинке показана панель «БАЛАНС LLM» аккаунта AIHope. "
        "Видно: роли и числа. Ниже указано: «День / неделя / месяц: — / — / —»."
    )
    clean, _ = extract_sound_tags(body + "北京赛车有")
    assert clean == body
    assert "北京" not in clean

    clean2, _ = extract_sound_tags(body + "<|endoftext|>")
    assert clean2 == body


def main() -> int:
    _test_json_safe_stringifies_snowflake()
    _test_parse_snowflake_prefers_string()
    _test_strip_cjk_and_end_tokens()
    print("OK test_snowflake_offline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
