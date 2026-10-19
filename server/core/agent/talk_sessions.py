"""Bounded Responses chains, isolated by owner/channel and usable across event loops."""
from __future__ import annotations

import asyncio
import hashlib
import json
import threading
import time
from collections import OrderedDict, deque
from concurrent.futures import Future
from dataclasses import dataclass, field
from types import SimpleNamespace

from core.runtime.features import FEATURE_DEFAULTS, feature_enabled

ENABLED = "llm.talk_model.responses.enabled"
WARMUP = "llm.talk_model.responses.warmup_on_start"
MAX_SESSIONS, MAX_TURNS, MAX_CHARS, IDLE_SECONDS = 200, 12, 48000, 1800


class ConversationReset(RuntimeError):
    pass


class RetiredResponse(str):
    def __new__(cls, response_id, connection):
        item = super().__new__(cls, response_id)
        item.connection = connection
        return item


@dataclass
class Chain:
    fingerprint: str
    parent: str
    ids: list[str]
    turns: int = 0
    chars: int = 0
    touched: float = field(default_factory=time.monotonic)
    last_text: str = ""
    history_count: int = 0
    connection: object = field(default=None, repr=False)


@dataclass
class Transaction:
    manager: object
    key: tuple
    gate: Future
    epoch: int
    fingerprint: str = ""
    parent: str | None = None
    continuing: bool = False
    candidates: list[str] = field(default_factory=list)
    last_id: str | None = None
    last_text: str = ""
    chars: int = 0
    history_count: int = 0
    reduced: bool = False
    connection: object = field(default=None, repr=False)
    committed: bool = False
    closed: bool = False

    def prepare(self, system, history):
        fp = self.manager.fingerprint(system)
        self.history_count = len(history)
        with self.manager.lock:
            if not self.fingerprint:
                self.fingerprint = fp
                chain = self.manager.chains.get(self.key)
                if chain and (chain.fingerprint != fp or chain.turns >= MAX_TURNS
                              or chain.chars >= MAX_CHARS or time.monotonic() - chain.touched > IDLE_SECONDS
                              or len(history) < chain.history_count or not history or history[-1].content != chain.last_text):
                    self.manager.retire(self.key)
                    chain = None
                if chain:
                    self.parent, self.continuing = chain.parent, True
                elif self.manager.seed and self.manager.seed[0] == fp:
                    self.parent = self.manager.seed[1]
            elif fp != self.fingerprint:
                # A concurrent configuration/persona change cannot continue an old policy.
                self.parent, self.continuing, self.fingerprint = None, False, fp
        return self.parent, self.continuing

    def recover(self, *, overflow=False):
        self.reduced = self.reduced or overflow
        with self.manager.lock:
            if self.manager.seed and self.parent == self.manager.seed[1]:
                self.manager.seed = None
                self.manager.warmup_state = "failed"
                self.manager.warmup_error = "history_unavailable"
        self.parent, self.continuing = None, False
        with self.manager.lock:
            self.manager.retire(self.key)

    def candidate(self, response_id, text, chars):
        self.candidates.append(response_id)
        self.last_id, self.last_text, self.chars = response_id, text, chars

    def ensure_current(self):
        if self.epoch != self.manager.epoch or self.gate in self.manager.invalidated:
            raise ConversationReset("conversation_reset")

    def commit(self, agent, final_text):
        from core.agent.reply_postprocess import EMPTY_REPLY_PLACEHOLDER
        text, _ = agent._extract_think_blocks(self.last_text)
        text, _ = agent._strip_leading_micro_plan(text)
        text, _, _ = agent._strip_micro_plan_blocks(text)
        text, _ = agent._extract_sound_tags(text, preserve_line_breaks=True)
        with self.manager.lock:
            if (not self.last_id or not text or text.strip() != final_text.strip()
                    or final_text == EMPTY_REPLY_PLACEHOLDER or self.epoch != self.manager.epoch
                    or self.gate in self.manager.invalidated):
                self.manager.retire(self.key)
                return
            old = self.manager.chains.pop(self.key, None) if self.continuing else None
            if not self.continuing:
                self.manager.retire(self.key)
            ids = (old.ids if old else []) + [self.last_id]
            self.manager.chains[self.key] = Chain(
                self.fingerprint, self.last_id, ids, (old.turns if old else 0) + 1,
                (old.chars if old else 0) + self.chars, last_text=final_text, history_count=self.history_count + 2, connection=self.connection)
            self.manager.enqueue((rid for rid in self.candidates if rid != self.last_id), self.connection)
            self.committed = True
            while len(self.manager.chains) > MAX_SESSIONS:
                self.manager.retire(next(iter(self.manager.chains)))

    def close(self):
        if self.closed:
            return
        self.closed = True
        with self.manager.lock:
            if not self.committed and self.fingerprint:
                self.manager.enqueue(self.candidates, self.connection)
                self.manager.retire(self.key)
            self.manager.active.pop(self.gate, None)
            self.manager.invalidated.discard(self.gate)
            if not self.gate.done():
                self.gate.set_result(None)
            if self.manager.gates.get(self.key) is self.gate:
                self.manager.gates.pop(self.key, None)


