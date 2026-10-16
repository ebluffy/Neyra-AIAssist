"""One HTTP generation per call; protocol retries are owned by the traced pipeline."""
from __future__ import annotations

import json
from contextlib import asynccontextmanager
from urllib.parse import quote

import httpx
from langchain_core.messages import AIMessage, AIMessageChunk

from core.llm.profile import resolve_openai_compatible_connection
from core.text_resources import prompt_text


class ResponsesError(RuntimeError):
    pass


class ResponsesRetryable(ResponsesError):
    pass


def connection(agent):
    return getattr(agent, "_llm_conn_talk", None) or resolve_openai_compatible_connection(agent.config, role="talk_model")


@asynccontextmanager
async def client_for(agent, timeout, connection_override=None):
    conn = connection_override or connection(agent)
    headers = {**conn.default_headers, "Authorization": "Bearer " + conn.api_key}
    async with httpx.AsyncClient(headers=headers, timeout=timeout, transport=getattr(agent, "_responses_transport", None)) as client:
        yield client, conn.base_url.rstrip("/") + "/responses"


async def delete_response(agent, response_id, connection_override=None):
    try:
        async with client_for(agent, 1.0, connection_override) as (client, url):
            await client.delete(url + "/" + quote(response_id, safe=""))
    except (httpx.HTTPError, ValueError):
        pass


def output_text(response):
    return "".join(part.get("text", "") for item in response.get("output", [])
                   if item.get("type") == "message" and item.get("role") == "assistant"
                   for part in item.get("content", []) if part.get("type") == "output_text")


def content_parts(content, role):
    if isinstance(content, str):
        return content
    parts = []
    for part in content:
        if part.get("type") == "text":
            parts.append({"type": "input_text" if role != "assistant" else "output_text", "text": part["text"]})
        elif part.get("type") == "image_url" and role == "user":
            image = part["image_url"]
            parts.append({"type": "input_image", "image_url": image["url"], "detail": image.get("detail", "auto")})
        else:
            raise ResponsesError("unsupported_input_content")
    return parts


