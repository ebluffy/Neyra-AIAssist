# ADR-0001: client monorepo and shared UI kit (English summary)

**Status:** accepted 11.11.2026. The canonical text is the Russian document
[`docs/ru/architecture/adr-0001-client-monorepo.md`](../../ru/architecture/adr-0001-client-monorepo.md);
this page is a summary and follows it.

## Context

Two React applications with different UI stacks exist today: the Tauri desktop client (`client/`,
own CSS and hand-written components, 233 Vitest tests) and the web dashboard (`server/dashboard`,
Tailwind, Radix/shadcn primitives, `createBrowserRouter`, TanStack Query, Playwright). Keeping both
after the reform would reproduce the two design languages the reform exists to remove.

## Decision

1. **A monorepo with a shared kit and two thin applications:**
   - `packages/ui` — tokens, theme, Radix/shadcn primitives;
   - `packages/contracts` — zod schemas for HTTP/WSS and the desktop bridge;
   - `apps/web` — today's dashboard and the web client;
   - `apps/desktop` — the Tauri front end on the same kit.
2. **Rust is untouched.** `client/src-tauri` (cpal, PTT hotkeys, keyring, updater) and
   `client/overlay.html` stay, and the IPC contract stays the same, so hardware acceptance is done
   once and does not depend on the UI.
3. **Overlay and character window stay separate webviews** with their own minimal bundle (three-vrm).
4. **Router:** `createBrowserRouter` for the web and a hash/memory variant for Tauri, otherwise
   routes break under the `tauri://` protocol.
5. **Platform adapter:** PTT, keyring, input devices and screen capture are unavailable in a
   browser, so they are shown as "app only" instead of being hidden.
6. **Layout:** chat is full-bleed, ops screens keep the dense "list + detail" shape.

## Consequences

- The chat surface — about 12 components and 3 screens — moves to the Radix kit together with the
  Vitest suite; this is the largest part of the epic.
- Order of work: monorepo + `packages/ui` + `packages/contracts` + empty Tauri front end → ops
  screens → chat.
- Run hardware acceptance on the new UI so it is not tested twice.
- The old `client/` UI and `server/dashboard` stay until parity, then are deleted.

## Rejected alternatives

- **Keep two UIs** — two design languages and duplicated work.
- **One SPA including overlay and character** — different load and separate windows.
- **Rewrite Rust for the new UI** — breaks the accepted hardware part and the IPC contract.
