const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { openKnowledgeDb, closeDb } = require("../../hooks/lib/db.cjs");
const { insertRule, getRule } = require("../../hooks/lib/rules.cjs");

function tmpHome() {
  const d = path.join(os.tmpdir(), `tses-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const HOOK = path.join(__dirname, "..", "..", "hooks", "sessionstart.cjs");

describe("sessionstart.cjs", () => {
  it("creates DBs and emits valid JSON (or empty) on stdout, exit 0", () => {
    const HOME = tmpHome();
    const cwd = tmpHome();
    const input = JSON.stringify({ session_id: "S1" });
    const r = spawnSync("node", [HOOK], { input, env: { ...process.env, HOME, USERPROFILE: HOME }, cwd, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(HOME, ".teamagent", "global.db"))).toBe(true);
    expect(fs.existsSync(path.join(HOME, ".teamagent", "events.db"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, ".teamagent", "knowledge.db"))).toBe(true);
  });

  it("survives broken stdin (empty)", () => {
    const HOME = tmpHome();
    const r = spawnSync("node", [HOOK], { input: "", env: { ...process.env, HOME, USERPROFILE: HOME }, encoding: "utf8" });
    expect(r.status).toBe(0);
  });

  it("applies decay to wilson_lower of stale rules (>7 days last_seen_at)", () => {
    const HOME = tmpHome();
    const gp = path.join(HOME, ".teamagent", "global.db");
    const gdb = openKnowledgeDb(gp);
    const oldSeenAt = new Date(Date.now() - 60 * 86400 * 1000).toISOString(); // 60 days ago
    insertRule(gdb, {
      id: "rule-stale-1", scope: "global", tier: "canonical",
      wrong: "x", correct: "y", why: "z",
      match_regex: null, match_literals: ["x"], match_tools: ["Bash"], match_scope_globs: null,
      embedding: null, embed_model: null, embed_text: "x. y. z",
      hits: 10, misses: 0, exceptions: 0, wilson_lower: 0.8,
      last_seen_at: oldSeenAt, last_demerit_at: null,
      captured_at: oldSeenAt, session_origin: null, source_text: null, evidence_json: null,
    });
    closeDb(gdb);

    const input = JSON.stringify({ session_id: "S1" });
    const r = spawnSync("node", [HOOK], { input, env: { ...process.env, HOME, USERPROFILE: HOME }, encoding: "utf8" });
    expect(r.status).toBe(0);

    const gdb2 = openKnowledgeDb(gp);
    const rule = getRule(gdb2, "rule-stale-1");
    // 60 days decay with half-life 60 -> wilson * exp(-1) = 0.8 * 0.368 ≈ 0.294
    expect(rule.wilson_lower).toBeLessThan(0.5);
    expect(rule.wilson_lower).toBeGreaterThan(0.2);
    closeDb(gdb2);
  });

  it("archives experimental rules >30 days old with hits=0", () => {
    const HOME = tmpHome();
    const gp = path.join(HOME, ".teamagent", "global.db");
    const gdb = openKnowledgeDb(gp);
    const oldCaptured = new Date(Date.now() - 40 * 86400 * 1000).toISOString();
    insertRule(gdb, {
      id: "rule-zombie", scope: "global", tier: "experimental",
      wrong: "x", correct: "y", why: "z",
      match_regex: null, match_literals: ["x"], match_tools: ["Bash"], match_scope_globs: null,
      embedding: null, embed_model: null, embed_text: "x. y. z",
      hits: 0, misses: 0, exceptions: 0, wilson_lower: 0.5,
      last_seen_at: null, last_demerit_at: null,
      captured_at: oldCaptured, session_origin: null, source_text: null, evidence_json: null,
    });
    closeDb(gdb);

    const r = spawnSync("node", [HOOK], { input: "{}", env: { ...process.env, HOME, USERPROFILE: HOME }, encoding: "utf8" });
    expect(r.status).toBe(0);

    const gdb2 = openKnowledgeDb(gp);
    const rule = getRule(gdb2, "rule-zombie");
    expect(rule.tier).toBe("archived");
    closeDb(gdb2);
  });
});