class TalkSessions:
    def __init__(self, agent):
        self.agent = agent
        self.lock = threading.RLock()
        self.chains = OrderedDict()
        self.gates = {}
        self.active = {}
        self.invalidated = set()
        self.garbage = deque(maxlen=MAX_SESSIONS * (MAX_TURNS + 2))
        self.epoch = 0
        self.seed = None
        self.warming = None
        self.warmup_job = None
        self.warmup_state = "idle"
        self.warmup_error = None
        self.warmed_at = None
        self.cleanup_running = False

    def fingerprint(self, system):
        agent = self.agent
        conn = getattr(agent, "_llm_conn_talk", None)
        data = [system, getattr(conn, "base_url", None), getattr(conn, "provider", None),
                agent.llm_talk_model,
                {key: feature_enabled(agent.config, key) for key in FEATURE_DEFAULTS}]
        return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True).encode()).hexdigest()

    def enqueue(self, ids, connection):
        self.garbage.extend(RetiredResponse(rid, connection) for rid in ids)

    def retire(self, key):
        chain = self.chains.pop(key, None)
        if chain:
            self.enqueue(chain.ids, chain.connection)

    def invalidate(self, owner=None, channel=None):
        with self.lock:
            def matches(key):
                return ((owner is None or key[2] == owner or (key[1] == "shared" and channel is not None))
                        and (channel is None or key[3] == str(channel)))
            for gate, key in self.active.items():
                if matches(key):
                    self.invalidated.add(gate)
            for key in list(self.chains):
                if matches(key):
                    self.retire(key)
            if owner is None and channel is None:
                self.epoch += 1
                if self.seed:
                    self.enqueue([self.seed[1]], self.seed[2])
                self.seed = None
                self.warmup_state = "idle"
                self.warmup_error = None
                self.warmed_at = None

    async def enter(self, scope, *, wait_warmup=True):
        key = scope.key
        mine = Future()
        with self.lock:
            previous = self.gates.get(key)
            self.gates[key] = mine
        try:
            if previous:
                await asyncio.shield(asyncio.wrap_future(previous))
            with self.lock:
                epoch, warming = self.epoch, self.warming
            if warming and wait_warmup:
                await asyncio.shield(asyncio.wrap_future(warming))
            with self.lock:
                self.active[mine] = key
            return Transaction(self, key, mine, epoch)
        except BaseException:
            # A cancelled waiter must not let later turns overtake its predecessor.
            def release(_=None):
                with self.lock:
                    if not mine.done():
                        mine.set_result(None)
                    if self.gates.get(key) is mine:
                        self.gates.pop(key, None)
            if previous and not previous.done():
                previous.add_done_callback(release)
            else:
                release()
            raise

    def status(self):
        with self.lock:
            enabled = feature_enabled(self.agent.config, ENABLED)
            return {"enabled": enabled, "warmup_on_start": feature_enabled(self.agent.config, WARMUP),
                    "warmup_state": self.warmup_state if enabled else "disabled",
                    "warmup_error": self.warmup_error, "warmed_at": self.warmed_at,
                    "active_sessions": len(self.chains), "max_sessions": MAX_SESSIONS,
                    "max_turns": MAX_TURNS, "idle_seconds": IDLE_SECONDS}

    def start_warmup(self, *, manual=False):
        if not feature_enabled(self.agent.config, ENABLED) or (not manual and not feature_enabled(self.agent.config, WARMUP)):
            return False
        with self.lock:
            if self.warming and not self.warming.done():
                return False
            if self.seed and not manual:
                return False
            if manual:
                self.invalidate()
            epoch = self.epoch
            ready = self.warming = Future()
            self.warmup_state, self.warmup_error = "warming", None
        from core.agent.model_trace import spawn_background
        self.warmup_job = spawn_background(self.agent, "persona_warmup", lambda: self._warmup(epoch, ready))
        return True

    async def _warmup(self, epoch, ready):
        from datetime import datetime, timezone
        from langchain_core.messages import HumanMessage, SystemMessage
        from core.agent.model_trace import invoke
        from core.agent.responses_talk import ResponsesTalk
        from core.agent.talk_messages import build_talk_system_prompt
        from core.text_resources import prompt_text
        from core.agent.model_trace import ACTIVE_TRACE
        gate = Future()
        tx = Transaction(self, ("", ""), gate, epoch)
        try:
            prep = SimpleNamespace(has_vis_prompt=False, lyrics_mode=False,
                                   include_appearance=bool((self.agent.config.get("assistant") or {}).get("appearance_always")),
                                   affect_data=None)
            # Warmup is not a user turn. Set only the private transport transaction.
            ACTIVE_TRACE.get().talk_session = tx
            prompt = build_talk_system_prompt(self.agent, prep, brain_context="")
            model = ResponsesTalk(self.agent, self.agent.llm_talk, tx).bind(max_tokens=512)
            await invoke(self.agent, model, [SystemMessage(content=prompt), HumanMessage(content=prompt_text("responses.warmup"))], lane="talk", purpose="persona_warmup")
            with self.lock:
                if epoch == self.epoch and feature_enabled(self.agent.config, ENABLED):
                    if self.seed:
                        self.enqueue([self.seed[1]], self.seed[2])
                    self.seed = (tx.fingerprint, tx.last_id, tx.connection)
                    self.warmup_state, self.warmed_at = "ready", datetime.now(timezone.utc).isoformat()
                    self.enqueue((rid for rid in tx.candidates if rid != tx.last_id), tx.connection)
                else:
                    self.enqueue(tx.candidates, tx.connection)
        except BaseException as exc:
            with self.lock:
                self.enqueue(tx.candidates, tx.connection)
                if epoch == self.epoch:
                    self.warmup_state = "failed"
                    self.warmup_error = "cancelled" if isinstance(exc, asyncio.CancelledError) else "provider_unavailable"
            raise
        finally:
            with self.lock:
                if not ready.done():
                    ready.set_result(None)
                if self.warming is ready:
                    self.warming = None

    def schedule_cleanup(self):
        with self.lock:
            if self.cleanup_running or not self.garbage:
                return
            self.cleanup_running = True
        async def run():
            try:
                await self.cleanup()
            finally:
                with self.lock:
                    self.cleanup_running = False
        task = asyncio.create_task(run())
        jobs = getattr(self.agent, "_background_jobs", None)
        if jobs is None:
            jobs = self.agent._background_jobs = set()
        jobs.add(task)
        task.add_done_callback(jobs.discard)

    async def cleanup(self, limit=8):
        from core.agent.responses_talk import delete_response
        for _ in range(limit):
            with self.lock:
                if not self.garbage:
                    return
                rid = self.garbage.popleft()
            await delete_response(self.agent, rid, connection_override=getattr(rid, "connection", None))

    async def stop(self):
        job = self.warmup_job
        if job and not job.done():
            loop = job.get_loop()
            loop.call_soon_threadsafe(job.cancel)
            if loop is asyncio.get_running_loop():
                await asyncio.gather(job, return_exceptions=True)
        with self.lock:
            if self.warming and not self.warming.done():
                self.warming.set_result(None)
            self.warming = None
        self.invalidate()
        try:
            await asyncio.wait_for(self.cleanup(limit=len(self.garbage)), timeout=3)
        except TimeoutError:
            pass


def sessions_for(agent):
    # Real agents create this before resident integration threads are started.
    manager = getattr(agent, "talk_sessions", None)
    if not isinstance(manager, TalkSessions):
        manager = agent.talk_sessions = TalkSessions(agent)
    return manager


def current_transaction():
    from core.agent.model_trace import ACTIVE_TRACE
    trace = ACTIVE_TRACE.get()
    return getattr(trace, "talk_session", None) if trace and not trace.closed else None


def responses_talk_model(agent, model):
    tx = current_transaction()
    if tx is None:
        return model
    from core.agent.responses_talk import ResponsesTalk
    return ResponsesTalk(agent, model, tx)
