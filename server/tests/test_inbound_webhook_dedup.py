"""B2: inbound webhook idempotency / dedup."""

from __future__ import annotations

import uuid


def test_inbound_dedup_by_idempotency_key(client, stub_agent):
    ep = f"ep-{uuid.uuid4().hex[:8]}"
    path = f"/v1/webhooks/in/testprov/{ep}"
    key = f"deliv-{uuid.uuid4().hex}"
    headers = {"Idempotency-Key": key, "Content-Type": "application/json"}
    body = {"text": "hello once", "username": "u1"}

    r1 = client.post(path, headers=headers, json=body)
    assert r1.status_code == 200, r1.text
    d1 = r1.json()["data"]
    assert d1.get("accepted") is True
    assert d1.get("deduplicated") is False
    assert stub_agent.chat.await_count == 1

    r2 = client.post(path, headers=headers, json=body)
    assert r2.status_code == 200, r2.text
    d2 = r2.json()["data"]
    assert d2.get("accepted") is True
    assert d2.get("deduplicated") is True
    assert stub_agent.chat.await_count == 1  # not re-processed


def test_inbound_dedup_by_body_hash_without_header(client, stub_agent):
    ep = f"ep-{uuid.uuid4().hex[:8]}"
    path = f"/v1/webhooks/in/testprov/{ep}"
    body = {"message": f"same payload {uuid.uuid4().hex}", "username": "u2"}

    r1 = client.post(path, json=body)
    assert r1.status_code == 200
    assert r1.json()["data"].get("deduplicated") is False
    assert stub_agent.chat.await_count == 1

    r2 = client.post(path, json=body)
    assert r2.status_code == 200
    assert r2.json()["data"].get("deduplicated") is True
    assert stub_agent.chat.await_count == 1

    r3 = client.post(path, json={**body, "message": f"different {uuid.uuid4().hex}"})
    assert r3.status_code == 200
    assert r3.json()["data"].get("deduplicated") is False
    assert stub_agent.chat.await_count == 2
