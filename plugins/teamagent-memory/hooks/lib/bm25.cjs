"use strict";

// BM25-lite: tokenize query and rules, build IDF, score by IDF-weighted overlap.
// Used as Layer 3 (DESIGN §5.1) when fast-path AND semantic both miss for very
// short queries where embedding is unreliable.

const STOP = new Set([
  "the","a","an","and","or","of","to","in","on","at","for","with","by","is","are",
  "use","using","do","does","this","that","my","i","you","please","run","add","install",
]);

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9_@.\-\/]+/)
    .filter(t => t.length > 1 && !STOP.has(t));
}

function buildIdf(rules) {
  const dfs = new Map();
  const N = rules.length || 1;
  for (const r of rules) {
    const seen = new Set();
    for (const lit of (r.match_literals || [])) {
      for (const t of tokenize(lit)) seen.add(t);
    }
    for (const t of tokenize(r.embed_text)) seen.add(t);
    for (const t of seen) dfs.set(t, (dfs.get(t) || 0) + 1);
  }
  const idf = new Map();
  for (const [t, df] of dfs) idf.set(t, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
  return idf;
}

function score(query, rules, opts = {}) {
  const threshold = opts.threshold || 0.3;
  if (!query || rules.length === 0) return [];
  const queryToks = tokenize(query);
  if (queryToks.length === 0) return [];
  const idf = buildIdf(rules);

  const out = [];
  for (const r of rules) {
    const ruleToks = new Set();
    for (const lit of (r.match_literals || [])) for (const t of tokenize(lit)) ruleToks.add(t);
    for (const t of tokenize(r.embed_text)) ruleToks.add(t);

    let s = 0;
    let max = 0;
    for (const qt of queryToks) {
      const w = idf.get(qt) || 0;
      max += w;
      if (ruleToks.has(qt)) s += w;
    }
    const norm = max > 0 ? s / max : 0;
    if (norm >= threshold) out.push({ rule: r, sim: 0.5, raw: norm });
  }
  out.sort((a, b) => b.raw - a.raw);
  return out;
}

module.exports = { tokenize, score };
