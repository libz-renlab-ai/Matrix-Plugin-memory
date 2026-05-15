const path = require("path");
const os = require("os");
const fs = require("fs");
const {
  BEGIN, END,
  renderRule, renderBlock, pickRules, spliceBlock,
  writeAgentsMd, compileFromDb,
} = require("../../hooks/lib/compile.cjs");
const { openKnowledgeDb, closeDb } = require("../../hooks/lib/db.cjs");
const { insertRule } = require("../../hooks/lib/rules.cjs");

function tmpDir() {
  const d = path.join(os.tmpdir(), `tcompile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function mkRule(over = {}) {
  return {
    id: "r-x", scope: "project", tier: "canonical",
    wrong: "do x", correct: "do y", why: "z",
    match_regex: null, match_literals: ["x"], match_tools: ["Bash"], match_scope_globs: null,
    embedding: null, embed_model: null, embed_text: "do x. do y. z",
    hits: 10, misses: 0, exceptions: 0, wilson_lower: 0.75, prior: 0.6,
    captured_at: "2026-05-15T00:00:00Z",
    ...over,
  };
}

describe("renderRule", () => {
  it("includes tier, wrong, correct, why, wilson, id", () => {
    const out = renderRule({ id: "r-1", tier: "canonical+", wrong: "use moment", correct: "use dayjs", why: "deprecated", wilson_lower: 0.93 });
    expect(out).toMatch(/canonical\+/);
    expect(out).toMatch(/use moment/);
    expect(out).toMatch(/use dayjs/);
    expect(out).toMatch(/deprecated/);
    expect(out).toMatch(/wilson 0\.93/);
    expect(out).toMatch(/r-1/);
  });
  it("escapes pipe characters and collapses newlines", () => {
    const out = renderRule({ id: "r-2", tier: "canonical", wrong: "a|b", correct: "c\nd", why: "e", wilson_lower: 0.7 });
    expect(out).toMatch(/a\\\|b/);
    expect(out).not.toMatch(/\n/); // newline replaced with space
    expect(out).toMatch(/c d/);
  });
});

describe("pickRules", () => {
  it("filters by tier and wilson floor", () => {
    const rules = [
      mkRule({ id: "keep1", tier: "canonical", wilson_lower: 0.8 }),
      mkRule({ id: "drop-tier", tier: "experimental", wilson_lower: 0.95 }),
      mkRule({ id: "drop-wilson", tier: "canonical", wilson_lower: 0.5 }),
      mkRule({ id: "keep2", tier: "canonical+", wilson_lower: 0.9 }),
    ];
    const out = pickRules(rules);
    expect(out.map(r => r.id)).toEqual(["keep2", "keep1"]); // canonical+ first, then wilson desc
  });
  it("respects maxRules cap", () => {
    const rules = Array.from({ length: 50 }, (_, i) => mkRule({ id: `r-${i}`, wilson_lower: 0.7 + i * 0.001 }));
    const out = pickRules(rules, { maxRules: 5 });
    expect(out.length).toBe(5);
  });
  it("custom tiers set", () => {
    const rules = [
      mkRule({ id: "exp", tier: "experimental", wilson_lower: 0.8 }),
      mkRule({ id: "can", tier: "canonical", wilson_lower: 0.8 }),
    ];
    const out = pickRules(rules, { tiers: new Set(["experimental"]) });
    expect(out.map(r => r.id)).toEqual(["exp"]);
  });
});

describe("spliceBlock", () => {
  it("creates file content when input is empty", () => {
    const out = spliceBlock("", `${BEGIN}\nbody\n${END}`);
    expect(out).toMatch(BEGIN);
    expect(out).toMatch("body");
    expect(out).toMatch(END);
  });
  it("replaces existing managed block in place", () => {
    const orig = `# repo\n\nhello\n\n${BEGIN}\nold\n${END}\n\ntrailing\n`;
    const out = spliceBlock(orig, `${BEGIN}\nnew\n${END}`);
    expect(out).toMatch(/^# repo/);
    expect(out).not.toMatch("old");
    expect(out).toMatch("new");
    expect(out).toMatch("trailing");
  });
  it("appends to end when no markers", () => {
    const orig = "# repo\n\nhello\n";
    const out = spliceBlock(orig, `${BEGIN}\nfresh\n${END}`);
    expect(out.indexOf("hello")).toBeLessThan(out.indexOf(BEGIN));
    expect(out).toMatch("fresh");
  });
});

describe("writeAgentsMd", () => {
  it("writes a new AGENTS.md with the block", () => {
    const dir = tmpDir();
    const rules = [mkRule({ id: "r-a", wrong: "use moment", correct: "use dayjs", why: "deprecated" })];
    const res = writeAgentsMd(dir, rules);
    expect(res.changed).toBe(true);
    expect(res.ruleCount).toBe(1);
    const content = fs.readFileSync(res.path, "utf8");
    expect(content).toMatch(BEGIN);
    expect(content).toMatch("use moment");
    expect(content).toMatch("use dayjs");
    expect(content).toMatch(END);
  });
  it("preserves user content outside the block on rewrite", () => {
    const dir = tmpDir();
    const target = path.join(dir, "AGENTS.md");
    const orig = `# Project Agents\n\nUser-authored guidance.\n\n${BEGIN}\nstale\n${END}\n\nMore user notes.\n`;
    fs.writeFileSync(target, orig, "utf8");
    const rules = [mkRule({ id: "r-new", wrong: "x", correct: "y", why: "z" })];
    writeAgentsMd(dir, rules);
    const content = fs.readFileSync(target, "utf8");
    expect(content).toMatch("User-authored guidance");
    expect(content).toMatch("More user notes");
    expect(content).not.toMatch("stale");
    expect(content).toMatch("r-new");
  });
  it("returns changed:false when content is byte-identical", () => {
    const dir = tmpDir();
    const rules = [mkRule({ id: "r-a", wrong: "use moment", correct: "use dayjs", why: "deprecated" })];
    const opts = { generatedAt: "2026-05-15T00:00:00Z" };
    writeAgentsMd(dir, rules, opts);
    const second = writeAgentsMd(dir, rules, opts);
    expect(second.changed).toBe(false);
  });
});

describe("compileFromDb", () => {
  it("end-to-end: insert project rules, compile picks the canonical+ ones", () => {
    const repo = tmpDir();
    const db = openKnowledgeDb(path.join(repo, ".teamagent", "knowledge.db"));
    insertRule(db, mkRule({ id: "r-top", tier: "canonical+", wilson_lower: 0.95, wrong: "install moment", correct: "use dayjs", why: "deprecated" }));
    insertRule(db, mkRule({ id: "r-low", tier: "experimental", wilson_lower: 0.55, wrong: "x", correct: "y", why: "z" }));
    const res = compileFromDb(db, repo);
    closeDb(db);
    expect(res.changed).toBe(true);
    expect(res.ruleCount).toBe(1);
    const content = fs.readFileSync(res.path, "utf8");
    expect(content).toMatch("r-top");
    expect(content).not.toMatch("r-low");
  });
  it("skips when no repo root", () => {
    const db = openKnowledgeDb(path.join(tmpDir(), ".teamagent", "knowledge.db"));
    const res = compileFromDb(db, null);
    closeDb(db);
    expect(res.changed).toBe(false);
    expect(res.skipped).toBe("no_repo_root");
  });
});
