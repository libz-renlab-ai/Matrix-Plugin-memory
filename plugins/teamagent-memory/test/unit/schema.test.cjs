const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { applyKnowledgeSchemaV1, applyEventsSchemaV1, getSchemaVersion } = require("../../hooks/lib/schema.cjs");

function tmpDbPath() {
  return path.join(os.tmpdir(), `teamagent-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("schema knowledge v1", () => {
  let p, db;
  beforeEach(() => { p = tmpDbPath(); db = new Database(p); });

  it("creates rules table with expected columns", () => {
    applyKnowledgeSchemaV1(db);
    const cols = db.prepare("PRAGMA table_info(rules)").all().map(r => r.name);
    expect(cols).toEqual(expect.arrayContaining([
      "id","scope","tier","wrong","correct","why",
      "match_regex","match_literals","match_tools","match_scope_globs",
      "embedding","embed_model","embed_text",
      "hits","misses","exceptions","wilson_lower",
      "last_seen_at","last_demerit_at",
      "captured_at","session_origin","source_text","evidence_json",
    ]));
  });

  it("creates rule_exceptions table", () => {
    applyKnowledgeSchemaV1(db);
    const cols = db.prepare("PRAGMA table_info(rule_exceptions)").all().map(r => r.name);
    expect(cols).toEqual(expect.arrayContaining(["id","parent_rule_id","condition","example","captured_at"]));
  });

  it("creates scan_cursor table", () => {
    applyKnowledgeSchemaV1(db);
    const cols = db.prepare("PRAGMA table_info(scan_cursor)").all().map(r => r.name);
    expect(cols).toEqual(expect.arrayContaining(["transcript_path","last_turn_index","updated_at"]));
  });

  it("records schema_version=1", () => {
    applyKnowledgeSchemaV1(db);
    expect(getSchemaVersion(db)).toBe(1);
  });

  it("is idempotent — running twice does not throw", () => {
    applyKnowledgeSchemaV1(db);
    expect(() => applyKnowledgeSchemaV1(db)).not.toThrow();
    expect(getSchemaVersion(db)).toBe(1);
  });
});

describe("schema events v1", () => {
  it("creates events table with expected columns", () => {
    const db = new Database(tmpDbPath());
    applyEventsSchemaV1(db);
    const cols = db.prepare("PRAGMA table_info(events)").all().map(r => r.name);
    expect(cols).toEqual(expect.arrayContaining([
      "id","ts","kind","session_id","rule_id","hook_name","tool_name","decision","score","payload_json",
    ]));
    expect(getSchemaVersion(db)).toBe(1);
  });
});
