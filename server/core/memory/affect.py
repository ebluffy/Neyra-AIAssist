"""Bounded rule-based assistant state; no model calls or inferred user feelings."""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from typing import Callable

MOOD_HALF_LIFE_HOURS = 8.0
RELATION_HALF_LIFE_HOURS = 24.0 * 30
HISTORY_LIMIT = 20
LEDGER_RETENTION_DAYS = 30
MOOD_AUTHOR_HOURLY_LIMIT = 0.2

# These are explicit conversational cues, not a sentiment or truth detector.
_CUES = (
    ("admitted_lie", r"\b(?:я (?:соврал|соврала|солгал|солгала)|i lied)\b", -0.04, 0.02, -0.02),
    ("insult", r"\b(?:ты (?:дура|тупая|бесполезная)|you(?: are|['’]re) (?:stupid|useless))\b", -0.10, 0.08, -0.04),
    ("apology", r"\b(?:извини|извините|прости|простите|sorry|i apologize)\b", 0.04, -0.02, 0.02),
    ("thanks", r"\b(?:спасибо|благодарю|thank you|thanks)\b", 0.04, -0.01, 0.01),
)


def event_for(text: str) -> tuple[str, float, float, float]:
    for code, pattern, valence, arousal, affinity in _CUES:
        if re.search(pattern, text[:12000], re.IGNORECASE):
            return code, valence, arousal, affinity
    return "interaction", 0.0, 0.0, 0.0


def _clamp(value, low, high):
    return max(low, min(high, value))


def _elapsed(timestamp, now):
    return max(0.0, (now - datetime.fromisoformat(timestamp)).total_seconds() / 3600) if timestamp else 0.0


def _mood(row, now):
    data = dict(row) if row else {"valence": 0.0, "arousal": 0.0, "updated_at": None}
    factor = 2 ** (-_elapsed(data["updated_at"], now) / MOOD_HALF_LIFE_HOURS)
    data["valence"] *= factor
    data["arousal"] *= factor
    data["label"] = "irritated" if data["valence"] < -0.25 else "warm" if data["valence"] > 0.25 else "calm"
    data["decay_half_life_hours"] = MOOD_HALF_LIFE_HOURS
    return data


def _relation(row, person_id, now):
    data = dict(row) if row else {
        "person_id": person_id, "affinity": 0.0, "trust": 0.5, "familiarity": 0.0,
        "updated_at": None, "history": "[]", "last_significant_event": None,
    }
    factor = 2 ** (-_elapsed(data["updated_at"], now) / RELATION_HALF_LIFE_HOURS)
    data["affinity"] *= factor
    data["trust"] = 0.5 + (data["trust"] - 0.5) * factor
    data["familiarity"] *= factor
    data["history"] = json.loads(data["history"])
    data["tone_bias"] = "cold" if data["affinity"] < -0.25 else "warm" if data["affinity"] > 0.25 else "neutral"
    data["observed"] = row is not None
    return data


def talk_state(snapshot):
    """Keep transient talk data small enough to survive context overflow retries."""
    enabled = snapshot.get("enabled", {"mood": True, "relations": True})
    result = {}
    if enabled["mood"]:
        result["mood"] = {key: snapshot["mood"][key] for key in ("valence", "arousal", "label")}
    relation = snapshot["relation"]
    if enabled["relations"] and relation:
        result["relation"] = {key: relation[key] for key in (
            "person_id", "affinity", "trust", "familiarity", "tone_bias"
        )}
    return result or None



