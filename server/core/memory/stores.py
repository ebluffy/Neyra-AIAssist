"""
core/memory/stores.py — session/helper memory classes for Neyra
──────────────────────────────────────────────────────────────
• ShortTermMemory: sliding in-context window
• LongTermMemory: ChromaDB semantic index adapter
• PeopleDB / NeyraDiary: thin wrappers over Memory Hub SQLite (no file store)
"""

from __future__ import annotations

import json
import logging
import re
import sys
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("neyra.memory")


def _parse_metadata_timestamp(raw: Any) -> Optional[datetime]:
    """Парсит ISO timestamp из метаданных Chroma (UTC для сравнения)."""
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _chroma_flat_metadata(d: Optional[dict[str, Any]]) -> dict[str, str | int | float | bool]:
    """Chroma требует метаданные примитивами; длинные значения обрезаем."""
    if not d:
        return {}
    out: dict[str, str | int | float | bool] = {}
    for k, v in d.items():
        key = str(k)[:256]
        if v is None:
            continue
        if isinstance(v, bool):
            out[key] = v
        elif isinstance(v, int):
            out[key] = v
        elif isinstance(v, float):
            out[key] = v
        elif isinstance(v, str):
            out[key] = v[:8000]
        else:
            out[key] = str(v)[:8000]
    return out


def _configure_embedding_blas_env() -> None:
    """
    До импорта torch/sentence-transformers: один поток BLAS/OpenMP и совместимость
    нескольких OpenMP-рантаймов в одном процессе (на Windows часто рвёт процесс при
    загрузке эмбеддера параллельно с Uvicorn).
    """
    import os

    if sys.platform == "win32":
        os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    os.environ.setdefault("MKL_NUM_THREADS", "1")
    os.environ.setdefault("NUMEXPR_MAX_THREADS", "1")
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


# ─── Краткосрочная память (история чата) ─────────────────────────────────────

