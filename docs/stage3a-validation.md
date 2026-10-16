# Stage 3a local acceptance (#27)

Scope: conversation settings, Discord metadata, model evidence, and existing ops
flows on an isolated backend. No deployment, real LLM calls, or Discord login.

## Evidence

Finalization after Kilo (2026-10-15): input SHA `9cb2bed` had 4 pytest
failures and 6 passing CI jobs. Human-role Discord metadata and reduced-context
retry handling are restored; the marker is consistently `[DISCORD CONTEXT]`.
The current local server suite passes **142 tests**, all 14 stage/offline
scripts pass, and compileall passes. The 127-test result below is the earlier
Stage 3a baseline. Dashboard and final HEAD CI are checked separately.

This is a bounded integration review, not completion of every item in PLAN
sections 12–14. Coder routing, full memory UI redesign, end-to-end scoped diary
and production background-call instrumentation remain implementation work;
see PLAN, BUGS, and MODEL_TRACE for the limits.

- Server: 127 tests passed, including real turn preparation/finalization with
  temporary SQLite, REST/WS, actual Discord command registration with mocked
  sync, owner isolation, vision, retries, cancellation, and concurrent turns.
- Dashboard: 32 unit tests, lint without errors, typecheck and production build
  on Node 22. Existing LogViewer lint warning and bundle-size warning remain.
- Playwright: 8 desktop/mobile scenarios passed. Both themes, all five modes,
  persisted settings into actual offline prompts, discard, keyboard selection,
  save error retention, model evidence, module toggle/invoke, people creation,
  SQLite backup, and process-exit-stubbed restart request.
- Stage 1b/1c/1d/2 checks and offline security/brain-hard-failure checks passed.
- Screenshots are generated under ignored `server/dashboard/test-results/`.
  Gate-only smoke and the real-API integration tests are reported separately.

## UI delivery gate

This gate covers the changed Settings/Status controls and theme corrections,
not a claim of a complete audit of every existing dashboard surface.
Direction: existing DESIGN.md, ENERGY 3 / RHYTHM 2 / MOTION 2.

- R-01 PASS: existing card hierarchy; no new gradients or glows.
- R-02 PASS: new UI copy contains no em dashes.
- R-03 PASS: desktop/mobile layout checks and both-theme screenshots show no document overflow.
- R-04 PASS: existing Activity icon identifies call history; existing Select chevron indicates its menu.
- R-05 PASS: settings field and operational call history follow the existing task layout.
- R-06 PASS: existing Fira Sans UI and Fira Code model identifiers.
- R-07 PASS: no decorative background grids added.
- R-08 PASS: no decorative arrows added.
- R-09 PASS: no promotional badges added.
- R-10 PASS: no glass surfaces added.
- R-11 PASS: existing radius tokens and Select primitive.
- R-12 PASS: no new elevation/shadow system.
- R-13 PASS: no glow effects added.
- R-14 PASS: repeated model rows represent the same schema; configured/evidence sections are distinct.
- R-15 PASS: actions retain explicit Save/Discard/Retry wording.
- R-16 PASS: no marketing claims added.
- R-17 PASS: statuses and model identifiers come from API responses, not invented statistics.
- R-18 PASS: no testimonials added.
- R-19 PASS: no additional motion; existing reduced-motion rules retained.
- R-20 PASS: existing Neyra tokens, typography, ops hierarchy and Russian UI retained.
- R-21 PASS: dark and light screenshots inspected; no forced theme.
- R-22 PASS: no generic illustrations added.
- R-23 PASS: no visual assets invented or fetched.
- R-24 PASS: existing routes reused; no dead navigation added.
- R-25 PASS: light cyan foreground contrast 4.89:1 and warning foreground 6.47:1 against canvas, checked with contrast-check.py; model copy uses existing text tokens.
- R-26 PASS: save/discard/retry and native disclosure controls have working behavior; real API integration passed.
- R-27 PASS: Select save error/loading and activity loading/error/empty states implemented and tested.
- R-28 PASS: no FAQ content added.
- R-29 PASS: existing semantic palette; light warning foreground is a readable warning shade.
- R-30 PASS: changes extend the existing product design.
- R-31 PASS: Select controls a single preference; evidence list distinguishes configured and reported models.
- R-32 PASS: associated label/helper/error IDs, aria-invalid, 44px Select target, visible focus and browser keyboard checks.
- R-33 PASS: UI source and styles changed directly with patches, not generated patch scripts.
- R-34 PASS: both themes inspected; sidebar uses themed background; cyan/warning actions retain readable text.
- R-35 PASS: production build and actual-backend click-through completed on desktop/mobile.
- R-36 PASS: no security/compliance/performance promises added.
- R-37 PASS: direction and dials come from the existing DESIGN.md.
- R-38 PASS: production history comes from calls; deterministic providers exist only in the explicit temporary test backend.
- Liveliness PASS: selected mode and latest report provide focal points; existing spacing, cyan accent and typography supply hierarchy and identity without extra motion.
- C-1 PASS: controls and sections have explicit operational purposes.
- C-2 PASS: changed actions are connected to actual API/state.
- C-3 PASS: new sections implement roadmap capabilities.
- C-4 PASS: changed surfaces tested with errors, unknown model IDs, keyboard input, themes and mobile viewport.
- C-5 PASS: no fabricated product claims.

