"""Public progress/usage allowlist, independent of operator model traces."""
PHASES = {'retrieval': 'Собираю контекст…', 'plan': 'Думаю…', 'answer': 'Формулирую ответ…'}
USAGE_KEYS = ('prompt_tokens', 'completion_tokens', 'context_limit', 'context_used')


def public_usage(value):
    if not isinstance(value, dict):
        return None
    if not all(type(value.get(key)) is int and value[key] >= 0 for key in USAGE_KEYS):
        return None
    if value['context_limit'] <= 0:
        return None
    return {key: value[key] for key in USAGE_KEYS}


def collect_provider_usage(payload, collected):
    """Only reported response metadata: never consult model config or estimate tokens."""
    metadata = getattr(payload, 'response_metadata', None) or {}
    direct = getattr(payload, 'usage_metadata', None)
    sources = [metadata] if isinstance(metadata, dict) else []
    if isinstance(metadata, dict):
        sources += [metadata.get(k) for k in ('usage', 'token_usage', 'usage_metadata')]
    sources += [direct]
    aliases = {'input_tokens': 'prompt_tokens', 'output_tokens': 'completion_tokens'}
    for source in sources:
        if isinstance(source, dict):
            for key, value in source.items():
                key = aliases.get(key, key)
                if key in USAGE_KEYS and type(value) is int and value >= 0:
                    collected[key] = value
