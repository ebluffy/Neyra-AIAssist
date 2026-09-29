"""File logging helpers for thoughts / chat lines."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional


def log_thought(agent: Any, thought: str, user_msg: str) -> None:
    if not thought:
        return
    with open(agent.thoughts_log_path, "a", encoding="utf-8") as f:
        f.write(f"\n[{datetime.now().isoformat()}] Запрос: {user_msg[:80]}\n")
        f.write(f"<think>\n{thought}\n</think>\n")


def log_chat(
    agent: Any,
    user: str,
    assistant: str,
    metadata: Optional[dict] = None,
) -> None:
    with open(agent.chat_log_path, "a", encoding="utf-8") as f:
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        who = metadata.get("username", "User") if metadata else "User"
        f.write(f"\n[{ts}] {who}: {user}\n")
        f.write(f"[{ts}] Нейра: {assistant}\n")
