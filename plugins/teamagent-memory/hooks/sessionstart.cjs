#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { resolveProjectDbPath, resolveGlobalDbPath, resolveEventsDbPath } = require("./lib/paths.cjs");
const { openKnowledgeDb, openEventsDb, closeDb } = require("./lib/db.cjs");
const { logHook } = require("./lib/log.cjs");
const { decay } = require("./lib/confidence.cjs");

function readStdinSync() { try { return fs.readFileSync(0, "utf8"); } catch (_e) { return ""; } }
function safeParse(s) { try { return JSON.parse(s); } catch (_e) { return null; } }

function gcStaleExperimental(db, cutoffIso) {
  try {
    db.prepare(`UPDATE rules SET tier='archived' WHERE tier='experimental' AND hits=0 AND captured_at < ?`).run(cutoffIso);
  } catch (_e) {}
}

function applyDecay(db, seenCutoffIso) {
  try {
    const rows = db.prepare(`
      SELECT id, wilson_lower, last_seen_at FROM rules
      WHERE tier != 'archived' AND last_seen_at IS NOT NULL AND last_seen_at < ?
    `).all(seenCutoffIso);
    if (rows.length === 0) return 0;
    const stmt = db.prepare("UPDATE rules SET wilson_lower = ? WHERE id = ?");
    const now = Date.now();
    let touched = 0;
    for (const r of rows) {
      const daysIdle = (now - new Date(r.last_seen_at).getTime()) / 86400000;
      if (daysIdle <= 7) continue;
      const next = decay(r.wilson_lower, daysIdle);
      stmt.run(next, r.id);
      touched++;
    }
    return touched;
  } catch (_e) { return 0; }
}

function main() {
  const event = safeParse(readStdinSync()) || {};
  const session_id = event.session_id || (event.session && event.session.id) || null;

  let knowledgeDb = null, globalDb = null, eventsDb = null;
  try { knowledgeDb = openKnowledgeDb(resolveProjectDbPath()); } catch (_e) {}
  try { globalDb = openKnowledgeDb(resolveGlobalDbPath()); } catch (_e) {}
  try { eventsDb = openEventsDb(resolveEventsDbPath()); } catch (_e) {}

  // GC: archive experimental rules untouched for 30+ days
  const gcCutoff = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  // Decay: apply exponential decay to wilson_lower for rules idle > 7 days
  const seenCutoff = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  let decayedTotal = 0;
  for (const db of [knowledgeDb, globalDb].filter(Boolean)) {
    gcStaleExperimental(db, gcCutoff);
    decayedTotal += applyDecay(db, seenCutoff);
  }

  logHook(eventsDb, "SessionStart", {
    kind: "session_start",
    session_id,
    payload: { decayed: decayedTotal },
  });

  for (const db of [knowledgeDb, globalDb, eventsDb]) closeDb(db);
  process.exit(0);
}

try { main(); } catch (err) {
  try { process.stderr.write("teamagent sessionstart error: " + (err && err.message) + "\n"); } catch (_e) {}
  process.exit(0);
}
