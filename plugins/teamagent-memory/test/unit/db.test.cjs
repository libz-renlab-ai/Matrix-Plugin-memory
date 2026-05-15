const fs = require("fs");
const path = require("path");
const os = require("os");
const { openKnowledgeDb, openEventsDb, closeDb } = require("../../hooks/lib/db.cjs");
const { getSchemaVersion } = require("../../hooks/lib/schema.cjs");

function tmpDir() {
  const p = path.join(os.tmpdir(), `teamagent-db-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

describe("openKnowledgeDb", () => {
  it("creates file and applies schema v1", () => {
    const dir = tmpDir();
    const p = path.join(dir, "k.db");
    const db = openKnowledgeDb(p);
    expect(fs.existsSync(p)).toBe(true);
    expect(getSchemaVersion(db)).toBe(1);
    closeDb(db);
  });

  it("opens existing file without re-applying schema", () => {
    const dir = tmpDir();
    const p = path.join(dir, "k.db");
    closeDb(openKnowledgeDb(p));
    const db = openKnowledgeDb(p);
    expect(getSchemaVersion(db)).toBe(1);
    closeDb(db);
  });

  it("creates parent dir if missing", () => {
    const dir = tmpDir();
    const p = path.join(dir, "nested", "k.db");
    const db = openKnowledgeDb(p);
    expect(fs.existsSync(p)).toBe(true);
    closeDb(db);
  });
});

describe("openEventsDb", () => {
  it("applies events schema", () => {
    const dir = tmpDir();
    const p = path.join(dir, "e.db");
    const db = openEventsDb(p);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
    expect(tables).toContain("events");
    closeDb(db);
  });
});
