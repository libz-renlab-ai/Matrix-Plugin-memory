const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { openKnowledgeDb, closeDb } = require("../../hooks/lib/db.cjs");
const { insertRule } = require("../../hooks/lib/rules.cjs");

function tmpHome() {
  const d = path.join(os.tmpdir(), `tpt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const HOOK = path.join(__dirname, "..", "..", "hooks", "pretooluse-enforce.cjs");

function rule(over = {}) {
  return {
    id: "rule-block", scope: "global", tier: "canonical+",
    wrong: "Adopting moment", correct: "Use dayjs", why: "deprecated",
    match_regex: "(npm|pnpm|yarn)\\s+(install|add)\\s+moment", match_literals: ["moment"],
    match_tools: ["Bash"], match_scope_globs: null,
    embedding: null, embed_model: null, embed_text: "x",
    hits: 30, misses: 0, exceptions: 0, wilson_lower: 0.93,
    last_seen_at: "2026-05-14T00:00:00Z", last_demerit_at: null,
    captured_at: "2026-04-01T00:00:00Z", session_origin: null, source_text: null, evidence_json: null,
    ...over,
  };
}

function runHook(input, HOME) {
  return spawnSync("node", [HOOK], { input, env: { ...process.env, HOME, USERPROFILE: HOME }, encoding: "utf8" });
}

describe("pretooluse four tiers (Bash)", () => {
  it("canonical+ rule -> block (score >= 0.85)", () => {
    const HOME = tmpHome();
    const gdb = openKnowledgeDb(path.join(HOME, ".teamagent", "global.db"));
    insertRule(gdb, rule()); closeDb(gdb);
    const r = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm install moment" } }), HOME);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/rule-block/);
  });

  it("canonical rule -> warn (deny with warn-tier wording)", () => {
    const HOME = tmpHome();
    const gdb = openKnowledgeDb(path.join(HOME, ".teamagent", "global.db"));
    insertRule(gdb, rule({ id: "rule-warn", tier: "canonical", hits: 10, wilson_lower: 0.72 }));
    closeDb(gdb);
    const r = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm install moment" } }), HOME);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/warn/i);
  });

  it("experimental rule -> suggest (ask)", () => {
    const HOME = tmpHome();
    const gdb = openKnowledgeDb(path.join(HOME, ".teamagent", "global.db"));
    insertRule(gdb, rule({ id: "rule-sug", tier: "experimental", hits: 1, wilson_lower: 0.5 }));
    closeDb(gdb);
    const r = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm install moment" } }), HOME);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("no match -> pass (no output)", () => {
    const HOME = tmpHome();
    closeDb(openKnowledgeDb(path.join(HOME, ".teamagent", "global.db")));
    const r = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls -la" } }), HOME);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("Edit tool uses new_string", () => {
    const HOME = tmpHome();
    const gdb = openKnowledgeDb(path.join(HOME, ".teamagent", "global.db"));
    insertRule(gdb, rule({ id: "rule-edit", match_regex: null, match_literals: ["moment"], match_tools: ["Bash","Edit"] }));
    closeDb(gdb);
    const r = runHook(JSON.stringify({ tool_name: "Edit", tool_input: { new_string: "import moment from 'moment'", file_path: "/repo/x.ts" } }), HOME);
    const out = r.stdout ? JSON.parse(r.stdout) : null;
    expect(out).toBeTruthy();
    expect(out.hookSpecificOutput.permissionDecision).toBeDefined();
  });
});
