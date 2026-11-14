"""Public chat errors are selected by code, never by upstream exception text."""

from core.text_resources import message_text


def public_chat_error(chunk: dict) -> str:
    if chunk.get("code") == "brain_unavailable":
        return message_text("brain.unavailable")
    return message_text("reply.failed")


def provider_rate_limit_message() -> str:
    """User-facing text for a provider 429.

    The provider does not tell us its reset time, so the text promises no exact
    hour: it names the limit and says it clears by itself.
    """
    return message_text("provider.rate_limit")
