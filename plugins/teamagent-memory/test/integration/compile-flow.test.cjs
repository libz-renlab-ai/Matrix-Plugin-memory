const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { openKnowledgeDb, closeDb } = require("../../hooks/lib/db.cjs");
const { insertRule } = require("../../hooks/lib/rules.cjs");
const { BEGIN, END } = require("../../hooks/lib/compile.cjs");

function tmpDir() {
  const d = path.join(os.tmpdir(), `tcomp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const CLI = path.join(__dirname, "..", "..", "bin", "teamagent.cjs");
const HOOK = path.join(__dirname, "..", "..", "hooks", "stop-capture.cjs");

describe("M5.a compile-to-AGENTS.md flow", () => {
  it("`teamagent compile --repo <dir>` writes a managed block with project rules", () => {
    const HOME = tmpDir();
    const repo = tmpDir();
    const env = { ...process.env, HOME, USERPROFILE: HOME };

    // Insert a canonical+ project rule into <HOME>/<repo>/.teamagent/knowledge.db
    // by manipulating where the CLI resolves the project path. paths.cjs uses
    // the *current* working dir's .teamagent. Easiest: chdir into repo via spawn cwd.
    const projDbPath = path.join(repo, ".teamagent", "knowledge.db");
    const db = openKnowledgeDb(projDbPath);
    insertRule(db, {
      id: "r-moment-compile", scope: "project", tier: "canonical+",
      wrong: "install moment", correct: "use dayjs", why: "deprecated",
      match_regex: null, match_literals: ["moment"], match_tools: ["Bash"], match_scope_globs: null,
      embedding: null, embed_model: null, embed_text: "install moment. use dayjs. deprecated",
      hits: 30, misses: 0, exceptions: 0, wilson_lower: 0.93, prior: 0.6,
      captured_at: "2026-05-15T00:00:00Z",
    });
    insertRule(db, {
      id: "r-low-compile", scope: "project", tier: "experimental",
      wrong: "x", correct: "y", why: "z",
      match_regex: null, match_literals: ["x"], match_tools: ["Bash"], match_scope_globs: null,
      embedding: null, embed_model: null, embed_text: "x. y. z",
      hits: 0, misses: 0, exceptions: 0, wilson_lower: 0.4, prior: 0.5,
      captured_at: "2026-05-15T00:00:00Z",
    });
    closeDb(db);

    const r = spawnSync("node", [CLI, "compile", "--repo", repo], { env, cwd: repo, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/updated|unchanged/);

    const content = fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8");
    expect(content).toMatch(BEGIN);
    expect(content).toMatch(END);
    expect(content).toMatch("install moment");
    expect(content).toMatch("use dayjs");
    // Experimental rule filtered out
    expect(content).not.toMatch("r-low-compile");
  }, 30000);

  it("rewriting preserves user-authored content outside the managed block", () => {
    const HOME = tmpDir();
    const repo = tmpDir();
    const env = { ...process.env, HOME, USERPROFILE: HOME };

    const target = path.join(repo, "AGENTS.md");
    fs.writeFileSync(target, "# Project Agents\n\nKeep this paragraph.\n\nMore notes.\n", "utf8");

    const db = openKnowledgeDb(path.join(repo, ".teamagent", "knowledge.db"));
    insertRule(db, {
      id: "r-keep", scope: "project", tier: "canonical",
      wrong: "use axios", correct: "use fetch", why: "axios is heavy",
      match_regex: null, match_literals: ["axios"], match_tools: ["Bash"], match_scope_globs: null,
      embedding: null, embed_model: null, embed_text: "use axios. use fetch. axios is heavy",
      hits: 15, misses: 0, exceptions: 0, wilson_lower: 0.85, prior: 0.55,
      captured_at: "2026-05-15T00:00:00Z",
    });
    closeDb(db);

    const r = spawnSync("node", [CLI, "compile", "--repo", repo], { env, cwd: repo, encoding: "utf8" });
    expect(r.status).toBe(0);

    const content = fs.readFileSync(target, "utf8");
    expect(content).toMatch("# Project Agents");
    expect(content).toMatch("Keep this paragraph.");
    expect(content).toMatch("More notes.");
    expect(content).toMatch("use axios");
    expect(content).toMatch("use fetch");
  }, 30000);

  it("Stop hook also compiles when TEAMAGENT_REPO_ROOT points at a repo with project rules", () => {
    const HOME = tmpDir();
    const repo = tmpDir();
    const env = {
      ...process.env, HOME, USERPROFILE: HOME,
      TEAMAGENT_REPO_ROOT: repo,
    };

    const db = openKnowledgeDb(path.join(repo, ".teamagent", "knowledge.db"));
    insertRule(db, {
      id: "r-stop-compile", scope: "project", tier: "canonical+",
      wrong: "use moment", correct: "use dayjs", why: "deprecated",
      match_regex: null, match_literals: ["moment"], match_tools: ["Bash"], match_scope_globs: null,
      embedding: null, embed_model: null, embed_text: "use moment. use dayjs. deprecated",
      hits: 30, misses: 0, exceptions: 0, wilson_lower: 0.92, prior: 0.6,
      captured_at: "2026-05-15T00:00:00Z",
    });
    closeDb(db);

    // No transcript -> Stop short-circuits early but the compile stage should still run
    // because compile is after the loop and is unconditional. But: in stop-capture, the
    // early-exit on no_transcript closes the dbs and exits *before* the compile stage.
    // So we test via a missing-transcript path which DOES short-circuit. To validate
    // compile-on-Stop properly, we need a real transcript; use the existing fixture.
    const FIX = path.join(__dirname, "..", "fixtures", "transcripts", "correction-moment.jsonl");
    const FAKE_CLAUDE = path.join(__dirname, "..", "fixtures", "fake-claude.cjs");
    const fullEnv = { ...env, TEAMAGENT_CLAUDE_BIN: `node ${FAKE_CLAUDE}`, FAKE_CLAUDE_MODE: "ok" };
    const input = JSON.stringify({ session_id: "S-compile", transcript_path: FIX });
    // cwd=repo so resolveProjectDbPath() picks the project knowledge.db we just wrote into.
    const r = spawnSync("node", [HOOK], { input, env: fullEnv, encoding: "utf8", timeout: 60000, cwd: repo });
    expect(r.status).toBe(0);

    const target = path.join(repo, "AGENTS.md");
    expect(fs.existsSync(target)).toBe(true);
    const content = fs.readFileSync(target, "utf8");
    expect(content).toMatch(BEGIN);
    expect(content).toMatch("use moment");
  }, 90000);
});
