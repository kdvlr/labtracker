import json
import sqlite3
from pathlib import Path

from .config import DB_PATH

_SCHEMA = (Path(__file__).parent / "schema.sql").read_text()


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    for key in ("conversions", "aliases", "zones"):
        if key in d and isinstance(d[key], str):
            try:
                d[key] = json.loads(d[key])
            except ValueError:
                pass
    return d


def init_db() -> None:
    conn = get_db()
    try:
        conn.executescript(_SCHEMA)
        # Create member_descriptions cache table if not exists
        conn.execute(
            """CREATE TABLE IF NOT EXISTS member_descriptions (
                member_id INTEGER NOT NULL,
                test_type_id INTEGER NOT NULL,
                description TEXT NOT NULL,
                generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (member_id, test_type_id),
                FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
                FOREIGN KEY (test_type_id) REFERENCES test_types(id) ON DELETE CASCADE
            )"""
        )
        # Migration: add columns that older databases predate.
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(test_types)")}

        if "zones" not in cols:
            conn.execute("ALTER TABLE test_types ADD COLUMN zones TEXT")
        dcols = {r["name"] for r in conn.execute("PRAGMA table_info(documents)")}
        if "extraction" not in dcols:
            conn.execute("ALTER TABLE documents ADD COLUMN extraction TEXT")

        n = conn.execute("SELECT COUNT(*) FROM test_types").fetchone()[0]
        if n == 0:
            from .seed_tests import SEED_TESTS

            for t in SEED_TESTS:
                conn.execute(
                    """INSERT INTO test_types
                       (name, slug, category, canonical_unit, conversions, ref_low, ref_high, aliases, description)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        t["name"],
                        t["slug"],
                        t.get("category"),
                        t["canonical_unit"],
                        json.dumps(t.get("conversions", {})),
                        t.get("ref_low"),
                        t.get("ref_high"),
                        json.dumps(t.get("aliases", [])),
                        t.get("description"),
                    ),
                )
        conn.commit()
        _migrate_categories_and_zones(conn)
    finally:
        conn.close()


def _migrate_categories_and_zones(conn) -> None:
    """Assign every test type a keyword-derived category and attach known
    interpretation bands. Idempotent — safe to run on every startup."""
    from .reference import ZONES, categorize

    rows = conn.execute("SELECT id, name, slug, category, zones FROM test_types").fetchall()
    for r in rows:
        cat = categorize(r["name"])
        if cat != r["category"]:
            conn.execute("UPDATE test_types SET category = ? WHERE id = ?", (cat, r["id"]))
        # Curated bands are authoritative: sync markers that have them, and clear
        # any stale bands from markers that no longer do (they revert to the lab
        # reference range).
        desired = json.dumps(ZONES[r["slug"]]) if r["slug"] in ZONES else None
        if r["zones"] != desired:
            conn.execute("UPDATE test_types SET zones = ? WHERE id = ?", (desired, r["id"]))
    conn.commit()
