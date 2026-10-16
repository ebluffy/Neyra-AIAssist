from __future__ import annotations

from types import SimpleNamespace

from core.agent.model_trace import (
    ACTIVE_TRACE,
    ModelActivity,
    TurnTrace,
    begin_call,
    begin_task,
    end_call,
    end_task,
    finish,
    mark_first_meaningful_token,
)


class _Bus:
    def publish(self, _event):
        pass


def _agent():
    return SimpleNamespace(
        config={"llm": {"talk_model": {"provider": "stub", "model": "configured"}}},
        model_activity=ModelActivity(),
        event_bus=_Bus(),
    )


def test_provider_fields_are_unknown_until_provider_reports_them():
    agent = _agent()
    trace = TurnTrace("u", "c", agent.config)
    token = ACTIVE_TRACE.set(trace)
    try:
        call = begin_call(agent, "talk", "reply")
        assert call["call_id"]
        assert call["provider_request_id"] is None
        assert call["usage"] is None
        assert call["actual_billing"] is None
        end_call(call, SimpleNamespace(response_metadata={"usage": {"prompt_tokens": 3, "completion_tokens": 5}, "request_id": "req-1"}))
        assert call["provider_request_id"] == "req-1"
        assert call["provider_usage"] == {"prompt_tokens": 3, "completion_tokens": 5}
        assert call["usage"] == {"input_tokens": 3, "output_tokens": 5}
        assert call["cost_estimate"] is None
    finally:
        ACTIVE_TRACE.reset(token)


def test_first_token_and_background_task_keep_local_timing_and_parent_relation():
    agent = _agent()
    trace = TurnTrace("u", "c", agent.config)
    token = ACTIVE_TRACE.set(trace)
    try:
        call = begin_call(agent, "talk", "reply", attempt=2)
        mark_first_meaningful_token(call)
        assert call["first_meaningful_token_at"]
        assert call["first_meaningful_token_ms"] >= 0
        task = begin_task(agent, "reflection", parent_call_id=call["call_id"])
        end_task(task)
        assert task["task_id"]
        assert task["parent_call_id"] == call["call_id"]
        assert task["duration_ms"] >= 0
        end_call(call, status="cancelled")
        assert call["attempt"] == 2
        assert call["status"] == "cancelled"
        report = finish(agent, trace)
        assert report["tasks"][0]["status"] == "completed"
    finally:
        ACTIVE_TRACE.reset(token)


def test_finish_closes_unfinished_background_tasks_without_creating_calls():
    agent = _agent()
    trace = TurnTrace("u", "c", agent.config)
    token = ACTIVE_TRACE.set(trace)
    try:
        task = begin_task(agent, "memory", parent_task_id="parent-task")
        report = finish(agent, trace, status="cancelled")
        assert report["calls"] == []
        assert report["tasks"][0]["status"] == "cancelled"
        assert report["tasks"][0]["parent_task_id"] == "parent-task"
    finally:
        ACTIVE_TRACE.reset(token)
