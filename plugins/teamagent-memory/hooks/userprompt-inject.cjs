#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { resolveProjectDbPath, resolveGlobalDbPath, resolveEventsDbPath } = require("./lib/paths.cjs");
const { openKnowledgeDb, openEventsDb, closeDb } = require("./lib/db.cjs");
const { listRules, listExceptions } = require("./lib/rules.cjs");
const { runMatch } = require("./lib/match.cjs");
const { readEvents } = require("./lib/events.cjs");
const { logHook } = require("./lib/log.cjs");

function findUnhandledOverride(eventsDb, session_id) {
  if (!eventsDb || !session_id) return null;
  try {
    const rows = readEvents(eventsDb, { session_id, limit: 50 });
    const handled = new Set();
    for (const r of rows) {
      if (r.kind === "override_classified" && r.rule_id) handled.add(r.rule_id);
    }
    for (const r of rows) {
      if (r.kind === "override_detected" && r.rule_id && !handled.has(r.rule_id)) {
        return r;
      }
    }
  } catch (_e) {}
  return null;
}

const MAX_INJECT = 5;

function readStdinSync() { try { return fs.readFileSync(0, "utf8"); } catch (_e) { return ""; } }
function safeParse(s) { try { return JSON.parse(s); } catch (_e) { return null; } }

function extractPrompt(ev) {
  if (typeof ev.prompt === "string") return ev.prompt;
  if (typeof ev.user_prompt === "string") return ev.user_prompt;
  if (ev.message && typeof ev.message.content === "string") return ev.message.content;
  if (ev.message && Array.isArray(ev.message.content)) {
    return ev.message.content.map(c => (typeof c === "string" ? c : (c && c.text) || "")).join("\n");
  }
  return "";
}

async function main() {
  const ev = safeParse(readStdinSync()) || {};
  const session_id = ev.session_id || null;
  const prompt = extractPrompt(ev);
  if (!prompt) { process.exit(0); }

  let knowledgeDb = null, globalDb = null, eventsDb = null;
  try { knowledgeDb = openKnowledgeDb(resolveProjectDbPath()); } catch (_e) {}
  try { globalDb = openKnowledgeDb(resolveGlobalDbPath()); } catch (_e) {}
  try { eventsDb = openEventsDb(resolveEventsDbPath()); } catch (_e) {}

  // If there's an unhandled override from this session, surface the
  // 3-option reply prompt first (don't compete with normal rule reminders).
  const override = findUnhandledOverride(eventsDb, session_id);
  if (override) {
    const lines = [
      `TeamAgent noticed you bypassed rule ${override.rule_id}. Was that:`,
      `  (a) The rule is wrong / no longer applies — demote it`,
      `  (b) Rule is correct but this specific context is an exception — save the exception`,
      `  (c) Skip — don't touch the rule`,
      `Reply with a/b/c. For (b), explain the context in one short sentence.`,
      `(To classify directly: \`teamagent classify ${override.id} a|b|c [--condition "..."]\`)`,
    ];
    const out = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: lines.join("\n"),
      },
    };
    logHook(eventsDb, "UserPromptSubmit", {
      kind: "override_prompt_injected",
      session_id,
      rule_id: override.rule_id,
      payload: { override_event_id: override.id },
    });
    for (const db of [knowledgeDb, globalDb, eventsDb]) closeDb(db);
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }

  const rules = [];
  if (knowledgeDb) {
    for (const r of listRules(knowledgeDb)) {
      try { r._exceptions = listExceptions(knowledgeDb, r.id); } catch (_e) { r._exceptions = []; }
      rules.push(r);
    }
  }
  if (globalDb) {
    for (const r of listRules(globalDb)) {
      try { r._exceptions = listExceptions(globalDb, r.id); } catch (_e) { r._exceptions = []; }
      rules.push(r);
    }
  }

  const hits = await runMatch(prompt, rules);
  logHook(eventsDb, "UserPromptSubmit", {
    kind: "prompt_match",
    session_id,
    payload: { hit_count: hits.length, rule_ids: hits.map(h => h.rule.id) },
  });

  for (const db of [knowledgeDb, globalDb, eventsDb]) closeDb(db);

  if (hits.length === 0) { process.exit(0); }

  const lines = ["TeamAgent rule reminder (do not repeat past mistakes):"];
  for (const h of hits.slice(0, MAX_INJECT)) {
    const r = h.rule;
    lines.push(`- [${r.id}] wrong: ${r.wrong} | correct: ${r.correct} | why: ${r.why} | tier: ${r.tier} (wilson ${r.wilson_lower.toFixed(2)})`);
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

main().catch(err => {
  try { process.stderr.write("teamagent userprompt-inject error: " + (err && err.message) + "\n"); } catch (_e) {}
  process.exit(0);
});
