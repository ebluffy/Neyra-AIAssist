## Summary
- Follow-up to #25: D0–D8 Ops Console v2.
- **AR-113..117**: access field clear + dirty-bar tests; cmdk backdrop `role="presentation"` (no button label); Webhooks `useWatch`; honest tracker.
- **D8**: a11y/polish + checklists 5.1/5.2; react-doctor notes; web-ui docs sync.

## Задачи этапа
| # | Задача | Статус |
|---|---|---|
| D0–D8 | Ops Console v2 | ✅ FIXED (этот push) |
| AR-75..117 | blockers…palette/a11y | ✅ FIXED (этот push) |
| Smoke мини-ПК | вне scope агента (осознанно) | ⬜ OPEN (владелец) |

## Чеклист 5.1 (фронт)
| Пункт | Статус | Доказательство |
|---|---|---|
| 404 | ✅ | `NotFoundScreen` + `routes.tsx` `*` |
| Meta title | ✅ | `AppShell` `document.title`; e2e shell |
| Meta description | ✅ | `index.html` |
| Favicon | ✅ | `public/favicon.svg`, `.ico`, apple-touch, theme-color |
| robots.txt | ✅ | `public/robots.txt` Disallow + meta/X-Robots-Tag |
| sitemap.xml | N/A | закрытая админка / noindex |
| Open Graph | N/A | не шарится |
| Alt text | ✅ | Memory avatars `alt`; icons `aria-hidden` |
| Адаптив | ✅ | Sheet sidebar; hit ≥40/44; DESIGN |
| Loading | ✅ | Skeleton / RestartProgress / button busy |
| Ошибки | ✅ | ErrorState + InlineFeedback + ConnectionBanner |
| ToS | N/A | self-hosted / LICENSE |
| Cookies | N/A | sessionStorage session; UI prefs only in localStorage |
| Аналитика | N/A | нет трекеров; audit/health на Статусе |
| Формы / feedback | ✅ | RHF+zod webhooks; Settings rotate; Docs «Сообщить о проблеме» |
| Сжатые изображения | ✅ | `avatarSrc` Discord `size=64` + lazy |

## Чеклист 5.2 (бэк)
| Пункт | Статус | Доказательство |
|---|---|---|
| Валидация | ✅ | pydantic `extra=forbid` (#25 B2) |
| Хеши | ✅ | PBKDF2 600k + session hash (#25 B5) |
| Секреты вне git | ✅ | gitignore + gitleaks CI |
| Auth на сервере | ✅ | RequireRole на `/v1` |
| Rate limit login/rotate | ✅ | login window + RPM |
| Таймауты | ✅ | httpx/LLM/webhooks |
| Идемпотентность платежей | N/A | вебхуки: dedup |
| Транзакции | ✅ | SQLite backup/restore (#25 B4) |
| Индексы | ✅ | Hub migrations (#25 B3) |
| Версионированные миграции | ✅ | memory hub |
| Логи без токенов | ✅ | redaction filters |
| Health + DB | ✅ | `/v1/health` live/ready |
| Бэкапы | ✅ | API + System UI |
| CORS | ✅ | security headers |
| 429 | ✅ | rate limit |
| ID isolation | ✅ | roles viewer/maint/admin |

## Test plan
- [x] `cd server/dashboard && npm run lint && npm run typecheck && npm test -- --run && npm run build` (lint 0 errors; 26 tests)
- [ ] Smoke на мини-ПК (осознанно не агентом)

## Деплой
```bash
cd /opt/neyra && git fetch && git checkout dash/d1-d8-ops-console && git pull --ff-only
<venv>/bin/pip install -r server/requirements.txt
cd server/dashboard && npm ci && npm run build && cd /opt/neyra
sudo systemctl restart neyra
```

## Не проверено
- Smoke на мини-ПК (по брифу агент не деплоит).
