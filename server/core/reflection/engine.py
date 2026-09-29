"""
core/reflection.py — Ночная рефлексия Нейры
─────────────────────────────────────────────
APScheduler запускает задачу в 04:00 каждую ночь.
LLM суммирует дневник/диалоги → journal в Memory Hub SQLite
(без Hub — только in-memory на время процесса).
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional
import re

logger = logging.getLogger("neyra.reflection")


class ReflectionEngine:
    """Движок ночной рефлексии."""

    def __init__(self, config: dict, agent=None):
        self.config = config
        self.agent = agent  # Ссылка на NeyraAgent (для вызова LLM)

        mem_cfg = config.get("memory", {})
        # Deprecated config key kept for event payload / old configs; never read/written as a store.
        self.journal_path = Path(mem_cfg.get("journal_path", "./data/memory/journal.json"))
        self.reflect_json_path = Path(mem_cfg.get("reflection_json_path", "./data/memory/reflection_last.json"))
        self.chat_log_path = Path(config["logging"]["chat_log"])
        self.reflection_time = mem_cfg.get("reflection_time", "04:00")
        self.small_reflection_enabled = bool(mem_cfg.get("small_reflection_enabled", True))
        self.small_reflection_hours = max(1, int(mem_cfg.get("small_reflection_hours", 4)))
        self.small_reflection_min_lines = int(mem_cfg.get("small_reflection_min_lines", 8))
        self.small_reflection_max_chars = int(mem_cfg.get("small_reflection_max_chars", 1400))
        self.diary_hourly_enabled = bool(mem_cfg.get("diary_hourly_enabled", True))
        self.diary_hourly_min_lines = int(mem_cfg.get("diary_hourly_min_lines", 6))
        self._last_hourly_key: str = ""
        self._last_small_key: str = ""

        # Hub SQLite is the source of truth. Without a Hub, journal stays in-memory only
        # for this process (legacy journal.json store abandoned — never read or written).
        self._journal: list[dict] = []
        self._hydrate_journal_from_hub()

    def _memory_hub(self):
        agent = getattr(self, "agent", None)
        return getattr(agent, "memory_hub", None) if agent is not None else None

    def _hydrate_journal_from_hub(self) -> int:
        """Rebuild in-memory journal from SQLite when a Hub is attached.

        Fetches the most recent rows (newest first) so today's entries are never
        pushed out by an older-first LIMIT, then reverses them for chronological
        (oldest→newest) order in RAM.
        """
        hub = self._memory_hub()
        if hub is None:
            return 0
        try:
            rows = hub.list_journal_entries(limit=1000, newest_first=True)
        except Exception as e:
            logger.warning("Reflection journal hydrate from Hub failed: %s", e)
            return 0
        if not rows:
            return 0
        rows = list(reversed(rows))
        rebuilt: list[dict] = []
        for row in rows:
            meta = row.get("meta") if isinstance(row.get("meta"), dict) else {}
            entry: dict = dict(meta) if meta else {}
            if not entry.get("date"):
                title = str(row.get("title") or "").strip()
                ts = str(row.get("ts") or "").strip()
                entry["date"] = title if len(title) == 10 and title[4] == "-" else ts[:10]
            if not entry.get("summary"):
                entry["summary"] = str(row.get("text") or "")
            if "generated_at" not in entry and row.get("ts"):
                entry["generated_at"] = row.get("ts")
            if entry.get("date") or entry.get("summary"):
                rebuilt.append(entry)
        if not rebuilt:
            return 0
        self._journal = rebuilt
        logger.info("Reflection journal hydrated from Hub SQLite: %s entries", len(rebuilt))
        return len(rebuilt)

    def _journal_has_date(self, date_str: str) -> bool:
        if any(e.get("date") == date_str for e in self._journal):
            return True
        # With Hub attached, refresh from it so restart/empty file does not re-run reflection.
        if self._memory_hub() is not None:
            self._hydrate_journal_from_hub()
            return any(e.get("date") == date_str for e in self._journal)
        return False

    def _save_journal(self) -> bool:
        """Persist last journal entry. Returns False if Hub write failed (entry rolled back)."""
        agent = getattr(self, "agent", None)
        bus = getattr(agent, "event_bus", None) if agent is not None else None
        hub = self._memory_hub()
        if hub is None:
            # No Hub: keep in-memory only (legacy journal.json store abandoned).
            if bus is not None:
                from core.runtime.event_bus import MEMORY_JOURNAL_UPDATED, CoreEvent

                bus.publish(
                    CoreEvent(
                        MEMORY_JOURNAL_UPDATED,
                        "core.reflection",
                        {"path": None, "entries": len(self._journal)},
                    )
                )
            return True
        hub_ok = False
        if self._journal:
            try:
                last = self._journal[-1] if isinstance(self._journal[-1], dict) else {"text": str(self._journal[-1])}
                text = str(last.get("summary") or last.get("text") or last.get("content") or "")
                if not text and last:
                    text = json.dumps(last, ensure_ascii=False)[:8000]
                if text:
                    hub.add_journal_entry(
                        text,
                        title=str(last.get("title") or last.get("date") or "")[:200] or None,
                        kind=str(last.get("kind") or "reflection"),
                        meta=last if isinstance(last, dict) else None,
                        ts=str(last.get("timestamp") or last.get("date") or last.get("generated_at") or "") or None,
                        publish_event=bus is None,
                    )
                    hub_ok = True
            except Exception as e:
                logger.warning("Reflection→Hub journal write failed: %s", e)
        if not hub_ok:
            if self._journal:
                dropped = self._journal.pop()
                logger.error(
                    "Reflection: Hub journal write failed — entry rolled back (%s)",
                    (dropped.get("date") if isinstance(dropped, dict) else dropped),
                )
            return False
        if bus is not None:
            from core.runtime.event_bus import MEMORY_JOURNAL_UPDATED, CoreEvent

            bus.publish(
                CoreEvent(
                    MEMORY_JOURNAL_UPDATED,
                    "core.reflection",
                    {"path": str(self.journal_path), "entries": len(self._journal)},
                )
            )
        return True

    async def reflect(self, date: datetime = None, force: bool = False) -> str:
        """Ночная рефлексия: дневник за 24ч -> JSON (people_updates/global_lore/behavior_rules)."""
        if date is None:
            date = datetime.now()

        date_str = date.strftime("%Y-%m-%d")
        logger.info("Запускаю self-reflection за %s (force=%s)", date_str, force)

        # Для ночного крона — не запускать повторно в тот же день; /reflect может передать force=True.
        if not force and self._journal_has_date(date_str):
            logger.info("Рефлексия за %s уже есть, пропускаю", date_str)
            return ""

        diary_lines = self._get_diary_last_24h()
        if not diary_lines:
            logger.info("Дневник за 24ч пуст — рефлексию пропускаю")
            return ""

        result = await self._analyze_diary_json(diary_lines, date_str)
        if not result:
            return ""
        self._apply_reflection_result(result)

        try:
            self.reflect_json_path.parent.mkdir(parents=True, exist_ok=True)
            self.reflect_json_path.write_text(
                json.dumps(result, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            logger.warning("Не удалось записать reflection_last.json: %s", e)

        summary = self._compact_summary(result)
        if summary:
            self._journal.append({
                "date": date_str,
                "summary": summary,
                "reflection_json": result,
                "generated_at": datetime.now().isoformat(),
            })
            self._save_journal()
            logger.info("Рефлексия за %s сохранена", date_str)
            await self._auto_sync_external_backup()
            mem_cfg = self.config.get("memory") or {}
            sm_cfg = mem_cfg.get("ltm_auto_summarize") if isinstance(mem_cfg.get("ltm_auto_summarize"), dict) else {}
            if bool(sm_cfg.get("run_after_nightly_reflection")) and bool(sm_cfg.get("enabled", False)):
                try:
                    await self._ltm_scheduled_summarize_job()
                    logger.info("LTM summarize после ночной рефлексии выполнен")
                except Exception as e:
                    logger.warning("LTM summarize после ночной рефлексии: %s", e)

        return summary

    async def _auto_sync_external_backup(self) -> None:
        """Автосинхронизация бэкапа после большой рефлексии (если включено в конфиге)."""
        cfg = self.config.get("external_storage") or {}
        if not bool(cfg.get("enabled", False)):
            return
        sync_after = bool(cfg.get("sync_after_big_reflection", True))
        if not sync_after:
            return
        try:
            from core.runtime.backup import BackupManager

            mgr = BackupManager(self.config)
            res = await asyncio.to_thread(mgr.run_backup, "post_big_reflection")
            logger.info("External storage auto-sync done: %s", res.get("external_ref") or res.get("archive"))
        except Exception as e:
            logger.warning("External storage auto-sync failed: %s", e)

    @staticmethod
    def _normalize_fact_text(text: str) -> str:
        t = (text or "").strip().lower()
        t = re.sub(r"\s+", " ", t)
        return t

    @staticmethod
    def _is_high_signal_fact(text: str) -> bool:
        """Фильтр «важность/мусор» для записи фактов в долговременную память."""
        t = (text or "").strip()
        if len(t) < 12:
            return False
        low = t.lower()
        # Явный мусор/мета.
        trash_markers = (
            "не знаю",
            "без изменений",
            "ничего нового",
            "просто поболтали",
            "шутка",
            "мем без факта",
        )
        if any(m in low for m in trash_markers):
            return False
        # Наличие признаков значимого факта.
        important_markers = (
            "работ",
            "учеб",
            "переех",
            "отношен",
            "боле",
            "конфликт",
            "помир",
            "проект",
            "план",
            "договор",
            "деньги",
            "покуп",
            "продал",
            "сменил",
            "цель",
            "проблем",
        )
        if any(m in low for m in important_markers):
            return True
        # Если маркеров нет, но фраза достаточно содержательная — оставляем.
        return len(t) >= 30

    def _apply_reflection_result(self, result: dict) -> None:
        """Большая рефлексия: запись устойчивых фактов в PeopleDB + дневник."""
        if not self.agent:
            return
        people_db = getattr(self.agent, "people_db", None)
        diary = getattr(self.agent, "diary", None)
        hub = getattr(self.agent, "memory_hub", None)
        if people_db is None and hub is None:
            return

        updates = list(result.get("people_updates") or [])
        existing_norm: dict[str, set[str]] = {}
        if hub is not None:
            for person in hub.list_people():
                pid = str(person.get("id") or "").strip()
                if not pid or pid in existing_norm:
                    continue
                norms: set[str] = set()
                for row in hub.list_person_facts(pid, limit=80):
                    norms.add(self._normalize_fact_text(str(row.get("fact") or "")))
                existing_norm[pid] = norms
        elif people_db is not None:
            for pid, person in getattr(people_db, "_cache", {}).items():
                norms = set()
                for row in list(person.get("dynamic_facts") or []):
                    norms.add(self._normalize_fact_text(str(row.get("fact") or "")))
                existing_norm[pid] = norms

        added: list[str] = []
        for item in updates:
            if not isinstance(item, dict):
                continue
            hint = str(item.get("person_hint") or "").strip()
            fact = str(item.get("fact") or "").strip()
            if not hint or not fact or not self._is_high_signal_fact(fact):
                continue
            if hub is not None:
                person = hub.find_person(hint)
            else:
                person = people_db.find(hint) if people_db is not None else None
            if not person:
                continue
            pid = str(person.get("id") or "").strip()
            if not pid:
                continue
            norm = self._normalize_fact_text(fact)
            if not norm:
                continue
            if norm in existing_norm.setdefault(pid, set()):
                continue
            ok = False
            if people_db is not None:
                if pid not in getattr(people_db, "_cache", {}):
                    people_db._cache[pid] = dict(person)
                ok = people_db.update_fact(pid, fact)
            elif hub is not None:
                try:
                    hub.add_person_fact(
                        pid,
                        fact,
                        source="reflection",
                        aliases=list(person.get("names") or []),
                        display_name=(person.get("names") or [pid])[0],
                        person_meta=person,
                    )
                    ok = True
                except Exception:
                    ok = False
            if ok:
                existing_norm[pid].add(norm)
                added.append(f"{pid}: {fact}")

        if diary is not None:
            lore = [str(x).strip() for x in list(result.get("global_lore") or []) if str(x).strip()]
            rules = [str(x).strip() for x in list(result.get("behavior_rules") or []) if str(x).strip()]
            if added:
                diary.add_entry(
                    text="Большая рефлексия: закрепила факты в PeopleDB:\n- " + "\n- ".join(added[:8]),
                    source="nightly_reflection_apply",
                    meta={"facts_added": len(added)},
                )
            if lore:
                diary.add_entry(
                    text="Большая рефлексия: глобальные наблюдения:\n- " + "\n- ".join(lore[:6]),
                    source="nightly_reflection_apply",
                    meta={"global_lore_count": len(lore)},
                )
            if rules:
                diary.add_entry(
                    text="Большая рефлексия: правила поведения:\n- " + "\n- ".join(rules[:4]),
                    source="nightly_reflection_apply",
                    meta={"behavior_rules_count": len(rules)},
                )

    async def small_reflection(self) -> str:
        """Малая рефлексия (каждые N часов): сжатие активного контекста в дневник."""
        if not self.agent or not hasattr(self.agent, "diary"):
            return ""
        now = datetime.now()
        block_start = (now.hour // self.small_reflection_hours) * self.small_reflection_hours
        key = now.strftime("%Y-%m-%d") + f" {block_start:02d}"
        if self._last_small_key == key:
            return ""
        logs = self._get_logs_for_last_hours(self.small_reflection_hours)
        if len([x for x in logs.splitlines() if x.strip()]) < self.small_reflection_min_lines:
            return ""
        prompt = (
            f"Сожми контекст последних {self.small_reflection_hours} часов в 2-4 коротких предложения. "
            "Только практичные наблюдения для памяти: кто, что изменилось, какие темы/риски. "
            "Без markdown и списков.\n\n"
            f"Логи:\n{logs[:5000]}"
        )
        try:
            from langchain_core.messages import HumanMessage

            llm_reflect = getattr(self.agent, "llm_memory", None) or getattr(
                self.agent, "llm_reflection", self.agent.llm
            )
            from core.llm.retry import ainvoke_with_rate_limit_backoff

            response = await ainvoke_with_rate_limit_backoff(
                llm_reflect, [HumanMessage(content=prompt)], lane="memory_model"
            )
            note = str(response.content).strip()
            if not note:
                return ""
            if len(note) > self.small_reflection_max_chars:
                note = note[: self.small_reflection_max_chars - 1] + "…"
            ok = self.agent.diary.add_entry(
                text=note,
                source="small_reflection",
                meta={"hours": self.small_reflection_hours, "key": key},
            )
            if ok:
                self._last_small_key = key
                logger.info("Добавлена малая рефлексия за блок %s", key)
                return note
            return ""
        except Exception as e:
            logger.error("Ошибка small_reflection: %s", e)
            return ""

    def _parse_iso_ts(self, raw: str) -> Optional[datetime]:
        from core.runtime.timeutil import parse_ts

        return parse_ts(raw)

    def _diary_lines_from_hub(self, hub, cutoff: datetime) -> str:
        from core.runtime.timeutil import to_local

        rows: list[tuple[datetime, str]] = []
        try:
            notes = hub.list_diary_notes(limit=300, newest_first=True)
        except Exception as e:
            logger.error("Ошибка чтения дневника из Hub за 24ч: %s", e)
            return ""
        cutoff_local = to_local(cutoff)
        for item in notes:
            ts = self._parse_iso_ts(str(item.get("ts") or ""))
            if ts is None:
                continue
            ts_local = to_local(ts)
            # No early-break: TEXT ORDER BY ts is not chronological across mixed offsets.
            if ts_local < cutoff_local:
                continue
            source = str(item.get("source") or "unknown")
            text = str(item.get("text") or "").strip()
            if text:
                rows.append(
                    (ts_local, f"[{ts_local.strftime('%Y-%m-%d %H:%M')} | {source}] {text}")
                )
        rows.sort(key=lambda x: x[0])
        return "\n".join(line for _, line in rows)

    def _diary_lines_from_agent(self, cutoff: datetime) -> str:
        """No-Hub path: read agent.diary in-memory (_local via recent()), never JSONL files."""
        from core.runtime.timeutil import to_local

        agent = getattr(self, "agent", None)
        diary = getattr(agent, "diary", None) if agent is not None else None
        if diary is None:
            return ""
        cutoff_local = to_local(cutoff)
        rows: list[tuple[datetime, str]] = []
        try:
            items = diary.recent(limit=500)
        except Exception as e:
            logger.error("Ошибка чтения дневника из agent.diary: %s", e)
            return ""
        for item in items:
            if not isinstance(item, dict):
                continue
            ts = self._parse_iso_ts(str(item.get("timestamp") or item.get("ts") or ""))
            if ts is None:
                continue
            ts_local = to_local(ts)
            if ts_local < cutoff_local:
                continue
            source = str(item.get("source") or "unknown")
            text = str(item.get("text") or "").strip()
            if text:
                rows.append(
                    (ts_local, f"[{ts_local.strftime('%Y-%m-%d %H:%M')} | {source}] {text}")
                )
        rows.sort(key=lambda x: x[0])
        return "\n".join(line for _, line in rows)

    def _get_diary_last_24h(self) -> str:
        """Diary for nightly reflect: Hub SQLite when attached, else agent.diary RAM."""
        from core.runtime.timeutil import cutoff_hours

        cutoff = cutoff_hours(24)
        hub = self._memory_hub()
        if hub is not None:
            return self._diary_lines_from_hub(hub, cutoff)
        return self._diary_lines_from_agent(cutoff)

    def _chat_lines_from_hub(self, *, cutoff: Optional[datetime] = None, date_str: Optional[str] = None) -> str:
        from core.runtime.timeutil import to_local

        hub = self._memory_hub()
        if hub is None:
            return ""
        rows_out: list[tuple[datetime, str]] = []
        try:
            rows = hub.list_chat(limit=500, newest_first=True)
        except Exception as e:
            logger.error("Ошибка чтения chat_log из Hub: %s", e)
            return ""
        cutoff_local = to_local(cutoff) if cutoff is not None else None
        for item in rows:
            ts = self._parse_iso_ts(str(item.get("ts") or ""))
            if ts is None:
                continue
            ts_local = to_local(ts)
            # No early-break: mixed UTC/local ISO TEXT order is not chronological.
            if cutoff_local is not None and ts_local < cutoff_local:
                continue
            if date_str is not None and ts_local.strftime("%Y-%m-%d") != date_str:
                continue
            role = str(item.get("role") or "?")
            who = str(item.get("display_name") or item.get("user_id") or role)
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            rows_out.append(
                (ts_local, f"[{ts_local.strftime('%Y-%m-%d %H:%M:%S')}] {who}: {text}")
            )
        rows_out.sort(key=lambda x: x[0])
        return "\n".join(line for _, line in rows_out)

    def _get_logs_for_date(self, date: datetime) -> str:
        """Читает строки чата за указанную дату (Hub SQLite при наличии, иначе chat.log)."""
        date_str = date.strftime("%Y-%m-%d")
        if self._memory_hub() is not None:
            return self._chat_lines_from_hub(date_str=date_str)
        if not self.chat_log_path.exists():
            return ""
        lines = []
        try:
            for line in self.chat_log_path.read_text(encoding="utf-8").splitlines():
                if date_str in line:
                    lines.append(line)
        except Exception as e:
            logger.error(f"Ошибка чтения chat.log: {e}")
        return "\n".join(lines)

    def _get_logs_for_last_hour(self) -> str:
        """Читает свежие строки чата за последний час."""
        return self._get_logs_for_last_hours(1)

    def _get_logs_for_last_hours(self, hours: int) -> str:
        """Читает строки чата за последние N часов (Hub SQLite при наличии, иначе chat.log)."""
        from core.runtime.timeutil import cutoff_hours

        cutoff = cutoff_hours(max(1, int(hours)))
        if self._memory_hub() is not None:
            return self._chat_lines_from_hub(cutoff=cutoff)
        if not self.chat_log_path.exists():
            return ""
        lines: list[str] = []
        try:
            for line in self.chat_log_path.read_text(encoding="utf-8").splitlines():
                if not line.startswith("[") or "]" not in line:
                    continue
                ts_str = line[1 : line.find("]")]
                try:
                    ts = datetime.strptime(ts_str, "%Y-%m-%d %H:%M:%S")
                except Exception:
                    continue
                # chat.log lines are naive local wall time — compare in host local
                from core.runtime.timeutil import to_local

                if to_local(ts) >= cutoff:
                    lines.append(line)
        except Exception as e:
            logger.error("Ошибка чтения chat.log за %s часов: %s", hours, e)
        return "\n".join(lines)

    @staticmethod
    def _extract_json_blob(raw: str) -> str:
        t = (raw or "").strip()
        if not t:
            return ""
        if t.startswith("```"):
            lines = t.splitlines()
            if lines and lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].startswith("```"):
                lines = lines[:-1]
            t = "\n".join(lines).strip()
        start = t.find("{")
        end = t.rfind("}")
        if start >= 0 and end > start:
            return t[start : end + 1]
        return t

    async def _analyze_diary_json(self, diary_24h: str, date_str: str) -> dict:
        """LLM-анализ дневника за 24ч в строгий JSON."""
        if self.agent is None:
            return {
                "people_updates": [],
                "global_lore": [],
                "behavior_rules": [],
            }

        prompt = (
            "Ты аналитический модуль памяти Нейры. Верни ответ СТРОГО в JSON без пояснений и markdown.\n"
            "Формат:\n"
            "{\n"
            '  "people_updates": [{"person_hint":"...", "fact":"..."}],\n'
            '  "global_lore": ["..."],\n'
            '  "behavior_rules": ["..."]\n'
            "}\n"
            "Ограничения:\n"
            "- Только факты/мемы/правила из лога ниже.\n"
            "- behavior_rules: максимум 2 пункта.\n"
            "- Если данных нет: пустые массивы.\n\n"
            f"Дата: {date_str}\n"
            f"Лог дневника за 24 часа:\n{diary_24h[:12000]}"
        )

        try:
            from langchain_core.messages import HumanMessage
            llm_reflect = getattr(self.agent, "llm_memory", None) or getattr(
                self.agent, "llm_reflection", self.agent.llm
            )
            from core.llm.retry import ainvoke_with_rate_limit_backoff

            response = await ainvoke_with_rate_limit_backoff(
                llm_reflect, [HumanMessage(content=prompt)], lane="memory_model"
            )
            raw = str(response.content).strip()
            blob = self._extract_json_blob(raw)
            data = json.loads(blob)
            return {
                "people_updates": list(data.get("people_updates") or []),
                "global_lore": list(data.get("global_lore") or []),
                "behavior_rules": list(data.get("behavior_rules") or [])[:2],
            }
        except Exception as e:
            logger.error("Ошибка LLM-анализа рефлексии: %s", e)
            return {"people_updates": [], "global_lore": [], "behavior_rules": []}

    @staticmethod
    def _compact_summary(data: dict) -> str:
        fu = len(list(data.get("people_updates") or []))
        gl = len(list(data.get("global_lore") or []))
        br = len(list(data.get("behavior_rules") or []))
        return f"Self-reflection: people_updates={fu}, global_lore={gl}, behavior_rules={br}"

    async def hourly_diary_note(self) -> str:
        """Пишет почасовую заметку в личный дневник Нейры."""
        if not self.agent or not hasattr(self.agent, "diary"):
            return ""

        now = datetime.now()
        hour_key = now.strftime("%Y-%m-%d %H")
        if self._last_hourly_key == hour_key:
            return ""  # уже писали в этот час

        logs = self._get_logs_for_last_hour()
        if len([x for x in logs.splitlines() if x.strip()]) < self.diary_hourly_min_lines:
            return ""

        prompt = (
            "Сделай ОДНУ короткую заметку (1-3 предложения) для личного дневника Нейры "
            "по диалогам за последний час. От первого лица, разговорно: что заметила в людях, "
            "настроении, темах. Без markdown и списков.\n\n"
            f"Логи за час:\n{logs[:3500]}"
        )
        try:
            from langchain_core.messages import HumanMessage

            llm_reflect = getattr(self.agent, "llm_memory", None) or getattr(
                self.agent, "llm_reflection", self.agent.llm
            )
            from core.llm.retry import ainvoke_with_rate_limit_backoff

            response = await ainvoke_with_rate_limit_backoff(
                llm_reflect, [HumanMessage(content=prompt)], lane="memory_model"
            )
            note = str(response.content).strip()
            if not note:
                return ""
            ok = self.agent.diary.add_entry(
                text=note,
                source="hourly_auto",
                meta={"hour": hour_key},
            )
            if ok:
                self._last_hourly_key = hour_key
                logger.info("Добавлена почасовая запись дневника за %s", hour_key)
                return note
            return ""
        except Exception as e:
            logger.error("Ошибка hourly_diary_note: %s", e)
            return ""

    def _ltm_scheduled_prune_job(self) -> None:
        from core.memory.ltm_maintenance import run_scheduled_prune

        if self.agent is None:
            return
        run_scheduled_prune(self.agent, self.config)

    async def _ltm_scheduled_summarize_job(self) -> None:
        from core.memory.ltm_maintenance import run_scheduled_summarize

        if self.agent is None:
            return
        await run_scheduled_summarize(self.agent, self.config)

    def start_scheduler(self):
        """Запускает APScheduler для ночной рефлексии."""
        try:
            from apscheduler.schedulers.asyncio import AsyncIOScheduler

            hour, minute = map(int, self.reflection_time.split(":"))
            scheduler = AsyncIOScheduler()
            scheduler.add_job(
                self.reflect,
                trigger="cron",
                hour=hour,
                minute=minute,
                id="nightly_reflection",
                kwargs={"force": False},
            )
            if self.small_reflection_enabled:
                scheduler.add_job(
                    self.small_reflection,
                    trigger="cron",
                    hour=f"*/{self.small_reflection_hours}",
                    minute=15,
                    id="small_reflection",
                )
            if self.diary_hourly_enabled:
                scheduler.add_job(
                    self.hourly_diary_note,
                    trigger="cron",
                    minute=0,
                    id="hourly_diary_note",
                )
            mem_cfg = self.config.get("memory") or {}
            ap_cfg = mem_cfg.get("ltm_auto_prune") if isinstance(mem_cfg.get("ltm_auto_prune"), dict) else {}
            if ap_cfg.get("enabled"):
                hours = max(1, int(ap_cfg.get("interval_hours", 168)))
                scheduler.add_job(
                    self._ltm_scheduled_prune_job,
                    trigger="interval",
                    hours=hours,
                    id="ltm_auto_prune",
                    replace_existing=True,
                )
                logger.info(
                    "LTM auto-prune: каждые %s ч | older_than_days=%s",
                    hours,
                    ap_cfg.get("older_than_days", 90),
                )
            sm_cfg = mem_cfg.get("ltm_auto_summarize") if isinstance(mem_cfg.get("ltm_auto_summarize"), dict) else {}
            if sm_cfg.get("enabled"):
                hours = max(1, int(sm_cfg.get("interval_hours", 720)))
                scheduler.add_job(
                    self._ltm_scheduled_summarize_job,
                    trigger="interval",
                    hours=hours,
                    id="ltm_auto_summarize",
                    replace_existing=True,
                )
                logger.info("LTM auto-summarize: каждые %s ч", hours)
            scheduler.start()
            logger.info(f"Рефлексия запланирована на {self.reflection_time} каждую ночь")
            if self.small_reflection_enabled:
                logger.info(
                    "Малая рефлексия: каждые %sч (minute=15)",
                    self.small_reflection_hours,
                )
            if self.diary_hourly_enabled:
                logger.info("Личный дневник: автозапись каждый час (minute=00)")
            return scheduler
        except ImportError:
            logger.warning("APScheduler не установлен. Рефлексия отключена.")
            return None

    def get_recent_journal(self, days: int = 7) -> str:
        """Возвращает записи журнала за последние N дней."""
        if self._memory_hub() is not None:
            self._hydrate_journal_from_hub()
        recent = self._journal[-days:] if self._journal else []
        if not recent:
            return "Журнал пустой."
        lines = []
        for entry in recent:
            date = entry.get("date") or "?"
            summary = entry.get("summary") or entry.get("text") or ""
            lines.append(f"[{date}] {summary}")
        return "\n".join(lines)
