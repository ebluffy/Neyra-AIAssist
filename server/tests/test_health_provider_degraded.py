"""AR-55 (health при 429 провайдера): деградация backend по источнику /v1/llm/activity.

Никакой сети и реальных провайдеров: httpx и перечень провайдеров подменяются,
готовность проверяется через TestClient со stub-агентом из conftest.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest


def _failed_report(*, minutes_ago=0, error_class=None, http_status=None):
    ts = (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()
    calls = []
    if http_status is not None:
        calls.append({"http_status": http_status, "status": "failed"})
    return {
        "timestamp": ts,
        "status": "failed",
        "error_class": error_class,
        "calls": calls,
        "kind": "turn",
    }


def _seed(agent, report):
    from core.agent.model_trace import activity_for

    activity_for(agent).append(
        SimpleNamespace(user_id=None, channel_id=None), report
    )


class TestRecentProviderRateLimit:
    def test_http_429_in_window_is_reported(self, stub_agent):
        from core.agent.model_trace import recent_provider_rate_limit

        _seed(stub_agent, _failed_report(minutes_ago=2, http_status=429,
                                         error_class="RateLimitError"))
        hit = recent_provider_rate_limit(stub_agent)
        assert hit is not None
        assert hit["http_status"] == 429
        assert hit["error_class"] == "RateLimitError"
        assert hit["at"]

    def test_rate_limit_error_class_without_status_is_reported(self, stub_agent):
        from core.agent.model_trace import recent_provider_rate_limit

        _seed(stub_agent, _failed_report(minutes_ago=1, error_class="RateLimitError"))
        hit = recent_provider_rate_limit(stub_agent)
        assert hit is not None
        assert hit["http_status"] is None
        assert hit["error_class"] == "RateLimitError"

    def test_old_failure_outside_window_is_ignored(self, stub_agent):
        from core.agent.model_trace import recent_provider_rate_limit

        _seed(stub_agent, _failed_report(minutes_ago=60, http_status=429,
                                         error_class="RateLimitError"))
        assert recent_provider_rate_limit(stub_agent) is None

    def test_long_turn_that_failed_now_is_fresh(self, stub_agent):
        """Окно считается по времени отказа, а не по времени старта хода (P3 ревью)."""
        from core.agent.model_trace import recent_provider_rate_limit

        now = datetime.now(timezone.utc)
        report = _failed_report(minutes_ago=30, http_status=429,
                                error_class="RateLimitError")
        report["ended_at"] = (now - timedelta(minutes=1)).isoformat()
        report["calls"][0]["ended_at"] = report["ended_at"]
        _seed(stub_agent, report)
        hit = recent_provider_rate_limit(stub_agent)
        assert hit is not None
        assert hit["at"] == report["ended_at"]

    def test_old_rate_limit_is_not_refreshed_by_a_later_turn_end(self, stub_agent):
        """Время берётся у самого rate-limit-вызова, а не у конца хода (P3 ревью)."""
        from core.agent.model_trace import recent_provider_rate_limit

        now = datetime.now(timezone.utc)
        report = _failed_report(minutes_ago=40, http_status=429,
                                error_class="RateLimitError")
        report["ended_at"] = now.isoformat()
        report["calls"][0]["ended_at"] = (now - timedelta(minutes=20)).isoformat()
        report["calls"].append({"status": "failed", "error_class": "TimeoutError",
                                "ended_at": now.isoformat()})
        _seed(stub_agent, report)
        assert recent_provider_rate_limit(stub_agent) is None

    def test_stale_long_turn_without_failure_time_stays_ignored(self, stub_agent):
        from core.agent.model_trace import recent_provider_rate_limit

        _seed(stub_agent, _failed_report(minutes_ago=30, http_status=429,
                                         error_class="RateLimitError"))
        assert recent_provider_rate_limit(stub_agent) is None

    def test_completed_turn_and_unrelated_failure_are_ignored(self, stub_agent):
        from core.agent.model_trace import recent_provider_rate_limit

        ok = _failed_report(minutes_ago=0, http_status=429)
        ok["status"] = "completed"
        _seed(stub_agent, ok)
        _seed(stub_agent, _failed_report(minutes_ago=0, error_class="TimeoutError"))
        assert recent_provider_rate_limit(stub_agent) is None


class TestHealthMonitorBackendDegraded:
    def _backend(self, monkeypatch, tmp_path, *, probe, providers=1):
        import asyncio

        from core.runtime.health import HealthMonitor

        conn = SimpleNamespace(provider="fake", base_url="http://127.0.0.1:9",
                               api_key="k", default_headers={})
        monkeypatch.setattr(
            "core.llm.profile.iter_unique_provider_connections",
            lambda config: [conn] if providers else [],
        )
        monkeypatch.setattr(
            "httpx.get",
            lambda *a, **k: SimpleNamespace(status_code=200),
        )
        monitor = HealthMonitor(
            {"paths": {"data_dir": str(tmp_path)}},
            project_root=tmp_path,
            llm_activity=(lambda: probe) if probe is not None else None,
        )
        return asyncio.run(monitor._check_backend())

    def test_models_ok_but_recent_429_marks_backend_not_ok(self, monkeypatch, tmp_path):
        probe = {"error_class": "RateLimitError", "http_status": 429, "at": "now"}
        backend = self._backend(monkeypatch, tmp_path, probe=probe)
        assert backend["degraded"] is True
        assert backend["degraded_reason"] == probe
        assert backend["ok"] is False

    def test_no_recent_429_keeps_backend_ok(self, monkeypatch, tmp_path):
        backend = self._backend(monkeypatch, tmp_path, probe=None)
        assert backend["degraded"] is False
        assert backend["ok"] is True

    def test_no_providers_and_recent_429_still_degraded(self, monkeypatch, tmp_path):
        probe = {"error_class": "RateLimitError", "http_status": 429, "at": "now"}
        backend = self._backend(monkeypatch, tmp_path, probe=probe, providers=0)
        assert backend["degraded"] is True
        assert backend["ok"] is False


class TestHealthReadyEndpoint:
    def test_ready_503_when_provider_429_in_window(self, client, auth_headers, monkeypatch):
        probe = {"error_class": "RateLimitError", "http_status": 429, "at": "now"}
        monkeypatch.setattr(
            "core.agent.model_trace.recent_provider_rate_limit", lambda agent: probe
        )
        r = client.get("/v1/health/ready", headers=auth_headers["viewer"])
        assert r.status_code == 503
        checks = {c["name"]: c for c in r.json()["data"]["checks"]}
        assert checks["llm_provider"]["ok"] is False
        assert checks["llm_provider"]["reason"] == probe
        assert checks["memory_hub"]["ok"] is True

    def test_ready_200_when_no_recent_429(self, client, auth_headers, monkeypatch):
        monkeypatch.setattr(
            "core.agent.model_trace.recent_provider_rate_limit", lambda agent: None
        )
        r = client.get("/v1/health/ready", headers=auth_headers["viewer"])
        assert r.status_code == 200
        checks = {c["name"]: c for c in r.json()["data"]["checks"]}
        assert checks["llm_provider"]["ok"] is True
