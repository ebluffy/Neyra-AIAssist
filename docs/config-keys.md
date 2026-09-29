# Config keys inventory (Stage 1c)

> One row per leaf key. Defaults from tracked `*.example.yaml` only (not invented).
> Loader: `config/*.yaml` → short root → `modules/*/config.yaml` → env secrets → resolved memory paths → schema.

## `local_voice` merge

| Item | Value |
|---|---|
| Module file | `server/modules/local_voice/config.yaml` |
| Consumer | `merge_plugin_configs` → `config.plugins.local_voice` |
| Stub reader | `stub.py` → `plugins.local_voice.wake_word` |
| Compatibility | Shallow merge; module overlay wins |

## Leaf keys

| Key | Type | Default (example) | Source | Target file | Env override | Compatibility |
|---|---|---|---|---|---|---|
| `paths.data_dir` | str | "./data" | core/runtime/paths.py | `server/config.yaml` | NEYRA_DATA_DIR | current |
| `system.timezone` | null | None | runtime/timeutil, memory display | `server/config.yaml` | — | current |
| `assistant.name` | str | "Neyra" | core/agent/persona.py | `server/config.yaml` | — | current |
| `assistant.persona_path` | str | "prompts/persona.md" | core/agent/persona.py | `server/config.yaml` | — | current |
| `assistant.appearance_path` | str | "prompts/appearance.md" | core/agent/persona.py | `server/config.yaml` | — | current |
| `assistant.appearance_always` | bool | False | core/agent/persona.py | `server/config.yaml` | — | current |
| `assistant.appearance_max_chars` | int | 400 | core/agent/persona.py | `server/config.yaml` | — | current |
| `assistant.persona_in_brain` | bool | True | core/agent/persona.py | `server/config.yaml` | — | current |
| `assistant.persona_brain_max_chars` | int | 600 | core/agent/persona.py | `server/config.yaml` | — | current |
| `assistant.system_prompt` | str | see config.example.yaml | core/agent/persona.py | `server/config.yaml` | — | current |
| `llm.providers.aihope.base_url` | str | "https://aihope.fun/v1" | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.providers.openrouter.base_url` | str | "https://openrouter.ai/api/v1" | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.talk_model.provider` | str | "openrouter" | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.talk_model.model` | str | "qwen/qwen3.8-27b:free" | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.talk_model.reply_max_tokens` | int | 220 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.talk_model.lyrics_reply_max_tokens` | int | 4096 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.talk_model.temperature` | float | 0.8 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.talk_model.top_p` | float | 1.0 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.talk_model.presence_penalty` | float | 0.3 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.talk_model.frequency_penalty` | float | 0.3 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.talk_model.timeout_seconds` | float | 30.0 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.talk_model.max_retries` | int | 1 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.talk_model.primary_first_token_timeout_seconds` | float | 8.0 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.brain_model.provider` | str | "aihope" | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.brain_model.model` | str | "gpt-6-luna" | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.brain_model.model_deep` | str | "gpt-6-luna" | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.brain_model.temperature` | float | 0.35 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.brain_model.top_p` | float | 1.0 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.brain_model.timeout_seconds` | float | 30.0 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.brain_model.max_retries` | int | 1 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.memory_model.provider` | str | "aihope" | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.memory_model.model` | str | "gpt-6-luna" | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.memory_model.temperature` | float | 0.6 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.memory_model.timeout_seconds` | float | 60.0 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.memory_model.max_retries` | int | 1 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.vision_model.enabled` | bool | True | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.vision_model.use_brain_model_for_vision` | bool | True | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.vision_model.provider` | str | "aihope" | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.vision_model.model` | str | "gpt-6-luna" | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.vision_model.max_tokens` | int | 800 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.vision_model.temperature` | float | 0.75 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.vision_model.timeout_seconds` | float | 180.0 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.vision_model.max_images_per_message` | int | 4 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.vision_model.max_image_bytes` | int | 8388608 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.vision_model.max_image_width` | int | 1920 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.vision_model.max_image_height` | int | 1080 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.vision_model.remember_last_image` | bool | True | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.vision_model.last_image_note_max_chars` | int | 1200 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.micro_planning.enabled` | bool | False | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.micro_planning.mode` | str | "tags" | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.micro_planning.prefill_enabled` | bool | False | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.micro_planning.start_tag` | str | "[PLAN]" | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.micro_planning.end_tag` | str | "[/PLAN]" | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.micro_planning.anchor_plan` | str | "PLAN:" | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.micro_planning.anchor_reply` | str | "SAY:" | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.async_reflection.enabled` | bool | False | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.async_reflection.temperature` | float | 0.6 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.async_reflection.max_tokens` | int | 1200 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.async_reflection.timeout_seconds` | int | 60 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.async_reflection.max_retries` | int | 1 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `llm.async_reflection.max_note_chars` | int | 1200 | core/llm/, core/agent/llm_setup.py | `server/config/llm.yaml` | — | current |
| `agent.fast_path.enabled` | bool | False | core/agent/ | `server/config/agent.yaml` | — | current |
| `agent.fast_path.min_confidence` | float | 1.0 | core/agent/ | `server/config/agent.yaml` | — | current |
| `agent.fast_path.intents` | list | see agent.example.yaml | core/agent/ | `server/config/agent.yaml` | — | current |
| `memory.sqlite_path` | str | "./data/memory/neyra_memory.db" | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.rag_write_mode` | str | "important_only" | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.chat_log_retention_days` | int | 0 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.stm_max_messages` | int | 10 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.chroma_db_path` | str | "./data/memory/chroma_db" | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.journal_path` | str | "./data/memory/journal.json" | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.diary_path` | str | "./data/memory/neyra_diary.jsonl" | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.thoughts_log` | str | "./data/memory/thoughts.log" | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.diary_max_entries` | int | 5000 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.diary_hourly_enabled` | bool | True | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.diary_hourly_min_lines` | int | 6 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.rag_enabled` | bool | True | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.rag_init_in_background` | bool | True | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.embedding_model` | str | "paraphrase-multilingual-mpnet-base-v2" | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.rag_top_k` | int | 3 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.max_records` | int | 10000 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.ltm_archive_dir` | str | "ltm_archive" | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.ltm_summarize_max_tokens` | int | 2048 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.ltm_cluster_merge.enabled` | bool | True | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.ltm_cluster_merge.similarity_threshold` | float | 0.86 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.ltm_cluster_merge.max_cluster_chars` | int | 95000 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.ltm_cluster_merge.log_dir` | str | "./data/memory/ltm_consolidation" | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.working_memory.enabled` | bool | False | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.working_memory.per_user` | bool | True | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.working_memory.storage_dir` | str | "./data/memory/working_memory" | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.working_memory.shared_file_path` | str | "./data/memory/working_memory.md" | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.working_memory.max_chars_in_prompt` | int | 3500 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.working_memory.update_every_n_turns` | int | 2 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.working_memory.update_after_context_trim` | bool | True | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.working_memory.min_interval_seconds` | int | 45 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.working_memory.max_file_chars` | int | 12000 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.working_memory.llm_max_tokens` | int | 1200 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.pre_context.enabled` | bool | False | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.pre_context.max_chars` | int | 600 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.pre_context.sources` | list | see example yaml | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.pre_context.inject_lane` | str | "talk" | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.session_archive.enabled` | bool | False | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.session_archive.on_overflow` | bool | True | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.session_archive.on_manual_reset` | bool | True | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.session_archive.on_stm_threshold` | bool | False | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.session_archive.threshold_messages` | int | 0 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.session_archive.write_diary` | bool | True | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.session_archive.write_ltm_digest` | bool | False | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.session_archive.clear_stm_after` | bool | False | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.session_archive.max_window_chars` | int | 8000 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.session_archive.max_diary_chars` | int | 1200 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.emotional_layer.enabled` | bool | False | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.emotional_layer.diary_after_turn` | bool | True | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.emotional_layer.diary_emotion_min_interval_seconds` | int | 90 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.emotional_layer.max_diary_emotion_chars` | int | 480 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.emotional_layer.diary_emotion_max_tokens` | int | 350 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.emotional_layer.ltm_emotion_sync` | bool | False | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.emotional_layer.ltm_emotion_max_tokens` | int | 180 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.ltm_auto_prune.enabled` | bool | True | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.ltm_auto_prune.interval_hours` | int | 168 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.ltm_auto_prune.older_than_days` | int | 90 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.ltm_auto_prune.dry_run` | bool | False | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.ltm_auto_summarize.enabled` | bool | False | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.ltm_auto_summarize.interval_hours` | int | 720 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.ltm_auto_summarize.older_than_days` | int | 60 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.ltm_auto_summarize.max_entries` | int | 500 | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.ltm_auto_summarize.compress_with_llm` | bool | True | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.ltm_auto_summarize.dry_run` | bool | False | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.ltm_auto_summarize.run_after_nightly_reflection` | bool | False | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `memory.reflection_time` | str | "04:00" | core/memory/, apply_resolved_memory_paths | `server/config/memory.yaml` | — | current |
| `backup.local_dir` | str | "./backups" | core/runtime/backup.py | `server/config/memory.yaml` | — | current |
| `external_storage.enabled` | bool | False | core/runtime/external_storage.py | `server/config/memory.yaml` | — | current |
| `external_storage.provider` | str | "local_folder" | core/runtime/external_storage.py | `server/config/memory.yaml` | — | current |
| `external_storage.sync_after_big_reflection` | bool | True | core/runtime/external_storage.py | `server/config/memory.yaml` | — | current |
| `external_storage.local_folder.path` | str | "./external_storage" | core/runtime/external_storage.py | `server/config/memory.yaml` | — | current |
| `external_storage.google_drive.credentials_json` | str | "./secrets/google-drive-service-account.json" | core/runtime/external_storage.py | `server/config/memory.yaml` | — | current |
| `external_storage.google_drive.folder_id` | str | "" | core/runtime/external_storage.py | `server/config/memory.yaml` | — | current |
| `voice.language` | str | "ru" | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.prefer` | str | "cloud" | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.local.enable` | bool | False | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.local.model` | str | "small" | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.local.device` | str | "cpu" | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.cloud.enable` | bool | True | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.cloud.provider` | str | "deepgram" | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.cloud.timeout_seconds` | float | 30.0 | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.cloud.max_retries` | int | 1 | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.cloud.openrouter.model` | str | "openai/whisper-large-v3-turbo" | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.cloud.openrouter.base_url` | str | "" | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.cloud.openrouter.temperature` | float | 0.0 | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.cloud.openrouter.upload_mode` | str | "multipart" | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.cloud.deepgram.model` | str | "nova-3" | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.cloud.deepgram.base_url` | str | "https://api.deepgram.com/v1" | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.cloud.deepgram.smart_format` | bool | True | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.cloud.deepgram.punctuate` | bool | True | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.cloud.deepgram.upload_payload` | str | "linear16" | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.cloud.deepgram.use_detect_language` | bool | False | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.cloud.groq.model` | str | "whisper-large-v3-turbo" | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.cloud.groq.base_url` | str | "https://api.groq.com/openai/v1" | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.cloud.groq.temperature` | float | 0.0 | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.stt.cloud.groq.filter_hallucinations` | bool | True | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.tts.prefer` | str | "cloud" | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.tts.local.enable` | bool | False | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.tts.local.provider` | str | "" | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.tts.cloud.enable` | bool | True | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.tts.cloud.provider` | str | "yandex" | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.tts.cloud.endpoint` | str | "https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis" | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.tts.cloud.voice` | str | "masha" | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.tts.cloud.role` | str | "friendly" | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.tts.cloud.speed` | float | 1.1 | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.tts.cloud.pitch_shift_hz` | float | 50.0 | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `voice.tts.cloud.timeout_seconds` | float | 60.0 | core/voice/config.py | `server/config/voice.yaml` | — | current |
| `mcp_client.enabled` | bool | False | core/runtime/mcp_client.py | `server/config/modules.yaml` | — | current |
| `logging.chat_log` | str | "./logs/chat.log" | main.py bootstrap | `server/config/runtime.yaml` | — | current |
| `logging.system_log` | str | "./logs/system.log" | main.py bootstrap | `server/config/runtime.yaml` | — | current |
| `logging.level` | str | "INFO" | main.py bootstrap | `server/config/runtime.yaml` | — | current |
| `health_monitor.enabled` | bool | True | core/runtime/health.py | `server/config/runtime.yaml` | — | current |
| `health_monitor.interval_seconds` | int | 3600 | core/runtime/health.py | `server/config/runtime.yaml` | — | current |
| `health_monitor.llm_timeout_seconds` | int | 10 | core/runtime/health.py | `server/config/runtime.yaml` | — | current |
| `health_monitor.status_log` | str | "./logs/health_status.jsonl" | core/runtime/health.py | `server/config/runtime.yaml` | — | current |
| `internal_api.host` | str | "127.0.0.1" | modules/internal_api/ | `server/config/server.yaml` | INTERNAL_API_BIND_HOST | current |
| `internal_api.port` | int | 8787 | modules/internal_api/ | `server/config/server.yaml` | — | current |
| `internal_api.rate_limit_requests_per_minute` | int | 0 | modules/internal_api/ | `server/config/server.yaml` | — | current |
| `internal_api.audit_log_enabled` | bool | True | modules/internal_api/ | `server/config/server.yaml` | — | current |
| `internal_api.audit_log_path` | str | "./logs/api_audit.jsonl" | modules/internal_api/ | `server/config/server.yaml` | — | current |
| `internal_api.debug_lifecycle_enabled` | bool | False | modules/internal_api/ | `server/config/server.yaml` | — | current |
| `internal_api.websocket.idle_timeout_seconds` | int | 60 | modules/internal_api/ | `server/config/server.yaml` | — | current |
| `internal_api.websocket.ping_interval_seconds` | int | 20 | modules/internal_api/ | `server/config/server.yaml` | — | current |
| `internal_api.websocket.close_grace_seconds` | int | 5 | modules/internal_api/ | `server/config/server.yaml` | — | current |
| `internal_api.level` | str | "INFO" | modules/internal_api/ | `server/config/server.yaml` | — | current |
| `dashboard.enabled` | bool | True | modules/internal_api/ (dashboard) | `server/config/server.yaml` | — | current |
| `dashboard.dist_path` | str | "dashboard/dist" | modules/internal_api/ (dashboard) | `server/config/server.yaml` | — | current |
| `dashboard.require_build` | bool | False | modules/internal_api/ (dashboard) | `server/config/server.yaml` | — | current |
| `plugins.local_voice.wake_word` | str | "neyra" | merge_plugin_configs → plugins.local_voice; stub.py | `server/modules/local_voice/config.yaml` | — | current |
| `plugins.local_voice.input_device` | str | "" | merge_plugin_configs → plugins.local_voice; stub.py | `server/modules/local_voice/config.yaml` | — | current |
| `plugins.local_voice.output_device` | str | "" | merge_plugin_configs → plugins.local_voice; stub.py | `server/modules/local_voice/config.yaml` | — | current |
| `plugins.local_voice.vb_cable_output_device` | str | "" | merge_plugin_configs → plugins.local_voice; stub.py | `server/modules/local_voice/config.yaml` | — | current |

## Legacy / aliases

| Item | Behavior |
|---|---|
| Deep keys still in short `server/config.yaml` | Merged with warning `legacy root deep key …` |
| `YANDEX_ID_KEY` | Alias for `YANDEX_FOLDER_ID`; warning once |
| `HUGGING_FACE_HUB_TOKEN` | Alias for `HF_TOKEN`; warning once |

## Module overlays

| Module | Merged as |
|---|---|
| `modules/discord/config.yaml` | top-level `discord` |
| `modules/internal_api/config.yaml` | `internal_api`, `dashboard` (overrides `server.yaml`) |
| other `modules/<id>/config.yaml` | `plugins.<id>` |
