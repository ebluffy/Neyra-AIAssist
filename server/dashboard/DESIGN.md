# Neyra Dashboard — design direction

Draft for future polish. **Do not treat this as a mandate to reskin the whole SPA in one PR.**

## Identity

Neyra is an ops console for a personal AI agent: dense, technical, calm. The UI should feel like a control surface (modules, memory, webhooks), not a marketing site.

Personality: precise, slightly cool, Russian-first copy. Prefer short verbs («Сохранить», «Тест», «Восстановить») over soft filler.

## Palette (current tokens)

Source: `src/styles/tokens.css`.

| Role | Token | Value |
|------|-------|-------|
| Canvas | `--bg` | `#0b1220` |
| Surface | `--surface` / `--surface-2` | `#121a2b` / `#182235` |
| Border | `--border` / `--border-hi` | `#2a364d` / `#3d4d6b` |
| Text | `--text` / `--muted` | `#f1f5f9` / `#94a3b8` |
| Accent A | `--cyan` | `#22d3ee` |
| Accent B | `--purple` / `--violet` | `#8b5cf6` / `#7c3aed` |
| Status | `--emerald` / `--amber` / `--danger` | ok / warn / error |

Gradients are for brand marks and active chrome only — not full-page purple washes.

## Typography

- UI: **Fira Sans** (loaded); avoid default Inter/Roboto stacks for new surfaces.
- Code / IDs / paths: **Fira Code** via `--mono`.
- Density: compact panel tabs, mono for plugin ids and webhook URLs.

## Layout patterns

1. **Page = one job**: header + optional actions; one primary card stack.
2. **VPN-like forms** (webhooks, module config): enable → destination/URL → secret → options → events → Save. No card soup in the hero of a section.
3. **Split lists**: left list (modules/people), right detail with panel tabs (manage / configs / logs).
4. **Empty states**: icon + one title + one short line; no decorative illustration packs.

## Forms & feedback

- Inputs: `.input` / `.input-mono`; secrets with generate + masked placeholder.
- Confirm destructive / soft-restart / restore with `window.confirm` (or typed archive name for restore).
- Errors: `InlineFeedback` tone error with API message; success for short status lines.
- Soft-restart: expect brief disconnect; use `waitForCoreRestart`.

## Do

- Keep Neyra cyan/purple accents consistent with tokens.
- Prefer table + expand for deliveries over nested cards.
- Show lifecycle badges (`resident` / `on_demand`) next to enable state.
- Document webhook HMAC (`X-Neyra-Signature` over `timestamp.body`) next to the secret field.

## Don't

- Purple-on-white marketing gradients, cream+serif “AI landing” looks, glow stacks, emoji rows.
- Dashboard-of-widgets on first viewport of a single-purpose screen.
- Dual config paths or legacy seed people UI.
- Full visual reskin without updating this file first.

## References (orientation only)

- Antislop core + UI filter (crafted density, anti-generic AI chrome).
- Catalog patterns: clear forms, high-signal tables, quiet empty states (`ebluffy/agent-tool-catalog` anti-slop / ibelick / emil as taste checks — not copy-paste kits).
