#!/usr/bin/env node
// bin/teamagent.cjs — v0.2 CLI
"use strict";

const path = require("path");
const HOOKS_LIB = path.join(__dirname, "..", "hooks", "lib");
const { resolveProjectDbPath, resolveGlobalDbPath, resolveEventsDbPath } = require(path.join(HOOKS_LIB, "paths.cjs"));
const { openKnowledgeDb, openEventsDb, closeDb } = require(path.join(HOOKS_LIB, "db.cjs"));
const { listRules, getRule, updateRule, archiveRule, addException } = require(path.join(HOOKS_LIB, "rules.cjs"));
const { readEvents } = require(path.join(HOOKS_LIB, "events.cjs"));
const { applyEvent } = require(path.join(HOOKS_LIB, "confidence.cjs"));
const { getSchemaVersion } = require(path.join(HOOKS_LIB, "schema.cjs"));

const VERSION = "0.2.0";

function usage() {
  console.log(`teamagent — TeamAgent memory store CLI (v${VERSION})

Usage:
  teamagent list [--tier T] [--scope project|global]
  teamagent inspect <id>
  teamagent events [N] [--rule R]
  teamagent mute <id>            archive
  teamagent demote <id>          misses+=1
  teamagent promote <id>         hits+=1
  teamagent doctor               self-check
  teamagent export [--rule id]   JSON dump
  teamagent forget --rule <id>   physical delete
  teamagent gc [--dry-run]       trigger gc
  teamagent classify <event_id> <a|b|c> [--condition "..."]
                                 process an override reply (a=rule-wrong, b=context-specific, c=skip)
  teamagent compile [--repo PATH] [--dry-run]
                                 (re)write the managed TeamAgent block in <repo>/AGENTS.md
  teamagent --version
`);
}

function bothDbs() {
  const result = { knowledge: null, global: null };
  try { result.knowledge = openKnowledgeDb(resolveProjectDbPath()); } catch (_e) {}
  try { result.global = openKnowledgeDb(resolveGlobalDbPath()); } catch (_e) {}
  return result;
}
function closeAll(dbs) { for (const k of Object.keys(dbs)) closeDb(dbs[k]); }
function findRule(dbs, id) {
  for (const k of ["knowledge", "global"]) {
    if (!dbs[k]) continue;
    const r = getRule(dbs[k], id);
    if (r) return { db: dbs[k], rule: r };
  }
  return null;
}

function cmdList(args) {
  const dbs = bothDbs();
  const filter = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tier") filter.tier = args[++i];
    else if (args[i] === "--scope") filter.scope = args[++i];
  }
  const rows = [];
  for (const k of ["knowledge", "global"]) {
    if (!dbs[k]) continue;
    let list = listRules(dbs[k]);
    if (filter.tier) list = list.filter(r => r.tier === filter.tier);
    if (filter.scope) list = list.filter(r => r.scope === filter.scope);
    rows.push(...list);
  }
  if (rows.length === 0) { console.log("(no rules)"); closeAll(dbs); return 0; }
  for (const r of rows) {
    console.log(`${r.id}\t${r.tier}\twilson=${r.wilson_lower.toFixed(2)}\thits=${r.hits}\tmisses=${r.misses}\twrong: ${r.wrong}`);
  }
  closeAll(dbs);
  return 0;
}

function cmdInspect(args) {
  const id = args[0];
  if (!id) { console.error("inspect: missing id"); return 2; }
  const dbs = bothDbs();
  const found = findRule(dbs, id);
  if (!found) { console.error("rule not found"); closeAll(dbs); return 1; }
  console.log(JSON.stringify(found.rule, null, 2));
  closeAll(dbs);
  return 0;
}

function cmdEvents(args) {
  let n = 50, rule = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rule") rule = args[++i];
    else if (/^\d+$/.test(args[i])) n = parseInt(args[i], 10);
  }
  let db = null;
  try { db = openEventsDb(resolveEventsDbPath()); } catch (_e) { console.error("cannot open events.db"); return 1; }
  const rows = readEvents(db, { limit: n, rule_id: rule });
  for (const r of rows.reverse()) {
    console.log(`${r.ts}\t${r.kind}\t${r.rule_id || ""}\t${r.decision || ""}\t${r.payload_json || ""}`);
  }
  closeDb(db);
  return 0;
}

function cmdMute(args) {
  const id = args[0]; if (!id) return 2;
  const dbs = bothDbs();
  const found = findRule(dbs, id);
  if (!found) { closeAll(dbs); return 1; }
  archiveRule(found.db, id);
  console.log(`archived ${id}`);
  closeAll(dbs);
  return 0;
}

