"""
core/tools/builtins.py — Инструменты (Tools) для агента Нейры
──────────────────────────────────────────────────────────────
LLM может вызывать эти функции сама через Function Calling.

Динамические MCP-инструменты подмешиваются в рантайме
(core.runtime.mcp_client + NeyraAgent._ensure_mcp), имена вида mcp_<server>_<tool>.

Текущие инструменты:
  • TimeContextTool   — текущее время и дата
  • SystemMonitorTool — состояние системы (безопасные команды)
  • WebSearchTool     — поиск через DuckDuckGo
  • MemorySearchTool  — семантический поиск (Hub / Chroma)
  • RecallChat        — хронологический chat_log (SQLite Hub)
  • RememberKnowledge — сохранить фрагмент в ChromaDB (опционально affect_note)
  • UpdatePersonFact  — записать новый факт о человеке (опционально emotion_note)
  • GetPersonInfo     — получить досье на человека
  • delegate_to_deep_logic — глубокая логика (brain.model_deep / GPT-OSS)
"""

from __future__ import annotations

import contextvars
import logging
import platform
import subprocess
import time
from datetime import datetime
from typing import TYPE_CHECKING

from langchain_core.tools import tool

if TYPE_CHECKING:
    from core.memory import LongTermMemory, PeopleDB

logger = logging.getLogger("neyra.tools")

# Web search engine health memory (in-process).
# Goal: stop hitting repeatedly failing backends on every lyrics request.
_WEBSEARCH_ENGINES = (
    "brave",
    "google",
    "duckduckgo",
    "wikipedia",
    "yahoo",
    "mojeek",
    "startpage",
    "yandex",
    "grokipedia",
)
_websearch_fail_count: dict[str, int] = {e: 0 for e in _WEBSEARCH_ENGINES}
_websearch_cooldown_until: dict[str, float] = {e: 0.0 for e in _WEBSEARCH_ENGINES}
_WEBSEARCH_FAIL_COOLDOWN_BASE_S = 120.0
_WEBSEARCH_COOLDOWN_MAX_S = 900.0

# Будут заинжектированы при инициализации агента
_long_memory: "LongTermMemory | None" = None
_people_db: "PeopleDB | None" = None
_assistant_cfg: dict | None = None
_neyra_config: dict | None = None
_memory_hub = None
# Per-turn scope (ContextVar — safe under asyncio.create_task / parallel Discord chats)
_turn_memory_uid: contextvars.ContextVar[str] = contextvars.ContextVar(
    "neyra_turn_memory_uid", default=""
)
_turn_memory_channel: contextvars.ContextVar[str] = contextvars.ContextVar(
    "neyra_turn_memory_channel", default=""
)


def set_turn_memory_scope(*, user_id: str = "", channel_id: str = "") -> None:
    """Bind current turn user/channel for scoped semantic search."""
    _turn_memory_uid.set(str(user_id or "").strip())
    _turn_memory_channel.set(str(channel_id or "").strip())


def clear_turn_memory_scope() -> None:
    _turn_memory_uid.set("")
    _turn_memory_channel.set("")


def get_turn_memory_scope() -> dict[str, str]:
    return {
        "user_id": _turn_memory_uid.get() or "",
        "channel_id": _turn_memory_channel.get() or "",
    }


def init_tools(
    long_memory,
    people_db,
    assistant_cfg: dict | None = None,
    *,
    neyra_config: dict | None = None,
    memory_hub=None,
) -> None:
    """Инициализирует ссылки на модули памяти и корневой конфиг (для delegate_to_deep_logic)."""
    global _long_memory, _people_db, _assistant_cfg, _neyra_config, _memory_hub
    _long_memory = long_memory
    _people_db = people_db
    _assistant_cfg = assistant_cfg or {}
    _neyra_config = neyra_config if isinstance(neyra_config, dict) else {}
    _memory_hub = memory_hub

# ─── TimeContextTool ─────────────────────────────────────────────────────────

