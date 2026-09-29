<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Contributing

Thanks for contributing to Neyra.

## Development setup

1. Create a virtualenv:
   - `python -m venv .venv`
   - Windows: `.venv\Scripts\activate`
2. Install dependencies:
   - `pip install -r requirements.txt`
3. Create `.env` from `.env.example`.
4. Run the healthcheck:
   - `.venv\Scripts\python.exe scripts\healthcheck.py`

## Scope and architecture

- Keep runtime model-first.
- Do not add Discord voice receive/send into the stable path.
- New interface work belongs in `server/modules/` as isolated plugins; see `server/modules/000EXAMPLE/HELP.md` (EN) and `server/modules/000EXAMPLE/HELP-RU.md` (RU).
- Keep secrets out of code and default config; use `.env`.

## Code style

- Prefer simple, explicit Python.
- Keep comments short and practical.
- Avoid unrelated refactors in the same change.

## Before opening a PR

- Run syntax checks / tests for the areas you changed.
- Run the healthcheck script.
- Update docs (`README.md`, `PLAN.md`, `.env.example`) if behavior changed.