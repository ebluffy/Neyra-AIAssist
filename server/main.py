#!/usr/bin/env python3
"""
Cyber-Core — Проект «Нейра»
Главная точка входа.

Использование:
  python main.py                  # Ядро (по умолчанию): HTTP API + дашборд + resident-плагины — см. core/runtime/server.py
  python main.py --mode core      # то же явно
  python main.py --mode console   # только консоль (промпты, без HTTP-стека)

Команды в консольном режиме:
  /reset     — сбросить краткосрочную память
  /stats     — статистика агента
  /journal   — последние записи дневника
  /reflect   — запустить рефлексию вручную
  /search <запрос> — поиск по памяти (RAG)
  /time — дата и время
  /sys <uptime|disk|memory|cpu|python> — железо
  /web <запрос> — DuckDuckGo
  /person <имя|id> — досье из PeopleDB
  exit / quit — выход
"""

# ─── КРИТИЧНО: прячем GPU от Python/torch ДО любых импортов ──────────────────
# sentence-transformers в этом процессе не должны занимать VRAM там,
# где мешают другим демонам (исторически — Ollama).
import faulthandler
import os
import sys
import threading
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent
from core.runtime.win_runtime import apply_runtime_patches

apply_runtime_patches()
# Секреты из .env (см. .env.example) — до CUDA и до загрузки config.yaml
from core.runtime.secrets import apply_env_secrets, load_dotenv_file

load_dotenv_file(_PROJECT_ROOT)
os.environ["CUDA_VISIBLE_DEVICES"] = ""
# ─────────────────────────────────────────────────────────────────────────────

import argparse
import asyncio
import logging
import subprocess
from typing import Any

import yaml

from core.plugins import merge_plugin_configs

# ─── Загрузка конфига ─────────────────────────────────────────────────────────

CONFIG_PATH = _PROJECT_ROOT / "config.yaml"


def load_config() -> dict[str, Any]:
    if not CONFIG_PATH.exists():
        print(f"[FATAL] Конфиг не найден: {CONFIG_PATH}")
        sys.exit(1)
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, dict):
        data = {}
    merge_plugin_configs(data, _PROJECT_ROOT)
    apply_env_secrets(data)
    return data


config = load_config()
BACKEND = str(config.get("BACKEND", "openrouter")).lower()

# Hugging Face: токен не обязателен, если модели уже в кэше; даёт выше лимиты на скачивание
_mem = config.get("memory") or {}
_hf = (_mem.get("hf_token") or os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or "").strip()
if _hf:
    os.environ["HF_TOKEN"] = _hf
# На Windows без Developer Mode warning про symlink-кэш HF очень шумный и бесполезный.
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

# ─── Логирование ──────────────────────────────────────────────────────────────

log_dir = Path("./logs")
log_dir.mkdir(exist_ok=True)

logging.basicConfig(
    level=getattr(logging, config["logging"]["level"], logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(config["logging"]["system_log"], encoding="utf-8"),
    ],
)
logger = logging.getLogger("cyber-core")

# Подавляем шумные httpx/httpcore логи в консоли — они идут только в файл
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("apscheduler").setLevel(logging.WARNING)
logging.getLogger("huggingface_hub").setLevel(logging.WARNING)
logging.getLogger("huggingface_hub.utils._http").setLevel(logging.ERROR)
logging.getLogger("torch").setLevel(logging.WARNING)
logging.getLogger("torch._subclasses").setLevel(logging.WARNING)

# Voice STT/TTS misconfig → soft ERROR only (core must keep running)
try:
    from core.voice.config import log_voice_soft_errors

    log_voice_soft_errors(config)
except Exception:
    logger.exception("Voice preflight soft-check failed (ignored — ядро продолжает)")

# Диагностика: падения в фоновых потоках и нативные SIGABRT/SIGSEGV в stderr
def _thread_excepthook(args: threading.ExceptHookArgs) -> None:
    logging.getLogger("neyra.threading").critical(
        "Необработанное исключение в потоке %s",
        getattr(args.thread, "name", "?"),
        exc_info=(args.exc_type, args.exc_value, args.exc_traceback),
    )


threading.excepthook = _thread_excepthook
try:
    faulthandler.enable(all_threads=True)
except Exception:
    pass

# ─── Баннер ───────────────────────────────────────────────────────────────────

BANNER = f"""
╔════════════════════════════════════════════════════╗
║        CYBER-CORE  //  Ассистент «Нейра»          ║
║  Backend: {BACKEND.upper():<9}  Model: {'loading...':<16}║
╚════════════════════════════════════════════════════╝
"""

