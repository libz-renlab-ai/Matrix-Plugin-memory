"use strict";

const { unpackEmbedding, cosine } = require("./embed.cjs");

// rules: array of { id, embedding (Buffer), ... }
// queryVec: Float32Array
// Returns top-K [{ rule, sim }] sorted desc by sim. Full-table scan (M2);
// migrate to sqlite-vec when rule count > 500 per ADR-0004.
function topK(queryVec, rules, k = 5) {
  if (!queryVec || !rules || rules.length === 0) return [];
  const scored = [];
  for (const r of rules) {
    if (!r.embedding) continue;
    const v = unpackEmbedding(r.embedding);
    if (!v || v.length !== queryVec.length) continue;
    scored.push({ rule: r, sim: cosine(queryVec, v) });
  }
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, k);
}

module.exports = { topK };