function cmdDemote(args) {
  const id = args[0]; if (!id) return 2;
  const dbs = bothDbs();
  const found = findRule(dbs, id);
  if (!found) { closeAll(dbs); return 1; }
  const next = applyEvent(found.rule, { kind: "miss", at: new Date().toISOString() });
  updateRule(found.db, id, { misses: next.misses, wilson_lower: next.wilson_lower, last_demerit_at: next.last_demerit_at, tier: next.tier });
  console.log(`demoted ${id} -> tier=${next.tier} wilson=${next.wilson_lower.toFixed(2)}`);
  closeAll(dbs);
  return 0;
}

function cmdPromote(args) {
  const id = args[0]; if (!id) return 2;
  const dbs = bothDbs();
  const found = findRule(dbs, id);
  if (!found) { closeAll(dbs); return 1; }
  const next = applyEvent(found.rule, { kind: "hit", at: new Date().toISOString() });
  updateRule(found.db, id, { hits: next.hits, wilson_lower: next.wilson_lower, last_seen_at: next.last_seen_at, tier: next.tier });
  console.log(`promoted ${id} -> tier=${next.tier} wilson=${next.wilson_lower.toFixed(2)}`);
  closeAll(dbs);
  return 0;
}

function cmdDoctor() {
  let ok = true;
  for (const [name, p] of [["knowledge", resolveProjectDbPath()], ["global", resolveGlobalDbPath()], ["events", resolveEventsDbPath()]]) {
    try {
      const db = name === "events" ? openEventsDb(p) : openKnowledgeDb(p);
      const v = getSchemaVersion(db);
      console.log(`${name}\t${p}\tschema=${v}\tok`);
      closeDb(db);
    } catch (e) { ok = false; console.error(`${name}\t${p}\tERROR: ${e.message}`); }
  }
  return ok ? 0 : 1;
}

function cmdExport(args) {
  let ruleFilter = null;
  for (let i = 0; i < args.length; i++) if (args[i] === "--rule") ruleFilter = args[++i];
  const dbs = bothDbs();
  const out = [];
  for (const k of ["knowledge", "global"]) {
    if (!dbs[k]) continue;
    for (const r of listRules(dbs[k], { includeArchived: true })) {
      if (ruleFilter && r.id !== ruleFilter) continue;
      out.push(r);
    }
  }
  console.log(JSON.stringify(out, null, 2));
  closeAll(dbs);
  return 0;
}

function cmdForget(args) {
  let id = null;
  for (let i = 0; i < args.length; i++) if (args[i] === "--rule") id = args[++i];
  if (!id) { console.error("forget: --rule <id> required"); return 2; }
  const dbs = bothDbs();
  for (const k of ["knowledge", "global"]) {
    if (!dbs[k]) continue;
    const r = getRule(dbs[k], id);
    if (r) dbs[k].prepare("DELETE FROM rules WHERE id = ?").run(id);
  }
  let ev = null;
  try { ev = openEventsDb(resolveEventsDbPath()); ev.prepare("DELETE FROM events WHERE rule_id = ?").run(id); } catch (_e) {}
  closeDb(ev);
  console.log(`forgot ${id}`);
  closeAll(dbs);
  return 0;
}

