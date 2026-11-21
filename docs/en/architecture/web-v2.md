# Web client v2 (English summary)

**Status:** accepted 11.11.2026. The canonical, complete specification is the Russian document
[`docs/ru/architecture/web-v2.md`](../../ru/architecture/web-v2.md); this page is a short summary
kept in sync with it. If the two disagree, the Russian text wins until this page is corrected.

## Goal

One web client for Neyra on top of the existing core: chat with streaming answers, ops screens,
memory browsing, and the desktop client's server-side counterpart. The old dashboard
(`server/dashboard`) stays as an ops fallback at `/legacy` until parity, then is removed (D14).

## Main decisions

| ID | Decision |
| --- | --- |
| D1 | The web client lives in the client monorepo (`web`), not in `server/dashboard` |
| D3 | Stack: Next.js, Better Auth, PostgreSQL, Drizzle |
| D5 | Identity: the web signs a short-lived JWT (HS256, 60 s TTL); the core verifies it and resolves the web account to its current person (initial ID is uuid5 of `web:<sub>`, a merge may change the account owner) |
| D14 | Old dashboard is decommissioned after parity; `/legacy` during migration |
| D15 | Attachments (images, PDF, audio) are part of the chat contract |
| D27 | Per-message model choice: switching the model does not create a new chat |

The full list is D1–D27 in the Russian document.

## Trust boundary

The core does not filter the request source: `/v1/chat`, `/v1/ws/chat` and `/v1/memory/*` are
protected by role tokens only, not by the network. Only `/v1/desktop/*` is published; the reverse
proxy denies the rest at the edge (see [api-reverse-proxy](../ops/api-reverse-proxy.md)).

## Stages

| Stage | Scope |
| --- | --- |
| P0 | Monorepo, shared UI kit, contracts, empty web shell |
| P1–P3 | Auth, chat with streaming, memory and settings screens |
| P4–P5 | Ops screens parity, attachments, model switching |
| P6 | Domain switch, `/legacy`, removal of the old UI |

## Known blockers before web P1

§15 of the Russian document lists the core changes. Items 1, 2, 5 and 7 (identity, `/v1/web/me`,
attachments and scoped memory) are implemented in the web identity PR; items 4 and 6
(per-request `model`, `stop`) are implemented in #80; item 3 (`platform`) and item 8 (HTTP voice)
remain P1 work:

| # | Change | Priority |
| --- | --- | --- |
| 1 | Verify `X-Neyra-Identity` on `/v1/chat`, `/v1/ws/chat`, `/v1/memory/*`, `/v1/desktop/*` | done (#73) |
| 2 | `GET /v1/web/me`: `person_id`, role, limits from the JWT | done (#73) |
| 3 | `platform` field in `WsChatMessage` | P1 |
| 4 | `model` field in `ChatRequest` / `WsChatMessage` plus a model override in `agent.chat` | done (#80) |
| 5 | Attachment contract: `attachments[]` (`kind`, `path`/`url`, `mime`, `text?`) routed to vision/STT/text extraction | done (#73) |
| 6 | `stop` message type in WS | done (#80) |
| 7 | Scope in `/v1/memory/*`: a user sees only their own `person_id` | done (#73) |
| 8 | HTTP wrapper for STT/TTS in the web (`/v1/web/voice` or `/v1/desktop/voice`) | P1 |

The stack itself is fixed and needs no further decision: `web` is the Next.js App Router, while the
desktop front end (`client/`, later `desktop/`) is a Vite SPA with its own router and hash/memory
history under `tauri://`. The legacy dashboard's `createBrowserRouter` is not reused in either
application. This is ADR-0001 item 4 and D3.
