"""Public context counters: actual provider inputs and configured context windows."""
PHASES = {'retrieval': 'Собираю контекст…', 'plan': 'Думаю…', 'answer': 'Формулирую ответ…'}
LANES = ('talk', 'brain', 'memory', 'vision')


def lane_inputs(report):
    """Latest successful request per lane; never include traces or failed retries."""
    result = {}
    for call in (report or {}).get('calls', []):
        lane = call.get('lane')
        if lane not in LANES or call.get('status') != 'completed':
            continue
        usage = call.get('usage') or {}
        used = usage.get('input_tokens', usage.get('prompt_tokens'))
        # A newer successful call without usage invalidates the earlier reading.
        result.pop(lane, None)
        if type(used) is int and used >= 0:
            result[lane] = used
    return result


def context_usage(config, inputs=None):
    """No estimates/default capacities. Unknown fields are absent, never zero.

    There is no percentage-based automatic compression policy in this core;
    threshold_messages is not a percentage and must not be exposed as one.
    """
    llm = config.get('llm') or {}
    lanes = {}
    for lane in LANES:
        entry = {}
        limit = (llm.get(lane + '_model') or {}).get('context_window')
        if type(limit) is int and limit > 0:
            entry['limit'] = limit
        used = (inputs or {}).get(lane)
        if type(used) is int and used >= 0:
            entry['used'] = used
        lanes[lane] = entry
    total = {}
    for field in ('used', 'limit'):
        if all(field in entry for entry in lanes.values()):
            total[field] = sum(entry[field] for entry in lanes.values())
    return {'total': total, 'lanes': lanes}


def context_policy(config):
    """Describe the existing archive switches without changing their policy."""
    from core.agent.session_archive import session_archive_cfg
    cfg = session_archive_cfg(config)
    enabled = bool(cfg.get('enabled'))
    threshold = int(cfg.get('threshold_messages') or 0)
    active = enabled and bool(cfg.get('on_stm_threshold')) and threshold > 0
    return {'compaction_enabled': enabled, 'mode': 'messages' if active else 'off',
            'threshold_messages': threshold}
