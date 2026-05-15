#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { resolveEventsDbPath } = require("./lib/paths.cjs");
const { openEventsDb, closeDb } = require("./lib/db.cjs");
const { logHook } = require("./lib/log.cjs");
const { detect } = require("./lib/override.cjs");

function readStdinSync() { try { return fs.readFileSync(0, "utf8"); } catch (_e) { return ""; } }
function safeParse(s) { try { return JSON.parse(s); } catch (_e) { return null; } }

function main() {
  const ev = safeParse(readStdinSync()) || {};
  const session_id = ev.session_id || null;
  const tool_name = ev.tool_name || (ev.tool && ev.tool.name) || null;
  const resp = ev.tool_response || ev.toolResult || {};
  const exit_code = typeof resp.exit_code === "number" ? resp.exit_code : (typeof resp.exitCode === "number" ? resp.exitCode : null);
  const stderr = typeof resp.stderr === "string" ? resp.stderr.slice(0, 500) : null;

  let eventsDb = null;
  try { eventsDb = openEventsDb(resolveEventsDbPath()); } catch (_e) {}

  const kind = exit_code === 0 || exit_code === null ? "posttool_ok" : "posttool_fail";
  const command = ev.tool_input && typeof ev.tool_input.command === "string" ? ev.tool_input.command : "";
  logHook(eventsDb, "PostToolUse", {
    kind,
    session_id,
    tool_name,
    payload: {
      exit_code,
      stderr_excerpt: stderr,
      command: command.slice(0, 500),
    },
  });

  // Override detection: if the just-completed Bash succeeded AND a prior
  // deny/warn in this session referenced a similar command, log it for the
  // next UserPromptSubmit to surface a reply prompt.
  if (kind === "posttool_ok" && command) {
    const hit = detect(eventsDb, session_id, command, true);
    if (hit) {
      logHook(eventsDb, "PostToolUse", {
        kind: "override_detected",
        session_id,
        rule_id: hit.rule_id,
        payload: {
          prior_command: hit.prior_command,
          similarity: hit.similarity,
          current_command: command.slice(0, 500),
        },
      });
    }
  }

  closeDb(eventsDb);
  process.exit(0);
}

try { main(); } catch (err) {
  try { process.stderr.write("teamagent posttool error: " + (err && err.message) + "\n"); } catch (_e) {}
  process.exit(0);
}
