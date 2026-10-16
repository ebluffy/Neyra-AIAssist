"""Public chat errors are selected by code, never by upstream exception text."""

from core.text_resources import message_text


def public_chat_error(chunk: dict) -> str:
    if chunk.get("code") == "brain_unavailable":
        return message_text("brain.unavailable")
    return message_text("reply.failed")