class ResponsesTalk:
    def __init__(self, agent, model, tx, options=None):
        self.agent, self.bound, self.tx = agent, model, tx
        self.options = dict(getattr(model, "kwargs", {}) or {}) | (options or {})
        self.model_name = agent.llm_talk_model
        self.connection = tx.connection or connection(agent)
        tx.connection = self.connection

    def bind(self, **kwargs):
        return ResponsesTalk(self.agent, self.bound, self.tx, self.options | kwargs)

    def request(self, messages, stream):
        system = str(messages[0].content)
        history = [m for m in messages if m.additional_kwargs.get("neyra_history")]
        parent, continuing = self.tx.prepare(system, history)
        items, instructions = [], []
        for index, message in enumerate(messages):
            if index == 0 and parent:
                continue
            if message.additional_kwargs.get("neyra_ephemeral"):
                if message.additional_kwargs.get("neyra_state"):
                    instructions.append(prompt_text("talk.state_policy"))
                instructions.append(prompt_text("responses.current_context", data=json.dumps({"untrusted_context": str(message.content)[:2000 if self.tx.reduced else 16000]}, ensure_ascii=False)))
                continue
            if index > 0 and message.type == "system":
                instructions.append(str(message.content))
                continue
            if continuing and message.additional_kwargs.get("neyra_history"):
                continue
            if self.tx.reduced and message.additional_kwargs.get("neyra_history") and message not in history[-4:]:
                continue
            # Assistant prefill isn't supported by Responses; policy already defines the plan.
            if index == len(messages) - 1 and message.type == "ai":
                continue
            role = {"system": "system", "human": "user", "ai": "assistant"}.get(message.type)
            if role is None:
                raise ResponsesError("unsupported_input_role")
            items.append({"role": role, "content": content_parts(message.content, role)})
        root = self.bound
        while getattr(root, "bound", None) is not None:
            root = root.bound
        cfg = (self.agent.config.get("llm") or {}).get("talk_model") or {}
        cap = self.options.get("max_tokens", getattr(root, "max_tokens", None) or self.agent.reply_max_tokens)
        payload = {"model": self.model_name, "input": items, "store": True, "stream": stream,
                   "max_output_tokens": int(cap)}
        for name in ("temperature", "top_p"):
            value = self.options.get(name, getattr(root, name, cfg.get(name)))
            if value is not None:
                payload[name] = value
        if parent:
            payload["previous_response_id"] = parent
        if instructions:
            payload["instructions"] = "\n\n".join(instructions)
        self._input_chars = len(json.dumps(items, ensure_ascii=False))
        return payload

    @property
    def timeout(self):
        return float(((self.agent.config.get("llm") or {}).get("talk_model") or {}).get("timeout_seconds", 120))

    def check_http(self, response, payload):
        if response.is_success:
            return
        # Only explicit history/context errors permit a fresh-chain retry. No auth fallback.
        code = ""
        try:
            error = response.json().get("error", {})
            code = str(error.get("code", "")) if isinstance(error, dict) else ""
        except (ValueError, AttributeError):
            pass
        if code == "context_length_exceeded" or (payload.get("previous_response_id") and (response.status_code == 404 or code in {
                "previous_response_not_found", "previous_response_id_not_found"})):
            self.tx.recover(overflow=code == "context_length_exceeded")
            raise ResponsesRetryable("responses_history_unavailable")
        raise ResponsesError("responses_http_" + str(response.status_code))

    def metadata(self, response, headers):
        from .model_trace import ACTIVE_TRACE, observe_payload
        metadata = {"id": response.get("id"), "model_name": response.get("model"),
                    "usage": response.get("usage"), "request_id": headers.get("x-request-id") or headers.get("request-id")}
        trace = ACTIVE_TRACE.get()
        if trace and trace.calls and trace.calls[-1]["status"] == "running":
            observe_payload(trace.calls[-1], AIMessageChunk(content="", response_metadata=metadata))
        return metadata

    def completed(self, response, headers):
        metadata = self.metadata(response, headers)
        rid, text = response.get("id"), output_text(response)
        if rid:
            self.tx.candidate(str(rid), text, self._input_chars + len(text))
        if response.get("status") != "completed":
            raise ResponsesError("responses_" + str(response.get("status", "missing_terminal")))
        if not rid or not text.strip():
            raise ResponsesRetryable("responses_empty_output")
        return metadata

    async def ainvoke(self, messages):
        payload = self.request(messages, False)
        try:
            async with client_for(self.agent, self.timeout, self.connection) as (client, url):
                result = await client.post(url, json=payload)
                self.check_http(result, payload)
                data = result.json()
                metadata = self.completed(data, result.headers)
                return AIMessage(content=output_text(data), response_metadata=metadata)
        except httpx.HTTPError as exc:
            raise ResponsesError("responses_transport_error") from exc

    async def astream(self, messages):
        payload = self.request(messages, True)
        try:
            async with client_for(self.agent, self.timeout, self.connection) as (client, url):
                async with client.stream("POST", url, json=payload) as result:
                    if not result.is_success:
                        await result.aread()
                        self.check_http(result, payload)
                    if "text/event-stream" not in result.headers.get("content-type", ""):
                        raise ResponsesError("responses_sse_required")
                    data_lines = []
                    seen_id = None
                    async for line in result.aiter_lines():
                        if line.startswith("data:"):
                            data_lines.append(line[5:].lstrip())
                            continue
                        if line or not data_lines:
                            continue
                        raw, data_lines = "\n".join(data_lines), []
                        if raw == "[DONE]":
                            break
                        event = json.loads(raw)
                        kind = event.get("type")
                        response = event.get("response") or {}
                        if response:
                            self.metadata(response, result.headers)
                        if response.get("id") and seen_id is None:
                            seen_id = str(response["id"])
                            self.tx.candidates.append(seen_id)
                        if kind == "response.output_text.delta":
                            yield AIMessageChunk(content=event.get("delta", ""))
                        elif kind == "response.completed":
                            metadata = self.completed(response, result.headers)
                            yield AIMessageChunk(content="", response_metadata=metadata)
                            return
                        elif kind in ("error", "response.failed", "response.incomplete"):
                            raise ResponsesError("responses_stream_failed")
                    raise ResponsesError("responses_missing_terminal")
        except httpx.HTTPError as exc:
            raise ResponsesError("responses_transport_error") from exc
