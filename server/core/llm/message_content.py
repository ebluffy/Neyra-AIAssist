"""Normalize LangChain / OpenAI message ``content`` (str | list blocks) to text."""

from __future__ import annotations

from typing import Any


def message_content_to_text(content: Any) -> str:
    """Flatten assistant/user content that may be a string or list of parts.

    Newer LangChain + Responses API often returns ``content`` as a list of
    ``{"type": "text", "text": "..."}`` (or similar) blocks instead of a plain str.
    """
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                if block:
                    parts.append(block)
                continue
            if not isinstance(block, dict):
                text = getattr(block, "text", None)
                if text:
                    parts.append(str(text))
                continue
            btype = str(block.get("type") or "").lower()
            if btype in {"text", "output_text", "input_text"}:
                t = block.get("text")
                if t is None and isinstance(block.get("content"), str):
                    t = block.get("content")
                if t:
                    parts.append(str(t))
            elif "text" in block and block.get("text"):
                parts.append(str(block["text"]))
        return "".join(parts)
    return str(content)
