"use strict";

const { spawn } = require("child_process");
const { readEvents } = require("./events.cjs");

const LOOKBACK = 10;
const SIMILARITY_THRESHOLD = 0.6;

function tokenize(s) {
  // Split on anything that isn't alphanumeric / underscore / dash / slash.
  // Treat '.', '@', and other version-y separators as boundaries — so
  // "moment@2.29" → ["moment", "2", "29"] and matches a prior "moment".
  return new Set(String(s || "").toLowerCase().split(/[^a-z0-9_\-\/]+/).filter(Boolean));
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function safeParse(s) { try { return JSON.parse(s); } catch (_e) { return null; } }

// Detect "override": within last LOOKBACK events of this session, was there a
// pretooluse_{block,warn} with a command similar (Jaccard >= threshold) to the
// current PostToolUse command, AND did the current PostToolUse succeed?
function detect(eventsDb, sessionId, currentCommand, currentExitOk) {
  if (!eventsDb || !currentExitOk || !sessionId) return null;
  let rows;
  try { rows = readEvents(eventsDb, { session_id: sessionId, limit: LOOKBACK + 1 }); }
  catch (_e) { return null; }
  if (!rows || rows.length === 0) return null;

  const currentToks = tokenize(currentCommand);
  for (const r of rows) {
    if (r.kind !== "pretooluse_block" && r.kind !== "pretooluse_warn") continue;
    if (!r.rule_id) continue;
    const payload = r.payload_json ? safeParse(r.payload_json) : null;
    const prior = payload && typeof payload.command === "string" ? payload.command : "";
    if (!prior) continue;
    const sim = jaccard(currentToks, tokenize(prior));
    if (sim >= SIMILARITY_THRESHOLD) {
      return { rule_id: r.rule_id, prior_command: prior, similarity: sim };
    }
  }
  return null;
}

// Extract a one-line "condition" from the user's reply describing the context.
// Returns { condition, example } or null.
async function extractCondition(userReply, opts = {}) {
  const claudeBin = opts.claudeBin || ["claude"];
  const timeoutMs = opts.timeoutMs || 20000;
  const model = opts.model || process.env.TEAMAGENT_EXTRACT_MODEL || "claude-haiku-4-5";
  const prompt = `Extract a one-line "condition" describing the specific context in which a TeamAgent rule
should be skipped, based on the user's reply below. Output JSON only:
{ "condition": "<one short clause, less than 20 words>", "example": "<optional matching token from the reply, or null>" }

User reply:
<<<
${userReply}
>>>

If the reply doesn't describe a real exception context (just venting / ambiguous), return:
{ "condition": null }`;
  const { tryParseRule } = require("./extract.cjs");
  return new Promise((resolve) => {
    const args = [
      ...claudeBin.slice(1),
      "-p",
      "--model", model,
      "--output-format", "text",
      "--max-turns", "1",
      "--disallowed-tools", "*",
    ];
    const child = spawn(claudeBin[0], args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(opts.env || {}) } });
    let stdout = "", stderr = "";
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; resolve(v); };
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch (_e) {} finish(null); }, timeoutMs);
    child.stdout.on("data", d => stdout += d.toString());
    child.stderr.on("data", d => stderr += d.toString());
    child.on("error", () => { clearTimeout(timer); finish(null); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) return finish(null);
      const parsed = tryParseRule(stdout);
      if (parsed && typeof parsed.condition === "string" && parsed.condition.length > 0 && parsed.condition.length < 200) {
        return finish(parsed);
      }
      finish(null);
    });
    try { child.stdin.write(prompt); child.stdin.end(); } catch (_e) {}
  });
}

module.exports = { detect, extractCondition, tokenize, jaccard, LOOKBACK, SIMILARITY_THRESHOLD };
