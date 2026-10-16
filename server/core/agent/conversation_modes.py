"""Configured talk styles; the default leaves the persona unchanged."""

from core.text_resources import prompt_text


CONVERSATION_MODE_HINTS: dict[str, str] = {
    "default": "",
    "brief": prompt_text("mode.brief"),
    "detailed": prompt_text("mode.detailed"),
    "technical": prompt_text("mode.technical"),
    "no_jokes": prompt_text("mode.no_jokes"),
}


def conversation_mode_hint(mode: str) -> str:
    if not isinstance(mode, str) or mode not in CONVERSATION_MODE_HINTS:
        raise ValueError("agent.conversation_mode: expected " + ", ".join(CONVERSATION_MODE_HINTS))
    hint = CONVERSATION_MODE_HINTS[mode]
    if not hint:
        return ""
    return (
        prompt_text("mode.header", mode=mode)
        + hint
    )
