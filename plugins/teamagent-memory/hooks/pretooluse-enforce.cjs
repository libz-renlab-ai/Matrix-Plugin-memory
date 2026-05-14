#!/usr/bin/env node
// teamagent-memory: PreToolUse enforcer.
// Reads stdin (Claude Code hook event), iterates rule cards from
// ~/.teamagent/rules.jsonl, and if any rule's trigger matches the Bash
// command, emits a deny decision JSON. Logs every check to events.jsonl.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = process.env.HOME || os.homedir();
const STORE_DIR = path.join(HOME, ".teamagent");
const RULES_PATH = path.join(STORE_DIR, "rules.jsonl");
const EVENTS_PATH = path.join(STORE_DIR, "events.jsonl");

function readStdinSync() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch (_e) {
    return "";
  }
}

function safeParseJSON(s) {
  try {
    return JSON.parse(s);
  } catch (_e) {
    return null;
  }
}

function loadRules() {
  if (!fs.existsSync(RULES_PATH)) return [];
  const raw = fs.readFileSync(RULES_PATH, "utf8");
  const rules = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const obj = safeParseJSON(t);
    if (obj && obj.trigger && obj.trigger.pattern) rules.push(obj);
  }
  return rules;
}

function ensureStoreDir() {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  } catch (_e) { /* ignore */ }
}

function logEvent(evt) {
  try {
    ensureStoreDir();
    fs.appendFileSync(EVENTS_PATH, JSON.stringify(evt) + "\n");
  } catch (_e) { /* ignore */ }
}

const MAX_PATTERN_LEN = 512; // bound regex compile + ReDoS exposure

function matchRule(rule, command) {
  const pat = rule.trigger && rule.trigger.pattern;
  if (!pat || typeof command !== "string") return false;
  if (typeof pat !== "string" || pat.length > MAX_PATTERN_LEN) return false;
  try {
    const re = new RegExp(pat, "i");
    if (re.test(command)) return true;
  } catch (_e) { /* not a valid regex, fall through */ }
  return command.toLowerCase().includes(pat.toLowerCase());
}

function main() {
  const raw = readStdinSync();
  const event = safeParseJSON(raw) || {};
  const toolName = event.tool_name || (event.tool && event.tool.name);
  const toolInput = event.tool_input || (event.tool && event.tool.input) || {};
  const command = toolInput.command || "";

  if (toolName !== "Bash" || !command) {
    process.exit(0);
  }

  const rules = loadRules();
  for (const rule of rules) {
    if (matchRule(rule, command)) {
      const reason =
        "TeamAgent rule " + (rule.id || "<no-id>") + " blocks this command. " +
        "Wrong: " + (rule.wrong || "(unspecified)") + ". " +
        "Correct: " + (rule.correct || "(unspecified)") + ". " +
        "Why: " + (rule.why || "(unspecified)") + ".";

      logEvent({
        ts: new Date().toISOString(),
        kind: "pretooluse_block",
        rule_id: rule.id || null,
        command: command,
        decision: "deny",
      });

      const out = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
      process.stdout.write(JSON.stringify(out));
      process.exit(0);
    }
  }

  logEvent({
    ts: new Date().toISOString(),
    kind: "pretooluse_pass",
    command: command,
  });
  process.exit(0);
}

try {
  main();
} catch (err) {
  // Never break the user's session; log to stderr and exit 0.
  try { process.stderr.write("teamagent-memory pretooluse error: " + (err && err.message) + "\n"); } catch (_e) {}
  process.exit(0);
}