function cmdClassify(args) {
  // teamagent classify <event_id> <a|b|c> [--condition "..."]
  const [eventIdStr, choice, ...rest] = args;
  if (!eventIdStr || !choice) { console.error("classify: need <event_id> <a|b|c>"); return 2; }
  let condition = null;
  for (let i = 0; i < rest.length; i++) if (rest[i] === "--condition") condition = rest[++i];

  let ev = null;
  try { ev = openEventsDb(resolveEventsDbPath()); } catch (_e) { console.error("cannot open events.db"); return 1; }
  const event = ev.prepare("SELECT * FROM events WHERE id = ?").get(parseInt(eventIdStr, 10));
  if (!event || event.kind !== "override_detected") {
    console.error("classify: event not found or not an override_detected");
    closeDb(ev); return 1;
  }
  const ruleId = event.rule_id;
  const dbs = bothDbs();
  const found = findRule(dbs, ruleId);
  if (!found) { console.error("classify: rule not found: " + ruleId); closeDb(ev); closeAll(dbs); return 1; }

  if (choice === "a") {
    const next = applyEvent(found.rule, { kind: "miss", at: new Date().toISOString() });
    updateRule(found.db, ruleId, { misses: next.misses, wilson_lower: next.wilson_lower, last_demerit_at: next.last_demerit_at, tier: next.tier });
    ev.prepare(`INSERT INTO events (ts, kind, rule_id, payload_json) VALUES (?, 'override_classified', ?, ?)`)
      .run(new Date().toISOString(), ruleId, JSON.stringify({ classification: "rule_wrong" }));
    console.log(`classified as rule-wrong; demoted to tier=${next.tier} wilson=${next.wilson_lower.toFixed(2)}`);
  } else if (choice === "b") {
    if (!condition) { console.error("classify b: --condition required"); closeDb(ev); closeAll(dbs); return 2; }
    // Embed the condition synchronously-style (await in async wrapper).
    return (async () => {
      let embedding = null;
      try {
        const { embedText, packEmbedding } = require(path.join(HOOKS_LIB, "embed.cjs"));
        const vec = await embedText(condition);
        embedding = packEmbedding(vec);
      } catch (_e) { /* fall through with embedding=null; literal substring still works */ }
      addException(found.db, { parent_rule_id: ruleId, condition, example: null, embedding });
      ev.prepare(`INSERT INTO events (ts, kind, rule_id, payload_json) VALUES (?, 'override_classified', ?, ?)`)
        .run(new Date().toISOString(), ruleId, JSON.stringify({ classification: "context_specific", condition, embedded: !!embedding }));
      console.log(`classified as context-specific; exception saved: "${condition}"${embedding ? " (embedded)" : ""}`);
      closeDb(ev); closeAll(dbs);
      return 0;
    })();
  } else if (choice === "c") {
    ev.prepare(`INSERT INTO events (ts, kind, rule_id, payload_json) VALUES (?, 'override_classified', ?, ?)`)
      .run(new Date().toISOString(), ruleId, JSON.stringify({ classification: "skip" }));
    console.log(`classified as skip (no change to rule)`);
  } else {
    console.error("classify: choice must be a/b/c"); closeDb(ev); closeAll(dbs); return 2;
  }
  closeDb(ev); closeAll(dbs);
  return 0;
}

function cmdCompile(args) {
  let repo = null;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo") repo = args[++i];
    else if (args[i] === "--dry-run") dryRun = true;
  }
  repo = repo || process.env.TEAMAGENT_REPO_ROOT || process.cwd();
  let knowledgeDb = null;
  try { knowledgeDb = openKnowledgeDb(resolveProjectDbPath()); } catch (e) { console.error("cannot open knowledge.db: " + e.message); return 1; }
  const { listRules: listProjectRules } = require(path.join(HOOKS_LIB, "rules.cjs"));
  const { compileFromDb, pickRules, renderBlock } = require(path.join(HOOKS_LIB, "compile.cjs"));
  if (dryRun) {
    const all = listProjectRules(knowledgeDb, { scope: "project", limit: 1000 });
    const picks = pickRules(all);
    process.stdout.write(renderBlock(picks) + "\n");
    closeDb(knowledgeDb);
    return 0;
  }
  const res = compileFromDb(knowledgeDb, repo);
  closeDb(knowledgeDb);
  if (res.skipped) {
    console.error("skipped: " + res.skipped);
    return 1;
  }
  console.log(`${res.changed ? "updated" : "unchanged"} ${res.path} (${res.ruleCount} rules)`);
  return 0;
}

function cmdGc(args) {
  const dryRun = args.includes("--dry-run");
  const dbs = bothDbs();
  const cutoff = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  let archived = 0;
  for (const k of ["knowledge", "global"]) {
    if (!dbs[k]) continue;
    const rows = dbs[k].prepare(`SELECT id FROM rules WHERE tier='experimental' AND hits=0 AND captured_at < ?`).all(cutoff);
    archived += rows.length;
    if (!dryRun) {
      dbs[k].prepare(`UPDATE rules SET tier='archived' WHERE tier='experimental' AND hits=0 AND captured_at < ?`).run(cutoff);
    }
  }
  console.log(`${dryRun ? "[dry-run] " : ""}archived ${archived} stale experimental rules`);
  closeAll(dbs);
  return 0;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "--version":
    case "-v":
      console.log(`teamagent-memory ${VERSION}`); return 0;
    case "list": return cmdList(rest);
    case "inspect": return cmdInspect(rest);
    case "events": return cmdEvents(rest);
    case "mute": return cmdMute(rest);
    case "demote": return cmdDemote(rest);
    case "promote": return cmdPromote(rest);
    case "doctor": return cmdDoctor();
    case "export": return cmdExport(rest);
    case "forget": return cmdForget(rest);
    case "gc": return cmdGc(rest);
    case "classify": return cmdClassify(rest);
    case "compile": return cmdCompile(rest);
    case undefined:
    case "":
    case "-h":
    case "--help":
    case "help":
      usage(); return 0;
    default:
      console.error("unknown subcommand: " + cmd); usage(); return 2;
  }
}

Promise.resolve(main(process.argv.slice(2))).then(code => process.exit(code || 0)).catch(err => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