@tool
def get_current_time() -> str:
    """
    Возвращает текущее время, дату, день недели и время суток.
    Используй когда нужно знать который сейчас час или день.
    """
    now = datetime.now()
    days_ru = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"]
    months_ru = [
        "", "января", "февраля", "марта", "апреля", "мая", "июня",
        "июля", "августа", "сентября", "октября", "ноября", "декабря"
    ]

    hour = now.hour
    if 5 <= hour < 12:
        time_of_day = "утро"
    elif 12 <= hour < 17:
        time_of_day = "день"
    elif 17 <= hour < 22:
        time_of_day = "вечер"
    else:
        time_of_day = "ночь"

    return (
        f"{now.strftime('%H:%M')} — {time_of_day}, "
        f"{days_ru[now.weekday()]}, "
        f"{now.day} {months_ru[now.month]} {now.year} года"
    )


# ─── SystemMonitorTool ───────────────────────────────────────────────────────

# Whitelist безопасных команд (только чтение)
_SAFE_COMMANDS = {
    "uptime": ["uptime"],
    "disk": ["df", "-h"],
    "memory": ["free", "-h"],
    "cpu": ["top", "-bn1"],
    "python": ["python", "--version"],
}

# Для Windows — альтернативные команды
_SAFE_COMMANDS_WIN = {
    "uptime": ["powershell", "-Command", "(Get-Date) - (gcim Win32_OperatingSystem).LastBootUpTime"],
    "disk": ["powershell", "-Command", "Get-PSDrive -PSProvider FileSystem | Select-Object Name,Used,Free"],
    "memory": ["powershell", "-Command", "Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory"],
    "cpu": ["powershell", "-Command", "Get-CimInstance Win32_Processor | Select-Object Name,LoadPercentage"],
    "python": ["python", "--version"],
}


@tool
def check_system(command: str) -> str:
    """
    Проверяет состояние системы.
    Доступные команды: uptime, disk, memory, cpu, python.
    Используй чтобы узнать как себя чувствует железо.
    """
    is_windows = platform.system() == "Windows"
    cmd_map = _SAFE_COMMANDS_WIN if is_windows else _SAFE_COMMANDS

    if command not in cmd_map:
        available = ", ".join(cmd_map.keys())
        return f"Неизвестная команда '{command}'. Доступны: {available}"

    try:
        result = subprocess.run(
            cmd_map[command],
            capture_output=True,
            text=True,
            timeout=10,
        )
        output = result.stdout.strip() or result.stderr.strip()
        return output if output else "Нет данных"
    except subprocess.TimeoutExpired:
        return "Команда завишла (таймаут 10 сек)"
    except Exception as e:
        return f"Ошибка выполнения команды: {e}"


# ─── WebSearchTool ───────────────────────────────────────────────────────────

