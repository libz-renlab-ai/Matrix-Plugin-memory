"use strict";

function serializeArrays(rule) {
  return {
    ...rule,
    match_literals: rule.match_literals != null ? JSON.stringify(rule.match_literals) : null,
    match_tools: rule.match_tools != null ? JSON.stringify(rule.match_tools) : JSON.stringify(["Bash"]),
    match_scope_globs: rule.match_scope_globs != null ? JSON.stringify(rule.match_scope_globs) : null,
    evidence_json: rule.evidence_json != null ? JSON.stringify(rule.evidence_json) : null,
  };
}

function deserializeArrays(row) {
  if (!row) return row;
  return {
    ...row,
    match_literals: row.match_literals ? JSON.parse(row.match_literals) : null,
    match_tools: row.match_tools ? JSON.parse(row.match_tools) : [],
    match_scope_globs: row.match_scope_globs ? JSON.parse(row.match_scope_globs) : null,
    evidence_json: row.evidence_json ? JSON.parse(row.evidence_json) : null,
  };
}

function insertRule(db, rule) {
  const r = serializeArrays(rule);
  // prior defaults to the wilson_lower at insert time (the prior we chose).
  const wilson_lower = typeof r.wilson_lower === "number" ? r.wilson_lower : 0.5;
  const prior = typeof r.prior === "number" ? r.prior : wilson_lower;
  db.prepare(`
    INSERT INTO rules (
      id, scope, tier, wrong, correct, why,
      match_regex, match_literals, match_tools, match_scope_globs,
      embedding, embed_model, embed_text,
      hits, misses, exceptions, wilson_lower, prior,
      last_seen_at, last_demerit_at,
      captured_at, session_origin, source_text, evidence_json
    ) VALUES (
      @id, @scope, @tier, @wrong, @correct, @why,
      @match_regex, @match_literals, @match_tools, @match_scope_globs,
      @embedding, @embed_model, @embed_text,
      @hits, @misses, @exceptions, @wilson_lower, @prior,
      @last_seen_at, @last_demerit_at,
      @captured_at, @session_origin, @source_text, @evidence_json
    )
  `).run({
    id: r.id,
    scope: r.scope,
    tier: r.tier,
    wrong: r.wrong,
    correct: r.correct,
    why: r.why,
    match_regex: r.match_regex || null,
    match_literals: r.match_literals,
    match_tools: r.match_tools,
    match_scope_globs: r.match_scope_globs,
    embedding: r.embedding || null,
    embed_model: r.embed_model || null,
    embed_text: r.embed_text,
    hits: r.hits || 0,
    misses: r.misses || 0,
    exceptions: r.exceptions || 0,
    wilson_lower,
    prior,
    last_seen_at: r.last_seen_at || null,
    last_demerit_at: r.last_demerit_at || null,
    captured_at: r.captured_at,
    session_origin: r.session_origin || null,
    source_text: r.source_text || null,
    evidence_json: r.evidence_json,
  });
}

function getRule(db, id) {
  const row = db.prepare("SELECT * FROM rules WHERE id = ?").get(id);
  return deserializeArrays(row);
}

function listRules(db, { includeArchived = false, scope = null, limit = 1000 } = {}) {
  const where = [];
  const args = { limit };
  if (!includeArchived) where.push("tier != 'archived'");
  if (scope) { where.push("scope = @scope"); args.scope = scope; }
  const sql = `SELECT * FROM rules ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY wilson_lower DESC, captured_at DESC LIMIT @limit`;
  return db.prepare(sql).all(args).map(deserializeArrays);
}

function updateRule(db, id, patch) {
  const allowed = [
    "tier","wrong","correct","why",
    "match_regex","match_literals","match_tools","match_scope_globs",
    "embedding","embed_model","embed_text",
    "hits","misses","exceptions","wilson_lower","prior",
    "last_seen_at","last_demerit_at","source_text","evidence_json",
  ];
  const sets = [];
  const args = { id };
  for (const k of Object.keys(patch)) {
    if (!allowed.includes(k)) continue;
    let v = patch[k];
    if (["match_literals","match_tools","match_scope_globs","evidence_json"].includes(k) && v != null) {
      v = JSON.stringify(v);
    }
    sets.push(`${k} = @${k}`);
    args[k] = v;
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE rules SET ${sets.join(", ")} WHERE id = @id`).run(args);
}

function archiveRule(db, id) {
  db.prepare("UPDATE rules SET tier = 'archived' WHERE id = ?").run(id);
}

function addException(db, { parent_rule_id, condition, example }) {
  const id = `exc-${parent_rule_id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT INTO rule_exceptions (id, parent_rule_id, condition, example, captured_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, parent_rule_id, condition, example || null, new Date().toISOString());
  return id;
}

function listExceptions(db, parent_rule_id) {
  return db.prepare("SELECT * FROM rule_exceptions WHERE parent_rule_id = ?").all(parent_rule_id);
}

module.exports = { insertRule, getRule, listRules, updateRule, archiveRule, addException, listExceptions };
