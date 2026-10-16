# Prompt and memory pipeline audit — PR #27

The offline contract is implemented in the production pipeline. Actual model
adherence remains a live acceptance item.

Follow-up §14: system policy text now comes from
`server/resources/prompts/en.json` through `core/text_resources.py`. Builders
retain assembly/roles/limits; persona is still loaded separately. Exact builder
outputs and all five modes are frozen against merged #27 fixtures. See
[TEXT_RESOURCES.md](TEXT_RESOURCES.md) for keys, parameters, localization boundaries
and the remaining text migration.

| Path | Instructions | Data and boundary |
| --- | --- | --- |
| `agent/prompts.py`, `persona.py` | English service policy; configurable persona/appearance only for talk | Persona language stays user controlled; brain identity snippet disabled even under legacy persona_in_brain |
| `turn_prep.py`, `talk_messages.py`, `brain_phase.py` | English neutral routing and talk policy | Discord metadata, memory, captions, web/tool results in bounded human-role data blocks |
| `chat.py`, `chat_stream.py` | Same talk persona and captured mode | Brain supplies facts/tool results before talk; never rewrites completed talk output; overflow retries drop extra data |
| `de_repeat.py`, `reply_pipeline.py` | Talk-only rewrite/empty-response retry | Persona/mode retained, detailed/technical structure preserved; lyrics bypass shortening/rewrite |
| `vision_context.py` | English neutral image description | Discord context separately human-role; native brain vision records brain call with images |
| `memory_jobs.py` | English neutral first-person diary artifact | One completed exchange, stable owner/channel, turn dedupe; no diary job for cancelled/failed turns |
| `working_memory.py`, `emotional_layer.py` | English neutral compression/observable-tone extraction | WM per owner; failures preserve snapshot; per-owner refresh serialized |
| `reflection/engine.py` | English neutral diary/strict-JSON reflection | Nightly input grouped by owner, explicit person-ID allowlist; ambiguous display names rejected; technical results in journal; proposed rules never become policy |
| `ltm_summarize.py`, `ltm_maintenance.py` | English neutral summary; source in human role | Separate owners, retain ownership; empty/failed summaries retain source records |
| `tools/builtins.py`, `plugins/builder.py` | English tool descriptions and technical coder/delegation | Character-profile tool does not disclose persona; coder uses coder_model or brain_model/provider |
| `modules/discord/bot.py` | English intent-classifier system message | User text separately user-role; proactive default has no forged System prefix |

STM windows are bounded and scoped by internal owner/channel. SQLite diary
reads use the same scope, including pre-context. User-owned semantic knowledge
and archive/consolidation digests retain their owner. Shared knowledge means
explicit ownerless knowledge. Legacy unowned diary remains visible to admins
but is excluded from a user's prompt. Image notes store the public response,
never private reasoning. Hub wipes invalidate delayed background writes.

Dashboard exposes process STM, automatic diary and durable profile facts with
sources. This is not hidden reasoning, a full prompt or every Chroma document.
Technical journal lives under System → memory events, without manual creation.
Existing role-protected deletion and wipe routes are retained. Historical
third-person entries stay as history; new generation requests first person.
Model compliance, useful retrieval, latency/billing and production migration
remain separate live acceptance.

Text extraction/localization (§14) has a first server implementation; remaining
UI/Discord/API translations and data wrappers are still open. Mood/Relations
(§7.5) is a near-term priority. Agent loop (§10) and Windows/Linux client come
last; voice/DAVE (§11) is deferred until after the thesis or spare time.
