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
| D1 | The web client lives in the client monorepo (`apps/web`), not in `server/dashboard` |
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

## Known blockers before P0

Three core-contract gaps are described in §15 of the Russian document and are not implemented yet:
`person_id` derivation, attachments in the chat request, and a per-request `model` field. They must
be decided before P0 code starts. The web stack choice (D3, Next.js) also conflicts with
[ADR-0001](adr-0001-client-monorepo.md), which names `createBrowserRouter`; PLAN §6.2 recommends
keeping Next.js and correcting the ADR line.

## Core web identity contract

`NEYRA_IDENTITY_JWT_SECRET` must contain at least 32 UTF-8 bytes. The core requires
`NEYRA_IDENTITY_JWT_ISSUER` with no default; the web signer must put that exact value
in the required `iss` claim. HS256 is fixed and TTL is at most 60 seconds.
An absent identity header preserves legacy API behaviour; an invalid present header
returns 401, not anonymous access. A bearer service key is still required (WS also
supports the existing query-token path), and its role is not elevated by JWT claims.
`GET /v1/web/me` returns the account's current `person_id`, `user_id`, role, name and
`limits: null`; per-user limits are not implemented yet.
Signed users can only use scoped search/chat-recall and GET their own person card;
all other memory API paths and mutations default to 403. Signed admins and legacy
callers retain existing ops routes subject to the bearer key's permissions.
