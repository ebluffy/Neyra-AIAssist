<!-- co-authored-cursor-badge -->
[![Cursor AI assist](https://img.shields.io/badge/Cursor-AI_assist-141414?style=flat-square)](https://cursor.com)

<sub>Соавторство: материал создан при поддержке ИИ-агента [Cursor](https://cursor.com) (AI coding agent).</sub>

---

# Участие в проекте

Спасибо за вклад в Neyra.

## Окружение разработки

1. Виртуальное окружение:
   - `python -m venv .venv`
   - Windows: `.venv\Scripts\activate`
2. Зависимости:
   - `pip install -r requirements.txt`
3. Скопируйте `.env` из `.env.example`.
4. Проверка:
   - `.venv\Scripts\python.exe scripts\healthcheck.py`

## Границы и архитектура

- Рантайм ориентирован на модель и ядро.
- Не добавляйте приём/отправку голоса Discord в стабильный контур без явной необходимости.
- Новые интерфейсы — в `server/modules/` изолированными плагинами; см. `server/modules/000EXAMPLE/HELP-RU.md` и `HELP.md`.
- Секреты только в `.env`, не в коде и дефолтных конфигах.

## Стиль кода

- Простой явный Python.
- Короткие практичные комментарии.
- Без посторонних рефакторингов в одном PR.

## Перед PR

- Проверки синтаксиса / тесты затронутых мест.
- Скрипт healthcheck.
- Обновите документацию (`README.md`, `PLAN.md`, `.env.example`), если поменялось поведение.