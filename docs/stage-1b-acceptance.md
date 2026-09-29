# Stage 1b — acceptance record

## Policy change (memory / logs)

Исходная формулировка на `main` запрещала физический перенос `memory/` и `logs/` в 1b.

**Решение владельца:** физический перенос runtime под `server/data/memory/` и `server/logs/` с hash/size check и сохранностью Hub/Chroma.

**Подтверждение в PR #14:** Дмитрий явно подтвердил в комментарии авторевью («ДА СОГЛАСЕН…»). PLAN и inventory приведены к этому решению.

## Backup

- Полный архив рабочей копии: `Z:\!Others\!Dev\AIAssist.zip` (до `git mv` и migrate).

## Verification commands

| Check | Command |
|-------|---------|
| Legacy paths | `python server/scripts/verify_stage_1b.py` |
| With local Hub | `python server/scripts/verify_stage_1b.py --strict-memory` |
| Migrate plan | `python server/scripts/migrate_runtime_layout.py --dry-run` |
| Hub/Chroma stats | `python server/scripts/migrate_runtime_layout.py --report-memory` |
| Health | `cd server && python scripts/healthcheck.py --mode core --skip-http` |
| Docker layout | `docker compose config` (из корня; не публиковать вывод с секретами) |

## Evidence

Фактические выводы с рабочей машины (без секретов): [`stage-1b-evidence.md`](stage-1b-evidence.md).

**Важно:** migrate уже выполнен на рабочей машине до появления `--dry-run`; baseline Hub/Chroma в evidence — **post-migrate** (не «до»). Fingerprint дерева `server/data/memory` зафиксирован как приёмочный снимок после переноса.
