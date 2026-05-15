const path = require("path");
const os = require("os");
const { openEventsDb, closeDb } = require("../../hooks/lib/db.cjs");
const { writeEvent } = require("../../hooks/lib/events.cjs");
const { detect, extractCondition, jaccard, tokenize } = require("../../hooks/lib/override.cjs");

function tmpEventsDb() {
  const p = path.join(os.tmpdir(), `tovr-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return openEventsDb(p);
}

const FAKE = path.join(__dirname, "..", "fixtures", "fake-claude.cjs");

describe("override.detect", () => {
  it("returns null when no prior deny", () => {
    const db = tmpEventsDb();
    writeEvent(db, { kind: "session_start", session_id: "S1" });
    expect(detect(db, "S1", "npm install moment", true)).toBeNull();
    closeDb(db);
  });

  it("returns hit when prior block + similar command + ok", () => {
    const db = tmpEventsDb();
    writeEvent(db, { kind: "pretooluse_block", session_id: "S1", rule_id: "r-1", payload: { command: "npm install moment" } });
    const out = detect(db, "S1", "npm install moment", true);
    expect(out).toBeTruthy();
    expect(out.rule_id).toBe("r-1");
    expect(out.similarity).toBeCloseTo(1.0, 1);
    closeDb(db);
  });

  it("returns null when prior block but command is different", () => {
    const db = tmpEventsDb();
    writeEvent(db, { kind: "pretooluse_block", session_id: "S1", rule_id: "r-1", payload: { command: "npm install moment" } });
    const out = detect(db, "S1", "ls -la", true);
    expect(out).toBeNull();
    closeDb(db);
  });

  it("warn also triggers detection", () => {
    const db = tmpEventsDb();
    writeEvent(db, { kind: "pretooluse_warn", session_id: "S1", rule_id: "r-w", payload: { command: "npm install moment" } });
    const out = detect(db, "S1", "npm install moment@2.29", true);
    expect(out).toBeTruthy();
    expect(out.rule_id).toBe("r-w");
    closeDb(db);
  });

  it("does not trigger when exit_code != 0 (currentExitOk=false)", () => {
    const db = tmpEventsDb();
    writeEvent(db, { kind: "pretooluse_block", session_id: "S1", rule_id: "r-1", payload: { command: "npm install moment" } });
    expect(detect(db, "S1", "npm install moment", false)).toBeNull();
    closeDb(db);
  });
});

describe("jaccard", () => {
  it("returns 1.0 for identical token sets", () => {
    expect(jaccard(tokenize("npm install moment"), tokenize("npm install moment"))).toBeCloseTo(1.0);
  });
  it("returns ~0.33 for half-overlap", () => {
    expect(jaccard(tokenize("a b"), tokenize("b c"))).toBeCloseTo(1/3);
  });
  it("empty sets return 0", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});

describe("extractCondition (with fake-claude)", () => {
  it("fake-claude error mode returns null", async () => {
    const out = await extractCondition("just testing", { claudeBin: ["node", FAKE], env: { FAKE_CLAUDE_MODE: "error" }, timeoutMs: 5000 });
    expect(out).toBeNull();
  }, 10000);

  it("fake-claude invalid output returns null", async () => {
    const out = await extractCondition("testing", { claudeBin: ["node", FAKE], env: { FAKE_CLAUDE_MODE: "invalid" }, timeoutMs: 5000 });
    expect(out).toBeNull();
  }, 10000);
});
