import json
import sqlite3
from pathlib import Path

from .config import DB_PATH

_SCHEMA = (Path(__file__).parent / "schema.sql").read_text()


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
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
        # Whole-member AI health analysis (JSON), cached with a hash of the data
        # it was generated from so the UI can flag it as stale when results change.
        conn.execute(
            """CREATE TABLE IF NOT EXISTS member_analyses (
                member_id INTEGER PRIMARY KEY,
                analysis TEXT NOT NULL,
                results_hash TEXT,
                generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
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
        if "category_override" not in cols:
            conn.execute("ALTER TABLE test_types ADD COLUMN category_override TEXT")
        dcols = {r["name"] for r in conn.execute("PRAGMA table_info(documents)")}
        if "extraction" not in dcols:
            conn.execute("ALTER TABLE documents ADD COLUMN extraction TEXT")
        scols = {r["name"] for r in conn.execute("PRAGMA table_info(unlock_sessions)")}
        if "scope" not in scols:
            conn.execute("ALTER TABLE unlock_sessions ADD COLUMN scope TEXT DEFAULT 'member'")
            conn.commit()
            
        conn.execute("CREATE INDEX IF NOT EXISTS idx_documents_member ON documents(member_id)")

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

        # Category/zone sync is authoritative and cheap — it re-applies whenever
        # the reference definitions in code change, so it runs every startup.
        _migrate_categories_and_zones(conn)

        # These are one-time data backfills over every document/result row. Gate
        # them on a stored schema version so they stop full-scanning the table on
        # every boot once they've run.
        SCHEMA_VERSION = 1
        cur = conn.execute("SELECT value FROM settings WHERE key = 'schema_version'").fetchone()
        applied = int(cur["value"]) if cur and str(cur["value"]).isdigit() else 0
        if applied < SCHEMA_VERSION:
            _migrate_document_lifecycle(conn)
            _migrate_clean_filenames(conn)
            _migrate_document_status(conn)
            conn.execute(
                "INSERT INTO settings (key, value) VALUES ('schema_version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (str(SCHEMA_VERSION),),
            )
            conn.commit()
    finally:
        conn.close()


def _migrate_document_lifecycle(conn) -> None:
    # Check if we need to migrate.
    docs = conn.execute("SELECT id, status, extraction FROM documents").fetchall()
    
    from .matching import match_test_type
    from .units import parse_value, to_number
    
    test_types_list = [row_to_dict(r) for r in conn.execute("SELECT * FROM test_types").fetchall()]
    
    for doc in docs:
        doc_id = doc["id"]
        status = doc["status"]
        extraction = doc["extraction"]
        
        # Check if document_items already exist for this document
        existing_items = conn.execute("SELECT COUNT(*) FROM document_items WHERE document_id = ?", (doc_id,)).fetchone()[0]
        if existing_items > 0:
            continue
            
        if status == 'committed':
            # Set to fully_imported
            conn.execute("UPDATE documents SET status = 'fully_imported' WHERE id = ?", (doc_id,))
            # Fetch results for this document
            results = conn.execute("SELECT * FROM results WHERE document_id = ?", (doc_id,)).fetchall()
            for r in results:
                # Get test type name
                tt_row = conn.execute("SELECT name FROM test_types WHERE id = ?", (r["test_type_id"],)).fetchone()
                tt_name = tt_row["name"] if tt_row else "Unknown Test"
                # Backpopulate document_items
                conn.execute(
                    """INSERT INTO document_items (
                        document_id, raw_name, raw_value, raw_value_text, raw_unit, raw_qualifier, raw_flag,
                        raw_ref_low, raw_ref_high, page_number, test_type_id, status, result_id
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'imported', ?)""",
                    (
                        doc_id,
                        tt_name,
                        r["value"],
                        r["value_text"],
                        r["unit"],
                        r["qualifier"],
                        r["flag"],
                        r["ref_low"],
                        r["ref_high"],
                        r["test_type_id"],
                        r["id"]
                    )
                )
        elif status == 'extracted':
            # Set to needs_review
            conn.execute("UPDATE documents SET status = 'needs_review' WHERE id = ?", (doc_id,))
            if extraction:
                try:
                    data = json.loads(extraction)
                    results = data.get("results", [])
                    
                    for r in results:
                        name = r.get("test_name")
                        value, parsed_qual = parse_value(r.get("value"))
                        qualifier = r.get("qualifier") or parsed_qual
                        if qualifier not in ("<", ">"):
                            qualifier = None
                        unit = (r.get("unit") or "").strip()
                        value_text = (r.get("value_text") or "").strip() or None
                        if (value is None and value_text is None) or not name or not str(name).strip():
                            continue
                            
                        ref_low = to_number(r.get("ref_low"))
                        ref_high = to_number(r.get("ref_high"))
                        tt = match_test_type(name, test_types_list)
                        tt_id = tt["id"] if tt else None
                        
                        conn.execute(
                            """INSERT INTO document_items (
                                document_id, raw_name, raw_value, raw_value_text, raw_unit,
                                raw_qualifier, raw_flag, raw_ref_low, raw_ref_high, page_number,
                                test_type_id, status
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs_review')""",
                            (
                                doc_id,
                                name,
                                value,
                                value_text,
                                unit,
                                qualifier,
                                r.get("flag"),
                                ref_low,
                                ref_high,
                                r.get("page_number") or 1,
                                tt_id
                            )
                        )
                except Exception as e:
                    print("Failed migrating legacy extraction:", e)
        conn.commit()


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

    rows = conn.execute("SELECT id, name, slug, category, zones, category_override FROM test_types").fetchall()
    for r in rows:
        if r["category_override"]:
            cat = r["category_override"]
        else:
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


def _migrate_clean_filenames(conn) -> None:
    """Updates legacy documents to display their clean, organized stored filenames instead of the raw original uploaded names."""
    docs = conn.execute("SELECT id, stored_name, filename FROM documents").fetchall()
    for d in docs:
        if d["stored_name"] and "/" in d["stored_name"]:
            clean_name = d["stored_name"].split("/")[-1]
            if d["filename"] != clean_name:
                conn.execute("UPDATE documents SET filename = ? WHERE id = ?", (clean_name, d["id"]))
    conn.commit()


def _migrate_document_status(conn) -> None:
    """Fixes documents whose status is out of sync with their actual remaining document_items review counts."""
    docs = conn.execute("SELECT id FROM documents").fetchall()
    for d in docs:
        doc_id = d["id"]
        # Check if they have document_items
        has_items = conn.execute("SELECT 1 FROM document_items WHERE document_id = ? LIMIT 1", (doc_id,)).fetchone()
        if not has_items:
            continue
            
        needs_review_count = conn.execute("SELECT COUNT(*) FROM document_items WHERE document_id = ? AND status = 'needs_review'", (doc_id,)).fetchone()[0]
        imported_count = conn.execute("SELECT COUNT(*) FROM document_items WHERE document_id = ? AND status = 'imported'", (doc_id,)).fetchone()[0]
        
        if needs_review_count > 0:
            if imported_count > 0:
                new_status = 'partially_imported'
            else:
                new_status = 'needs_review'
        else:
            if imported_count > 0:
                new_status = 'fully_imported'
            else:
                new_status = 'failed'
                
        # Update documents table if status changed
        current_status = conn.execute("SELECT status FROM documents WHERE id = ?", (doc_id,)).fetchone()["status"]
        if current_status != new_status:
            conn.execute("UPDATE documents SET status = ? WHERE id = ?", (new_status, doc_id))
    conn.commit()
