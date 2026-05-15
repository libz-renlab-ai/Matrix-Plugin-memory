const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { openKnowledgeDb, openEventsDb, closeDb } = require("../../hooks/lib/db.cjs");
const { insertRule } = require("../../hooks/lib/rules.cjs");
const { readEvents } = require("../../hooks/lib/events.cjs");
const { embedText, packEmbedding } = require("../../hooks/lib/embed.cjs");

function tmpHome() {
  const d = path.join(os.tmpdir(), `tovr-flow-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

describe("override flow end-to-end", () => {
  beforeAll(async () => { await embedText("warmup"); }, 900000);

  it("deny -> retry -> override_detected -> classify b -> exception saved -> next match skips", async () => {
    const HOME = tmpHome();
    const env = { ...process.env, HOME, USERPROFILE: HOME };
    const gp = path.join(HOME, ".teamagent", "global.db");
    const gdb = openKnowledgeDb(gp);
    const v = await embedText("Adopting moment. Use dayjs. deprecated");
    insertRule(gdb, {
      id: "r-moment", scope: "global", tier: "canonical+",
      wrong: "Adopting moment", correct: "Use dayjs", why: "deprecated",
      match_regex: "(npm|pnpm|yarn)\\s+(install|add)\\s+moment",
      match_literals: ["moment"], match_tools: ["Bash"], match_scope_globs: null,
      embedding: packEmbedding(v), embed_model: "multilingual-e5-small@v1",
      embed_text: "Adopting moment. Use dayjs. deprecated",
      hits: 30, misses: 0, exceptions: 0, wilson_lower: 0.93, prior: 0.6,
      captured_at: "2026-05-15T00:00:00Z",
    });
    closeDb(gdb);

    const SESSION = "S-override-" + Date.now();

    // 1. PreToolUse: deny
    const pretool = spawnSync("node", [path.join(__dirname, "..", "..", "hooks", "pretooluse-enforce.cjs")], {
      input: JSON.stringify({ session_id: SESSION, tool_name: "Bash", tool_input: { command: "npm install moment" } }),
      env, encoding: "utf8",
    });
    expect(pretool.status).toBe(0);
    const decision = JSON.parse(pretool.stdout).hookSpecificOutput.permissionDecision;
    expect(decision).toBe("deny");

    // 2. PostToolUse: user retried, exit 0 -> override should be detected
    spawnSync("node", [path.join(__dirname, "..", "..", "hooks", "posttool-record.cjs")], {
      input: JSON.stringify({ session_id: SESSION, tool_name: "Bash", tool_input: { command: "npm install moment" }, tool_response: { exit_code: 0 } }),
      env, encoding: "utf8",
    });

    const evdb = openEventsDb(path.join(HOME, ".teamagent", "events.db"));
    const overrideEvents = readEvents(evdb, { kind: "override_detected", session_id: SESSION });
    expect(overrideEvents.length).toBeGreaterThan(0);
    const eventId = overrideEvents[0].id;
    expect(overrideEvents[0].rule_id).toBe("r-moment");
    closeDb(evdb);

    // 3. CLI classify b with condition
    const cli = path.join(__dirname, "..", "..", "bin", "teamagent.cjs");
    const cls = spawnSync("node", [cli, "classify", String(eventId), "b", "--condition", "in test fixtures"], { env, encoding: "utf8" });
    expect(cls.status).toBe(0);
    expect(cls.stdout).toMatch(/context-specific/);

    // 4. Next PreToolUse with query containing "test fixtures" should be skipped (no firing)
    const next = spawnSync("node", [path.join(__dirname, "..", "..", "hooks", "pretooluse-enforce.cjs")], {
      input: JSON.stringify({ session_id: SESSION + "-next", tool_name: "Bash", tool_input: { command: "npm install moment in test fixtures" } }),
      env, encoding: "utf8",
    });
    expect(next.status).toBe(0);
    // Exception fires -> rule skipped -> pass (silent)
    expect(next.stdout.trim()).toBe("");

    // 5. But the same rule WITHOUT the exception trigger still fires
    const stillFires = spawnSync("node", [path.join(__dirname, "..", "..", "hooks", "pretooluse-enforce.cjs")], {
      input: JSON.stringify({ session_id: SESSION + "-next2", tool_name: "Bash", tool_input: { command: "npm install moment" } }),
      env, encoding: "utf8",
    });
    expect(stillFires.status).toBe(0);
    const out = stillFires.stdout ? JSON.parse(stillFires.stdout) : null;
    expect(out).toBeTruthy();
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  }, 120000);

  it("classify a (rule-wrong) demotes the rule", async () => {
    const HOME = tmpHome();
    const env = { ...process.env, HOME, USERPROFILE: HOME };
    const gp = path.join(HOME, ".teamagent", "global.db");
    const gdb = openKnowledgeDb(gp);
    insertRule(gdb, {
      id: "r-axios", scope: "global", tier: "canonical",
      wrong: "Adopting axios", correct: "Use fetch", why: "axios is heavy",
      match_regex: null, match_literals: ["axios"], match_tools: ["Bash"], match_scope_globs: null,
      embedding: null, embed_model: null,
      embed_text: "Adopting axios. Use fetch. axios is heavy",
      hits: 10, misses: 0, exceptions: 0, wilson_lower: 0.72, prior: 0.55,
      captured_at: "2026-05-15T00:00:00Z",
    });
    closeDb(gdb);

    const SESSION = "S-classify-a-" + Date.now();
    // Pre-trigger override
    spawnSync("node", [path.join(__dirname, "..", "..", "hooks", "pretooluse-enforce.cjs")], {
      input: JSON.stringify({ session_id: SESSION, tool_name: "Bash", tool_input: { command: "npm install axios" } }),
      env, encoding: "utf8",
    });
    spawnSync("node", [path.join(__dirname, "..", "..", "hooks", "posttool-record.cjs")], {
      input: JSON.stringify({ session_id: SESSION, tool_name: "Bash", tool_input: { command: "npm install axios" }, tool_response: { exit_code: 0 } }),
      env, encoding: "utf8",
    });
    const evdb = openEventsDb(path.join(HOME, ".teamagent", "events.db"));
    const ovr = readEvents(evdb, { kind: "override_detected", session_id: SESSION });
    expect(ovr.length).toBeGreaterThan(0);
    closeDb(evdb);

    const cli = path.join(__dirname, "..", "..", "bin", "teamagent.cjs");
    const cls = spawnSync("node", [cli, "classify", String(ovr[0].id), "a"], { env, encoding: "utf8" });
    expect(cls.status).toBe(0);
    expect(cls.stdout).toMatch(/rule-wrong/);

    // Inspect the rule: misses should be 1
    const inspect = spawnSync("node", [cli, "inspect", "r-axios"], { env, encoding: "utf8" });
    const ruleObj = JSON.parse(inspect.stdout);
    expect(ruleObj.misses).toBe(1);
  }, 120000);
});
