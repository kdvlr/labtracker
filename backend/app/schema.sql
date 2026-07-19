CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    dob TEXT,
    sex TEXT,
    color TEXT,
    -- 1 = only visible once the private PIN has been entered on this device.
    -- 0 (default) = always visible, no PIN, no interaction. The people who use
    -- this app daily should never meet a lock screen.
    private INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A device that has entered the correct PIN. Presence of a live row here is
-- what "unlocked" means; deleting rows locks every device at once.
CREATE TABLE IF NOT EXISTS unlock_sessions (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
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
    zones TEXT,
    category_override TEXT
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
    file_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    test_type_id INTEGER NOT NULL REFERENCES test_types(id) ON DELETE CASCADE,
    document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    taken_at TEXT NOT NULL,
    -- A result is either numeric (value/value_canonical) or qualitative
    -- (value_text, e.g. "Negative", "B+", "Trace"). Numeric columns stay NULL
    -- for qualitative rows so they never pollute charts or averages.
    value REAL,
    unit TEXT NOT NULL,
    value_canonical REAL,
    value_text TEXT,
    ref_low REAL,
    ref_high REAL,
    ref_low_canonical REAL,
    ref_high_canonical REAL,
    flag TEXT,          -- 'H' | 'L' | NULL
    -- '<' or '>' when the lab reported a detection/reporting limit rather than a
    -- measurement ("<0.01"). value/value_canonical then hold the limit itself.
    qualifier TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_results_member_test ON results(member_id, test_type_id, taken_at);
CREATE INDEX IF NOT EXISTS idx_results_document ON results(document_id);

CREATE TABLE IF NOT EXISTS document_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    raw_name TEXT NOT NULL,
    raw_value REAL,
    raw_value_text TEXT,
    raw_unit TEXT,
    raw_qualifier TEXT,
    raw_flag TEXT,
    raw_ref_low REAL,
    raw_ref_high REAL,
    page_number INTEGER,
    test_type_id INTEGER REFERENCES test_types(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'needs_review', -- needs_review | imported | skipped | errored
    error_reason TEXT,
    result_id INTEGER REFERENCES results(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_document_items_doc ON document_items(document_id);
CREATE INDEX IF NOT EXISTS idx_documents_member ON documents(member_id);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

