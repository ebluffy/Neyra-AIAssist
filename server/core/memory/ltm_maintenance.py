"""
Долговременная память (Chroma): обслуживание и фоновые джобы (этап B3).
Общая логика для Internal API и планировщика.

Консолидация «во сне»: группировка старых записей по косинусной близости эмбеддингов,
несколько вызовов memory_model по кластерам, архив только успешно обработанных id
(неуспешные остаются в Chroma — предсказуемое поведение без «дыр»).
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("neyra.ltm")


def project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def resolve_ltm_archive_dir(config: dict, root: Optional[Path] = None) -> Path:
    root = root or project_root()
    mem_cfg = config.get("memory") if isinstance(config.get("memory"), dict) else {}
    raw_chroma = mem_cfg.get("chroma_db_path", "./data/memory/chroma_db")
    chroma_path = Path(str(raw_chroma)).expanduser()
    if not chroma_path.is_absolute():
        chroma_path = (root / chroma_path).resolve()
    sub = str(mem_cfg.get("ltm_archive_dir", "ltm_archive")).strip() or "ltm_archive"
    arch = Path(sub).expanduser()
    return arch if arch.is_absolute() else chroma_path.parent / arch


def _read_cluster_merge_cfg(mem_cfg: dict[str, Any]) -> dict[str, Any]:
    raw = mem_cfg.get("ltm_cluster_merge") if isinstance(mem_cfg.get("ltm_cluster_merge"), dict) else {}
    return {
        "enabled": bool(raw.get("enabled", True)),
        "similarity_threshold": float(raw.get("similarity_threshold", 0.86)),
        "max_cluster_chars": max(8_000, int(raw.get("max_cluster_chars", 95_000))),
        "log_dir": str(raw.get("log_dir", "./data/memory/ltm_consolidation")).strip() or "./data/memory/ltm_consolidation",
    }


def _l2_normalize(vec: list[float]) -> list[float]:
    s = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / s for x in vec]


def _cos_sim(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def _assign_clusters(
    norms: list[list[float]],
    doc_lens: list[int],
    *,
    threshold: float,
    max_cluster_chars: int,
) -> list[list[int]]:
    """Жадная кластеризация по максимальной косинусной близости к любому члену кластера."""
    clusters: list[list[int]] = []
    cluster_chars: list[int] = []

    for i in range(len(norms)):
        candidates: list[tuple[float, int]] = []
        for ci, idxs in enumerate(clusters):
            mx = max(_cos_sim(norms[i], norms[j]) for j in idxs)
            if mx >= threshold and cluster_chars[ci] + doc_lens[i] <= max_cluster_chars:
                candidates.append((mx, ci))
        if candidates:
            _mx, best_ci = max(candidates)
            clusters[best_ci].append(i)
            cluster_chars[best_ci] += doc_lens[i]
        else:
            clusters.append([i])
            cluster_chars.append(doc_lens[i])
    return clusters


def _bins_for_llm(cluster_indices: list[int], rows: list[tuple[str, dict[str, Any], str]], max_body_chars: int) -> list[list[int]]:
    """Разбиение индексов кластера на бины по суммарному размеру текста (лимит на один вызов LLM)."""
    bins: list[list[int]] = []
    cur: list[int] = []
    cur_len = 0
    sep = 12
    for idx in cluster_indices:
        L = len(rows[idx][2] or "") + sep
        if cur and cur_len + L > max_body_chars:
            bins.append(cur)
            cur = []
            cur_len = 0
        cur.append(idx)
        cur_len += L
    if cur:
        bins.append(cur)
    return bins


def run_scheduled_prune(agent: Any, config: dict) -> dict[str, Any]:
    """Синхронный prune по расписанию (вызывается из APScheduler)."""
    mem_cfg = config.get("memory") if isinstance(config.get("memory"), dict) else {}
    auto = mem_cfg.get("ltm_auto_prune") if isinstance(mem_cfg.get("ltm_auto_prune"), dict) else {}
    if not bool(auto.get("enabled", False)):
        return {"skipped": True, "reason": "ltm_auto_prune.disabled"}
    older = float(auto.get("older_than_days", 90))
    types = auto.get("types")
    if types is not None and not isinstance(types, list):
        types = None
    dry = bool(auto.get("dry_run", False))
    try:
        res = agent.long_memory.prune_older_than(older, types=types, dry_run=dry)
        logger.info("LTM scheduled prune | %s", res)
        return {"skipped": False, **res}
    except Exception as e:
        logger.exception("LTM scheduled prune failed: %s", e)
        return {"skipped": False, "error": str(e)[:500]}


async def _legacy_execute_ltm_summarize(
    agent: Any,
    config: dict,
    root: Path,
    *,
    rows: list[tuple[str, dict[str, Any], str]],
    older_than_days: float,
    types: Optional[list[str]],
    max_entries: int,
    compress_with_llm: bool,
    digest_source: str,
) -> dict[str, Any]:
    combined = "\n\n---\n\n".join((r[2] or "") for r in rows)
    digest_id: Optional[str] = None
    digest_chars = 0
    if rows and compress_with_llm:
        digest_text = await agent.summarize_ltm_corpus(combined, consolidation=False)
        digest_chars = len(digest_text or "")
        if digest_text:
            meta = {
                "type": "ltm_digest",
                "source": digest_source,
                "covers_older_than_days": str(older_than_days),
            }

            def _add() -> tuple[bool, str]:
                return agent.long_memory.add_knowledge(digest_text, meta)

            ok, info = await asyncio.to_thread(_add)
            if ok:
                digest_id = info

    archive_dir = resolve_ltm_archive_dir(config, root)

    def _arch() -> dict[str, Any]:
        return agent.long_memory.archive_older_than(
            older_than_days,
            archive_dir,
            types=types,
            dry_run=False,
            max_entries=max_entries,
        )

    arch_res = await asyncio.to_thread(_arch)
    return {
        **arch_res,
        "digest_added_id": digest_id,
        "digest_added_ids": [digest_id] if digest_id else [],
        "digest_chars": digest_chars,
        "consolidation": {"mode": "legacy_single_digest"},
    }


async def _clustered_execute_ltm_summarize(
    agent: Any,
    config: dict,
    root: Path,
    *,
    rows: list[tuple[str, dict[str, Any], str]],
    older_than_days: float,
    types: Optional[list[str]],
    max_entries: int,
    digest_source: str,
    cm: dict[str, Any],
) -> dict[str, Any]:
    archive_dir = resolve_ltm_archive_dir(config, root)
    batch_id = uuid.uuid4().hex
    log_root = Path(cm["log_dir"]).expanduser()
    if not log_root.is_absolute():
        log_root = (root / log_root).resolve()
    log_root.mkdir(parents=True, exist_ok=True)

    def _encode() -> list[list[float]]:
        texts = [r[2] or "" for r in rows]
        return agent.long_memory.encode_texts(texts)

    embs = await asyncio.to_thread(_encode)
    if len(embs) != len(rows) or not embs:
        logger.warning("LTM cluster merge: эмбеддинги недоступны, fallback на legacy")
        return await _legacy_execute_ltm_summarize(
            agent,
            config,
            root,
            rows=rows,
            older_than_days=older_than_days,
            types=types,
            max_entries=max_entries,
            compress_with_llm=True,
            digest_source=digest_source,
        )

    doc_lens = [max(1, len(r[2] or "") + 8) for r in rows]
    norms = [_l2_normalize(e) for e in embs]
    clusters = _assign_clusters(
        norms,
        doc_lens,
        threshold=float(cm["similarity_threshold"]),
        max_cluster_chars=int(cm["max_cluster_chars"]),
    )

    pending_manifest = {
        "batch_id": batch_id,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "older_than_days": older_than_days,
        "types": types,
        "max_entries": max_entries,
        "digest_source": digest_source,
        "cluster_merge": cm,
        "row_count": len(rows),
        "clusters": [[rows[j][0] for j in cl] for cl in clusters],
        "status": "running",
    }
    pending_path = log_root / f"pending_{batch_id}.json"
    try:
        pending_path.write_text(json.dumps(pending_manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        logger.warning("LTM consolidation manifest (pending): %s", e)

    digest_ids: list[str] = []
    digest_chars_total = 0
    archive_paths: list[str] = []
    archived_total = 0
    deleted_total = 0
    failed_clusters: list[dict[str, Any]] = []
    cluster_results: list[dict[str, Any]] = []

    max_bin = min(int(cm["max_cluster_chars"]), 100_000)

    for ci, cluster_indices in enumerate(clusters):
        rows_in_c = [rows[i] for i in cluster_indices]
        bins = _bins_for_llm(cluster_indices, rows, max_bin)
        cluster_ok = True
        cluster_bin_digest_ids: list[str] = []
        planned_bins: list[tuple[str, list[int]]] = []

        for bi, bin_idxs in enumerate(bins):
            combined = "\n\n---\n\n".join((rows[j][2] or "") for j in bin_idxs)
            try:
                digest_text = await agent.summarize_ltm_corpus(combined, consolidation=True)
            except Exception as e:
                logger.exception("LTM cluster %s bin %s: LLM ошибка: %s", ci, bi, e)
                cluster_ok = False
                break

            digest_text = (digest_text or "").strip()
            if not digest_text:
                logger.warning("LTM cluster %s bin %s: пустой digest — кластер не архивируем", ci, bi)
                cluster_ok = False
                break
            planned_bins.append((digest_text, bin_idxs))

        if cluster_ok and planned_bins:
            cluster_digest_chars = 0
            try:
                for bi, (digest_text, bin_idxs) in enumerate(planned_bins):
                    meta = {
                        "type": "ltm_digest",
                        "source": digest_source,
                        "covers_older_than_days": str(older_than_days),
                        "consolidation_batch": batch_id,
                        "cluster_index": str(ci),
                        "cluster_bin": str(bi),
                        "source_doc_ids": ",".join(rows[j][0] for j in bin_idxs)[:8000],
                    }

                    def _add(text: str = digest_text, m: dict[str, Any] = meta) -> tuple[bool, str]:
                        return agent.long_memory.add_knowledge(text, m)

                    ok, info = await asyncio.to_thread(_add)
                    if not ok:
                        logger.error("LTM cluster %s bin %s: add_knowledge failed: %s", ci, bi, info)
                        raise RuntimeError(str(info))
                    cluster_bin_digest_ids.append(info)
                    digest_ids.append(info)
                    cluster_digest_chars += len(digest_text)
                    digest_chars_total += len(digest_text)
            except Exception:
                digest_chars_total = max(0, digest_chars_total - cluster_digest_chars)
                if cluster_bin_digest_ids:

                    def _rollback() -> None:
                        agent.long_memory.delete_document_ids(cluster_bin_digest_ids)

                    await asyncio.to_thread(_rollback)
                    for _xid in cluster_bin_digest_ids:
                        if _xid in digest_ids:
                            digest_ids.remove(_xid)
                cluster_ok = False

        if cluster_ok:

            def _arch_one() -> dict[str, Any]:
                return agent.long_memory.archive_row_tuples(
                    rows_in_c,
                    archive_dir,
                    file_name_suffix=f"{batch_id[:12]}_c{ci}",
                )

            arch_one = await asyncio.to_thread(_arch_one)
            archive_paths.append(str(arch_one.get("archive_path") or ""))
            archived_total += int(arch_one.get("archived") or 0)
            deleted_total += int(arch_one.get("deleted_from_chroma") or 0)
            cluster_results.append(
                {
                    "cluster_index": ci,
                    "digests": cluster_bin_digest_ids,
                    "archived": arch_one.get("archived"),
                    "archive_path": arch_one.get("archive_path"),
                }
            )
        else:
            failed_clusters.append(
                {
                    "cluster_index": ci,
                    "doc_ids": [rows[j][0] for j in cluster_indices],
                }
            )

    final_manifest = {
        **pending_manifest,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "status": "completed" if not failed_clusters else "partial",
        "digest_added_ids": digest_ids,
        "cluster_results": cluster_results,
        "failed_clusters": failed_clusters,
        "totals": {
            "archived": archived_total,
            "deleted_from_chroma": deleted_total,
            "digest_count": len(digest_ids),
        },
    }
    final_path = log_root / f"batch_{batch_id}.json"
    try:
        final_path.write_text(json.dumps(final_manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        if pending_path.exists():
            pending_path.unlink(missing_ok=True)
    except Exception as e:
        logger.warning("LTM consolidation manifest (final): %s", e)

    primary = digest_ids[0] if digest_ids else None
    return {
        "dry_run": False,
        "archived": archived_total,
        "deleted_from_chroma": deleted_total,
        "archive_path": archive_paths[0] if archive_paths else None,
        "archive_paths": archive_paths,
        "digest_added_id": primary,
        "digest_added_ids": digest_ids,
        "digest_chars": digest_chars_total,
        "consolidation": {
            "mode": "embedding_clusters",
            "batch_id": batch_id,
            "manifest_path": str(final_path),
            "clusters_total": len(clusters),
            "clusters_ok": len(cluster_results),
            "clusters_failed": len(failed_clusters),
            "failed_clusters": failed_clusters,
        },
    }


async def execute_ltm_summarize(
    agent: Any,
    config: dict,
    root: Path,
    *,
    older_than_days: float,
    types: Optional[list[str]],
    dry_run: bool,
    max_entries: int,
    compress_with_llm: bool,
    digest_source: str = "memory_summarize_api",
) -> dict[str, Any]:
    """Полный цикл summarize: digest LLM + cold archive (API и планировщик)."""

    def _select() -> list[tuple[str, dict[str, Any], str]]:
        r = agent.long_memory.select_older_than(older_than_days, types=types)
        return r[:max_entries]

    mem_cfg = config.get("memory") if isinstance(config.get("memory"), dict) else {}
    cm = _read_cluster_merge_cfg(mem_cfg)

    rows = await asyncio.to_thread(_select)
    rag_on = bool(getattr(agent.long_memory, "rag_enabled", True))

    if dry_run:
        cluster_would = bool(
            compress_with_llm
            and cm["enabled"]
            and rag_on
            and rows
            and agent.long_memory.count() > 0
        )
        return {
            "dry_run": True,
            "would_process": len(rows),
            "digest_would_run": bool(compress_with_llm and rows),
            "cluster_merge_would_run": cluster_would,
            "cluster_merge": {"enabled": cm["enabled"], "similarity_threshold": cm["similarity_threshold"]},
        }

    if not rows:
        return {
            "dry_run": False,
            "archived": 0,
            "deleted_from_chroma": 0,
            "archive_path": None,
            "digest_added_id": None,
            "digest_added_ids": [],
            "digest_chars": 0,
            "consolidation": {"skipped": True, "reason": "no_rows"},
        }

    use_clusters = (
        compress_with_llm
        and cm["enabled"]
        and rag_on
        and len(rows) >= 2
    )

    if use_clusters:
        return await _clustered_execute_ltm_summarize(
            agent,
            config,
            root,
            rows=rows,
            older_than_days=older_than_days,
            types=types,
            max_entries=max_entries,
            digest_source=digest_source,
            cm=cm,
        )

    if compress_with_llm:
        return await _legacy_execute_ltm_summarize(
            agent,
            config,
            root,
            rows=rows,
            older_than_days=older_than_days,
            types=types,
            max_entries=max_entries,
            compress_with_llm=True,
            digest_source=digest_source,
        )

    # Только архив без LLM
    archive_dir = resolve_ltm_archive_dir(config, root)

    def _arch_only() -> dict[str, Any]:
        return agent.long_memory.archive_older_than(
            older_than_days,
            archive_dir,
            types=types,
            dry_run=False,
            max_entries=max_entries,
        )

    arch_res = await asyncio.to_thread(_arch_only)
    return {
        **arch_res,
        "digest_added_id": None,
        "digest_added_ids": [],
        "digest_chars": 0,
        "consolidation": {"mode": "archive_only"},
    }


async def run_scheduled_summarize(agent: Any, config: dict, root: Optional[Path] = None) -> dict[str, Any]:
    """Фоновый summarize по конфигу memory.ltm_auto_summarize."""
    root = root or project_root()
    mem_cfg = config.get("memory") if isinstance(config.get("memory"), dict) else {}
    auto = mem_cfg.get("ltm_auto_summarize") if isinstance(mem_cfg.get("ltm_auto_summarize"), dict) else {}
    if not bool(auto.get("enabled", False)):
        return {"skipped": True, "reason": "ltm_auto_summarize.disabled"}
    try:
        out = await execute_ltm_summarize(
            agent,
            config,
            root,
            older_than_days=float(auto.get("older_than_days", 60)),
            types=auto.get("types") if isinstance(auto.get("types"), list) else None,
            dry_run=bool(auto.get("dry_run", False)),
            max_entries=int(auto.get("max_entries", 500)),
            compress_with_llm=bool(auto.get("compress_with_llm", True)),
            digest_source="ltm_scheduled_summarize",
        )
        logger.info("LTM scheduled summarize | keys=%s", list(out.keys()))
        return {"skipped": False, **out}
    except Exception as e:
        logger.exception("LTM scheduled summarize failed: %s", e)
        return {"skipped": False, "error": str(e)[:500]}
