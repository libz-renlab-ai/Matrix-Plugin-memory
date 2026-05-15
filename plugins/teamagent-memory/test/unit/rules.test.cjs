const path = require("path");
const os = require("os");
const { openKnowledgeDb, closeDb } = require("../../hooks/lib/db.cjs");
const { insertRule, getRule, listRules, updateRule, archiveRule, addException, listExceptions } = require("../../hooks/lib/rules.cjs");

function tmpKnowDb() {
  const p = path.join(os.tmpdir(), `trk-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return openKnowledgeDb(p);
}

const sampleRule = {
  id: "rule-2026-05-15-moment-dayjs",
  scope: "global",
  tier: "experimental",
  wrong: "Adopting moment (per user correction)",
  correct: "Use dayjs",
  why: "moment is in maintenance mode",
  match_regex: "(npm|pnpm|yarn)\\s+(install|add)\\s+moment",
  match_literals: ["moment"],
  match_tools: ["Bash"],
  match_scope_globs: null,
  embedding: null,
  embed_model: null,
  embed_text: "Adopting moment. Use dayjs. moment is in maintenance mode",
  hits: 0,
  misses: 0,
  exceptions: 0,
  wilson_lower: 0.5,
  last_seen_at: null,
  last_demerit_at: null,
  captured_at: "2026-05-15T00:00:00Z",
  session_origin: null,
  source_text: "don't use moment, use dayjs",
  evidence_json: null,
};

describe("rules CRUD", () => {
  it("insert + get round-trip preserves arrays as JSON", () => {
    const db = tmpKnowDb();
    insertRule(db, sampleRule);
    const r = getRule(db, sampleRule.id);
    expect(r.id).toBe(sampleRule.id);
    expect(r.match_literals).toEqual(["moment"]);
    expect(r.match_tools).toEqual(["Bash"]);
    expect(r.wilson_lower).toBeCloseTo(0.5);
    closeDb(db);
  });

  it("listRules returns active rules sorted by wilson_lower desc, excludes archived", () => {
    const db = tmpKnowDb();
    insertRule(db, { ...sampleRule, id: "r1", wilson_lower: 0.6 });
    insertRule(db, { ...sampleRule, id: "r2", wilson_lower: 0.8 });
    insertRule(db, { ...sampleRule, id: "r3", wilson_lower: 0.9, tier: "archived" });
    const list = listRules(db);
    expect(list.map(r => r.id)).toEqual(["r2", "r1"]);
    closeDb(db);
  });

  it("updateRule patches selected fields, preserves others", () => {
    const db = tmpKnowDb();
    insertRule(db, sampleRule);
    updateRule(db, sampleRule.id, { hits: 5, wilson_lower: 0.72, last_seen_at: "2026-05-16T00:00:00Z" });
    const r = getRule(db, sampleRule.id);
    expect(r.hits).toBe(5);
    expect(r.wilson_lower).toBeCloseTo(0.72);
    expect(r.wrong).toBe(sampleRule.wrong);
    closeDb(db);
  });

  it("archiveRule sets tier='archived'", () => {
    const db = tmpKnowDb();
    insertRule(db, sampleRule);
    archiveRule(db, sampleRule.id);
    const r = getRule(db, sampleRule.id);
    expect(r.tier).toBe("archived");
    closeDb(db);
  });

  it("listRules with includeArchived: true returns all", () => {
    const db = tmpKnowDb();
    insertRule(db, { ...sampleRule, id: "r1" });
    insertRule(db, { ...sampleRule, id: "r2", tier: "archived" });
    expect(listRules(db, { includeArchived: true }).length).toBe(2);
    closeDb(db);
  });
});

describe("rule_exceptions", () => {
  it("addException + listExceptions round-trip", () => {
    const db = tmpKnowDb();
    insertRule(db, sampleRule);
    addException(db, { parent_rule_id: sampleRule.id, condition: "in test fixtures", example: "moment in __tests__/" });
    const out = listExceptions(db, sampleRule.id);
    expect(out.length).toBe(1);
    expect(out[0].condition).toBe("in test fixtures");
    closeDb(db);
  });

  it("listExceptions returns empty when none", () => {
    const db = tmpKnowDb();
    insertRule(db, sampleRule);
    expect(listExceptions(db, sampleRule.id)).toEqual([]);
    closeDb(db);
  });
});
