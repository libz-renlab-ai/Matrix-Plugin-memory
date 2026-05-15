"use strict";

const KNOWLEDGE_DDL_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL,
  tier            TEXT NOT NULL,
  wrong           TEXT NOT NULL,
  correct         TEXT NOT NULL,
  why             TEXT NOT NULL,
  match_regex     TEXT,
  match_literals  TEXT,
  match_tools     TEXT NOT NULL,
  match_scope_globs TEXT,
  embedding       BLOB,
  embed_model     TEXT,
  embed_text      TEXT NOT NULL,
  hits            INTEGER NOT NULL DEFAULT 0,
  misses          INTEGER NOT NULL DEFAULT 0,
  exceptions      INTEGER NOT NULL DEFAULT 0,
  wilson_lower    REAL NOT NULL DEFAULT 0.5,
  last_seen_at    TEXT,
  last_demerit_at TEXT,
  captured_at     TEXT NOT NULL,
  session_origin  TEXT,
  source_text     TEXT,
  evidence_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_rules_tier_score ON rules(tier, wilson_lower DESC);
CREATE INDEX IF NOT EXISTS idx_rules_last_seen ON rules(last_seen_at);

CREATE TABLE IF NOT EXISTS rule_exceptions (
  id              TEXT PRIMARY KEY,
  parent_rule_id  TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  condition       TEXT NOT NULL,
  example         TEXT,
  captured_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exc_parent ON rule_exceptions(parent_rule_id);

CREATE TABLE IF NOT EXISTS scan_cursor (
  transcript_path TEXT PRIMARY KEY,
  last_turn_index INTEGER NOT NULL,
  updated_at      TEXT NOT NULL
);
`;

const EVENTS_DDL_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  kind          TEXT NOT NULL,
  session_id    TEXT,
  rule_id       TEXT,
  hook_name     TEXT,
  tool_name     TEXT,
  decision      TEXT,
  score         REAL,
  payload_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_rule ON events(rule_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
`;

function nowIso() { return new Date().toISOString(); }

function applyKnowledgeSchemaV1(db) {
  db.exec(KNOWLEDGE_DDL_V1);
  const v = getSchemaVersion(db);
  if (v < 1) db.prepare("INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (1, ?)").run(nowIso());
}

function applyEventsSchemaV1(db) {
  db.exec(EVENTS_DDL_V1);
  const v = getSchemaVersion(db);
  if (v < 1) db.prepare("INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (1, ?)").run(nowIso());
}

function getSchemaVersion(db) {
  try {
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get();
    return row && row.v ? row.v : 0;
  } catch (_e) {
    return 0;
  }
}

module.exports = { applyKnowledgeSchemaV1, applyEventsSchemaV1, getSchemaVersion };
