const path = require("path");
const os = require("os");
const { logHook } = require("../../hooks/lib/log.cjs");
const { openEventsDb, closeDb } = require("../../hooks/lib/db.cjs");
const { readEvents } = require("../../hooks/lib/events.cjs");

function tmpDb() {
  const p = path.join(os.tmpdir(), `tlog-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return openEventsDb(p);
}

describe("logHook", () => {
  it("appends event with hook_name auto-filled", () => {
    const db = tmpDb();
    logHook(db, "PreToolUse", { kind: "pretooluse_pass", tool_name: "Bash" });
    const ev = readEvents(db, { limit: 1 })[0];
    expect(ev.hook_name).toBe("PreToolUse");
    expect(ev.kind).toBe("pretooluse_pass");
    closeDb(db);
  });

  it("does not throw on a null db", () => {
    expect(() => logHook(null, "x", { kind: "y" })).not.toThrow();
  });
});
