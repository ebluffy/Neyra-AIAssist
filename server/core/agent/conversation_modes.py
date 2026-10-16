"""Configured talk styles; the default leaves the persona unchanged."""

CONVERSATION_MODE_HINTS: dict[str, str] = {
    "default": "",
    "brief": (
        "Answer briefly: usually 1-3 sentences, with the key point first. "
        "Do not omit necessary facts, commands, or warnings just to be short."
    ),
    "detailed": (
        "Answer in substantive detail: explain reasons, steps, and limitations; "
        "add examples when useful. Do not pad simple answers. "
        "Paragraphs and Markdown lists are allowed; the persona's 1-3 sentence limit does not apply."
    ),
    "technical": (
        "Answer with technical precision: use concrete terms, commands, and code examples "
        "when needed. Distinguish verified facts from assumptions. "
        "Markdown and code blocks are allowed; conversational brevity must not block an explanation."
    ),
    "no_jokes": (
        "Answer calmly and directly, without jokes, memes, sarcasm, taunts, or insults. "
        "Keep a neutral tone even if the persona suggests joking or the user provokes you."
    ),
}


def conversation_mode_hint(mode: str) -> str:
    if not isinstance(mode, str) or mode not in CONVERSATION_MODE_HINTS:
        raise ValueError("agent.conversation_mode: expected " + ", ".join(CONVERSATION_MODE_HINTS))
    hint = CONVERSATION_MODE_HINTS[mode]
    if not hint:
        return ""
    return (
        f"[CONVERSATION MODE: {mode}]\n"
        "This mode takes priority over persona style and micro-plan examples, "
        "but does not change facts, tool rules, or the prohibition on exposing private reasoning.\n"
        + hint
    )
