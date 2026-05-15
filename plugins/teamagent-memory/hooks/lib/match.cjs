"use strict";

const FAST_PATH_BUDGET_MS = 50;

function fastPathMatch(query, rule) {
  if (typeof query !== "string" || query.length === 0) return { hit: false, sim: 0, via: null };

  if (rule.match_regex) {
    try {
      const re = new RegExp(rule.match_regex, "i");
      if (re.test(query)) return { hit: true, sim: 1.0, via: "regex" };
    } catch (_e) { /* invalid regex, fall through */ }
  }

  if (Array.isArray(rule.match_literals) && rule.match_literals.length > 0) {
    const q = query.toLowerCase();
    for (const lit of rule.match_literals) {
      if (typeof lit === "string" && lit.length > 0 && q.includes(lit.toLowerCase())) {
        return { hit: true, sim: 1.0, via: "literal" };
      }
    }
  }

  return { hit: false, sim: 0, via: null };
}

function runMatch(query, rules, opts = {}) {
  const budget = opts.budget_ms || FAST_PATH_BUDGET_MS;
  const start = Date.now();
  const hits = [];
  for (const rule of rules) {
    if (Date.now() - start > budget) break;
    const m = fastPathMatch(query, rule);
    if (m.hit) hits.push({ rule, sim: m.sim, via: m.via });
  }
  return hits;
}

module.exports = { fastPathMatch, runMatch, FAST_PATH_BUDGET_MS };
