CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    dob TEXT,
    sex TEXT,
    color TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS test_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    category TEXT,
    canonical_unit TEXT NOT NULL,
    -- JSON map of unit -> {"factor": f, "offset": o} converting a value in that
    -- unit into the canonical unit: canonical = value * factor + offset
    conversions TEXT NOT NULL DEFAULT '{}',
    ref_low REAL,
    ref_high REAL,
    aliases TEXT NOT NULL DEFAULT '[]',
    description TEXT,
    -- JSON array of interpretation bands (canonical units), ascending:
    -- [{"to": upper|null, "c": "green|amber|red", "label": "..."}]. NULL = derive
    -- a simple in/out band from ref_low/ref_high on the client.
    zones TEXT
);

CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
    filename TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    report_date TEXT,
    lab_name TEXT,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'uploaded',  -- uploaded | extracted | committed
    -- JSON of the last extraction response, so an extracted-but-uncommitted
    -- report can be reopened and reviewed without re-running (re-paying for) AI.
    extraction TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    test_type_id INTEGER NOT NULL REFERENCES test_types(id) ON DELETE CASCADE,
    document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    taken_at TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT NOT NULL,
    value_canonical REAL NOT NULL,
    ref_low REAL,
    ref_high REAL,
    ref_low_canonical REAL,
    ref_high_canonical REAL,
    flag TEXT,          -- 'H' | 'L' | NULL
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_results_member_test ON results(member_id, test_type_id, taken_at);
CREATE INDEX IF NOT EXISTS idx_results_document ON results(document_id);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Recurring checkup reminders: "this member should retest this marker every N
-- months". Due status is computed from the member's latest result for the test.
CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    test_type_id INTEGER NOT NULL REFERENCES test_types(id) ON DELETE CASCADE,
    interval_months INTEGER NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(member_id, test_type_id)
);
