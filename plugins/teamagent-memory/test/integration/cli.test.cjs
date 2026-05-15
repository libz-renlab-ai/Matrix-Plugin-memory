const { spawnSync } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { openKnowledgeDb, closeDb } = require("../../hooks/lib/db.cjs");
const { insertRule } = require("../../hooks/lib/rules.cjs");

function tmpHome() {
  const d = path.join(os.tmpdir(), `tcli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const CLI_CJS = path.join(__dirname, "..", "..", "bin", "teamagent.cjs");
function run(args, HOME) {
  // Invoke the Node CLI directly to avoid bash dependency on Windows.
  return spawnSync("node", [CLI_CJS, ...args], { env: { ...process.env, HOME, USERPROFILE: HOME }, encoding: "utf8" });
}

function sample(over = {}) {
  return {
    id: "r1", scope: "global", tier: "canonical",
    wrong: "x", correct: "y", why: "z",
    match_regex: null, match_literals: ["x"], match_tools: ["Bash"], match_scope_globs: null,
    embedding: null, embed_model: null, embed_text: "x. y. z",
    hits: 3, misses: 0, exceptions: 0, wilson_lower: 0.6,
    last_seen_at: null, last_demerit_at: null,
    captured_at: "2026-05-15T00:00:00Z", session_origin: null, source_text: null, evidence_json: null,
    ...over,
  };
}

describe("teamagent CLI v0.2", () => {
  it("--version prints version", () => {
    const r = run(["--version"], tmpHome());
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/teamagent-memory\s+0\.2/);
  });

  it("list shows inserted rules", () => {
    const HOME = tmpHome();
    const gdb = openKnowledgeDb(path.join(HOME, ".teamagent", "global.db"));
    insertRule(gdb, sample());
    closeDb(gdb);
    const r = run(["list"], HOME);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/r1/);
  });

  it("inspect returns the rule", () => {
    const HOME = tmpHome();
    const gdb = openKnowledgeDb(path.join(HOME, ".teamagent", "global.db"));
    insertRule(gdb, sample());
    closeDb(gdb);
    const r = run(["inspect", "r1"], HOME);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/wilson_lower/);
  });

  it("mute archives the rule", () => {
    const HOME = tmpHome();
    const gdb = openKnowledgeDb(path.join(HOME, ".teamagent", "global.db"));
    insertRule(gdb, sample()); closeDb(gdb);
    const r = run(["mute", "r1"], HOME);
    expect(r.status).toBe(0);
    const r2 = run(["list"], HOME);
    expect(r2.stdout).not.toMatch(/^r1\b/m);
  });

  it("doctor passes on healthy DBs", () => {
    const HOME = tmpHome();
    closeDb(openKnowledgeDb(path.join(HOME, ".teamagent", "global.db")));
    const r = run(["doctor"], HOME);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/ok/i);
  });
});
