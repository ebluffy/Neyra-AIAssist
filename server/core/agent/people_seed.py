"""Seed default PeopleDB dossiers when Hub/cache is empty (no JSON import)."""

from __future__ import annotations

import copy
import logging
from typing import Any

from core.memory.person_profile import coerce_profile

logger = logging.getLogger("neyra.agent.people_seed")

# Canonical profile: first_name / last_name / birth_date / city only.
# Everything else → seed_facts (person_facts).
DEFAULT_PEOPLE: list[dict[str, Any]] = [
    {
        "id": "maxim",
        "names": ["Максим", "МаксимкусЮТ", "tiltedeverlastinghat", "hopelesness"],
        "discord_ids": [],
        "static_facts": {
            "first_name": "Максим",
            "birth_date": "2004",
            "city": "Киров",
        },
        "seed_facts": [
            "Занятие: безработный",
            "Живёт: квартира на кирпичке с мамой, бабушкой и братом Димой ~4г",
            "Игры: Roblox, Dota 2, CS2",
            "Аниме на аве. Подкалывать за безработность и Роблокс.",
        ],
        "dynamic_facts": [],
    },
    {
        "id": "kutyr",
        "names": ["Дмитрий", "Кутырин", "zalupank", "димас", "кутыр", "таксист на ауди"],
        "discord_ids": [],
        "static_facts": {
            "first_name": "Дмитрий",
            "last_name": "Кутырин",
            "birth_date": "2005",
            "city": "Киров",
        },
        "seed_facts": [
            "Занятие: таксист",
            "Живёт с девушкой, каблук",
            "Машина: старая Ауди",
            "Игры: Dota 2, CS2",
            "Бесится когда называют «Иван Золо»",
            "Аниме на аве. Шутить про Ауди можно, но в меру.",
        ],
        "dynamic_facts": [],
    },
    {
        "id": "timofey",
        "names": ["Тимофей", "maj14", "маджестик", "maji", "тимоша", "тимдимыч"],
        "discord_ids": [],
        "static_facts": {
            "first_name": "Тимофей",
            "birth_date": "~2007",
            "city": "Волгоград",
        },
        "seed_facts": [
            "Занятие: пилот БПЛА, колледж/шарага",
            "Игры: Garry's Mod (Postbellum ~4k ч), Dota 2",
            "Черты: везучее говно, говноед. Везёт на смены региона в Роблокс.",
            "Аниме на аве. Можно жёстко стебать — не обижается.",
        ],
        "dynamic_facts": [],
    },
    {
        "id": "andrey_griniks",
        "names": ["Андрей", "Гриникс", "гриндук", "гринишка", "андрейка", "школьник"],
        "discord_ids": [],
        "static_facts": {
            "first_name": "Андрей",
            "last_name": "Гриникс",
        },
        "seed_facts": [
            "Занятие: 11 класс",
            "Черты: немного тупенький, молчит или мычит",
            "Игры: Genshin Impact, Dota 2",
            "Девушка: Вика (иногда писали ей в ВК чтоб отпустила)",
        ],
        "dynamic_facts": [],
    },
    {
        "id": "bogdan",
        "names": ["Богдан", "zБИГден", "бигденчик", "psiqq"],
        "discord_ids": [],
        "static_facts": {
            "first_name": "Богдан",
        },
        "seed_facts": [
            "Связь: одноклассник Тимофея",
            "Черты: толстый (сам шутит — говорит сиськи >3 размера)",
            "Заходит редко",
            "Правило: КАК ТОЛЬКО ПОЯВЛЯЕТСЯ В ВОЙСЕ — СЛАТЬ НАХУЙ",
        ],
        "dynamic_facts": [],
    },
    {
        "id": "foxy",
        "names": ["Андрей Иванцов", "Фокси", "Иванцов", "Водитель ШНИВЫ"],
        "discord_ids": [],
        "static_facts": {
            "first_name": "Андрей",
            "last_name": "Иванцов",
            "birth_date": "~2005",
            "city": "Киров",
        },
        "seed_facts": [
            "Занятие: бывший курьер, теперь перекуп",
            "Машина: Шевроле Нива 2005 — ПОДАРОК ОТЦА, ТАБУ",
            "Девушка: Ксюша (никому не нравится характер)",
            "В дискорде не сидит. Про Ниву — МОЛЧАТЬ. Про Ксюшу только если сами начали.",
        ],
        "dynamic_facts": [],
    },
    {
        "id": "erik",
        "names": ["Эрик", "Хачик", "Армянин", "Сарибек", "Арзоян", "Чурка"],
        "discord_ids": [],
        "static_facts": {
            "first_name": "Эрик",
            "last_name": "Арзоян",
            "city": "Киров",
        },
        "seed_facts": [
            "Рядом с Димой",
            "Машина: Lada",
            "Клички принимает и не обижается",
            "В дискорде не сидит.",
        ],
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
        seed_facts = list(person.pop("seed_facts", []) or [])
        person["static_facts"] = {
            k: v for k, v in coerce_profile(person.get("static_facts")).items() if str(v).strip()
        }
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
                for fact in seed_facts:
                    hub.add_person_fact(person["id"], fact=fact, source="people_seed")
            except Exception as e:
                logger.warning("PeopleDB seed→Hub failed for %s: %s", person["id"], e)

    logger.info("Создано %s начальных досье", len(DEFAULT_PEOPLE))
    return len(DEFAULT_PEOPLE)
