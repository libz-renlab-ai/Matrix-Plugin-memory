#!/usr/bin/env node
// teamagent-memory: UserPromptSubmit injector.
// Scans the user prompt for keywords matching any rule trigger pattern and
// emits an additionalContext block listing relevant rules so the assistant
// is reminded before it acts.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = process.env.HOME || os.homedir();
const STORE_DIR = path.join(HOME, ".teamagent");
const RULES_PATH = path.join(STORE_DIR, "rules.jsonl");

function readStdinSync() {
  try { return fs.readFileSync(0, "utf8"); } catch (_e) { return ""; }
}
function safeParseJSON(s) { try { return JSON.parse(s); } catch (_e) { return null; } }

function loadRules() {
  if (!fs.existsSync(RULES_PATH)) return [];
  const out = [];
  const raw = fs.readFileSync(RULES_PATH, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const obj = safeParseJSON(t);
    if (obj && obj.trigger && obj.trigger.pattern) out.push(obj);
  }
  return out;
}

function keywordsFromPattern(pat) {
  // Strip regex metas to recover plain keyword tokens for substring matching.
  const cleaned = String(pat).replace(/\\s\+|\\s\*|\\s|\\\.|\\\$|\\\^|\\\(|\\\)|\\\[|\\\]|\\\{|\\\}|\\\||\\\+|\\\*|\\\?|\\\\/g, " ");
  return cleaned.split(/[^a-zA-Z0-9_@.\/-]+/).map((s) => s.trim()).filter((s) => s.length > 2);
}

function matches(text, rule) {
  const pat = rule.trigger && rule.trigger.pattern;
  if (!pat) return false;
  try {
    const re = new RegExp(pat, "i");
    if (re.test(text)) return true;
  } catch (_e) {}
  const lower = text.toLowerCase();
  for (const kw of keywordsFromPattern(pat)) {
    if (lower.includes(kw.toLowerCase())) return true;
  }
  return false;
}

function main() {
  const raw = readStdinSync();
  const event = safeParseJSON(raw) || {};
  const prompt = event.prompt || event.user_prompt || (event.message && event.message.content) || "";
  const text = typeof prompt === "string" ? prompt : JSON.stringify(prompt);

  if (!text) process.exit(0);

  const rules = loadRules();
  const hits = [];
  for (const rule of rules) {
    if (matches(text, rule)) hits.push(rule);
  }
  if (hits.length === 0) process.exit(0);

  const lines = ["TeamAgent rule reminder (do not repeat past mistakes):"];
  for (const r of hits.slice(0, 5)) {
    lines.push(
      "- [" + (r.id || "<no-id>") + "] wrong: " + (r.wrong || "?") +
      " | correct: " + (r.correct || "?") +
      " | why: " + (r.why || "?") +
      " | confidence: " + (r.confidence || 1)
    );
  }

  const out = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: lines.join("\n"),
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

try { main(); } catch (err) {
  try { process.stderr.write("teamagent-memory userprompt-inject error: " + (err && err.message) + "\n"); } catch (_e) {}
  process.exit(0);
}