class ShortTermMemory:
    """Скользящее окно сообщений для текущего контекста."""

    def __init__(self, max_messages: int = 10):
        self.max_messages = max_messages
        self._history: list[dict] = []  # [{"role": "user"|"assistant", "content": "..."}]

    def add(self, role: str, content: str) -> None:
        self._history.append({"role": role, "content": content})
        # Обрезаем до max_messages (всегда пары)
        if len(self._history) > self.max_messages:
            self._history = self._history[-self.max_messages:]

    def get_history(self) -> list[dict]:
        return list(self._history)

    def clear(self) -> None:
        self._history.clear()

    def trim_to_half(self) -> None:
        """Обрезает историю до половины — используется при переполнении контекста."""
        half = max(2, len(self._history) // 2)
        self._history = self._history[-half:]
        logger.info(f"ShortTermMemory обрезана до {len(self._history)} сообщений")

    def __len__(self) -> int:
        return len(self._history)


# ─── Долгосрочная память (ChromaDB RAG) ──────────────────────────────────────

class LongTermMemory:
    """RAG-память на основе ChromaDB + sentence-transformers."""

    def __init__(self, config: dict):
        self.config = config
        mem_cfg = config.get("memory", {}) if isinstance(config.get("memory"), dict) else {}
        raw_chroma = mem_cfg.get("chroma_db_path", "./data/memory/chroma_db")
        from pathlib import Path as _P
        from core.runtime.paths import resolve_memory_path

        chroma = str(raw_chroma).strip()
        self.db_path = (
            chroma
            if _P(chroma).is_absolute()
            else str(resolve_memory_path(_P.cwd(), config, chroma, "./data/memory/chroma_db"))
        )
        self.embedding_model = mem_cfg.get(
            "embedding_model", "paraphrase-multilingual-mpnet-base-v2"
        )
        self.top_k = mem_cfg.get("rag_top_k", 3)
        self.rag_enabled = mem_cfg.get("rag_enabled", True)
        self._collection = None
        self._embedder = None
        self._init_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._initializing = False

        if not self.rag_enabled:
            logger.info("RAG отключён (rag_enabled: false). ChromaDB не загружается.")

    def initialize(self):
        """
        Явная инициализация — вызывай при старте агента.
        Грузит ChromaDB и embedder сразу, а не при первом запросе.
        """
        if not self.rag_enabled:
            return   # Пропускаем — torch/CUDA DLL не загружаются

        with self._init_lock:
            if self._collection is not None:
                return
            if self._initializing:
                return
            self._initializing = True

        try:
            _configure_embedding_blas_env()

            import chromadb
            from chromadb.config import Settings

            # КРИТИЧНО: скрываем GPU от torch ДО его импорта.
            # Иначе torch инициализирует CUDA и занимает pinned memory,
            # из-за чего Ollama не может загрузить модель (resource already mapped).
            import os
            _old_cuda = os.environ.get("CUDA_VISIBLE_DEVICES", None)
            os.environ["CUDA_VISIBLE_DEVICES"] = ""

            from sentence_transformers import SentenceTransformer

            # Восстанавливаем переменную если была
            if _old_cuda is not None:
                os.environ["CUDA_VISIBLE_DEVICES"] = _old_cuda
            else:
                del os.environ["CUDA_VISIBLE_DEVICES"]

            Path(self.db_path).mkdir(parents=True, exist_ok=True)

            client = chromadb.PersistentClient(
                path=self.db_path,
                settings=Settings(anonymized_telemetry=False),
            )
            self._collection = client.get_or_create_collection(
                name="neyra_dialogs",
                metadata={"hnsw:space": "cosine"},
            )
            logger.info(f"ChromaDB: {self.db_path} | {self._collection.count()} записей")

            logger.info(f"Загружаю embedding модель: {self.embedding_model} (CPU only)...")
            self._embedder = SentenceTransformer(self.embedding_model, device="cpu")
            try:
                import torch

                torch.set_num_threads(1)
                torch.set_num_interop_threads(1)
            except Exception:
                pass
            logger.info("Embedding модель загружена (CPU, без CUDA)")

        except ImportError as e:
            logger.warning(f"ChromaDB/sentence-transformers не установлены: {e}. RAG отключён.")
        except Exception as e:
            logger.error(f"Ошибка инициализации ChromaDB: {e}")
        finally:
            with self._init_lock:
                self._initializing = False

    def initialize_async(self) -> None:
        """Фоновая неблокирующая инициализация RAG/эмбеддера."""
        if not self.rag_enabled:
            return
        with self._init_lock:
            if self._collection is not None or self._initializing:
                return
        threading.Thread(target=self.initialize, name="neyra-rag-init", daemon=True).start()

    def _init(self):
        """Ленивая инициализация — fallback если initialize() не вызвали."""
        self.initialize()

    def save(self, user_msg: str, assistant_msg: str, metadata: Optional[dict] = None) -> None:
        """Сохраняет пару диалога в ChromaDB."""
        self._init()
        if self._collection is None or self._embedder is None:
            return

        try:
            text = f"Пользователь: {user_msg}\nНейра: {assistant_msg}"
            embedding = self._embedder.encode(text, show_progress_bar=False).tolist()
            doc_id = f"dialog_{datetime.now().isoformat()}"

            meta = {"timestamp": datetime.now().isoformat(), "type": "dialog"}
            if metadata:
                meta.update(_chroma_flat_metadata(metadata))

            with self._write_lock:
                self._collection.add(
                    ids=[doc_id],
                    embeddings=[embedding],
                    documents=[text],
                    metadatas=[meta],
                )
            logger.debug(f"Диалог сохранён в ChromaDB: {doc_id}")

        except Exception as e:
            logger.error(f"Ошибка сохранения в ChromaDB: {e}")

    def add_knowledge(self, text: str, metadata: Optional[dict[str, Any]] = None) -> tuple[bool, str]:
        """
        Добавляет один документ знаний в RAG (не формат «диалог»).
        Вызывается из Internal API и инструментов агента — одна точка записи в Chroma.
        """
        self._init()
        if not self.rag_enabled:
            return False, "RAG отключён (rag_enabled: false)"
        if self._collection is None or self._embedder is None:
            return False, "ChromaDB или эмбеддер не инициализированы"
        raw = (text or "").strip()
        if not raw:
            return False, "Пустой текст"

        try:
            meta = _chroma_flat_metadata(metadata)
            if "type" not in meta:
                meta["type"] = "knowledge"
            meta["timestamp"] = datetime.now().isoformat()
            embedding = self._embedder.encode(raw, show_progress_bar=False).tolist()
            doc_id = f"knowledge_{uuid.uuid4().hex}"
            with self._write_lock:
                self._collection.add(
                    ids=[doc_id],
                    embeddings=[embedding],
                    documents=[raw],
                    metadatas=[meta],
                )
            logger.info("Добавлен документ знаний в ChromaDB: %s", doc_id)
            return True, doc_id
        except Exception as e:
            logger.error("Ошибка add_knowledge: %s", e)
            return False, str(e)[:500]

    def encode_texts(self, texts: list[str]) -> list[list[float]]:
        """Пакетные эмбеддинги для офлайн-кластеризации LTM (CPU, тот же embedder что и RAG)."""
        self._init()
        if self._collection is None or self._embedder is None:
            return []
        if not texts:
            return []
        try:
            raw = self._embedder.encode(
                texts,
                show_progress_bar=False,
                batch_size=min(32, max(1, len(texts))),
            )
            if hasattr(raw, "tolist"):
                raw = raw.tolist()
            out: list[list[float]] = []
            for row in raw:
                if isinstance(row, (int, float)):
                    out.append([float(row)])
                else:
                    out.append([float(x) for x in row])
            return out
        except Exception as e:
            logger.error("encode_texts failed: %s", e)
            return []

    def search(
        self,
        query: str,
        n_results: Optional[int] = None,
        *,
        user_id: Optional[str] = None,
    ) -> list[str]:
        """Semantic search. When ``user_id`` set — only that user's docs + shared knowledge."""
        self._init()
        if self._collection is None or self._embedder is None:
            return []

        try:
            k = n_results or self.top_k
            count = self._collection.count()
            if count == 0:
                return []

            k = min(k, count)
            uid = str(user_id or "").strip()
            fetch_k = min(count, max(k * 5, k) if uid else k)
            embedding = self._embedder.encode(query, show_progress_bar=False).tolist()
            q_kwargs: dict[str, Any] = {
                "query_embeddings": [embedding],
                "n_results": fetch_k,
                "include": ["documents", "metadatas"],
            }
            used_where = False
            if uid:
                try:
                    # Shared = knowledge only. session_archive_digest is owner-scoped.
                    q_kwargs["where"] = {
                        "$or": [
                            {"user_id": uid},
                            {"type": "knowledge"},
                        ]
                    }
                    used_where = True
                    results = self._collection.query(**q_kwargs)
                except Exception as where_e:
                    logger.debug("Chroma where filter failed, post-filter: %s", where_e)
                    q_kwargs.pop("where", None)
                    used_where = False
                    results = self._collection.query(**q_kwargs)
            else:
                results = self._collection.query(**q_kwargs)

            docs = (results.get("documents") or [[]])[0] or []
            metas = (results.get("metadatas") or [[]])[0] or []
            if not uid:
                return list(docs[:k])

            out: list[str] = []
            for doc, meta in zip(docs, metas):
                if not doc:
                    continue
                m = meta if isinstance(meta, dict) else {}
                typ = str(m.get("type") or "").strip().lower()
                owner = str(m.get("user_id") or "").strip()
                # Shared knowledge only; digests/dialogs require matching owner.
                if owner == uid or typ == "knowledge":
                    out.append(doc)
                elif not used_where and not owner and typ in ("", "dialog", "chat"):
                    # Ambiguous legacy dialog without user_id — skip when scoping
                    continue
            return out[:k]

        except Exception as e:
            logger.error(f"Ошибка поиска в ChromaDB: {e}")
            return []

    def count(self) -> int:
        self._init()
        if self._collection is None:
            return 0
        try:
            return self._collection.count()
        except Exception:
            return 0

    def backup_to(self, dest: Path | str) -> str:
        """Consistent Chroma dir backup under write lock (sqlite3.backup for chroma.sqlite3)."""
        import shutil
        import sqlite3

        src = Path(self.db_path)
        dest_p = Path(dest)
        if not src.exists():
            # Nothing to back up yet (async init may not have created the dir).
            return ""
        with self._write_lock:
            if dest_p.exists():
                if dest_p.is_dir():
                    shutil.rmtree(dest_p)
                else:
                    dest_p.unlink()
            dest_p.mkdir(parents=True, exist_ok=True)
            if src.is_file():
                dst_db = sqlite3.connect(str(dest_p / src.name))
                try:
                    src_db = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
                    try:
                        src_db.backup(dst_db)
                    finally:
                        src_db.close()
                finally:
                    dst_db.close()
                return str(dest_p)
            for item in src.iterdir():
                target = dest_p / item.name
                if item.name == "chroma.sqlite3" or item.suffix == ".sqlite3":
                    dst_db = sqlite3.connect(str(target))
                    try:
                        src_db = sqlite3.connect(f"file:{item}?mode=ro", uri=True)
                        try:
                            src_db.backup(dst_db)
                        finally:
                            src_db.close()
                    finally:
                        dst_db.close()
                elif item.is_dir():
                    shutil.copytree(item, target, dirs_exist_ok=True)
                else:
                    shutil.copy2(item, target)
            return str(dest_p)

    def clear_all(self) -> int:
        """Delete every document in the Chroma collection. Returns removed count."""
        self._init()
        if self._collection is None:
            return 0
        try:
            batch = self._collection.get(include=[])
            ids = list(batch.get("ids") or [])
            if not ids:
                return 0
            # chromadb delete in chunks
            n = 0
            chunk = 200
            with self._write_lock:
                for i in range(0, len(ids), chunk):
                    part = ids[i : i + chunk]
                    self._collection.delete(ids=part)
                    n += len(part)
            logger.info("ChromaDB clear_all: removed %s docs", n)
            return n
        except Exception as e:
            logger.error("ChromaDB clear_all failed: %s", e)
            return 0

    def _iter_all_documents(self) -> list[tuple[str, dict[str, Any], str]]:
        """Все документы коллекции (ids + meta + text). Для обслуживания / prune."""
        self._init()
        if self._collection is None:
            return []
        try:
            batch = self._collection.get(include=["metadatas", "documents"])
            ids = batch.get("ids") or []
            metas = batch.get("metadatas") or []
            docs = batch.get("documents") or []
            out: list[tuple[str, dict[str, Any], str]] = []
            for i, doc_id in enumerate(ids):
                meta = metas[i] if i < len(metas) and metas[i] else {}
                doc = docs[i] if i < len(docs) else ""
                out.append((doc_id, dict(meta) if meta else {}, doc or ""))
            return out
        except Exception as e:
            logger.error("ChromaDB get failed: %s", e)
            return []

    def select_older_than(
        self,
        older_than_days: float,
        *,
        types: Optional[list[str]] = None,
    ) -> list[tuple[str, dict[str, Any], str]]:
        """Записи с timestamp старше порога; без timestamp не трогаем (совместимость)."""
        self._init()
        if self._collection is None:
            return []
        cutoff = datetime.now(timezone.utc) - timedelta(days=older_than_days)
        type_set = set(types) if types else None
        selected: list[tuple[str, dict[str, Any], str]] = []
        for doc_id, meta, doc in self._iter_all_documents():
            if str(meta.get("ltm_priority") or "") == "pinned":
                continue
            ts = _parse_metadata_timestamp(meta.get("timestamp"))
            if ts is None:
                continue
            if ts >= cutoff:
                continue
            dtype = str(meta.get("type") or "dialog")
            if type_set is not None and dtype not in type_set:
                continue
            selected.append((doc_id, meta, doc))
        return selected

    def prune_older_than(
        self,
        older_than_days: float,
        *,
        types: Optional[list[str]] = None,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        """Удаляет из Chroma записи старше порога (TTL-подобная очистка)."""
        rows = self.select_older_than(older_than_days, types=types)
        ids = [r[0] for r in rows]
        if dry_run:
            return {"dry_run": True, "matched": len(ids), "deleted": 0, "sample_ids": ids[:40]}
        if not ids:
            return {"dry_run": False, "matched": 0, "deleted": 0}
        deleted = 0
        chunk = 400
        with self._write_lock:
            for i in range(0, len(ids), chunk):
                part = ids[i : i + chunk]
                self._collection.delete(ids=part)
                deleted += len(part)
        logger.info("LTM prune: удалено %s записей (старше %s дн.)", deleted, older_than_days)
        return {"dry_run": False, "matched": len(ids), "deleted": deleted}

    def archive_row_tuples(
        self,
        rows: list[tuple[str, dict[str, Any], str]],
        archive_dir: Path,
        *,
        file_name_suffix: str = "",
    ) -> dict[str, Any]:
        """
        Cold archive для явного набора (id, meta, document): JSONL + delete из Chroma.
        Используется консолидацией LTM по кластерам (частичный откат = не трогаем неуспешные id).
        """
        self._init()
        if self._collection is None:
            return {"dry_run": False, "archived": 0, "deleted_from_chroma": 0, "archive_path": None, "error": "no_collection"}
        ids = [r[0] for r in rows]
        if not ids:
            return {"dry_run": False, "archived": 0, "deleted_from_chroma": 0, "archive_path": None}
        archive_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        safe_suffix = re.sub(r"[^\w.\-]+", "_", (file_name_suffix or "")[:80]).strip("_")
        mid = f"_{safe_suffix}" if safe_suffix else ""
        path = archive_dir / f"ltm_archive{mid}_{stamp}.jsonl"
        with path.open("w", encoding="utf-8") as f:
            for doc_id, meta, doc in rows:
                rec = {"id": doc_id, "metadata": meta, "document": doc}
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        deleted = 0
        with self._write_lock:
            for i in range(0, len(ids), 400):
                part = ids[i : i + 400]
                self._collection.delete(ids=part)
                deleted += len(part)
        logger.info("LTM archive: %s строк → %s, удалено из Chroma: %s", len(ids), path, deleted)
        return {
            "dry_run": False,
            "archived": len(ids),
            "deleted_from_chroma": deleted,
            "archive_path": str(path),
        }

    def delete_document_ids(self, doc_ids: list[str]) -> int:
        """Удаление документов по id (откат частично добавленных digest при ошибке)."""
        self._init()
        if self._collection is None or not doc_ids:
            return 0
        deleted = 0
        with self._write_lock:
            for i in range(0, len(doc_ids), 400):
                part = doc_ids[i : i + 400]
                self._collection.delete(ids=part)
                deleted += len(part)
        if deleted:
            logger.info("LTM delete_document_ids: удалено %s записей", deleted)
        return deleted

    def archive_older_than(
        self,
        older_than_days: float,
        archive_dir: Path,
        *,
        types: Optional[list[str]] = None,
        dry_run: bool = False,
        max_entries: int = 2000,
    ) -> dict[str, Any]:
        """
        Cold archive: выгружает старые записи в JSONL и удаляет их из Chroma.
        Используется перед summarize или как самостоятельная операция.
        """
        rows = self.select_older_than(older_than_days, types=types)
        if len(rows) > max_entries:
            rows = rows[:max_entries]
        ids = [r[0] for r in rows]
        if dry_run:
            return {
                "dry_run": True,
                "would_archive": len(ids),
                "archive_path": None,
                "truncated_to_max": False,
            }
        if not ids:
            return {"dry_run": False, "archived": 0, "deleted_from_chroma": 0, "archive_path": None}
        return self.archive_row_tuples(rows, archive_dir, file_name_suffix="bulk")


# ─── PeopleDB — досье на людей ───────────────────────────────────────────────

class PeopleDB:
    """
    Досье на каждого человека.
    Источник истины: Memory Hub SQLite (см. MemoryHub) при подключении — никакого файлового
    стора не существует. Без Hub (консольный/аварийный сценарий) кэш живёт только в памяти
    процесса и не переживает рестарт.
    Идентификация: discord_user_id > ник > имя
    """

    def __init__(self, config: dict):
        self._cache: dict[str, dict] = {}
        self.memory_hub = None  # set by agent after MemoryHub init

    def find(self, identifier: str, discord_id: Optional[str] = None) -> Optional[dict]:
        """Exact lookup by discord_id, person id, or alias (no fuzzy/substring)."""
        hub = getattr(self, "memory_hub", None)
        if hub is not None:
            return hub.find_person(identifier, discord_id=discord_id)
        identifier_lower = (identifier or "").strip().lower()
        for person in self._cache.values():
            if discord_id and discord_id in person.get("discord_ids", []):
                return person
            if not identifier_lower:
                continue
            if str(person.get("id") or "").lower() == identifier_lower:
                return person
            names_lower = [n.lower() for n in person.get("names", []) if n]
            if identifier_lower in names_lower:
                return person
        return None

    def get_all_names_map(self) -> dict[str, str]:
        """Возвращает словарь {ник_нижний_регистр: person_id} для быстрого поиска."""
        result = {}
        for pid, person in self._cache.items():
            for name in person.get("names", []):
                result[name.lower()] = pid
        return result

    def update_fact(self, person_id: str, fact: str, emotion: Optional[str] = None) -> bool:
        """Добавляет новый динамический факт о человеке; опционально — реакция персонажа (эмоция)."""
        if person_id not in self._cache:
            logger.warning(f"PeopleDB: человек не найден: {person_id}")
            return False

        entry: dict[str, Any] = {
            "date": datetime.now().strftime("%Y-%m-%d"),
            "fact": fact,
        }
        em = (emotion or "").strip()
        if em:
            entry["emotion"] = em[:500]
        prev_facts = list(self._cache[person_id].get("dynamic_facts") or [])
        prev_seen = self._cache[person_id].get("last_seen")
        self._cache[person_id].setdefault("dynamic_facts", []).append(entry)
        self._cache[person_id]["last_seen"] = datetime.now().isoformat()
        logger.info(f"PeopleDB: факт добавлен [{person_id}]: {fact}")
        hub = getattr(self, "memory_hub", None)
        hub_ok = False
        if hub is not None:
            try:
                person = self._cache[person_id]
                hub.add_person_fact(
                    person_id,
                    fact,
                    emotion_note=em or None,
                    source="people_db",
                    person_meta=person,
                    aliases=list(person.get("names") or []),
                    display_name=(person.get("names") or [person_id])[0],
                )
                hub_ok = True
            except Exception as e:
                logger.warning("PeopleDB→Hub dual-write failed: %s", e)
        if hub is not None and not hub_ok:
            self._cache[person_id]["dynamic_facts"] = prev_facts
            self._cache[person_id]["last_seen"] = prev_seen
            logger.error(
                "PeopleDB: Hub write failed — fact dropped (no file fallback when Hub attached) [%s]",
                person_id,
            )
            return False
        return True

    def link_discord_id(self, person_id: str, discord_id: str) -> bool:
        """Привязывает Discord User ID к существующему досье."""
        if person_id not in self._cache:
            logger.warning(f"PeopleDB: не найден для привязки: {person_id}")
            return False
        ids = self._cache[person_id].setdefault("discord_ids", [])
        if discord_id in ids:
            return False  # Уже привязан
        prev_ids = list(ids)
        ids.append(discord_id)
        hub = getattr(self, "memory_hub", None)
        hub_ok = False
        if hub is not None:
            try:
                person = self._cache[person_id]
                hub.upsert_person(
                    person_id,
                    display_name=(person.get("names") or [person_id])[0],
                    aliases=list(person.get("names") or []),
                    meta=person,
                )
                hub.sqlite.upsert_person_account(
                    person_id=person_id,
                    platform="discord",
                    platform_user_id=str(discord_id).strip(),
                    handle=None,
                )
                hub_ok = True
            except Exception as e:
                logger.warning("PeopleDB→Hub link_discord_id failed: %s", e)
        if hub is not None and not hub_ok:
            self._cache[person_id]["discord_ids"] = prev_ids
            logger.error(
                "PeopleDB: Hub link failed — discord_id rolled back (no file fallback when Hub attached) [%s]",
                person_id,
            )
            return False
        logger.info(f"PeopleDB: привязан Discord ID {discord_id} → {person_id}")
        return True

    def add_person(self, person_id: str, names: list[str], discord_ids: Optional[list] = None) -> dict:
        """Создаёт новое досье."""
        person = {
            "id": person_id,
            "names": names,
            "discord_ids": discord_ids or [],
            "static_facts": {},
            "dynamic_facts": [],
            "last_seen": datetime.now().isoformat(),
        }
        self._cache[person_id] = person
        logger.info(f"PeopleDB: создано новое досье [{person_id}]")
        hub = getattr(self, "memory_hub", None)
        hub_ok = False
        if hub is not None:
            try:
                hub.upsert_person(
                    person_id,
                    display_name=(names or [person_id])[0],
                    aliases=list(names or []),
                    meta=person,
                )
                hub_ok = True
            except Exception as e:
                logger.warning("PeopleDB→Hub upsert failed: %s", e)
        if hub is not None and not hub_ok:
            self._cache.pop(person_id, None)
            logger.error(
                "PeopleDB: Hub upsert failed — person dropped (no file fallback when Hub attached) [%s]",
                person_id,
            )
            return {}
        return person

    def hydrate_from_hub(self, hub: Any) -> int:
        """Fill in-memory cache from Hub SQLite (needed after cutover / restart)."""
        if hub is None:
            return 0
        loaded = 0
        try:
            people = hub.list_people()
        except Exception as e:
            logger.warning("PeopleDB.hydrate_from_hub failed: %s", e)
            return 0
        for person in people:
            pid = str(person.get("id") or "").strip()
            if not pid:
                continue
            try:
                facts = hub.list_person_facts(pid, limit=100)
                dyn = []
                for f in reversed(facts):
                    row: dict[str, Any] = {
                        "date": str(f.get("created_at") or "")[:10],
                        "fact": str(f.get("fact") or ""),
                    }
                    emo = str(f.get("emotion_note") or "").strip()
                    if emo:
                        row["emotion"] = emo
                    if row["fact"]:
                        dyn.append(row)
                merged = dict(person)
                merged["dynamic_facts"] = dyn
                self._cache[pid] = merged
                loaded += 1
            except Exception as e:
                logger.debug("PeopleDB hydrate %s: %s", pid, e)
        if loaded:
            logger.info("PeopleDB hydrated from Hub SQLite: %s people", loaded)
        return loaded

    def get_summary(self, person_id: str) -> str:
        """Возвращает краткое текстовое досье для инжекта в промпт."""
        person = self._cache.get(person_id)
        if not person:
            return ""

        lines = [f"Досье на {person['names'][0]}:"]
        
        # Инжектим Discord ID для правильного пинга
        if person.get("discord_ids") and len(person["discord_ids"]) > 0:
            discord_id = person["discord_ids"][0]
            lines.append(f"  Discord пинг (ИСПОЛЬЗУЙ ЧТОБЫ ТЕГНУТЬ ЕГО): <@{discord_id}>")

        if person.get("static_facts"):
            for k, v in person["static_facts"].items():
                lines.append(f"  {k}: {v}")

        if person.get("dynamic_facts"):
            lines.append("  Новые факты:")
            # Последние 5 фактов
            for fact_entry in person["dynamic_facts"][-5:]:
                fact_line = str(fact_entry.get("fact") or "")
                emo = str(fact_entry.get("emotion") or "").strip()
                if emo:
                    lines.append(f"    [{fact_entry['date']}] {fact_line} (настроение Нейры при записи: {emo})")
                else:
                    lines.append(f"    [{fact_entry['date']}] {fact_line}")

        return "\n".join(lines)

    def get_context_for_prompt(self, mentioned_names: list[str]) -> str:
        """
        Принимает список имён упомянутых в запросе,
        возвращает блок с их досье для инжекта в промпт.
        """
        summaries = []
        name_map = self.get_all_names_map()

        for name in mentioned_names:
            pid = name_map.get(name.lower())
            if pid:
                summary = self.get_summary(pid)
                if summary:
                    summaries.append(summary)

        return "\n\n".join(summaries) if summaries else ""
# ─── Личный дневник Нейры ────────────────────────────────────────────────────

class NeyraDiary:
    """
    Личный дневник Нейры (наблюдения/мысли).
    Источник истины: Memory Hub SQLite при подключении — JSONL как активный стор не
    существует (не пишется, не читается, не триммится). Без Hub (консольный/аварийный
    сценарий) записи живут только в памяти процесса и не переживают рестарт.
    """

    def __init__(self, config: dict):
        mem_cfg = config.get("memory", {})
        self.max_entries = int(mem_cfg.get("diary_max_entries", 5000))
        self.memory_hub = None  # set by agent after MemoryHub init
        self._local: list[dict] = []  # only used when no Hub is attached

    def add_entry(self, text: str, source: str = "manual", meta: Optional[dict] = None) -> bool:
        text = (text or "").strip()
        if not text:
            return False
        entry = {
            "timestamp": datetime.now().isoformat(),
            "source": source,
            "text": text,
            "meta": meta or {},
        }
        hub = getattr(self, "memory_hub", None)
        if hub is None:
            # No Hub: in-memory only for this process (no file fallback).
            self._local.append(entry)
            if len(self._local) > self.max_entries:
                self._local = self._local[-self.max_entries :]
            return True
        try:
            emo = None
            if isinstance(meta, dict):
                emo = meta.get("emotion") or meta.get("assistant_emotion")
            hub.add_diary_note(
                text,
                source=source,
                emotion=str(emo)[:500] if emo else None,
                meta=meta,
                ts=entry["timestamp"],
            )
            return True
        except Exception as e:
            logger.error(
                "NeyraDiary: Hub write failed — entry dropped (no file fallback when Hub attached): %s",
                e,
            )
            return False

    def recent(self, limit: int = 10) -> list[dict]:
        hub = getattr(self, "memory_hub", None)
        if hub is not None:
            try:
                rows = hub.list_diary_notes(limit=max(1, int(limit)), newest_first=True)
                # oldest→newest for parity with a chronological tail
                return list(reversed(rows)) if rows else []
            except Exception as e:
                logger.warning("NeyraDiary.recent Hub read failed: %s", e)
                return []
        return self._local[-max(1, int(limit)) :]

    def recent_text(self, limit: int = 10) -> str:
        """Format recent entries locally (never call hub.diary_recent_text — would recurse)."""
        items = self.recent(limit=limit)
        if not items:
            return ""
        lines = []
        for e in items:
            ts = e.get("timestamp") or e.get("ts") or ""
            src = e.get("source", "manual")
            txt = str(e.get("text", "")).strip()
            if txt:
                meta = e.get("meta") or {}
                emo = str(meta.get("emotion") or meta.get("assistant_mood") or e.get("emotion") or "").strip()
                suf = f" | настр.: {emo}" if emo else ""
                lines.append(f"[{ts} | {src}{suf}] {txt}")
        return "\n".join(lines)
