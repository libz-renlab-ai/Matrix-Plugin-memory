const path = require("path");
const os = require("os");
const { openEventsDb, closeDb } = require("../../hooks/lib/db.cjs");
const { writeEvent, readEvents } = require("../../hooks/lib/events.cjs");

function tmpEventsDb() {
  const p = path.join(os.tmpdir(), `tev-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return openEventsDb(p);
}

describe("writeEvent / readEvents", () => {
  it("inserts and reads back", () => {
    const db = tmpEventsDb();
    writeEvent(db, {
      kind: "pretooluse_pass",
      session_id: "s1",
      hook_name: "PreToolUse",
      tool_name: "Bash",
      decision: "pass",
    });
    const rows = readEvents(db, { limit: 10 });
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("pretooluse_pass");
    expect(rows[0].tool_name).toBe("Bash");
    expect(rows[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    closeDb(db);
  });

  it("serializes payload_json", () => {
    const db = tmpEventsDb();
    writeEvent(db, { kind: "stop_extract", payload: { dedup_hash: "abc", attempts: 1 } });
    const row = readEvents(db, { limit: 1 })[0];
    expect(JSON.parse(row.payload_json)).toEqual({ dedup_hash: "abc", attempts: 1 });
    closeDb(db);
  });

  it("readEvents filters by rule_id", () => {
    const db = tmpEventsDb();
    writeEvent(db, { kind: "pretooluse_block", rule_id: "r-1" });
    writeEvent(db, { kind: "pretooluse_pass" });
    writeEvent(db, { kind: "pretooluse_block", rule_id: "r-1" });
    const filtered = readEvents(db, { rule_id: "r-1" });
    expect(filtered.length).toBe(2);
    closeDb(db);
  });

  it("does not throw on normal db", () => {
    const db = tmpEventsDb();
    expect(() => writeEvent(db, { kind: "test_kind" })).not.toThrow();
    closeDb(db);
  });
});
