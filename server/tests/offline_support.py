"""Deterministic providers around the real turn pipeline and temporary SQLite."""

import asyncio
import json
import threading

import httpx
from pathlib import Path
from types import SimpleNamespace

from langchain_core.messages import AIMessage, AIMessageChunk

from core.agent.micro_plan import MicroPlanSettings
from core.agent.model_trace import ModelActivity
from core.memory.hub import MemoryHub
from core.memory.stores import ShortTermMemory
from core.neyra import NeyraAgent
from core.runtime.event_bus import EventBus
from core.runtime.identity import UnifiedIdentityMapper


async def nothing(*args, **kwargs):
    return None


class OfflineModel:
    def __init__(self, lane):
        self.lane = lane
        self.messages = []
        self.failures = 0
        self.report_model = True
        self.errors = []

    def bind(self, **kwargs):
        return self

    def bind_tools(self, tools):
        return self

    async def ainvoke(self, messages):
        self.messages.append(messages)
        await asyncio.sleep(0)
        if self.errors:
            raise self.errors.pop(0)
        if self.failures:
            self.failures -= 1
            raise RuntimeError("offline provider failure")
        prompt = str(messages[0].content)
        mode = prompt.split("[CONVERSATION MODE: ", 1)[-1].split("]", 1)[0] if "[CONVERSATION MODE:" in prompt else "default"
        text = f"Режим: {mode}\nПроверочный ответ локальной заглушки." if self.lane == "talk" else "Проверочные факты."
        if self.lane == "memory":
            text = "Я ответила на вопрос в проверочном диалоге."
        metadata = {"model_name": f"reported-offline-{self.lane}"} if self.report_model else {}
        return AIMessage(content=text, response_metadata=metadata)

    async def astream(self, messages):
        response = await self.ainvoke(messages)
        yield AIMessageChunk(content=response.content[:10])
        yield AIMessageChunk(content=response.content[10:], response_metadata=response.response_metadata)


def offline_config(root):
    return {
        "paths": {"data_dir": str(root / "data")},
        "assistant": {"system_prompt": "Offline persona"},
        "agent": {"conversation_mode": "default"},
        "api": {"host": "127.0.0.1", "port": 8787, "token": "offline-admin-token", "viewer_token": "offline-viewer-token", "maint_token": "offline-maint-token", "rate_limit_requests_per_minute": 0, "audit_log_enabled": True},
        "dashboard": {"enabled": False},
        "logging": {"level": "INFO", "system_log": str(root / "logs" / "system.log")},
        "memory": {"sqlite_path": str(root / "data" / "memory" / "hub.db"), "rag_write_mode": "off", "rag_enabled": False, "diary_after_turn": False},
        "llm": {
            **{f"{lane}_model": {"model": f"configured-offline-{lane}", "provider": "offline"} for lane in ("talk", "brain", "memory", "vision")},
            "providers": {"offline": {"base_url": "http://127.0.0.1:1/v1"}},
        },
    }


def offline_agent(root: Path, config=None):
    root.mkdir(parents=True, exist_ok=True)
    (root / "logs").mkdir(exist_ok=True)
    agent = NeyraAgent.__new__(NeyraAgent)
    agent.config = config or offline_config(root)
    agent._project_root = root
    agent.event_bus = EventBus()
    agent.model_activity = ModelActivity()
    agent.identity = UnifiedIdentityMapper()
    agent.memory_hub = MemoryHub(agent.config, event_bus=agent.event_bus)
    agent.short_memory = ShortTermMemory(max_messages=100)
    agent.long_memory = SimpleNamespace(count=lambda: 0, rag_enabled=False)
    agent.people_db = SimpleNamespace(_cache={})
    agent.diary = SimpleNamespace(add_entry=lambda **kwargs: None)
    agent.tools = {}
    agent.mcp_manager = None
    agent.backend = "offline"
    agent.llm_talk = OfflineModel("talk")
    agent.llm_brain = OfflineModel("brain")
    agent.llm_memory = OfflineModel("memory")
    agent.llm_vision = None
    agent.llm = agent.llm_talk
    agent.llm_model = agent.llm_talk_model = "configured-offline-talk"
    agent.llm_brain_model = "configured-offline-brain"
    agent.reply_max_tokens = 400
    agent.lyrics_reply_max_tokens = 4096
    agent.primary_first_token_timeout = 1
    agent.micro_planning_enabled = False
    agent._micro_plan_settings = lambda: MicroPlanSettings(False, "tags", "[PLAN]", "[/PLAN]", "PLAN:", "SAY:", False)
    agent._micro_plan_metrics = {}
    agent._last_vision_note_by_scope = {}
    agent._ensure_mcp = agent.start_mcp_clients = agent.stop_mcp_clients = nothing
    agent._detect_mentioned_names = lambda text: []
    agent._handle_memory_trigger = lambda *args: []
    agent._handle_websearch_trigger = agent._collect_tool_context = lambda text: ""
    agent._read_working_memory_for_prompt = lambda uid: ""
    agent._save_dialog_to_ltm_with_emotion = nothing
    agent._setup_llm = lambda: None
    for method in ("_log_thought", "_log_chat", "_schedule_working_memory_refresh"):
        setattr(agent, method, lambda *args, **kwargs: None)
    agent.get_stats = lambda: {"model": agent.llm_talk_model, "talk_model": agent.llm_talk_model, "brain_model": agent.llm_brain_model, "short_memory_size": len(agent.short_memory), "long_memory_records": 0, "people_db_records": len(agent.people_db._cache)}
    return agent


class OfflineResponsesGateway:
    def __init__(self):
        self.requests, self.deleted, self.responses = [], [], {}
        self.failures = []
        self.lock = threading.RLock()
        self.incomplete = False
        self.report_model = True
        self.empty = False
        self.bad_stream = False

    def __call__(self, request):
        with self.lock:
            if request.method == 'DELETE':
                self.deleted.append(request.url.path.rsplit('/', 1)[-1])
                return httpx.Response(200, json={'deleted': True})
            assert request.url.path == '/v1/responses'
            body = json.loads(request.content)
            self.requests.append(body)
            if self.failures:
                return httpx.Response(self.failures.pop(0), json={'error': {'code': 'previous_response_not_found'}})
            rid = f'resp-{len(self.requests)}'
            text = '' if self.empty else f'Ответ номер {len(self.requests)} завершён.'
            self.empty = False
            response = {'id': rid, 'status': 'incomplete' if self.incomplete else 'completed',
                        'output': [{'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': text}]}],
                        'usage': {'input_tokens': 21, 'output_tokens': 7, 'input_tokens_details': {'cached_tokens': 10}}}
            if self.report_model:
                response['model'] = 'confirmed-model'
            self.responses[rid] = response
            if not body['stream']:
                return httpx.Response(200, json=response, headers={'x-request-id': 'req-' + rid})
            events = [dict(type='response.created', response={'id': rid}),
                      dict(type='response.reasoning_text.delta', delta='PRIVATE REASONING'),
                      dict(type='response.output_text.delta', delta=text)]
            if not self.bad_stream:
                events.append(dict(type='response.incomplete' if self.incomplete else 'response.completed', response=response))
            data = ''.join('event: ' + event['type'] + '\ndata: ' + json.dumps(event) + '\n\n' for event in events)
            return httpx.Response(200, text=data, headers={'content-type': 'text/event-stream', 'x-request-id': 'req-' + rid})
