"use strict";

const MAX_LEN = 512;
const PROBE_INPUT = "a".repeat(10000);
const PROBE_TIMEOUT_MS = 50;

// Static heuristic: detect "(x)+ followed by + or *" and similar.
const DANGEROUS = [
  /\([^()]*[+*?][^()]*\)[+*]/, // (a+)+, (a*)* etc
  /\([^()]*\)\{[^}]*,\s*\}/,   // (x){n,} unbounded
  /\(\.\*[^)]*\)\{\d{2,}/,     // (.*a){25}
];

function lintRegex(pat) {
  if (typeof pat !== "string") return { ok: false, reason: "pattern must be string" };
  if (pat.length === 0) return { ok: false, reason: "empty pattern" };
  if (pat.length > MAX_LEN) return { ok: false, reason: `pattern too long (${pat.length} > ${MAX_LEN})` };

  for (const danger of DANGEROUS) {
    if (danger.test(pat)) return { ok: false, reason: `pattern contains catastrophic backtracking pattern: ${danger}` };
  }

  let re;
  try { re = new RegExp(pat, "i"); }
  catch (e) { return { ok: false, reason: `regex compile failed: ${e.message}` }; }

  // Performance probe — wall-clock check; Node has no native RegExp timeout.
  const t0 = Date.now();
  try { re.test(PROBE_INPUT); } catch (_e) { /* ignore */ }
  const dt = Date.now() - t0;
  if (dt > PROBE_TIMEOUT_MS) return { ok: false, reason: `probe slow (${dt}ms > ${PROBE_TIMEOUT_MS}ms)` };

  return { ok: true, reason: null };
}

module.exports = { lintRegex, MAX_LEN, PROBE_TIMEOUT_MS };
