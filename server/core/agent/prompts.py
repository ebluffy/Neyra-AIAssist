"""System prompt builders for talk (personality) and brain (router) lanes."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from .micro_plan import MicroPlanSettings


def build_talk_system_prompt(
    *,
    base_prompt: str,
    backend: str,
    micro_plan: MicroPlanSettings,
    extra_memories: list[str] | None = None,
    people_context_active: str = "",
    people_context_mentioned: str = "",
    diary_context: str = "",
    username: str | None = None,
    web_context: str = "",
    tool_context: str = "",
    has_vision_images: bool = False,
    last_image_context: Optional[str] = None,
    lyrics_mode: bool = False,
    mcp_tools_catalog: str = "",
    brain_router_context: str = "",
    attached_image_caption: str = "",
    working_memory_context: str = "",
    pre_context: str = "",
) -> str:
    """Assemble talk-lane system prompt. Order: role → active → mentioned → rules → RAG → rest."""
    from core.llm.profile import is_local_openai_compatible_provider

    if is_local_openai_compatible_provider(backend):
        hw_note = "\n[СИСТЕМНАЯ ИНФОРМАЦИЯ: Работаешь через локальный/self-host OpenAI-compatible LLM endpoint.]"
    else:
        hw_note = "\n[СИСТЕМНАЯ ИНФОРМАЦИЯ: Работаешь через облачный LLM API (OpenAI-compatible).]"

    now = datetime.now()
    time_only = (
        f"\n\n[ВРЕМЯ И СРЕДА]\nТекущие дата и время (локально сервера): "
        f"{now.strftime('%Y-%m-%d %H:%M:%S')}"
    )

    sections: list[str] = [base_prompt + hw_note + time_only]
    if (pre_context or "").strip():
        sections.append("\n" + pre_context.strip())

    active_lines: list[str] = []
    if username:
        active_lines.append(
            f"Сейчас говоришь с: {username}. "
            "Это основной адресат текущей реплики; тон и обращение — в первую очередь к этому человеку."
        )
    if people_context_active:
        active_lines.append(people_context_active.strip())
    if active_lines:
        sections.append("\n# АКТИВНЫЙ СОБЕСЕДНИК\n" + "\n\n".join(active_lines))

    if people_context_mentioned:
        sections.append(
            "\n# УПОМЯНУТЫЕ ЛЮДИ (дополнительный контекст)\n"
            f"{people_context_mentioned.strip()}"
        )
    if people_context_active and people_context_mentioned:
        sections.append(
            "\n[ПРИОРИТЕТ ДОСЬЕ]\n"
            "Если сведения об активном собеседнике и об упомянутых людях расходятся — "
            "ориентируйся на активного собеседника для тона и адресации ответа."
        )

    rule_chunks: list[str] = [
        "[КРИТИЧЕСКОЕ ПРАВИЛО ОТВЕТА]\n"
        "Запрещено выводить теги/блоки внутреннего мышления: "
        "<think>, <thought>, <think> и любые их варианты. "
        "Отвечай сразу готовым текстом для пользователя.",
        "[АНТИ-ПОВТОР И РЕЛЕВАНТНОСТЬ]\n"
        "Сначала ответь ПО СМЫСЛУ текущего сообщения пользователя. "
        "Токсичность/локальные мемы/подколы используй как приправу, а не как основной контент. "
        "Не повторяй дословно свои последние фразы из истории чата.",
    ]
    if micro_plan.enabled:
        if micro_plan.mode == "anchor":
            rule_chunks.append(
                "[МИКРО-ПЛАНИРОВАНИЕ]\n"
                "Перед финальным ответом сформируй короткий внутренний план (до 8 слов) "
                "в anchor-формате, затем сам ответ пользователю. "
                "Не используй markdown.\n"
                "Шаблон (ОБЯЗАТЕЛЬНЫЙ формат):\n"
                f"Пользователь: Ало, как дела?\n"
                f"Нейра: {micro_plan.anchor_prefix} коротко поприветствовать. "
                f"{micro_plan.anchor_reply} Привет! Всё нормально, как ты?\n"
                f"Если не можешь соблюсти формат с {micro_plan.anchor_prefix} и "
                f"{micro_plan.anchor_reply}, не пиши план вообще и сразу отвечай пользователю."
            )
        else:
            rule_chunks.append(
                "[МИКРО-ПЛАНИРОВАНИЕ]\n"
                f"Перед основным текстом добавь КОРОТКИЙ внутренний план в тегах "
                f"{micro_plan.start}...{micro_plan.end} (до 8 слов), "
                "после него сразу дай обычный ответ для пользователя. "
                "Не используй markdown.\n"
                "Шаблон (ОБЯЗАТЕЛЬНЫЙ формат):\n"
                f"Пользователь: Ало, как дела?\n"
                f"Нейра: {micro_plan.start}поприветствовать и коротко ответить{micro_plan.end} "
                "Привет! Всё нормально, как ты?\n"
                f"Если не можешь соблюсти формат {micro_plan.start}...{micro_plan.end}, "
                "не пиши план вообще и сразу давай обычный ответ."
            )
    sections.append("\n# ПРАВИЛА ПОВЕДЕНИЯ И СТИЛЬ ОТВЕТА\n" + "\n\n".join(rule_chunks))

    if (working_memory_context or "").strip():
        sections.append(
            "\n# РАБОЧАЯ ПАМЯТЬ (1–3 дня, сжатый слой)\n"
            "Краткие договорённости и задачи из недавних суток; если противоречит RAG — приоритет у фактов из RAG, "
            "но не игнорируй явные «свежие» обещания из этого блока без причины.\n"
            f"{working_memory_context.strip()}"
        )

    if extra_memories:
        memories_text = "\n".join(f"- {m[:300]}" for m in extra_memories)
        sections.append(
            "\n# ДОЛГОСРОЧНАЯ ПАМЯТЬ (RAG, фрагменты прошлых разговоров)\n"
            f"{memories_text}"
        )

    if brain_router_context:
        sections.append(
            "\n# КОНТЕКСТ МАРШРУТИЗАТОРА (brain: инструменты и факты)\n"
            f"{brain_router_context.strip()}"
        )

    if diary_context:
        sections.append(f"\n# ЛИЧНЫЙ ДНЕВНИК НЕЙРЫ (последние заметки)\n{diary_context}")

    if web_context:
        sections.append(
            f"\n# АКТУАЛЬНЫЕ ДАННЫЕ ИЗ ИНТЕРНЕТА (по запросу пользователя)\n{web_context}\n"
            "(Опирайся на эти данные, если они релевантны вопросу.)"
        )

    if tool_context:
        sections.append(
            f"\n# РЕЗУЛЬТАТЫ ИНСТРУМЕНТОВ (уже посчитано кодом, не выдумывай другое)\n{tool_context}"
        )

    if mcp_tools_catalog:
        sections.append(
            "\n# ДОСТУПНЫЕ ВНЕШНИЕ ИНСТРУМЕНТЫ (MCP)\n"
            f"{mcp_tools_catalog.strip()}\n"
            "(Имена с префиксом mcp_ зарезервированы для вызова через ядро; не имитируй JSON-RPC.)"
        )

    if (attached_image_caption or "").strip():
        sections.append(
            "\n# ИЗОБРАЖЕНИЕ К ЭТОЙ РЕПЛИКЕ (конспект VL)\n"
            f"{attached_image_caption.strip()}"
        )

    if has_vision_images:
        sections.append(
            "\n[ЗРЕНИЕ — ПРИОРИТЕТ НАД БРЕДОМ И ПОДКОЛАМИ]\n"
            "К этому сообщению прикреплены изображения; тебе в запрос переданы пиксели через VL-модель.\n"
            "СНАЧАЛА по делу: 1–3 коротких предложения — что на картинке (интерфейс, люди, текст на скрине — "
            "перечисли читаемое дословно или очень близко). Опирайся только на видимое, не выдумывай.\n"
            "ЗАПРЕЩЕНО вместо описания отвечать шаблонами вроде «ничего не вижу», «почти ничего», "
            "«смотри нормально», «слепой», «криворукий», «что за хрень на картинке» — это будет ложь: изображение передано.\n"
            "После обязательного описания можешь одной фразой в своём тоне, без Markdown."
        )
    elif last_image_context:
        sections.append(
            "\n[ПОСЛЕДНИЙ СКРИН В ЭТОМ КАНАЛЕ — НОВОГО ВЛОЖЕНИЯ НЕТ]\n"
            "Ниже сжатая заметка с прошлого VL-хода (внутренний разбор, либо конспект ответа, если монолога не было). "
            "Если юзер переспрашивает про ту картинку — опирайся на это; для новых деталей по пикселям попроси скинуть скрин снова.\n"
            f"{last_image_context}"
        )

    if lyrics_mode:
        sections.append(
            "\n[РЕЖИМ ТЕКСТА ПЕСНИ / ПОЛНЫЙ ВЫВОД]\n"
            "Пользователь запросил текст песни (по данным из веб-поиска). "
            "На этот ход не действует правило отвечать очень кратко (1–3 предложения): выведи текст полностью. "
            "Сохраняй переносы строк и пустые строки между куплетами, как в источнике; "
            "не сжимай весь ответ в один абзац."
        )

    return "\n".join(sections)


def build_brain_system_prompt(
    *,
    identity_snippet: str = "",
    extra_memories: Optional[list[str]] = None,
    people_context_active: str = "",
    people_context_mentioned: str = "",
    diary_context: str = "",
    username: Optional[str] = None,
    web_context: str = "",
    tool_context: str = "",
    mcp_tools_catalog: str = "",
    last_image_context: Optional[str] = None,
    working_memory_context: str = "",
    pre_context: str = "",
) -> str:
    """Compact brain-lane system prompt: tools/facts + optional identity snippet."""
    lines: list[str] = [
        "Ты служебный маршрутизатор (brain) ассистента Нейра.",
        "Не имитируй финальный ответ пользователю и не копируй разговорный стиль talk-модели.",
        "Если доступны инструменты — вызывай их через tool_calls, когда это нужно для фактов.",
        "Когда данных достаточно или инструменты не нужны — выдай сжатое резюме для следующей модели (talk): "
        "факты, результаты инструментов, намерение пользователя; по-русски; без приветствий и без тегов мышления.",
    ]
    if (identity_snippet or "").strip():
        lines.append(identity_snippet.strip())
    if (pre_context or "").strip():
        lines.append(pre_context.strip())
    if username:
        lines.append(f"Текущий собеседник в подписи сообщений: {username}.")
    if people_context_active:
        lines.append("# Активный собеседник\n" + people_context_active.strip())
    if people_context_mentioned:
        lines.append("# Упомянутые люди\n" + people_context_mentioned.strip())
    if (working_memory_context or "").strip():
        lines.append("# Рабочая память (1–3 дня)\n" + working_memory_context.strip())
    if extra_memories:
        mt = "\n".join(f"- {m[:400]}" for m in extra_memories)
        lines.append("# Фрагменты памяти (RAG)\n" + mt)
    if diary_context:
        lines.append("# Дневник (недавние заметки)\n" + diary_context.strip())
    if web_context:
        lines.append("# Веб / актуальные данные\n" + web_context.strip())
    if tool_context:
        lines.append("# Уже посчитано кодом (не выдумывай другое)\n" + tool_context.strip())
    if last_image_context:
        lines.append(
            "# Последний скрин в канале (нет нового вложения)\n" + last_image_context.strip()
        )
    if mcp_tools_catalog:
        lines.append(
            "# Доступные MCP-инструменты\n"
            + mcp_tools_catalog.strip()
            + "\n(Имена с префиксом mcp_ — только через tool_calls.)"
        )
    return "\n\n".join(lines)