@tool
def web_search(query: str) -> str:
    """
    Ищет информацию в интернете через DuckDuckGo.
    Используй когда нужна актуальная инфа: новости, документация, ответы на вопросы.
    query — поисковый запрос на русском или английском.
    """
    try:
        from ddgs import DDGS
        from core.agent.tool_heuristics import sanitize_websearch_query

        q = sanitize_websearch_query(str(query or ""), max_len=160) or str(query or "").strip()[:160]
        if not q:
            return "Пустой поисковый запрос."
        if q != str(query or "").strip()[:160]:
            logger.info("WebSearch query sanitized | before=%r after=%r", str(query)[:120], q)

        now = time.time()
        engine_plan = sorted(
            _WEBSEARCH_ENGINES,
            key=lambda eng: (
                _websearch_cooldown_until.get(eng, 0.0) > now,
                _websearch_cooldown_until.get(eng, 0.0),
                _websearch_fail_count.get(eng, 0),
            ),
        )
        last_error = "no engine tried"
        results = []
        used_engine = ""

        for engine in engine_plan:
            if _websearch_cooldown_until.get(engine, 0.0) > now:
                continue
            try:
                with DDGS() as ddgs:
                    # backend=<engine> avoids waiting for all providers each call.
                    batch = list(
                        ddgs.text(
                            q,
                            max_results=3,
                            region="ru-ru",
                            backend=engine,
                        )
                    )
                if batch:
                    used_engine = engine
                    results = batch
                    _websearch_fail_count[engine] = 0
                    _websearch_cooldown_until[engine] = 0.0
                    break
                last_error = f"{engine}: empty results"
                _websearch_fail_count[engine] = int(_websearch_fail_count.get(engine, 0)) + 1
            except Exception as e:
                last_error = f"{engine}: {e}"
                fails = int(_websearch_fail_count.get(engine, 0)) + 1
                _websearch_fail_count[engine] = fails
                cooldown_s = min(
                    _WEBSEARCH_COOLDOWN_MAX_S,
                    _WEBSEARCH_FAIL_COOLDOWN_BASE_S * (2 ** max(0, fails - 1)),
                )
                _websearch_cooldown_until[engine] = time.time() + cooldown_s
                logger.info(
                    "WebSearch backend fail | engine=%s fails=%s cooldown_s=%.0f err=%s",
                    engine,
                    fails,
                    cooldown_s,
                    e,
                )
                continue

        if not results:
            return f"Ничего не нашла (или поисковые движки недоступны). Последняя ошибка: {last_error}"
        if used_engine:
            logger.info("WebSearch backend success | engine=%s query=%r", used_engine, q[:120])

        lines = []
        for i, r in enumerate(results, 1):
            title = r.get("title", "Без названия")
            body = r.get("body", "")[:300]
            lines.append(f"[{i}] {title}\n{body}")

        return "\n\n".join(lines)

    except ImportError:
        return "Пакет ddgs не установлен. Запусти: pip install ddgs"
    except Exception as e:
        logger.error(f"WebSearch ошибка: {e}")
        return f"Поиск упал с ошибкой: {e}"


# ─── MemorySearchTool ────────────────────────────────────────────────────────

@tool
def search_memory(query: str, user_id: str = "") -> str:
    """
    Ищет в долгосрочной памяти по смыслу: прошлые фрагменты диалогов и сохранённые знания (RAG).
    Используй, когда нужно вспомнить факты, о чём договаривались, что сохраняли через remember_knowledge.
    query — суть того, что нужно найти.
    user_id — игнорируется (scope только из текущего хода; нельзя запросить чужой id).
    Для хронологии («что было N сообщений назад») используй recall_chat, не search_memory.
    """
    # Never trust LLM-supplied user_id — always turn ContextVar scope.
    uid = (_turn_memory_uid.get() or "").strip()
    arg_uid = (user_id or "").strip()
    if arg_uid and arg_uid != uid:
        logger.warning(
            "search_memory: tool user_id=%r ignored (turn scope=%r)",
            arg_uid[:64],
            uid[:64],
        )
    if not uid:
        return (
            "Нужен user_id текущего собеседника для семантического поиска "
            "(защита от чужих фрагментов памяти)."
        )
    if _memory_hub is not None:
        results = _memory_hub.search_semantic(query, user_id=uid)
    elif _long_memory is not None:
        results = _long_memory.search(query, user_id=uid)
    else:
        return "Долгосрочная память не инициализирована."

    if not results:
        return "Ничего не нашла в памяти. Либо мы это ещё не обсуждали, либо память пустая."

    lines = ["Нашла в памяти:"]
    for i, r in enumerate(results, 1):
        lines.append(f"[{i}] {r[:400]}")

    return "\n\n".join(lines)


