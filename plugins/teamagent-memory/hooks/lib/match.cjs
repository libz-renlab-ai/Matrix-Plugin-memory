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
  // Layer 1 — Fast-path (string / regex). Highest priority — 0ms.
  const l1 = runFastPath(query, rules, opts);
  if (l1.length > 0) return l1.map(h => ({ ...h, layer: 1 }));

  // Layer 2 — Semantic. Embed query and cosine top-K with threshold.
  let queryVec = _cacheGet(query);
  if (!queryVec) {
    try { queryVec = await embedText(query); _cacheSet(query, queryVec); }
    catch (_e) { queryVec = null; }
  }
  if (queryVec) {
    const l2 = ann.topK(queryVec, rules, TOP_K)
      .filter(h => h.sim >= (opts.threshold || SEMANTIC_THRESHOLD))
      .map(h => ({ ...h, via: "semantic", layer: 2 }));
    if (l2.length > 0) return l2;
  }

  // Layer 3 — BM25-lite, only for short queries where embedding is unreliable.
  if (query.length < BM25_MAX_QUERY_LEN) {
    const l3 = bm25.score(query, rules).map(h => ({ ...h, via: "bm25", layer: 3 }));
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
  FAST_PATH_BUDGET_MS,
  SEMANTIC_THRESHOLD,
  BM25_MAX_QUERY_LEN,
  TOP_K,
};