## Automatic review follow-up (AR-7 through AR-12)

- Test fixtures and the E2E app factory discard inherited `NEYRA_DATA_DIR`.
  Regression tests protect an existing sentinel database and assert that only
  the temporary auth database is opened, for both harnesses.
- Discord prompts carry metadata in human-role messages, omit original content,
  cap mentions at 10, and omit the block on reduced-context overflow retry.
  Full typed input and ID-based memory ownership are preserved.
- Cancellation of a non-streaming turn produces `cancelled` evidence and an
  Event Bus report, and resets the active trace.
- Config persistence/rebind errors return fixed messages; detailed exceptions
  stay in server logs with the matching trace ID.
- Discord client defaults suppress user/role/everyone mentions, while allowing
  explicit replies to mention the replied-to author.
- PR Tasks describe local scope only. PLAN section 10 is added relative to
  main as documentation; its pre-existing local text remains unchanged.
- Follow-up validation: 89 targeted regressions, full suite 127 passed, and
  all 8 desktop/mobile E2E scenarios passed again on Node 22.
- All 10 standalone offline scripts from the LLM/memory CI job passed after
  preserving compatibility with legacy turn-preparation stubs that omit the
  optional Discord context field; the full 127-test suite passed again.

## Completion after Kilo — local acceptance

- 157 server tests, including scoped pipeline/pre-context, first-person diary
  artifact generation, detached job completion/failure/cancellation, wipe
  invalidation, finalized SQLite reports, response/request ID separation,
  metadata-only stream timeout, old-schema migration/reopen and owner-preserving
  consolidation with failed/empty-summary source retention.
- All 14 CI stage/offline scripts and compileall passed with project `.venv`.
- Node 22: 35 unit tests, lint (existing LogViewer warning only), typecheck and
  production build. Ten Playwright desktop/mobile scenarios use actual local
  API/temporary SQLite: settings round-trip, modules, memory layers, background
  diary, long-memory facts, journal deletion, backup and stubbed restart.
- UI skills: ui-ux-pro-max, shadcn, fixing-accessibility,
  make-interfaces-feel-better and antislop during. Existing DESIGN.md dials
  remain ENERGY 3 / RHYTHM 2 / MOTION 2; existing tokens and controls only.
- Gate: PASS for changed surfaces. Memory/System tabs support roving focus,
  arrows/Home/End and labelled tabpanels; native disclosures work by keyboard.
  Read-only panels expose loading/empty/error/retry. Journal keeps confirmation
  and failed-delete recovery. No raw RAG/manual diary or journal forms.
  Light/dark screenshots inspected at desktop and 390px mobile; no horizontal
  overflow, source labels wrap, actions remain available. No new fonts, palette,
  decorative effects or fabricated runtime data were added.
- Runtime diary language/model adherence, production migration and paid
  provider evidence remain the user's live acceptance, not offline successes.

## Review regressions AR-22…26

- Server: 181 passed; 14 stage/offline scripts and compileall passed.
- Node 22: 35 unit, lint/typecheck/build, 10 real offline-backend E2E scenarios.
- Partial legacy consolidation rolls back stored digests and retries cleanly;
  failed summaries never archive the source. Debug STM exposes bounded scoped
  windows outside a turn, retaining its flat compatibility field.
- Legacy diary knobs are explicitly deprecated; only the canonical turn job
  is scheduled. Wipe guards are per-scope and nested jobs inherit the snapshot.
- Journal delete again requires typing УДАЛИТЬ; keyboard-accessible confirmation
  remains open on errors. WIPE for full journal cleanup is preserved.

## Remaining live acceptance

AR-27 follow-up: full server suite **185 passed**, compileall passed. Four
isolated tool tests prove that JSON parse, write, manifest and exception
failures all return the same safe constant without raw output/error text.
Dashboard code remains unchanged from the 35-unit/10-E2E acceptance above.

AR-28 extends the same tests with caplog: the tool's server warning contains
the failure reason for parse/write/manifest errors. Raw provider output is
omitted from logs and the tool response; operator error detail is bounded.

- Actual model adherence, real Discord streaming/vision, and host lifecycle
  require a separately authorized live run. The corresponding PLAN checkboxes
  remain open.
- The API buffers application-level call evidence. SDK-internal HTTP retries
  and provider routing beyond reported model metadata are not observable here.