@tool
def recall_chat(
    limit: int = 10,
    offset: int = 0,
    user_id: str = "",
    channel_id: str = "",
) -> str:
    """
    Хронологический recall из полного chat log (SQLite), без семантического RAG.
    Используй для «что было N сообщений назад», «повтори что я сказал раньше», ленты канала.
    limit — сколько сообщений вернуть (1–100), offset — сколько пропустить от самых новых.
    Обязателен хотя бы один фильтр: user_id или channel_id (без фильтра запрос отклоняется — защита от утечки чужих диалогов).
    """
    if _memory_hub is None:
        return "Memory Hub не инициализирован."
    # Prefer turn scope; ignore LLM user_id that differs (same policy as search_memory).
    scope_uid = (_turn_memory_uid.get() or "").strip()
    scope_cid = (_turn_memory_channel.get() or "").strip()
    arg_uid = (user_id or "").strip()
    arg_cid = (channel_id or "").strip()
    if arg_uid and scope_uid and arg_uid != scope_uid:
        logger.warning(
            "recall_chat: tool user_id=%r ignored (turn scope=%r)",
            arg_uid[:64],
            scope_uid[:64],
        )
    uid = scope_uid or None
    cid = scope_cid or arg_cid or None
    if not uid and not cid:
        return (
            "Нужен фильтр: укажи user_id и/или channel_id. "
            "Без фильтра chat_log по всем пользователям не отдаётся."
        )
    lim = max(1, min(int(limit or 10), 100))
    off = max(0, int(offset or 0))
    rows = _memory_hub.list_chat(
        user_id=uid,
        channel_id=cid,
        limit=lim,
        offset=off,
        newest_first=True,
    )
    if not rows:
        return "В chat log пока пусто по этим фильтрам."
    # newest_first from SQL — show oldest→newest for reading
    rows = list(reversed(rows))
    lines = [f"Chat log (limit={lim}, offset={off}), oldest→newest:"]
    for r in rows:
        ts = str(r.get("ts") or "")[:19]
        role = r.get("role") or "?"
        text = str(r.get("text") or "").replace("\n", " ")[:300]
        lines.append(f"[{ts}] {role}: {text}")
    return "\n".join(lines)


@tool
def remember_knowledge(text: str, category: str = "general", affect_note: str = "") -> str:
    """
    Сохраняет фрагмент в долгосрочную векторную память (RAG), чтобы позже найти через search_memory.

    Используй для **любой нормальной информации**, которую разумно вспоминать позже: факты, новости, ситуации, договорённости,
    предпочтения, контекст чата, заметки о проекте, ссылки на события — не только мемы и шутки.
    Отдельно про людей: если речь о конкретном человеке из досье — чаще уместен update_person_fact; для всего остального
    универсального контекста — remember_knowledge.

    Для **мемов, приколов, локальных шуток, интернет-отсылок** тоже сохраняй: удобно передать category=\"meme\" или \"шутки\";
    при необходимости можно начать text с «[Категория: Мемы/Шутки]».

    text — что запомнить (кратко, 1–5 предложений, своими словами).
    category — необязательная метка: general, news, situation, meme, fact, шутки и т.п.
    affect_note — необязательно: короткая пометка «как Нейра это переживает» (тон), для богаче RAG; можно оставить пустым.
    """
    meta = {"source": "agent_tool", "category": (category or "general").strip()[:120]}
    aff = (affect_note or "").strip()
    if aff:
        meta["affect"] = aff[:500]
    if _memory_hub is not None:
        ok, info = _memory_hub.remember_knowledge(text.strip(), meta)
    elif _long_memory is not None:
        ok, info = _long_memory.add_knowledge(text.strip(), meta)
    else:
        return "Долгосрочная память не инициализирована."
    if ok:
        return f"Запомнила в долгую память (документ {info})."
    return f"Не удалось сохранить: {info}"


# ─── UpdatePersonFact ────────────────────────────────────────────────────────

def _find_person(name_or_id: str, discord_id: str | None = None):
    if _memory_hub is not None:
        return _memory_hub.find_person(name_or_id, discord_id=discord_id)
    if _people_db is not None:
        return _people_db.find(name_or_id, discord_id=discord_id)
    return None


