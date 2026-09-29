"""Micro-plan stream filters: hide [PLAN]...[/PLAN] or PLAN:/SAY: anchors from the user."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class MicroPlanSettings:
    enabled: bool
    mode: str
    start: str
    end: str
    anchor_prefix: str
    anchor_reply: str
    prefill_enabled: bool


def init_state() -> dict[str, Any]:
    return {
        "in_plan": False,
        "start_idx": 0,
        "end_idx": 0,
        "hidden_chars": 0,
        "anchor_decided": False,
        "anchor_mode": False,
        "lead_buffer": "",
        "say_idx": 0,
    }


def strip_leading(text: str, settings: MicroPlanSettings) -> tuple[str, str]:
    """Remove a leading start...end plan block; return (rest, plan_body)."""
    src = (text or "").strip()
    if not settings.enabled:
        return src, ""
    if not src.startswith(settings.start):
        return src, ""
    end_idx = src.find(settings.end)
    if end_idx < 0:
        return src, ""
    plan = src[len(settings.start) : end_idx].strip()
    rest = src[end_idx + len(settings.end) :].strip()
    return rest, plan


def filter_token(token: str, st: dict[str, Any], settings: MicroPlanSettings) -> str:
    """State-machine filter: hide content between start/end tags without buffering the whole reply."""
    if not settings.enabled:
        return token
    if settings.mode == "anchor":
        return filter_token_anchor(token, st, settings)
    start = settings.start
    end = settings.end
    if not start or not end:
        return token
    out: list[str] = []
    i = 0
    while i < len(token):
        ch = token[i]
        if not st["in_plan"]:
            sidx = st["start_idx"]
            if ch == start[sidx]:
                st["start_idx"] = sidx + 1
                i += 1
                if st["start_idx"] >= len(start):
                    st["in_plan"] = True
                    st["start_idx"] = 0
                continue
            if st["start_idx"] > 0:
                out.append(start[: st["start_idx"]])
                st["start_idx"] = 0
                continue
            out.append(ch)
            i += 1
        else:
            eidx = st["end_idx"]
            if ch == end[eidx]:
                st["end_idx"] = eidx + 1
                i += 1
                if st["end_idx"] >= len(end):
                    st["in_plan"] = False
                    st["end_idx"] = 0
                continue
            if st["end_idx"] > 0:
                st["end_idx"] = 0
                continue
            st["hidden_chars"] += 1
            i += 1
    return "".join(out)


def filter_token_anchor(token: str, st: dict[str, Any], settings: MicroPlanSettings) -> str:
    plan_anchor = settings.anchor_prefix
    say_anchor = settings.anchor_reply
    if not plan_anchor or not say_anchor:
        return token

    if not st["anchor_decided"]:
        st["lead_buffer"] += token
        probe = st["lead_buffer"].lstrip()
        if probe.startswith(plan_anchor):
            st["anchor_decided"] = True
            st["anchor_mode"] = True
            st["hidden_chars"] += len(st["lead_buffer"])
            st["lead_buffer"] = ""
            return ""
        if len(probe) >= len(plan_anchor) or not plan_anchor.startswith(probe):
            st["anchor_decided"] = True
            out = st["lead_buffer"]
            st["lead_buffer"] = ""
            return out
        return ""

    if not st["anchor_mode"]:
        return token

    out: list[str] = []
    i = 0
    while i < len(token):
        ch = token[i]
        sidx = st["say_idx"]
        if ch == say_anchor[sidx]:
            st["say_idx"] = sidx + 1
            st["hidden_chars"] += 1
            i += 1
            if st["say_idx"] >= len(say_anchor):
                st["anchor_mode"] = False
                st["say_idx"] = 0
            continue
        if st["say_idx"] > 0:
            st["hidden_chars"] += st["say_idx"]
            st["say_idx"] = 0
            continue
        st["hidden_chars"] += 1
        i += 1
    return "".join(out)


def finalize_state(
    st: dict[str, Any],
    settings: MicroPlanSettings,
    metrics: dict[str, int],
) -> str:
    """Flush stream state; update metrics; return any trailing visible chars."""
    if not settings.enabled:
        return ""
    if st.get("hidden_chars", 0) > 0:
        metrics["filtered_stream_chars"] += int(st["hidden_chars"])
    if settings.mode == "anchor":
        if not st.get("anchor_decided"):
            tail = st.get("lead_buffer", "")
            st["lead_buffer"] = ""
            return tail
        if st.get("anchor_mode"):
            metrics["unclosed_blocks"] += 1
        return ""
    if not st.get("in_plan") and st.get("start_idx", 0) > 0:
        tail = settings.start[: st["start_idx"]]
        st["start_idx"] = 0
        return tail
    if st.get("in_plan"):
        metrics["unclosed_blocks"] += 1
    return ""


def strip_blocks(text: str, settings: MicroPlanSettings) -> tuple[str, int, bool]:
    """Fail-safe: cut all start...end blocks; trim an unclosed trailing plan."""
    if not settings.enabled:
        return (text or ""), 0, False
    if settings.mode == "anchor":
        return strip_anchor(text, settings)
    src = text or ""
    start = settings.start
    end = settings.end
    if not start or not end or start not in src:
        return src, 0, False

    out: list[str] = []
    i = 0
    hidden = 0
    unclosed = False
    while i < len(src):
        s = src.find(start, i)
        if s < 0:
            out.append(src[i:])
            break
        out.append(src[i:s])
        e = src.find(end, s + len(start))
        if e < 0:
            hidden += len(src) - s
            unclosed = True
            break
        hidden += e + len(end) - s
        i = e + len(end)
    return "".join(out).strip(), hidden, unclosed


def strip_anchor(text: str, settings: MicroPlanSettings) -> tuple[str, int, bool]:
    src = (text or "").strip()
    plan_anchor = settings.anchor_prefix
    say_anchor = settings.anchor_reply
    if not plan_anchor or not say_anchor:
        return src, 0, False
    if not src.startswith(plan_anchor):
        return src, 0, False
    say_idx = src.find(say_anchor, len(plan_anchor))
    if say_idx < 0:
        return "", len(src), True
    hidden = say_idx + len(say_anchor)
    rest = src[say_idx + len(say_anchor) :].strip()
    return rest, hidden, False


def maybe_append_prefill(
    messages: list[Any],
    settings: MicroPlanSettings,
    *,
    has_vision_images: bool,
) -> list[Any]:
    if not settings.enabled or not settings.prefill_enabled or has_vision_images:
        return messages
    try:
        from langchain_core.messages import AIMessage

        prefill = settings.start if settings.mode != "anchor" else f"{settings.anchor_prefix} "
        return [*messages, AIMessage(content=prefill)]
    except Exception:
        return messages