HELP_TEXT = """
Команды:
  /reset             — сбросить краткосрочную память (новый диалог)
  /stats             — статистика агента
  /journal           — записи дневника за 7 дней
  /diary             — личный дневник Нейры (последние записи)
  /diary_add <текст> — вручную добавить заметку в личный дневник
  /reflect           — запустить ночную рефлексию вручную
  /search <текст>    — поиск по долгосрочной памяти (RAG)
  /time              — дата и время
  /sys <команда>    — uptime | disk | memory | cpu | python
  /web <запрос>      — поиск в интернете (ddgs)
  /person <имя|id>   — досье PeopleDB
  /launch            — поднять ядро вторым процессом (как `python main.py`, см. фоновый API)
  /running           — фоновое ядро (если запускали /launch)
  /health            — health-report и self-healing проверка
  exit / quit        — выход

  В Discord: текстовые slash-команды (reset, stats, search, web, person, ...)
"""

# Фоновое ядро из консоли: один дочерний процесс `main.py --mode core` (HTTP + дашборд + resident-плагины).
_SPAWNED_CORE: subprocess.Popen | None = None


def launch_background_core() -> tuple[bool, str]:
    """Из консоли поднять полное ядро отдельным процессом (тот же стек, что и `python main.py`)."""
    global _SPAWNED_CORE
    if _SPAWNED_CORE is not None and _SPAWNED_CORE.poll() is None:
        return False, f"Фоновое ядро уже запущено (pid={_SPAWNED_CORE.pid}). Остановите его перед повтором."
    py = next(
        (p for p in (Path(".venv_win/Scripts/python.exe"), Path(".venv/Scripts/python.exe")) if p.exists()),
        None,
    )
    python_exe = str(py if py is not None else Path(sys.executable))
    p = subprocess.Popen([python_exe, str(_PROJECT_ROOT / "main.py"), "--mode", "core"])
    _SPAWNED_CORE = p
    return True, f"Запущено ядро в фоне (pid={p.pid}) — API и дашборд как при `python main.py`"


def restart_interface_mode(_mode: str) -> tuple[bool, str]:
    # health monitor передаёт имя процесса; для консоли — одно фоновое ядро
    global _SPAWNED_CORE
    proc = _SPAWNED_CORE
    if proc and proc.poll() is None:
        try:
            proc.terminate()
        except Exception:
            pass
    _SPAWNED_CORE = None
    return launch_background_core()


def _spawn_registry() -> dict[str, subprocess.Popen]:
    if _SPAWNED_CORE is not None and _SPAWNED_CORE.poll() is None:
        return {"core": _SPAWNED_CORE}
    return {}


# ─── Консольный режим ─────────────────────────────────────────────────────────

