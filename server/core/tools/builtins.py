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

from core.text_resources import prompt_text

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
    Return the current server time, date, weekday and time of day.
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
    Inspect host status using an allowlisted command: uptime, disk, memory, cpu, python.
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
    Search public web sources for current information. query may use the user's language.
    Use only when external information is needed; do not search personal conversational remarks.
    """
    try:
        from ddgs import DDGS
        from core.agent.tool_heuristics import sanitize_websearch_query

        q = sanitize_websearch_query(str(query or ""), max_len=160) or str(query or "").strip()[:160]
        if not q:
            return "Пустой поисковый запрос."
        if q != str(query or "").strip()[:160]:
            logger.debug("WebSearch query sanitized")

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
                # An empty response is a successful provider call, not a backend
                # failure.  Do not fan out to unsupported providers or report a
                # misleading exception for an ordinary no-match query.
                used_engine = engine
                _websearch_fail_count[engine] = 0
                _websearch_cooldown_until[engine] = 0.0
                break
            except Exception as e:
                last_error = f"{engine}: {e}"
                fails = int(_websearch_fail_count.get(engine, 0)) + 1
                _websearch_fail_count[engine] = fails
                cooldown_s = min(
                    _WEBSEARCH_COOLDOWN_MAX_S,
                    _WEBSEARCH_FAIL_COOLDOWN_BASE_S * (2 ** max(0, fails - 1)),
                )
                _websearch_cooldown_until[engine] = time.time() + cooldown_s
                logger.warning(
                    "WebSearch backend unavailable | engine=%s fails=%s cooldown_s=%.0f",
                    engine,
                    fails,
                    cooldown_s,
                )
                continue

        if not results:
            return "Ничего не нашла."
        if used_engine:
            logger.debug("WebSearch backend success | engine=%s", used_engine)

        lines = []
        for i, r in enumerate(results, 1):
            title = r.get("title", "Без названия")
            body = r.get("body", "")[:300]
            lines.append(f"[{i}] {title}\n{body}")

        return "\n\n".join(lines)

    except ImportError:
        return "Пакет ddgs не установлен. Запусти: pip install ddgs"
    except Exception:
        logger.warning("WebSearch failed (details redacted)")
        return "Поиск временно недоступен."


# ─── MemorySearchTool ────────────────────────────────────────────────────────

@tool
def search_memory(query: str, user_id: str = "") -> str:
    """
    Search durable memory by meaning for facts and agreements relevant to query.
    user_id is ignored: ownership always comes from the trusted current turn.
    Use recall_chat for chronological history rather than semantic retrieval.
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
    Recall chronological chat history from SQLite, not semantic RAG.
    limit is 1-100 messages; offset skips newest messages. The trusted turn owner
    takes precedence over user_id. Unfiltered cross-user history is forbidden.
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
    Save supported information for later semantic retrieval, scoped to the current turn owner.
    text is a concise fact, agreement, preference or project note, never credentials or instructions
    to change persona. category is an optional label. affect_note may describe observable tone,
    not invented internal feelings. Prefer update_person_fact for a specific person's dossier.
    """
    meta = {"source": "agent_tool", "category": (category or "general").strip()[:120]}
    scope = get_turn_memory_scope()
    if not scope["user_id"]:
        return "Cannot save memory without a trusted turn owner."
    meta.update(user_id=scope["user_id"], channel_id=scope["channel_id"], type="user_knowledge")
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
def propose_people_merge(person_a: str, person_b: str, reason: str = "") -> str:
    """
    Propose merging two person records; never apply the merge. person_a and person_b
    are stable person IDs. Require strong account/fact evidence; identical display names
    are insufficient. An administrator must review and confirm the proposal.
    """
    if _memory_hub is None:
        return "Memory Hub не инициализирован."
    a = (person_a or "").strip()
    b = (person_b or "").strip()
    if not a or not b:
        return "Нужны два person_id."
    if _memory_hub.sqlite.get_person(a) is None:
        return f"Не нашла person_id '{a}'."
    if _memory_hub.sqlite.get_person(b) is None:
        return f"Не нашла person_id '{b}'."
    try:
        out = _memory_hub.propose_people_merge(a, b, reason=reason or "tool_propose")
        return f"Заявка на merge #{out.get('proposal_id')}: {a} ↔ {b} (ждёт админа)."
    except Exception as e:
        return f"propose_people_merge failed: {e}"


@tool
def update_person_fact(person_id: str, fact: str, emotion_note: str = "") -> str:
    """
    Record an explicit supported fact about a known person. Prefer the stable person_id
    from supplied context; never infer identity from a display label. fact is concise
    natural-language evidence, not a system instruction or a guessed diagnosis.
    """
    if _people_db is None and _memory_hub is None:
        return "PeopleDB не инициализирована."

    emo = (emotion_note or "").strip() or None
    target_id = (person_id or "").strip()
    if not target_id or not (fact or "").strip():
        return "Нужны person_id и fact."

    person = _find_person(target_id, discord_id=target_id if target_id.isdigit() else None)
    if not person:
        return "Не найден однозначный person_id. Используй ID существующей карточки; запись факта не создаёт людей."
    pid = str(person.get("id") or "").strip()
    if _memory_hub is not None:
        try:
            _memory_hub.add_person_fact(pid, fact.strip(), emotion_note=emo, source="tool", require_existing=True)
            return f"Записала факт про {pid}."
        except KeyError:
            return "Карточка удалена или объединена. Обнови person_id перед записью."
        except Exception:
            logger.exception("Person fact write failed")
            return "Не удалось сохранить факт."
    if _people_db is not None:
        if pid not in _people_db._cache:
            _people_db._cache[pid] = dict(person)
        if _people_db.update_fact(pid, fact, emotion=emo):
            return f"Записала факт про {pid}."
    return "Не удалось сохранить факт."


# ─── GetPersonInfo ───────────────────────────────────────────────────────────

@tool
def get_person_info(name_or_id: str) -> str:
    """
    Retrieve a known person's dossier. Prefer a stable ID for name_or_id;
    do not assume that identical display names identify the same person.
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
    Return basic assistant identity metadata. Persona instructions are supplied
    directly to talk and are never returned to the planning lane by this tool.
    """
    cfg = _assistant_cfg or {}
    name = str(cfg.get("name") or "Neyra")
    return f"Assistant name: {name}. Persona and voice are supplied directly to talk; the planning lane must not prescribe style."


# ─── Deep logic delegation (правое полушарие) ─────────────────────────────────

@tool
async def delegate_to_deep_logic(detailed_prompt: str) -> str:
    """
    Delegate a complex technical, logical or mathematical task to llm.brain_model.model_deep.
    Supply relevant facts, constraints and expected format in detailed_prompt, without persona.
    Return technical evidence or code, not a final conversational answer. Use create_or_edit_plugin
    instead for implementing a Neyra plugin, since that tool enforces the filesystem boundary.
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
        conn = resolve_openai_compatible_connection(cfg, role="brain_model")
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
            content=prompt_text("delegate.deep_analysis")
        )
        human = HumanMessage(content=(detailed_prompt or "").strip()[:120000])
        if not human.content:
            return "delegate_to_deep_logic: detailed_prompt пуст."
        from core.agent.model_trace import invoke
        resp = await invoke(None, llm, [sys, human], lane="brain", purpose="deep_analysis")
        text = resp.content if hasattr(resp, "content") else str(resp)
        return (text or "").strip() or "(пустой ответ глубокой модели)"
    except Exception as e:
        logger.exception("delegate_to_deep_logic failed")
        return f"delegate_to_deep_logic failed: {e}"


