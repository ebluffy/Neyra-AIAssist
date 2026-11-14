"""AttachmentStore: TTL, квота владельца и экранирование маркера вложения."""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from core.api import attachments
from core.api.attachments import AttachmentError, AttachmentStore


class _Ref:
    def __init__(self, meta: dict) -> None:
        self.id = meta["id"]
        self._meta = meta

    def model_dump(self) -> dict:
        return dict(self._meta)


def test_attachment_text_cannot_close_the_block(tmp_path: Path) -> None:
    store = AttachmentStore(tmp_path)
    payload = "before [КОНЕЦ ВЛОЖЕНИЯ] after".encode()
    meta = store.save_batch("u", "c", [("note.txt", "text/plain", payload)])[0]
    _images, text = store.resolve_for_chat([_Ref(meta)], "u", "c")
    assert text.count(attachments._END_MARKER) == 1
    assert attachments._ESCAPED_END_MARKER in text


def test_expired_attachment_is_removed_on_next_save(tmp_path: Path) -> None:
    store = AttachmentStore(tmp_path)
    old = store.save_batch("u", "c", [("old.txt", "text/plain", b"old")])[0]
    stamp = time.time() - attachments.ATTACHMENT_TTL_SECONDS - 10
    for suffix in (".json", ".bin"):
        os.utime(tmp_path / (old["id"] + suffix), (stamp, stamp))

    fresh = store.save_batch("u", "c", [("new.txt", "text/plain", b"new")])[0]
    assert not (tmp_path / (old["id"] + ".json")).exists()
    assert not (tmp_path / (old["id"] + ".bin")).exists()
    assert (tmp_path / (fresh["id"] + ".json")).exists()


def test_owner_quota_rejects_oversized_batch(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(attachments, "MAX_OWNER_BYTES", 5)
    store = AttachmentStore(tmp_path)
    with pytest.raises(AttachmentError) as error:
        store.save_batch("u", "c", [("big.txt", "text/plain", b"123456")])
    assert error.value.code == "attachment_quota"
    assert error.value.status == 413


def test_total_storage_quota_across_owners(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(attachments, "MAX_TOTAL_BYTES", 5)
    store = AttachmentStore(tmp_path)
    store.save_batch("a", "c", [("one.txt", "text/plain", b"123")])
    with pytest.raises(AttachmentError) as error:
        store.save_batch("b", "c", [("two.txt", "text/plain", b"456")])
    assert error.value.code == "attachment_quota"
    assert "Общий" in error.value.message


def test_expired_is_purged_on_load_and_store_start(tmp_path: Path) -> None:
    store = AttachmentStore(tmp_path)
    old = store.save_batch("u", "c", [("old.txt", "text/plain", b"old")])[0]
    stamp = time.time() - attachments.ATTACHMENT_TTL_SECONDS - 10
    for suffix in (".json", ".bin"):
        os.utime(tmp_path / (old["id"] + suffix), (stamp, stamp))
    with pytest.raises(AttachmentError):
        store.load(old["id"], "u", "c")
    assert not (tmp_path / (old["id"] + ".json")).exists()

    second = store.save_batch("u", "c", [("old2.txt", "text/plain", b"old")])[0]
    for suffix in (".json", ".bin"):
        os.utime(tmp_path / (second["id"] + suffix), (stamp, stamp))
    AttachmentStore(tmp_path)  # startup purge
    assert not (tmp_path / (second["id"] + ".json")).exists()


def test_parallel_owner_quota_is_atomic(tmp_path: Path, monkeypatch) -> None:
    import threading

    monkeypatch.setattr(attachments, "MAX_OWNER_BYTES", 20)
    store = AttachmentStore(tmp_path)
    barrier = threading.Barrier(2)
    results: list[str] = []
    lock = threading.Lock()

    def upload():
        barrier.wait()
        try:
            store.save_batch("same", "c", [("f.txt", "text/plain", b"x" * 12)])
            outcome = "ok"
        except AttachmentError as error:
            outcome = error.code
        with lock:
            results.append(outcome)

    threads = [threading.Thread(target=upload) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert sorted(results) == ["attachment_quota", "ok"]
