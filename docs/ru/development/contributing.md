<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Участие в проекте

Спасибо за вклад в Neyra.

## Окружение разработки

1. Виртуальное окружение (из корня репозитория):
   - `python -m venv .venv_win` (Windows) или `.venv`
   - Windows: `.venv_win\Scripts\activate`
2. Зависимости:
   - `pip install -r server/requirements.txt`
3. Скопируйте `server/.env` из `server/.env.example`.
4. Проверка:
   - `python server/scripts/healthcheck.py` (или из `server/` cwd: `python scripts/healthcheck.py`)

## Границы и архитектура

- Рантайм ориентирован на модель и ядро.
- Не добавляйте приём/отправку голоса Discord в стабильный контур без явной необходимости.
- Новые интерфейсы — в `server/modules/` изолированными плагинами; см. `server/modules/000EXAMPLE/HELP.md` (EN) и `server/modules/000EXAMPLE/HELP-RU.md` (RU).
- Control API — `server/core/api/`, не модуль; bind и dashboard — `server/config/server.yaml`.
- Секреты только в `server/.env`, не в коде и дефолтных конфигах.

## Стиль кода

- Простой явный Python.
- Короткие практичные комментарии.
- Без посторонних рефакторингов в одном PR.

## Перед PR

- Проверки синтаксиса / тесты затронутых мест.
- Скрипт healthcheck.
- Обновите документацию (`README.md`, [`docs/PLAN.md`](../../PLAN.md), `server/.env.example`), если поменялось поведение.
