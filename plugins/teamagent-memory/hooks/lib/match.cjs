"use strict";

const { embedText } = require("./embed.cjs");
const ann = require("./ann.cjs");
const bm25 = require("./bm25.cjs");

const FAST_PATH_BUDGET_MS = 50;
const SEMANTIC_THRESHOLD = 0.78;
const BM25_MAX_QUERY_LEN = 30;
const TOP_K = 5;

// LRU for query embeddings, in-process. Hook processes are short-lived; this
// mainly helps within a single hook invocation that calls runMatch multiple
// times (e.g., a Stop pass scanning many turns).
const _queryCache = new Map();
const QUERY_CACHE_MAX = 64;
function _cacheGet(k) {
  const v = _queryCache.get(k);
  if (v !== undefined) { _queryCache.delete(k); _queryCache.set(k, v); }
  return v;
}
function _cacheSet(k, v) {
  if (_queryCache.size >= QUERY_CACHE_MAX) {
    const first = _queryCache.keys().next().value;
    _queryCache.delete(first);
  }
  _queryCache.set(k, v);
}

function ruleHasMatchingException(rule, query) {
  const excs = rule._exceptions;
  if (!Array.isArray(excs) || excs.length === 0) return false;
  const q = (query || "").toLowerCase();
  for (const e of excs) {
    if (typeof e.condition !== "string" || e.condition.length === 0) continue;
    if (q.includes(e.condition.toLowerCase())) return true;
    // Token fallback: any condition word >2 chars present in query
    const tokens = e.condition.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    for (const t of tokens) if (q.includes(t)) return true;
  }
  return false;
}

function applyExceptionFilter(query, matches) {
  return matches.filter(m => !ruleHasMatchingException(m.rule, query));
}

function fastPathMatch(query, rule) {
  if (typeof query !== "string" || query.length === 0) return { hit: false, sim: 0, via: null };

  if (rule.match_regex) {
    try {
      const re = new RegExp(rule.match_regex, "i");
      if (re.test(query)) return { hit: true, sim: 1.0, via: "regex" };
    } catch (_e) { /* fall through */ }
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

function runFastPath(query, rules, opts = {}) {
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

async function runMatch(query, rules, opts = {}) {
  // Layer 1 — Fast-path
  const l1 = applyExceptionFilter(query, runFastPath(query, rules, opts)).map(h => ({ ...h, layer: 1 }));
  if (l1.length > 0) return l1;

  // Layer 2 — Semantic
  let queryVec = _cacheGet(query);
  if (!queryVec) {
    try { queryVec = await embedText(query); _cacheSet(query, queryVec); }
    catch (_e) { queryVec = null; }
  }
  if (queryVec) {
    const l2raw = ann.topK(queryVec, rules, TOP_K)
      .filter(h => h.sim >= (opts.threshold || SEMANTIC_THRESHOLD));
    const l2 = applyExceptionFilter(query, l2raw).map(h => ({ ...h, via: "semantic", layer: 2 }));
    if (l2.length > 0) return l2;
  }

  // Layer 3 — BM25-lite
  if (query.length < BM25_MAX_QUERY_LEN) {
    const l3raw = bm25.score(query, rules);
    const l3 = applyExceptionFilter(query, l3raw).map(h => ({ ...h, via: "bm25", layer: 3 }));
    if (l3.length > 0) return l3;
  }

  return [];
}

// Back-compat sync wrapper for callers that haven't been converted yet.
// Skips Layer 2/3 because they're async.
function runMatchSync(query, rules, opts = {}) {
  const l1 = runFastPath(query, rules, opts);
  return l1.map(h => ({ ...h, layer: 1 }));
}

module.exports = {
  fastPathMatch,
  runFastPath,
  runMatch,
  runMatchSync,
  ruleHasMatchingException,
  applyExceptionFilter,
  FAST_PATH_BUDGET_MS,
  SEMANTIC_THRESHOLD,
  BM25_MAX_QUERY_LEN,
  TOP_K,
};
