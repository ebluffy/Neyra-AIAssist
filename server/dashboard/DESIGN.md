# Neyra Dashboard — design direction

Ops console for a personal AI agent. Dense, technical, calm — a control surface, not a marketing site.

## Identity

- Personality: precise, slightly cool, Russian-first.
- Copy: short verbs («Сохранить», «Тест», «Восстановить»). No filler.
- Brand mark: wordmark «Neyra» in solid text; mark tile uses cyan border on surface (not purple glow).

## Dials

| Dial | Value | Meaning |
|------|-------|---------|
| ENERGY | 3 | Layered surfaces, hairline rings, inset highlights — not flat slabs; still no grid/orbs/glow stacks |
| RHYTHM | 2 | Compact ops density; split list + detail; VPN-like forms |
| MOTION | 2 | Page enter ≤220ms stagger; press 0.96; panel tabs/hover ≤150ms; no nav open anim (emil) |

## Palette

Source: `src/styles/tokens.css`.

| Role | Token | Value |
|------|-------|-------|
| Canvas | `--bg` | `#0b1220` |
| Surface | `--surface` / `--surface-2` | `#121a2b` / `#182235` |
| Border | `--border` / `--border-hi` | `#2a364d` / `#3d4d6b` |
| Text | `--text` / `--muted` | `#f1f5f9` / `#9aa8bc` |
| Accent (primary) | `--cyan` | `#22d3ee` |
| Accent (brand reserve) | `--purple` | `#8b5cf6` — logo/legacy only, not chrome |
| Status | `--emerald` / `--amber` / `--danger` | ok / warn / error |

Radius scale: `--radius-sm` 6 / `--radius` 8 / `--radius-lg` 12.

## Typography

- UI: **Fira Sans** (`--sans`). No Inter/Roboto.
- Code / IDs: **Fira Code** (`--mono`) + `tabular-nums` for live numbers.
- Titles: solid `--text`, `text-wrap: balance`. No gradient fill on headings.

## Layout

1. Page = one job: header + actions; primary card stack.
2. Forms (webhooks/modules): enable → destination → URL → secret → options → events → Save.
3. Split: left list, right detail with panel tabs.
4. Empty: icon + title + one line — no illustration packs.

## Interaction

- Focus: cyan ring (`:focus-visible`).
- Press: `scale(0.96)` on buttons/toggles; respect `prefers-reduced-motion`.
- Hit targets: ≥40px desktop, ≥44px mobile/menu.
- Icons: Lucide outline, `strokeWidth` ~1.75, `currentColor`.

## Do / Don't

**Do:** cyan for active/focus/primary CTA; solid surfaces; table + expand for deliveries; lifecycle badges.

**Don't:** purple grid backgrounds, ambient orbs, glass on every card, gradient titles, glow on nav/logo/status dots, pill radius on every control, emoji rows, Inter stack.

## References

Catalog stack ([ebluffy/agent-tool-catalog](https://github.com/ebluffy/agent-tool-catalog) UI section), all applied together — antislop alone is not enough:

| Skill | Role |
|-------|------|
| antislop (+ ui/human/layoutmobile) | Filter: block purple glow / template slop |
| hallmark | Structural variety, 8-state controls, token lock |
| emil-design-eng / review-animations | Motion gate, ease curves, press feedback |
| make-interfaces-feel-better | Radii, shadows, hit areas, tabular nums |
| ibelick (fixing-accessibility, baseline-ui, improve-ui) | A11y + baseline polish |
| ui-ux-pro-max | Product-type / UX guideline search |
