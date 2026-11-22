"""Safe per-turn lane timings for web/desktop chat (turn_stats)."""
from __future__ import annotations

from core.agent.model_trace import turn_stats


def test_turn_stats_aggregates_lanes_and_usage():
    report = {
        "duration_ms": 12345.6,
        "calls": [
            {"lane": "brain", "duration_ms": 2000.0, "configured_model": "brain-model", "usage": {"input_tokens": 100, "output_tokens": 20}},
            {"lane": "talk", "duration_ms": 3000.5, "configured_model": "talk-model", "usage": {"input_tokens": 200, "output_tokens": 80}},
            {"lane": "memory", "duration_ms": 500.0, "configured_model": "memory-model"},
            {"lane": "vision", "duration_ms": 1500.0, "configured_model": "vision-model", "usage": {"output_tokens": 10}},
            {"lane": "other", "duration_ms": 9000.0},
        ],
    }
    stats = turn_stats(report)
    assert stats["duration_ms"] == 12345.6
    assert stats["llm_ms"] == 7000.5
    assert stats["lanes"]["brain"] == {
        "calls": 1,
        "duration_ms": 2000.0,
        "model": "brain-model",
        "input_tokens": 100,
        "output_tokens": 20,
    }
    assert stats["lanes"]["talk"]["duration_ms"] == 3000.5
    assert stats["lanes"]["talk"]["model"] == "talk-model"
    assert stats["lanes"]["memory"] == {"calls": 1, "duration_ms": 500.0, "model": "memory-model"}
    assert stats["output_tokens"] == 110
    assert stats["tokens_per_second"] == 16.9
    assert "model" not in stats


def test_turn_stats_ignores_missing_and_invalid_calls():
    assert turn_stats(None) is None
    assert turn_stats({}) is None
    assert turn_stats({"calls": [{"lane": "talk", "duration_ms": None}]}) is None
    assert turn_stats({"calls": [{"lane": "other", "duration_ms": 10}]}) is None
    stats = turn_stats({"calls": [{"lane": "talk", "duration_ms": 0}]})
    assert stats == {"duration_ms": 0.0, "llm_ms": 0.0, "lanes": {"talk": {"calls": 1, "duration_ms": 0.0}}}


def test_turn_stats_never_leaks_raw_trace_fields():
    stats = turn_stats(
        {
            "duration_ms": 10,
            "calls": [
                {
                    "lane": "talk",
                    "duration_ms": 10,
                    "configured_model": "m",
                    "reported_model": "r",
                    "private": "secret",
                }
            ],
            "config": {"llm": {"api_key": "secret"}},
        }
    )
    assert stats["lanes"]["talk"]["model"] == "r"
    assert "private" not in str(stats)
    assert "api_key" not in str(stats)