@tool
def update_person_fact(person_id: str, fact: str, emotion_note: str = "") -> str:
    """
    Записывает новый факт о человеке в базу досье (PeopleDB).
    Используй когда узнала что-то новое о друге или знакомом.
    person_id — ID человека (maxim, kutyr, timofey, andrey_griniks, bogdan, foxy, erik).
    fact — что именно узнала (кратко, своими словами).
    emotion_note — по желанию: как ты это переживаешь (коротко), сохранится рядом с фактом в досье.
    """
    if _people_db is None and _memory_hub is None:
        return "PeopleDB не инициализирована."

    emo = (emotion_note or "").strip() or None
    target_id = (person_id or "").strip()
    if _people_db is not None and target_id in getattr(_people_db, "_cache", {}):
        success = _people_db.update_fact(target_id, fact, emotion=emo)
        if success:
            return f"Записала. Теперь знаю про {target_id}: {fact}"

    person = _find_person(person_id)
    if person:
        pid = str(person.get("id") or "").strip()
        if not pid:
            return f"Не нашла человека '{person_id}' в базе. Проверь ID."
        if _people_db is not None:
            # Ensure cache has the person (hydrate / create) so update_fact can dual-write.
            if pid not in _people_db._cache:
                _people_db._cache[pid] = dict(person)
            success = _people_db.update_fact(pid, fact, emotion=emo)
            if success:
                return f"Нашла по имени и записала про {(person.get('names') or [pid])[0]}: {fact}"
            return f"Не удалось сохранить факт про {pid} (Hub/PeopleDB)."
        if _memory_hub is not None:
            try:
                _memory_hub.add_person_fact(
                    pid,
                    fact,
                    emotion_note=emo,
                    source="tool",
                    aliases=list(person.get("names") or []),
                    display_name=(person.get("names") or [pid])[0],
                    person_meta=person,
                )
                return f"Записала. Теперь знаю про {pid}: {fact}"
            except Exception as e:
                return f"Не удалось сохранить: {e}"
    return f"Не нашла человека '{person_id}' в базе. Проверь ID."


# ─── GetPersonInfo ───────────────────────────────────────────────────────────

@tool
def get_person_info(name_or_id: str) -> str:
    """
    Получает досье на человека из базы.
    Используй когда нужно вспомнить кто это такой и что о нём знаешь.
    name_or_id — имя, ник или ID человека.
    """
    if _people_db is None and _memory_hub is None:
        return "PeopleDB не инициализирована."

    person = _find_person(name_or_id)
    if not person:
        return f"Никого с именем/ником '{name_or_id}' в базе нет. Может это новый человек?"

    pid = str(person.get("id") or "").strip()
    if _memory_hub is not None:
        summary = _memory_hub.get_person_summary(pid)
    else:
        summary = _people_db.get_summary(pid) if _people_db is not None else ""
    return summary or f"Досье на {name_or_id} есть, но оно пустое."


@tool
def get_character_profile() -> str:
    """
    Возвращает краткий профиль характера Нейры и базовые правила стиля.
    Используй, если нужно свериться с тоном, манерой речи и ограничениями.
    """
    from pathlib import Path

    from core.agent.persona import load_persona_text

    cfg = _assistant_cfg or {}
    name = str(cfg.get("name") or "Нейра")
    root = Path(__file__).resolve().parents[2]
    full_cfg = _neyra_config if isinstance(_neyra_config, dict) and _neyra_config else {"assistant": cfg}
    prompt = load_persona_text(full_cfg, root)
    # Короткая выжимка, чтобы не раздувать контекст при tool-call.
    return (
        f"Профиль: {name}. Тон: живой разговорный, с иронией по ситуации; русский язык; "
        "короткие ответы 1-3 предложения; без markdown/служебных тегов; "
        "без инструкций для реального вреда."
        + (f" В persona настроено: {prompt[:220]}..." if prompt else "")
    )


# ─── Deep logic delegation (правое полушарие) ─────────────────────────────────

