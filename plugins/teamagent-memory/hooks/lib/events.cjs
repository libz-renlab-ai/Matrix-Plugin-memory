"use strict";

function nowIso() { return new Date().toISOString(); }

function writeEvent(db, evt) {
  if (!db) return;
  const stmt = db.prepare(`
    INSERT INTO events (ts, kind, session_id, rule_id, hook_name, tool_name, decision, score, payload_json)
    VALUES (@ts, @kind, @session_id, @rule_id, @hook_name, @tool_name, @decision, @score, @payload_json)
  `);
  try {
    stmt.run({
      ts: evt.ts || nowIso(),
      kind: evt.kind,
      session_id: evt.session_id || null,
      rule_id: evt.rule_id || null,
      hook_name: evt.hook_name || null,
      tool_name: evt.tool_name || null,
      decision: evt.decision || null,
      score: typeof evt.score === "number" ? evt.score : null,
      payload_json: evt.payload != null ? JSON.stringify(evt.payload) : null,
    });
  } catch (_e) {
    // best-effort: never break a hook over telemetry
  }
}

function readEvents(db, { limit = 50, kind = null, rule_id = null, session_id = null } = {}) {
  const where = [];
  const args = {};
  if (kind) { where.push("kind = @kind"); args.kind = kind; }
  if (rule_id) { where.push("rule_id = @rule_id"); args.rule_id = rule_id; }
  if (session_id) { where.push("session_id = @session_id"); args.session_id = session_id; }
  const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT @limit`;
  args.limit = limit;
  return db.prepare(sql).all(args);
}

module.exports = { writeEvent, readEvents };