class AffectStore:
    """Transactions share the SQLite store's lock, including merge/backup/restore."""

    def __init__(self, store, *, clock: Callable = lambda: datetime.now(timezone.utc)):
        self.store = store
        self.clock = clock

    def snapshot(self, person_id=None):
        with self.store.lock:
            now = self.clock()
            conn = self.store._conn
            mood = _mood(conn.execute("SELECT valence, arousal, updated_at FROM neyra_state WHERE id=1").fetchone(), now)
            relation = None
            if person_id:
                if not conn.execute("SELECT 1 FROM people WHERE person_id=?", (person_id,)).fetchone():
                    raise KeyError(person_id)
                row = conn.execute("SELECT * FROM person_relations WHERE person_id=?", (person_id,)).fetchone()
                relation = _relation(row, person_id, now)
            return {"mood": mood, "relation": relation, "as_of": now.isoformat(), "method": "explicit_cues_v1"}

    def has_turn(self, turn_id):
        with self.store.lock:
            cutoff = (self.clock() - timedelta(days=LEDGER_RETENTION_DAYS)).isoformat()
            return self.store._conn.execute("SELECT 1 FROM affect_turns WHERE turn_id=? AND created_at>=?", (turn_id, cutoff)).fetchone() is not None

    def apply_turn(self, *, turn_id, person_id, text, mood_enabled=True, relations_enabled=True):
        if not turn_id:
            raise ValueError("turn_id required")
        code, dv, da, affinity = event_for(text)
        with self.store.lock:
            now = self.clock()
            stamp = now.isoformat()
            conn = self.store._conn
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute("DELETE FROM affect_turns WHERE created_at<?", ((now - timedelta(days=LEDGER_RETENTION_DAYS)).isoformat(),))
                hour_ago = (now - timedelta(hours=1)).isoformat()
                conn.execute("DELETE FROM affect_mood_events WHERE ts<=?", (hour_ago,))
                if conn.execute("SELECT 1 FROM affect_turns WHERE turn_id=?", (turn_id,)).fetchone():
                    conn.execute("COMMIT")
                    return False
                if person_id and not conn.execute("SELECT 1 FROM people WHERE person_id=?", (person_id,)).fetchone():
                    person_id = None
                if mood_enabled:
                    actor = f"person:{person_id}" if person_id else "anonymous"
                    used = conn.execute(
                        "SELECT COALESCE(SUM(valence_used),0),COALESCE(SUM(arousal_used),0) "
                        "FROM affect_mood_events WHERE actor_id=? AND ts>?", (actor, hour_ago),
                    ).fetchone()
                    def limited(delta, total):
                        available = max(0, MOOD_AUTHOR_HOURLY_LIMIT - total)
                        return round(min(abs(delta), available) * (1 if delta >= 0 else -1), 10)
                    mood_dv, mood_da = limited(dv, used[0]), limited(da, used[1])
                    if mood_dv or mood_da:
                        conn.execute("INSERT INTO affect_mood_events(actor_id,ts,valence_used,arousal_used) VALUES(?,?,?,?)",
                                     (actor, stamp, abs(mood_dv), abs(mood_da)))
                    mood = self.snapshot()["mood"]
                    conn.execute(
                        "INSERT INTO neyra_state(id,valence,arousal,updated_at) VALUES(1,?,?,?) "
                        "ON CONFLICT(id) DO UPDATE SET valence=excluded.valence,arousal=excluded.arousal,updated_at=excluded.updated_at",
                        (_clamp(mood["valence"] + mood_dv, -1, 1), _clamp(mood["arousal"] + mood_da, 0, 1), stamp),
                    )
                if person_id and relations_enabled:
                    relation = self.snapshot(person_id)["relation"]
                    history = relation["history"]
                    if code != "interaction":
                        history = (history + [{"event": code, "at": stamp}])[-HISTORY_LIMIT:]
                    last = stamp if code != "interaction" else relation["last_significant_event"]
                    # Only an explicit admission changes trust; politeness is not evidence of reliability.
                    trust_delta = -0.03 if code == "admitted_lie" else 0.0
                    conn.execute(
                        "INSERT INTO person_relations(person_id,affinity,trust,familiarity,updated_at,history,last_significant_event) "
                        "VALUES(?,?,?,?,?,?,?) ON CONFLICT(person_id) DO UPDATE SET "
                        "affinity=excluded.affinity,trust=excluded.trust,familiarity=excluded.familiarity,"
                        "updated_at=excluded.updated_at,history=excluded.history,last_significant_event=excluded.last_significant_event",
                        (person_id, _clamp(relation["affinity"] + affinity, -1, 1), _clamp(relation["trust"] + trust_delta, 0, 1),
                         _clamp(relation["familiarity"] + 0.01, 0, 1), stamp, json.dumps(history), last),
                    )
                conn.execute("INSERT INTO affect_turns(turn_id,created_at) VALUES(?,?)", (turn_id, stamp))
                conn.execute("COMMIT")
                return True
            except BaseException:
                conn.execute("ROLLBACK")
                raise

    def reset(self, scope, person_id=None):
        with self.store.lock:
            conn = self.store._conn
            conn.execute("BEGIN IMMEDIATE")
            try:
                if scope == "mood":
                    count = conn.execute("DELETE FROM neyra_state").rowcount
                elif scope == "relations":
                    sql = "DELETE FROM person_relations" + (" WHERE person_id=?" if person_id else "")
                    count = conn.execute(sql, (person_id,) if person_id else ()).rowcount
                    conn.execute("UPDATE affect_meta SET value=value+1 WHERE key='relations_revision'")
                else:
                    raise ValueError("Unknown affect scope")
                conn.execute("COMMIT")
                return count
            except BaseException:
                conn.execute("ROLLBACK")
                raise
