#!/usr/bin/env node
// teamagent-memory: Stop hook that scans recent transcript for user
// correction patterns and writes deduplicated rule cards to
// ~/.teamagent/rules.jsonl.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

const HOME = process.env.HOME || os.homedir();
const STORE_DIR = path.join(HOME, ".teamagent");
const RULES_PATH = path.join(STORE_DIR, "rules.jsonl");
const EVENTS_PATH = path.join(STORE_DIR, "events.jsonl");
const TAIL_N = 40;

function readStdinSync() {
  try { return fs.readFileSync(0, "utf8"); } catch (_e) { return ""; }
}
function safeParseJSON(s) { try { return JSON.parse(s); } catch (_e) { return null; } }

function ensureStoreDir() {
  try { fs.mkdirSync(STORE_DIR, { recursive: true }); } catch (_e) {}
}

function logEvent(evt) {
  try {
    ensureStoreDir();
    fs.appendFileSync(EVENTS_PATH, JSON.stringify(evt) + "\n");
  } catch (_e) {}
}

function readTranscriptTail(p, n) {
  if (!p || !fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-n);
    const msgs = [];
    for (const l of tail) {
      const obj = safeParseJSON(l);
      if (obj) msgs.push(obj);
    }
    return msgs;
  } catch (_e) { return []; }
}

function extractUserText(msg) {
  if (!msg || typeof msg !== "object") return "";
  // Tolerant of both Claude Code transcript shapes.
  if (msg.role === "user" || msg.type === "user") {
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .map((c) => (typeof c === "string" ? c : (c && c.text) || ""))
        .join("\n");
    }
    if (msg.message && typeof msg.message.content === "string") return msg.message.content;
    if (msg.message && Array.isArray(msg.message.content)) {
      return msg.message.content
        .map((c) => (typeof c === "string" ? c : (c && c.text) || ""))
        .join("\n");
    }
  }
  return "";
}

// Correction patterns: capture (wrong, correct) pairs.
const PATTERNS = [
  /\bdon['’]?t\s+use\s+([^,.;:!?\n]+?)[,.;:]?\s+use\s+([^.;:!?\n]+)/i,
  /\buse\s+([^,.;:!?\n]+?)\s+instead\s+of\s+([^.;:!?\n]+)/i,
  /\bnot\s+([^,.;:!?\n]+?),\s+use\s+([^.;:!?\n]+)/i,
  /([^\s,.;:!?]+)\s*不要[,，]?\s*用\s*([^\s,.;:!?。]+)/,
  /不要用\s*([^\s,.;:!?。]+)[,，]?\s*用\s*([^\s,.;:!?。]+)/,
  /用\s*([^\s,.;:!?。]+)\s*替代\s*([^\s,.;:!?。]+)/,
];

function extractCorrection(text) {
  if (!text) return null;
  for (let i = 0; i < PATTERNS.length; i++) {
    const m = text.match(PATTERNS[i]);
    if (!m) continue;
    let wrong, correct;
    if (i === 1) { correct = m[1]; wrong = m[2]; }
    else if (i === 5) { correct = m[1]; wrong = m[2]; }
    else { wrong = m[1]; correct = m[2]; }
    wrong = (wrong || "").trim();
    correct = (correct || "").trim();
    if (!wrong || !correct) continue;
    return { wrong, correct, source_text: text.slice(0, 400) };
  }
  return null;
}

function loadRules() {
  if (!fs.existsSync(RULES_PATH)) return [];
  const out = [];
  const raw = fs.readFileSync(RULES_PATH, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const obj = safeParseJSON(t);
    if (obj) out.push(obj);
  }
  return out;
}

function writeRules(rules) {
  ensureStoreDir();
  const body = rules.map((r) => JSON.stringify(r)).join("\n") + (rules.length ? "\n" : "");
  fs.writeFileSync(RULES_PATH, body);
}

function buildPattern(wrong) {
  // Build a Bash-command pattern. If the wrong noun looks like a package
  // name, key on `npm install <name>`; otherwise just match the name.
  const w = wrong.trim();
  const simple = /^[a-z0-9._@\/-]+$/i.test(w);
  if (simple) return "npm install\\s+" + w.replace(/[.+*?^$()\[\]{}|\\]/g, "\\$&");
  return w.replace(/[.+*?^$()\[\]{}|\\]/g, "\\$&");
}

function isoDateSlug(d) {
  return d.toISOString().slice(0, 10);
}

function captureCorrection(corr, ctx) {
  const rules = loadRules();
  const pattern = buildPattern(corr.wrong);
  const trigger = { tool: "Bash", pattern: pattern };
  // dedupe by lowercase pattern.
  const key = pattern.toLowerCase();
  let updated = false;
  let target = null;
  for (const r of rules) {
    if (r && r.trigger && r.trigger.pattern && String(r.trigger.pattern).toLowerCase() === key) {
      r.confidence = (typeof r.confidence === "number" ? r.confidence : 1) + 1;
      r.last_seen_at = new Date().toISOString();
      target = r;
      updated = true;
      break;
    }
  }
  if (!updated) {
    const id = "rule-" + isoDateSlug(new Date()) + "-" +
      corr.wrong.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) + "-" +
      corr.correct.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
    target = {
      id: id,
      trigger: trigger,
      wrong: "Adopting " + corr.wrong + " (per user correction)",
      correct: "Use " + corr.correct,
      why: "Captured from user correction in transcript",
      confidence: 1,
      captured_at: new Date().toISOString(),
      session_origin: ctx.session_id || null,
      evidence: {
        transcript_path: ctx.transcript_path || null,
        hook_event_id: ctx.hook_event_id || null,
        source_text: corr.source_text,
      },
    };
    rules.push(target);
  }
  writeRules(rules);
  return { rule: target, updated };
}

function main() {
  const raw = readStdinSync();
  const event = safeParseJSON(raw) || {};
  const transcript_path = event.transcript_path || (event.session && event.session.transcript_path) || null;
  const session_id = event.session_id || (event.session && event.session.id) || null;
  const hook_event_id = event.hook_event_id || event.id || null;

  const tail = readTranscriptTail(transcript_path, TAIL_N);
  const captures = [];
  for (const msg of tail) {
    const text = extractUserText(msg);
    if (!text) continue;
    const corr = extractCorrection(text);
    if (!corr) continue;
    const res = captureCorrection(corr, { transcript_path, session_id, hook_event_id });
    captures.push({ updated: res.updated, rule_id: res.rule.id });
  }

  logEvent({
    ts: new Date().toISOString(),
    kind: "stop_capture",
    transcript_path: transcript_path,
    session_id: session_id,
    captured: captures,
  });

  process.exit(0);
}

try { main(); } catch (err) {
  try { process.stderr.write("teamagent-memory stop-capture error: " + (err && err.message) + "\n"); } catch (_e) {}
  process.exit(0);
}
