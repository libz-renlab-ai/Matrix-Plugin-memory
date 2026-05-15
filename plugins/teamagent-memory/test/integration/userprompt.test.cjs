const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { openKnowledgeDb, closeDb } = require("../../hooks/lib/db.cjs");
const { insertRule } = require("../../hooks/lib/rules.cjs");

function tmpHome() {
  const d = path.join(os.tmpdir(), `tup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const HOOK = path.join(__dirname, "..", "..", "hooks", "userprompt-inject.cjs");

function makeRule(over = {}) {
  return {
    id: "rule-test-1", scope: "global", tier: "canonical",
    wrong: "Adopting moment", correct: "Use dayjs", why: "deprecated",
    match_regex: "(npm|pnpm|yarn)\\s+(install|add)\\s+moment", match_literals: ["moment"],
    match_tools: ["Bash"], match_scope_globs: null,
    embedding: null, embed_model: null, embed_text: "x",
    hits: 10, misses: 0, exceptions: 0, wilson_lower: 0.8,
    last_seen_at: "2026-05-14T00:00:00Z", last_demerit_at: null,
    captured_at: "2026-05-01T00:00:00Z", session_origin: null, source_text: null, evidence_json: null,
    ...over,
  };
}

describe("userprompt-inject", () => {
  it("injects reminder when prompt contains rule literal", () => {
    const HOME = tmpHome();
    const env = { ...process.env, HOME, USERPROFILE: HOME };
    const gdb = openKnowledgeDb(path.join(HOME, ".teamagent", "global.db"));
    insertRule(gdb, makeRule());
    closeDb(gdb);

    const input = JSON.stringify({ session_id: "S1", prompt: "let's install moment for date handling" });
    const r = spawnSync("node", [HOOK], { input, env, encoding: "utf8" });
    expect(r.status).toBe(0);
    const out = r.stdout ? JSON.parse(r.stdout) : null;
    expect(out).toBeTruthy();
    expect(out.hookSpecificOutput.additionalContext).toMatch(/rule-test-1/);
  });

  it("emits no output when no rule matches", () => {
    const HOME = tmpHome();
    const env = { ...process.env, HOME, USERPROFILE: HOME };
    closeDb(openKnowledgeDb(path.join(HOME, ".teamagent", "global.db")));
    const input = JSON.stringify({ prompt: "what's the weather" });
    const r = spawnSync("node", [HOOK], { input, env, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});
