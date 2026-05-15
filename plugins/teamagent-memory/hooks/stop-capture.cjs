#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { resolveProjectDbPath, resolveGlobalDbPath, resolveEventsDbPath } = require("./lib/paths.cjs");
const { openKnowledgeDb, openEventsDb, closeDb } = require("./lib/db.cjs");
const { insertRule, getRule, updateRule } = require("./lib/rules.cjs");
const { findCandidates } = require("./lib/analyze.cjs");
const { runExtract, dedupHash } = require("./lib/extract.cjs");
const { applyEvent } = require("./lib/confidence.cjs");
const { lintRegex } = require("./lib/redos.cjs");
const { logHook } = require("./lib/log.cjs");
const { readEvents } = require("./lib/events.cjs");

const STOP_BUDGET_MS = 25000;

function readStdinSync() { try { return fs.readFileSync(0, "utf8"); } catch (_e) { return ""; } }
function safeParse(s) { try { return JSON.parse(s); } catch (_e) { return null; } }

function nowIso() { return new Date().toISOString(); }

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
}

function isoDate() { return new Date().toISOString().slice(0, 10); }

function pickDbForScope(scope, knowledgeDb, globalDb) {
  return scope === "project" ? (knowledgeDb || globalDb) : (globalDb || knowledgeDb);
}

function isDuplicate(eventsDb, hash) {
  if (!eventsDb) return false;
  try {
    const rows = readEvents(eventsDb, { kind: "stop_extract", limit: 500 });
    return rows.some(r => {
      try { const p = r.payload_json ? JSON.parse(r.payload_json) : null; return p && p.dedup_hash === hash; }
      catch (_e) { return false; }
    });
  } catch (_e) { return false; }
}

async function processCandidate(cand, ctx) {
  const { transcript_path, knowledgeDb, globalDb, eventsDb, session_id, claudeBin, env } = ctx;
  const hash = dedupHash(transcript_path, cand.turn_index);
  if (isDuplicate(eventsDb, hash)) {
    logHook(eventsDb, "Stop", { kind: "stop_extract_skipped", payload: { dedup_hash: hash, reason: "duplicate" }, session_id });
    return;
  }

  const extracted = await runExtract(cand.context_turns, { claudeBin, env, timeoutMs: 30000 });
  logHook(eventsDb, "Stop", {
    kind: "stop_extract",
    session_id,
    payload: { dedup_hash: hash, ok: !!extracted, turn_index: cand.turn_index },
  });
  if (!extracted || !extracted.is_actionable_rule) return;

  let matchRegex = null;
  if (extracted.match_regex && typeof extracted.match_regex === "string") {
    const lint = lintRegex(extracted.match_regex);
    if (lint.ok) matchRegex = extracted.match_regex;
    else logHook(eventsDb, "Stop", { kind: "rule_regex_rejected", payload: { reason: lint.reason }, session_id });
  }

  const scope = extracted.scope_hint === "project" ? "project" : "global";
  const db = pickDbForScope(scope, knowledgeDb, globalDb);
  if (!db) return;

  const wrongSlug = slug(extracted.wrong);
  const correctSlug = slug(extracted.correct);
  const id = `rule-${isoDate()}-${wrongSlug}-${correctSlug}`;
  const embedText = `${extracted.wrong}. ${extracted.correct}. ${extracted.why}`.trim();

  const existing = getRule(db, id);
  if (existing) {
    const next = applyEvent(existing, { kind: "hit", at: nowIso() });
    updateRule(db, id, { hits: next.hits, wilson_lower: next.wilson_lower, last_seen_at: next.last_seen_at, tier: next.tier });
    logHook(eventsDb, "Stop", { kind: "rule_updated", rule_id: id, session_id });
    return;
  }

  const hint = typeof extracted.confidence_hint === "number" ? extracted.confidence_hint : 0.5;
  const prior = hint >= 0.9 ? 0.6 : (hint >= 0.7 ? 0.55 : 0.5);

  insertRule(db, {
    id, scope, tier: "experimental",
    wrong: extracted.wrong, correct: extracted.correct, why: extracted.why,
    match_regex: matchRegex,
    match_literals: Array.isArray(extracted.match_literals) ? extracted.match_literals.slice(0, 8) : null,
    match_tools: Array.isArray(extracted.match_tools) && extracted.match_tools.length ? extracted.match_tools : ["Bash"],
    match_scope_globs: null,
    embedding: null, embed_model: null,
    embed_text: embedText,
    hits: 0, misses: 0, exceptions: 0, wilson_lower: prior,
    last_seen_at: null, last_demerit_at: null,
    captured_at: nowIso(),
    session_origin: session_id,
    source_text: cand.context_turns.map(t => {
      const c = t && t.message && t.message.content;
      return typeof c === "string" ? c : "";
    }).join("\n").slice(0, 800),
    evidence_json: { transcript_path, turn_index: cand.turn_index },
  });
  logHook(eventsDb, "Stop", { kind: "rule_created", rule_id: id, session_id });
}

async function main() {
  const ev = safeParse(readStdinSync()) || {};
  const transcript_path = ev.transcript_path || (ev.session && ev.session.transcript_path) || null;
  const session_id = ev.session_id || (ev.session && ev.session.id) || null;

  let knowledgeDb = null, globalDb = null, eventsDb = null;
  try { knowledgeDb = openKnowledgeDb(resolveProjectDbPath()); } catch (_e) {}
  try { globalDb = openKnowledgeDb(resolveGlobalDbPath()); } catch (_e) {}
  try { eventsDb = openEventsDb(resolveEventsDbPath()); } catch (_e) {}

  if (!transcript_path) {
    logHook(eventsDb, "Stop", { kind: "stop_skipped", payload: { reason: "no_transcript" }, session_id });
    for (const db of [knowledgeDb, globalDb, eventsDb]) closeDb(db);
    process.exit(0);
  }

  const cands = findCandidates(transcript_path, 0);
  logHook(eventsDb, "Stop", { kind: "stop_analyze", payload: { candidate_count: cands.length }, session_id });
  if (cands.length === 0) {
    for (const db of [knowledgeDb, globalDb, eventsDb]) closeDb(db);
    process.exit(0);
  }

  const claudeBinSpec = process.env.TEAMAGENT_CLAUDE_BIN ? process.env.TEAMAGENT_CLAUDE_BIN.split(/\s+/) : ["claude"];
  const startedAt = Date.now();
  for (const cand of cands) {
    if (Date.now() - startedAt > STOP_BUDGET_MS) {
      logHook(eventsDb, "Stop", { kind: "stop_extract_skipped_remainder", session_id });
      break;
    }
    await processCandidate(cand, { transcript_path, knowledgeDb, globalDb, eventsDb, session_id, claudeBin: claudeBinSpec, env: process.env });
  }

  for (const db of [knowledgeDb, globalDb, eventsDb]) closeDb(db);
  process.exit(0);
}

main().catch(err => {
  try { process.stderr.write("teamagent stop error: " + (err && err.message) + "\n"); } catch (_e) {}
  process.exit(0);
});
