"""Persisted optional behavior flags and their backward-compatible defaults."""

FEATURE_DEFAULTS: dict[str, bool] = {
    "llm.talk_model.responses.enabled": False,
    "llm.talk_model.responses.warmup_on_start": False,
    "memory.mood.enabled": True,
    "memory.relations.enabled": True,
    "memory.diary_after_turn": True,
    "memory.working_memory.enabled": False,
    "memory.emotional_layer.enabled": False,
    "memory.pre_context.enabled": False,
    "agent.de_repeat.enabled": True,
    "memory.small_reflection_enabled": True,
    "memory.diary_hourly_enabled": True,
    "memory.emotional_layer.ltm_emotion_sync": False,
    "memory.rag_enabled": True,
    "memory.reflection_enabled": True,
    "memory.ltm_auto_prune.enabled": False,
    "memory.ltm_auto_summarize.enabled": False,
    "mcp_client.enabled": False,
}


def feature_enabled(config: dict, key: str) -> bool:
    value = config
    for part in key.split("."):
        if not isinstance(value, dict) or part not in value:
            return FEATURE_DEFAULTS[key]
        value = value[part]
    return value is True
