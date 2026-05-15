const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { openKnowledgeDb, closeDb } = require("../../hooks/lib/db.cjs");
const { listRules } = require("../../hooks/lib/rules.cjs");

function tmpHome() {
  const d = path.join(os.tmpdir(), `tstop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const HOOK = path.join(__dirname, "..", "..", "hooks", "stop-capture.cjs");
const FIX = path.join(__dirname, "..", "fixtures", "transcripts", "correction-moment.jsonl");
const FAKE_CLAUDE = path.join(__dirname, "..", "fixtures", "fake-claude.cjs");

describe("stop-capture 4-stage pipeline", () => {
  it("analyzes fixture, extracts via fake claude, inserts into global.db", () => {
    const HOME = tmpHome();
    const env = {
      ...process.env, HOME, USERPROFILE: HOME,
      TEAMAGENT_CLAUDE_BIN: `node ${FAKE_CLAUDE}`,
      FAKE_CLAUDE_MODE: "ok",
    };
    const input = JSON.stringify({ session_id: "S1", transcript_path: FIX });
    const r = spawnSync("node", [HOOK], { input, env, encoding: "utf8", timeout: 30000 });
    expect(r.status).toBe(0);
    const gdb = openKnowledgeDb(path.join(HOME, ".teamagent", "global.db"));
    const rules = listRules(gdb);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules[0].wrong).toMatch(/moment/i);
    closeDb(gdb);
  }, 60000);

  it("survives missing transcript", () => {
    const HOME = tmpHome();
    const env = { ...process.env, HOME, USERPROFILE: HOME };
    const input = JSON.stringify({ session_id: "S1", transcript_path: "/nonexistent/x.jsonl" });
    const r = spawnSync("node", [HOOK], { input, env, encoding: "utf8" });
    expect(r.status).toBe(0);
  });
});