async def run_console() -> None:
    """Интерактивный консольный режим с реальным агентом."""
    from rich.console import Console
    from rich.panel import Panel
    from rich.text import Text
    from core.runtime import HealthMonitor

    console = Console()

    console.print(BANNER, style="bold cyan")
    console.print("Проверяю связь с LLM backend...", style="yellow")

    # Проверяем доступность OpenAI-compatible endpoint (/v1/models)
    import httpx, time as _time

    from core.llm import resolve_openai_compatible_connection

    conn = resolve_openai_compatible_connection(config)
    backend_name = conn.provider.upper()
    check_url = conn.base_url.rstrip("/")
    check_endpoint = f"{check_url}/models"
    start_tip = f"Проверь доступ к {check_url} и API-ключ для провайдера «{conn.provider}» (.env / config)."

    console.print(f"Проверяю связь с LLM ({backend_name}, {check_url})...", style="yellow")
    for attempt in range(5):
        try:
            headers = {}
            ak = (conn.api_key or "").strip()
            if ak and ak != "ollama":
                headers["Authorization"] = f"Bearer {ak}"
            r = httpx.get(check_endpoint, timeout=10, headers=headers)
            console.print(f"  {backend_name} ✓", style="green")
            models = [m.get("id", "") for m in r.json().get("data", []) if isinstance(m, dict)]
            if models:
                console.print(f"  Доступно: {', '.join(models[:4])}", style="dim")
            break
        except Exception as e:
            if attempt < 4:
                console.print(f"  [yellow]Попытка {attempt+1}/5: {e} — жду...[/yellow]")
                _time.sleep(3)
            else:
                console.print(f"[red]{backend_name} недоступен после 5 попыток: {e}[/red]")
                console.print(f"[yellow]{start_tip}[/yellow]")
                sys.exit(1)

    console.print("Инициализирую агента...", style="yellow")

    # Инициализация агента
    try:
        from core.neyra import NeyraAgent
        agent = NeyraAgent(config)
        await agent.start_mcp_clients()
    except Exception as e:
        console.print(f"[red]ОШИБКА инициализации агента: {e}[/red]")
        console.print("[yellow]Проверь OPENROUTER_API_KEY в .env и доступ к интернету.[/yellow]")
        logger.exception(e)
        sys.exit(1)

    # Инициализация рефлексии
    from core.reflection import ReflectionEngine
    reflection = ReflectionEngine(config, agent)
    reflection.start_scheduler()
    health_monitor = HealthMonitor(
        config,
        project_root=_PROJECT_ROOT,
        process_registry=_spawn_registry,
        restart_callback=restart_interface_mode,
    )
    health_monitor.start()
    await health_monitor.run_once()

    # Обновляем баннер с реальной моделью
    stats = agent.get_stats()
    console.clear()
    banner_updated = (
        f"\n╔════════════════════════════════════════════════════╗\n"
        f"║        CYBER-CORE  //  Ассистент «Нейра»          ║\n"
        f"║  LLM: {str(stats.get('llm_provider', BACKEND)).upper():<12}  Model: {stats['model'][:16]:<16}║\n"
        f"╚════════════════════════════════════════════════════╝\n"
    )
    console.print(banner_updated, style="bold cyan")
    console.print(
        f"  RAM памяти: {stats['short_memory_size']} сообщений | "
        f"RAG: {stats['long_memory_records']} записей | "
        f"Люди: {stats.get('people_db_records', 0)}",
        style="dim"
    )
    console.print(HELP_TEXT, style="dim")
    console.print("─" * 52 + "\n", style="dim")

    while True:
        try:
            user_input = input("Ты: ").strip()
        except (EOFError, KeyboardInterrupt):
            console.print("\n[bold cyan]Нейра: Чё? Ладно, ухожу.[/bold cyan]")
            break

        if not user_input:
            continue

        # ── Команды ──
        if user_input.lower() in ("exit", "quit", "выход", "q"):
            console.print("[bold cyan]Нейра: Давай, пока.[/bold cyan]")
            break

        if user_input == "/reset":
            await agent.reset_context_async()
            console.print("[dim]── Память сброшена. Новый диалог. ──[/dim]")
            continue

        if user_input == "/stats":
            s = agent.get_stats()
            console.print(Panel(
                f"Режим: [bold]{s['mode']}[/bold]\n"
                f"Модель: [bold]{s['model']}[/bold]\n"
                f"История: {s['short_memory_size']} сообщений\n"
                f"RAG записей: {s['long_memory_records']}\n"
                f"Людей в базе: {s.get('people_db_records', 0)}\n"
                f"Инструментов: {s['tools_count']}",
                title="Статистика",
                border_style="cyan"
            ))
            continue

        if user_input == "/journal":
            journal = reflection.get_recent_journal(7)
            console.print(Panel(journal, title="Дневник (последние 7 дней)", border_style="magenta"))
            continue

        if user_input == "/diary":
            diary = agent.get_recent_diary(12)
            console.print(Panel(diary, title="Личный дневник Нейры", border_style="magenta"))
            continue

        if user_input.startswith("/diary_add "):
            note = user_input[len("/diary_add ") :].strip()
            if not note:
                console.print("[red]Добавь текст заметки после /diary_add[/red]")
                continue
            ok = agent.add_diary_entry(note, source="manual_console", meta={"author": "ebluffy"})
            console.print("[green]Записала в личный дневник.[/green]" if ok else "[red]Не смогла записать.[/red]")
            continue

        if user_input == "/reflect":
            console.print("[dim]Запускаю рефлексию...[/dim]")
            summary = await reflection.reflect(force=True)
            if summary:
                console.print(Panel(summary, title="Рефлексия", border_style="magenta"))
            else:
                console.print("[dim]Нечего рефлексировать (нет логов за вчера).[/dim]")
            continue

        if user_input.startswith("/search "):
            query = user_input[8:].strip()
            if query:
                results = agent.long_memory.search(query)
                if results:
                    text = "\n\n".join(r[:300] for r in results)
                    console.print(Panel(text, title=f"Поиск: '{query}'", border_style="blue"))
                else:
                    console.print("[dim]Ничего не нашла в памяти.[/dim]")
            continue

        if user_input == "/time":
            out = agent.tools["get_current_time"].invoke({})
            console.print(Panel(str(out), title="Время", border_style="green"))
            continue

        if user_input.startswith("/sys "):
            cmd = user_input[5:].strip().split()[0].lower()
            allowed = ("uptime", "disk", "memory", "cpu", "python")
            if cmd not in allowed:
                console.print(f"[red]Нужно: {' | '.join(allowed)}[/red]")
                continue
            raw = agent.tools["check_system"].invoke({"command": cmd})
            console.print(Panel(str(raw), title=f"Система: {cmd}", border_style="green"))
            continue

        if user_input.startswith("/web "):
            q = user_input[5:].strip()
            if q:
                raw = agent.tools["web_search"].invoke({"query": q[:500]})
                console.print(Panel(str(raw), title="Web", border_style="blue"))
            continue

        if user_input.startswith("/person "):
            q = user_input[8:].strip()
            if q:
                raw = agent.tools["get_person_info"].invoke({"name_or_id": q[:120]})
                console.print(Panel(str(raw), title=f"Досье: {q}", border_style="cyan"))
            continue

        if user_input.strip() == "/launch" or user_input.startswith("/launch "):
            extra = user_input.replace("/launch", "", 1).strip()
            if extra and extra.lower() != "core":
                console.print("[yellow]Используйте: /launch (поднять ядро в фоне)[/yellow]")
                continue
            ok, msg = launch_background_core()
            console.print(f"[green]{msg}[/green]" if ok else f"[yellow]{msg}[/yellow]")
            continue

        if user_input == "/running":
            alive = []
            for m, p in _spawn_registry().items():
                if p.poll() is None:
                    alive.append(f"{m} (pid={p.pid})")
            console.print(Panel("\n".join(alive) if alive else "Нет фонового ядра.", title="Фоновые процессы"))
            continue

        if user_input == "/health":
            rep = await health_monitor.run_once()
            console.print(
                Panel(
                    f"OK: {rep.get('ok')}\n"
                    f"backend: {rep.get('backend')}\n"
                    f"storage: {rep.get('storage')}\n"
                    f"integrations: {rep.get('integrations')}\n"
                    f"self_healing: {rep.get('self_healing')}",
                    title="Health monitor",
                    border_style="yellow",
                )
            )
            continue

        # ── Отправляем в агент (стриминг) ──
        sounds = []
        error_occurred = False

        # Печатаем "Нейра: " и сразу начинаем вывод токенов
        print("\nНейра: ", end="", flush=True)

        try:
            async for chunk in agent.chat_stream(user_input, username="ebluffy"):
                if chunk["type"] == "token":
                    # Просто печатаем всё как есть — быстро и надёжно
                    print(chunk["text"], end="", flush=True)

                elif chunk["type"] == "done":
                    sounds = chunk.get("sounds", [])
                    # DEBUG: показываем think-блоки если включено
                    if config["logging"]["level"] == "DEBUG" and chunk.get("thoughts"):
                        console.print(
                            f"\n[dim][think: {chunk['thoughts'][:200]}][/dim]"
                        )

                elif chunk["type"] == "error":
                    err = chunk["text"]
                    if err:  # Пустые ошибки игнорируем
                        console.print(f"\n[red]Ошибка: {err}[/red]")
                    error_occurred = True
                    break

            print()  # Перенос строки после ответа

        except Exception as e:
            print()
            console.print(f"[red]Критическая ошибка: {e}[/red]")
            logger.exception(e)
            continue

        # Звуки пока отключены — позже добавим саундпад
        # TODO: воспроизводить sounds через soundpad когда будет готов


# ─── Ядро (HTTP + дашборд + resident-плагины) ─────────────────────────────────

async def run_http_stack() -> None:
    """Ядро Нейры: FastAPI + дашборд + один NeyraAgent; см. core.runtime.run_neyra_server."""
    from core.runtime import run_neyra_server

    await asyncio.to_thread(run_neyra_server, config)


# ─── Точка входа ─────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Cyber-Core — Ассистент «Нейра»",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--mode",
        choices=["core", "console"],
        default="core",
        help="core = HTTP+дашборд+плагины; console = только консоль",
    )
    args = parser.parse_args()

    from core.runtime.paths import ensure_runtime_dirs

    ensure_runtime_dirs(_PROJECT_ROOT, config)

    logger.info(f"Старт | mode={args.mode} | backend={BACKEND}")

    mode_map = {
        "core": run_http_stack,
        "console": run_console,
    }

    try:
        asyncio.run(mode_map[args.mode]())
    except KeyboardInterrupt:
        logger.info("Получен Ctrl+C. Завершение...")
    except Exception as e:
        logger.exception(f"Критическая ошибка: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
