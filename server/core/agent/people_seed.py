"""Seed default PeopleDB dossiers when Hub/cache is empty (no JSON import)."""

from __future__ import annotations

import copy
import logging
from typing import Any

logger = logging.getLogger("neyra.agent.people_seed")

DEFAULT_PEOPLE: list[dict[str, Any]] = [
    {
        "id": "maxim",
        "names": ["Максим", "МаксимкусЮТ", "tiltedeverlastinghat", "hopelesness"],
        "discord_ids": [],
        "static_facts": {
            "birth_year": 2004,
            "city": "Киров",
            "living": "квартира на кирпичке с мамой, бабушкой и братом Димой ~4г",
            "work": "безработный",
            "games": ["Roblox", "Dota 2", "CS2"],
            "notes": "Аниме на аве. Подкалывать за безработность и Роблокс.",
        },
        "dynamic_facts": [],
    },
    {
        "id": "kutyr",
        "names": ["Дмитрий", "Кутырин", "zalupank", "димас", "кутыр", "таксист на ауди"],
        "discord_ids": [],
        "static_facts": {
            "birth_year": 2005,
            "city": "Киров",
            "living": "с девушкой, каблук",
            "car": "старая Ауди",
            "games": ["Dota 2", "CS2"],
            "trigger": "Бесится когда называют 'Иван Золо'",
            "notes": "Аниме на аве. Шутить про Ауди можно, но в меру.",
        },
        "dynamic_facts": [],
    },
    {
        "id": "timofey",
        "names": ["Тимофей", "maj14", "маджестик", "maji", "тимоша", "тимдимыч"],
        "discord_ids": [],
        "static_facts": {
            "age": "~19",
            "city": "Волгоград",
            "study": "пилот БПЛА, колледж/шарага",
            "games": ["Garry's Mod (Postbellum ~4k ч)", "Dota 2"],
            "traits": "Везучее говно, говноед. Везёт на смены региона в Роблокс.",
            "notes": "Аниме на аве. Можно жёстко стебать — не обижается.",
        },
        "dynamic_facts": [],
    },
    {
        "id": "andrey_griniks",
        "names": ["Андрей", "Гриникс", "гриндук", "гринишка", "андрейка", "школьник"],
        "discord_ids": [],
        "static_facts": {
            "grade": "11 класс",
            "traits": "немного тупенький, молчит или мычит",
            "games": ["Genshin Impact", "Dota 2"],
            "girlfriend": "Вика (иногда писали ей в ВК чтоб отпустила)",
        },
        "dynamic_facts": [],
    },
    {
        "id": "bogdan",
        "names": ["Богдан", "zБИГден", "бигденчик", "psiqq"],
        "discord_ids": [],
        "static_facts": {
            "relation_to": "одноклассник Тимофея",
            "traits": "толстый (сам шутит — говорит сиськи >3 размера)",
            "frequency": "заходит редко",
            "rule": "КАК ТОЛЬКО ПОЯВЛЯЕТСЯ В ВОЙСЕ — СЛАТЬ НАХУЙ",
        },
        "dynamic_facts": [],
    },
    {
        "id": "foxy",
        "names": ["Андрей Иванцов", "Фокси", "Иванцов", "Водитель ШНИВЫ"],
        "discord_ids": [],
        "static_facts": {
            "birth_year": "~2005",
            "city": "Киров",
            "work": "бывший курьер, теперь перекуп",
            "car": "Шевроле Нива 2005 — ПОДАРОК ОТЦА, ТАБУ",
            "girlfriend": "Ксюша (никому не нравится характер)",
            "notes": "В дискорде не сидит. Про Ниву — МОЛЧАТЬ. Про Ксюшу только если сами начали.",
        },
        "dynamic_facts": [],
    },
    {
        "id": "erik",
        "names": ["Эрик", "Хачик", "Армянин", "Сарибек", "Арзоян", "Чурка"],
        "discord_ids": [],
        "static_facts": {
            "city": "Киров (рядом с Димой)",
            "car": "Lada",
            "traits": "клички принимает и не обижается",
            "notes": "В дискорде не сидит.",
        },
        "dynamic_facts": [],
    },
]


def seed_default_people(people_db: Any, memory_hub: Any = None) -> int:
    """
    Seed base dossiers only when Hub/PeopleDB are empty (no JSON import).
    Returns number of people written.
    """
    hub = memory_hub
    if hub is not None:
        try:
            people_n = int(hub.stats().get("people") or 0)
        except Exception:
            people_n = 0
        if people_n > 0 or people_db._cache:
            return 0
    elif people_db._cache:
        return 0

    logger.info("Создаю начальные досье PeopleDB...")
    for template in DEFAULT_PEOPLE:
        person = copy.deepcopy(template)
        person.setdefault("last_seen", None)
        people_db._cache[person["id"]] = person
        if hub is not None:
            try:
                hub.upsert_person(
                    person["id"],
                    display_name=(person.get("names") or [person["id"]])[0],
                    aliases=list(person.get("names") or []),
                    meta=person,
                )
            except Exception as e:
                logger.warning("PeopleDB seed→Hub failed for %s: %s", person["id"], e)

    logger.info("Создано %s начальных досье", len(DEFAULT_PEOPLE))
    return len(DEFAULT_PEOPLE)