@tool
async def delegate_to_deep_logic(detailed_prompt: str) -> str:
    """
    Используй этот инструмент, если пользователь запрашивает написание программного кода,
    создание или модификацию плагинов ядра Neyra, решение сложных многоуровневых логических
    или математических задач. Передай в detailed_prompt развёрнутое техническое задание
    (контекст, ограничения, ожидаемый формат ответа). Инструмент вызывает глубокую модель
    (openrouter.brain_model.model_deep) и возвращает готовый код или аналитику.
    """
    from langchain_core.messages import HumanMessage, SystemMessage
    from langchain_openai import ChatOpenAI

    from core.llm.profile import (
        merge_llm_tuning_options,
        resolve_openai_compatible_connection,
        resolved_brain_model_deep,
    )

    cfg = _neyra_config or {}
    if not cfg:
        return "delegate_to_deep_logic: конфиг ядра не инициализирован (init_tools)."
    try:
        conn = resolve_openai_compatible_connection(cfg)
        tuning = merge_llm_tuning_options(cfg)
        deep_id = resolved_brain_model_deep(cfg, conn.provider)
        brain_timeout = float(
            tuning.get("brain_timeout_seconds", tuning.get("timeout_seconds", 120.0))
        )
        brain_retries = int(tuning.get("brain_max_retries", tuning.get("max_retries", 1)))
        temperature = float(tuning.get("brain_temperature", 0.25))
        llm_kwargs: dict = {
            "base_url": conn.base_url,
            "api_key": conn.api_key,
            "model": deep_id,
            "temperature": temperature,
            "streaming": False,
            "timeout": brain_timeout,
            "max_retries": brain_retries,
            "default_headers": {**dict(conn.default_headers), "X-Title": "Neyra Deep Logic"},
        }
        brain_cap = tuning.get("brain_max_tokens")
        if brain_cap is not None:
            llm_kwargs["max_tokens"] = int(brain_cap)
        llm = ChatOpenAI(**llm_kwargs)
        sys = SystemMessage(
            content=(
                "Ты глубокий аналитический и инженерный модуль Нейры (правое полушарие). "
                "Дай точный, завершённый ответ по ТЗ: код, план или разбор. "
                "Без markdown-обёрток вокруг всего ответа, если не просят; без тегов мышления."
            )
        )
        human = HumanMessage(content=(detailed_prompt or "").strip()[:120000])
        if not human.content:
            return "delegate_to_deep_logic: detailed_prompt пуст."
        resp = await llm.ainvoke([sys, human])
        text = resp.content if hasattr(resp, "content") else str(resp)
        return (text or "").strip() or "(пустой ответ глубокой модели)"
    except Exception as e:
        logger.exception("delegate_to_deep_logic failed")
        return f"delegate_to_deep_logic failed: {e}"


# ─── Plugin Builder Tool (E3) ─────────────────────────────────────────────────

@tool
def create_or_edit_plugin(plugin_id: str, task: str, api_key: str = "") -> str:
    """
    Личный инструмент для **создания/редактирования плагинов Neyra** в `modules/<plugin_id>`.

    **ВАЖНО ДЛЯ МОДЕЛИ (brain_model):**
    - Если пользователь просит *создать / написать / изменить / исправить / сгенерировать* плагин/модуль Neyra
      (всё, что относится к `modules/`), **нужно вызывать ТОЛЬКО этот инструмент**.
    - **КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО** делать web-поиск, Wikipedia, “как написать плагин” и т.п. — это внутренняя задача проекта.
      Не трать tool-calls на `web_search` для таких запросов.

    - Пишет СТРОГО внутри `modules/<plugin_id>` (Path Jail).
    - Блокирует изменения критических плагинов: discord, internal_api.
    - Генерация кода делегируется облачной модели OpenRouter.

    api_key: опционально. Если пусто — берётся из OPENROUTER_API_KEY (env/.env).
    """
    try:
        logger.info("Tool create_or_edit_plugin: start | plugin_id=%s", (plugin_id or "").strip())
        from core.plugins.builder import create_or_edit_plugin_impl

        out = create_or_edit_plugin_impl(plugin_id=plugin_id, task=task, api_key=api_key or None)
        # Возвращаем строку (для tool-calls), но в JSON-формате для наглядности.
        import json

        logger.info("Tool create_or_edit_plugin: done | ok=%s", bool(out.get("ok")))
        return json.dumps(out, ensure_ascii=False)
    except Exception as e:
        logger.exception("Tool create_or_edit_plugin: failed | plugin_id=%s", (plugin_id or "").strip())
        return f"create_or_edit_plugin failed: {e}"


# ─── Список всех инструментов для агента ─────────────────────────────────────

ALL_TOOLS = [
    get_current_time,
    check_system,
    web_search,
    search_memory,
    recall_chat,
    remember_knowledge,
    update_person_fact,
    get_person_info,
    get_character_profile,
    delegate_to_deep_logic,
    create_or_edit_plugin,
]
