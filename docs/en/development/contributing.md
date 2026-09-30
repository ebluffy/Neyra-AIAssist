<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Co-authored with [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Contributing

Thanks for contributing to [Neyra-AIAssist](https://github.com/ebluffy/Neyra-AIAssist).

## Development setup

1. Create a virtualenv at the repo root:
   - `python -m venv .venv_win` (Windows) or `.venv` (Linux/macOS)
   - activate it
2. Install dependencies:
   - `pip install -r server/requirements.txt`
3. Create `server/.env` from `server/.env.example` and copy config examples under `server/` (see [quickstart](../setup/quickstart.md)).
4. Run the healthcheck:
   - `python server/scripts/healthcheck.py`

## Scope and architecture

- Keep runtime model-first; core code under `server/core/`.
- Do not add Discord voice receive/send into the stable path.
- New integrations belong in `server/modules/` as isolated plugins; see `server/modules/000EXAMPLE/HELP.md` (EN) and `HELP-RU.md` (RU).
- Control API changes belong in `server/core/api/`, not a plugin module.
- Keep secrets out of code and YAML; use `server/.env`.
- Dev MCP only under `devtools/mcp_server/`.

## Code style

- Prefer simple, explicit Python.
- Keep comments short and practical.
- Avoid unrelated refactors in the same change.

## Before opening a PR

- Run syntax checks / tests for the areas you changed (`python -m compileall -q server/core server/modules server/main.py`, relevant verify scripts).
- Run `python server/scripts/healthcheck.py`.
- Update docs (`README.md`, [`docs/PLAN.md`](../../PLAN.md), `server/.env.example`, `docs/en/` as needed) if behavior changed.