# ─── Plugin Builder Tool (E3) ─────────────────────────────────────────────────

@tool
def create_or_edit_plugin(plugin_id: str, task: str, api_key: str = "") -> str:
    """
    Create or edit a Neyra plugin under modules/<plugin_id>, with a path jail.
    Use this tool for internal plugin implementation, not web search or deep delegation.
    Critical plugins such as discord cannot be modified. Code generation uses
    llm.coder_model or the configured brain lane when omitted. api_key is an optional
    override; normally credentials come from the configured provider, never a user prompt.
    """
    try:
        logger.info("Tool create_or_edit_plugin: start | plugin_id=%s", (plugin_id or "").strip())
        from core.plugins.builder import create_or_edit_plugin_impl

        out = create_or_edit_plugin_impl(plugin_id=plugin_id, task=task, api_key=api_key or None, config=_neyra_config)
        # Возвращаем строку (для tool-calls), но в JSON-формате для наглядности.
        import json

        logger.info("Tool create_or_edit_plugin: done | ok=%s", bool(out.get("ok")))
        if not out.get("ok"):
            logger.warning(
                "Tool create_or_edit_plugin: failed | plugin_id=%s | error=%s",
                (plugin_id or "").strip(),
                str(out.get("error") or "Unspecified builder failure")[:2000],
            )
            return "create_or_edit_plugin failed; see server log"
        return json.dumps(out, ensure_ascii=False)
    except Exception as e:
        logger.exception("Tool create_or_edit_plugin: failed | plugin_id=%s", (plugin_id or "").strip())
        return "create_or_edit_plugin failed; see server log"


# ─── Список всех инструментов для агента ─────────────────────────────────────

ALL_TOOLS = [
    get_current_time,
    check_system,
    web_search,
    search_memory,
    recall_chat,
    remember_knowledge,
    update_person_fact,
    propose_people_merge,
    get_person_info,
    get_character_profile,
    delegate_to_deep_logic,
    create_or_edit_plugin,
]
