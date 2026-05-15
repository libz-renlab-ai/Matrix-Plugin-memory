#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { resolveProjectDbPath, resolveGlobalDbPath, resolveEventsDbPath } = require("./lib/paths.cjs");
const { openKnowledgeDb, openEventsDb, closeDb } = require("./lib/db.cjs");
const { listRules, listExceptions } = require("./lib/rules.cjs");
const { runMatch } = require("./lib/match.cjs");
const { effectiveWilson } = require("./lib/confidence.cjs");
const { logHook } = require("./lib/log.cjs");

const THRESH = { block: 0.85, warn: 0.65, suggest: 0.45, passive: 0.25 };

function readStdinSync() { try { return fs.readFileSync(0, "utf8"); } catch (_e) { return ""; } }
function safeParse(s) { try { return JSON.parse(s); } catch (_e) { return null; } }

function extractQuery(toolName, input) {
  if (!input || typeof input !== "object") return "";
  if (toolName === "Bash") return typeof input.command === "string" ? input.command : "";
  if (toolName === "Edit") {
    const ns = typeof input.new_string === "string" ? input.new_string.slice(0, 200) : "";
    const fp = typeof input.file_path === "string" ? path.basename(input.file_path) : "";
    return ns ? ns + " :: " + fp : "";
  }
  if (toolName === "Write") {
    const c = typeof input.content === "string" ? input.content.slice(0, 500) : "";
    const fp = typeof input.file_path === "string" ? path.basename(input.file_path) : "";
    return c ? c + " :: " + fp : "";
  }
  return "";
}

function decisionFor(score) {
  if (score >= THRESH.block) return "block";
  if (score >= THRESH.warn) return "warn";
  if (score >= THRESH.suggest) return "suggest";
  if (score >= THRESH.passive) return "passive";
  return "pass";
}

function buildReason(rule, decision, sim, wilson, score) {
  const lines = [
    `TeamAgent rule ${rule.id} ${decision === "warn" ? "blocks this (warn-tier)" : decision === "block" ? "blocks this" : "suggests a change"}.`,
    `- wrong:   ${rule.wrong}`,
    `- correct: ${rule.correct}`,
    `- why:     ${rule.why}`,
    `- score:   ${score.toFixed(2)} (sim=${sim.toFixed(2)}, wilson=${wilson.toFixed(2)}, tier=${rule.tier})`,
    `- hits/misses: ${rule.hits}/${rule.misses}; last_seen ${rule.last_seen_at || "never"}`,
  ];
  if (decision === "warn") lines.push("If this is a false positive: > /mute-rule " + rule.id);
  if (decision === "suggest") lines.push("Suggestion only — you can proceed.");
  return lines.join("\n");
}

async function main() {
  const ev = safeParse(readStdinSync()) || {};
  const toolName = ev.tool_name || (ev.tool && ev.tool.name);
  const toolInput = ev.tool_input || (ev.tool && ev.tool.input) || {};
  const session_id = ev.session_id || null;

  if (!["Bash", "Edit", "Write"].includes(toolName)) { process.exit(0); }
  const query = extractQuery(toolName, toolInput);
  if (!query) { process.exit(0); }

  let knowledgeDb = null, globalDb = null, eventsDb = null;
  try { knowledgeDb = openKnowledgeDb(resolveProjectDbPath()); } catch (_e) {}
  try { globalDb = openKnowledgeDb(resolveGlobalDbPath()); } catch (_e) {}
  try { eventsDb = openEventsDb(resolveEventsDbPath()); } catch (_e) {}

  // Project rules take precedence on id collision (ADR-0012).
  const seen = new Set();
  const rules = [];
  if (knowledgeDb) {
    for (const r of listRules(knowledgeDb)) {
      try { r._exceptions = listExceptions(knowledgeDb, r.id); } catch (_e) { r._exceptions = []; }
      seen.add(r.id);
      rules.push(r);
    }
  }
  if (globalDb) {
    for (const r of listRules(globalDb)) {
      if (seen.has(r.id)) continue; // project wins
      try { r._exceptions = listExceptions(globalDb, r.id); } catch (_e) { r._exceptions = []; }
      rules.push(r);
    }
  }
  const eligible = rules.filter(r => Array.isArray(r.match_tools) && r.match_tools.includes(toolName));

  const matches = await runMatch(query, eligible);
  let best = null;
  for (const m of matches) {
    const sim = m.sim;
    const wilson = effectiveWilson(m.rule);
    const score = sim * wilson;
    if (!best || score > best.score) best = { rule: m.rule, sim, wilson, score, layer: m.layer };
  }

  const decision = best ? decisionFor(best.score) : "pass";

  logHook(eventsDb, "PreToolUse", {
    kind: "pretooluse_" + decision,
    session_id,
    rule_id: best ? best.rule.id : null,
    tool_name: toolName,
    decision,
    score: best ? best.score : 0,
    payload: { command: query.slice(0, 500), layer: best ? best.layer : null },
  });

  for (const db of [knowledgeDb, globalDb, eventsDb]) closeDb(db);

  if (decision === "pass" || decision === "passive") { process.exit(0); }

  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision === "suggest" ? "ask" : "deny",
      permissionDecisionReason: buildReason(best.rule, decision, best.sim, best.wilson, best.score),
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

main().catch(err => {
  try { process.stderr.write("teamagent pretooluse error: " + (err && err.message) + "\n"); } catch (_e) {}
  process.exit(0);
});
