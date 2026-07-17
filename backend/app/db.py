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
        mcols = {r["name"] for r in conn.execute("PRAGMA table_info(members)")}
        if "private" not in mcols:
            # Default 0 — an upgrade must never hide someone's results from them.
            conn.execute("ALTER TABLE members ADD COLUMN private INTEGER NOT NULL DEFAULT 0")
            conn.commit()

        rcols = {r["name"] for r in conn.execute("PRAGMA table_info(results)")}
        if "qualifier" not in rcols:
            conn.execute("ALTER TABLE results ADD COLUMN qualifier TEXT")
            conn.commit()
        if "value_text" not in rcols:
            _rebuild_results_for_qualitative(conn)

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


def _rebuild_results_for_qualitative(conn) -> None:
    """Relax value/value_canonical to nullable and add value_text.

    SQLite can't drop a NOT NULL constraint in place, so the table is rebuilt.
    Every existing row is numeric, so it copies across unchanged.
    """
    conn.commit()
    conn.execute("PRAGMA foreign_keys=off")
    conn.executescript(
        """
        CREATE TABLE results_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
            test_type_id INTEGER NOT NULL REFERENCES test_types(id) ON DELETE CASCADE,
            document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
            taken_at TEXT NOT NULL,
            value REAL,
            unit TEXT NOT NULL,
            value_canonical REAL,
            value_text TEXT,
            ref_low REAL,
            ref_high REAL,
            ref_low_canonical REAL,
            ref_high_canonical REAL,
            flag TEXT,
            qualifier TEXT,
            note TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO results_new
            (id, member_id, test_type_id, document_id, taken_at, value, unit,
             value_canonical, ref_low, ref_high, ref_low_canonical,
             ref_high_canonical, flag, qualifier, note, created_at)
        SELECT id, member_id, test_type_id, document_id, taken_at, value, unit,
               value_canonical, ref_low, ref_high, ref_low_canonical,
               ref_high_canonical, flag, qualifier, note, created_at
        FROM results;
        DROP TABLE results;
        ALTER TABLE results_new RENAME TO results;
        CREATE INDEX IF NOT EXISTS idx_results_member_test ON results(member_id, test_type_id, taken_at);
        CREATE INDEX IF NOT EXISTS idx_results_document ON results(document_id);
        """
    )
    conn.execute("PRAGMA foreign_keys=on")
    conn.commit()


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
