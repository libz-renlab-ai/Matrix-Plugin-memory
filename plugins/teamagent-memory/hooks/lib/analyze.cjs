"use strict";

const fs = require("fs");

// Aligned with v0.1 plus broader negation+object signal.
const CORRECTION_PATTERNS = [
  /\bdon['’]?t\s+use\s+[^\s,.;:!?]+.{0,50}\buse\s+/i,
  /\buse\s+[^\s,.;:!?]+\s+instead\s+of\s+/i,
  /\bnot\s+[^\s,.;:!?]+\s*,\s*use\s+/i,
  /[^\s,。.]+不要[,，]?\s*用\s*[^\s,。.]+/,
  /不要用\s*[^\s,。.]+[,，]?\s*用\s*[^\s,。.]+/,
  /用\s*[^\s,。.]+\s*替代\s*[^\s,。.]+/,
];

const NEG_HINTS = [/\bnot\b/i, /\bwrong\b/i, /\binstead\b/i, /\bnever\b/i, /不对/, /不要/, /别用/, /错了/, /不应该/];
const SUCCESS_HINTS = [/\bok\b/i, /\bworks?\b/i, /\bgood\b/i, /\bnice\b/i, /可以/, /行了/, /搞定/];

function textOf(turn) {
  if (!turn || !turn.message) return "";
  const c = turn.message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(x => (typeof x === "string" ? x : (x && x.text) || "")).join("\n");
  return "";
}

function isUser(turn) { return turn && (turn.type === "user" || turn.role === "user"); }
function isTool(turn) { return turn && (turn.type === "tool_use" || turn.type === "tool_call"); }

function scoreTurn(turn, prevTurn, ctx) {
  if (!isUser(turn)) return { score: 0, kind: null };
  const text = textOf(turn).trim();
  if (!text) return { score: 0, kind: null };

  let score = 0;
  let kind = null;

  for (const pat of CORRECTION_PATTERNS) {
    if (pat.test(text)) { score += 3; kind = "correction"; break; }
  }
  if (!kind) {
    const hasNeg = NEG_HINTS.some(p => p.test(text));
    if (hasNeg && text.length > 3) {
      const negPat = NEG_HINTS.find(p => p.test(text));
      const stripped = text.replace(negPat, "").trim();
      if (stripped.length > 1) { score += 2; kind = "correction"; }
    }
  }
  if (prevTurn && isTool(prevTurn) && isUser(turn)) score += 1;
  if (text.length <= 200) score += 1;
  if (ctx && ctx.recentDecisionEvent) score += 2;
  if (SUCCESS_HINTS.some(p => p.test(text)) && !kind) {
    if (prevTurn && isTool(prevTurn)) { score += 2; kind = "success"; }
  }
  return { score, kind };
}

function readTranscript(fp) {
  if (!fs.existsSync(fp)) return [];
  const raw = fs.readFileSync(fp, "utf8");
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (_e) { /* skip */ }
  }
  return out;
}

function findCandidates(transcriptPath, cursorTurnIndex = 0, opts = {}) {
  const all = readTranscript(transcriptPath);
  if (cursorTurnIndex >= all.length) return [];
  const start = Math.max(0, cursorTurnIndex);
  const results = [];
  for (let i = start; i < all.length; i++) {
    const turn = all[i];
    const prev = i > 0 ? all[i - 1] : null;
    const s = scoreTurn(turn, prev, opts.signalCtx || {});
    if (s.score >= 3) {
      const ctxBefore = all.slice(Math.max(0, i - 5), i);
      const ctxAfter = all.slice(i + 1, Math.min(all.length, i + 6));
      results.push({
        turn_index: i,
        score: s.score,
        kind: s.kind,
        context_turns: [...ctxBefore, turn, ...ctxAfter],
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 5);
}

module.exports = { scoreTurn, findCandidates, readTranscript };
