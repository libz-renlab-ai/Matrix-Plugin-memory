"use strict";

const crypto = require("crypto");
const { spawn } = require("child_process");

const SYSTEM_PROMPT = `You are TeamAgent's rule extractor. Given a Claude Code conversation fragment, decide whether it contains an actionable, cross-session rule, and return JSON only — no markdown, no commentary.`;

function dedupHash(transcriptPath, turnIndex) {
  return crypto.createHash("sha256").update(`${transcriptPath}::${turnIndex}`).digest("hex").slice(0, 32);
}

function summarizeTurn(turn) {
  const role = turn.type || turn.role || "?";
  const c = turn.message && turn.message.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) text = c.map(x => (typeof x === "string" ? x : (x && x.text) || "")).join("\n");
  else if (turn.input && typeof turn.input.command === "string") text = `[tool ${turn.name}] ${turn.input.command}`;
  return `${role}: ${text}`.slice(0, 500);
}

function buildExtractPrompt(contextTurns) {
  const dump = contextTurns.map(summarizeTurn).join("\n");
  return `${SYSTEM_PROMPT}

Conversation fragment (chronological, last is most recent):
<<<
${dump}
>>>

Output JSON only:
{
  "is_actionable_rule": true|false,
  "wrong": "<one-sentence wrong action>",
  "correct": "<one-sentence correct action>",
  "why": "<one-sentence rationale>",
  "scope_hint": "project"|"global",
  "match_regex": "<optional regex that uniquely matches the wrong command, or null>",
  "match_literals": ["<optional keyword>", ...],
  "match_tools": ["Bash"|"Edit"|"Write", ...],
  "confidence_hint": 0.0-1.0
}

Set is_actionable_rule=false if the user is venting, the correction is one-off, it relies on secret context, or contains credentials/paths/emails.`;
}

function spawnWithTimeout(cmd, args, { stdin, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    let settled = false;
    const finish = (res) => { if (settled) return; settled = true; resolve(res); };

    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch (_e) {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch (_e) {} }, 5000);
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);

    child.stdout.on("data", d => stdout += d.toString());
    child.stderr.on("data", d => stderr += d.toString());
    child.on("error", () => { clearTimeout(timer); finish({ code: -1, stdout, stderr, timedOut: false }); });
    child.on("close", code => { clearTimeout(timer); finish({ code, stdout, stderr, timedOut: false }); });

    try {
      if (stdin) child.stdin.write(stdin);
      child.stdin.end();
    } catch (_e) { /* child may have exited */ }
  });
}

// Strip a single leading ```json (or ```) / trailing ``` if the model wrapped
// its response in markdown code fences. Returns the raw inner text.
function stripFences(text) {
  let t = String(text || "").trim();
  // ```json\n...\n``` or ```\n...\n```
  const m = t.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```$/);
  if (m) return m[1].trim();
  return t;
}

// Parse the model's assistant text into a JSON object. Tries several
// strategies — raw parse, fence strip, then first {...} regex.
function tryParseRule(text) {
  if (!text) return null;
  const stripped = stripFences(text);
  try { return JSON.parse(stripped); } catch (_e) {}
  // last-resort: first balanced-looking object in the text
  const m = stripped.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_e2) {} }
  return null;
}

async function runExtract(contextTurns, opts = {}) {
  const claudeBin = opts.claudeBin || ["claude"];
  const env = opts.env || {};
  const timeoutMs = opts.timeoutMs || 30000;
  const model = opts.model || process.env.TEAMAGENT_EXTRACT_MODEL || "claude-haiku-4-5";

  const prompt = buildExtractPrompt(contextTurns);
  const baseArgs = claudeBin.slice(1);
  // --output-format text gives just the assistant's final text (no stream wrapper).
  // For test stubs (node fake-claude.cjs) we still pass these flags — they're ignored.
  const args = [
    ...baseArgs,
    "-p",
    "--model", model,
    "--output-format", "text",
    "--max-turns", "1",
    "--disallowed-tools", "*",
  ];

  let attempts = 0;
  while (attempts < 2) {
    attempts++;
    const res = await spawnWithTimeout(claudeBin[0], args, { stdin: prompt, env, timeoutMs });
    if (res.timedOut || res.code !== 0) return null;
    const parsed = tryParseRule(res.stdout);
    if (parsed && typeof parsed.is_actionable_rule === "boolean") return parsed;
  }
  return null;
}

module.exports = { runExtract, dedupHash, buildExtractPrompt, stripFences, tryParseRule };
