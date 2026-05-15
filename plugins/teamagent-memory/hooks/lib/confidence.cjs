"use strict";

const Z = 1.96;       // 95% CI
const PRIOR = 0.5;
const HALF_LIFE_DAYS = 60;

function wilsonLowerBound(hits, misses, z = Z) {
  const n = (hits | 0) + (misses | 0);
  if (n === 0) return PRIOR;
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p) / n) + z2 / (4 * n * n));
  return (center - half) / denom;
}

function decay(score, daysIdle, halfLife = HALF_LIFE_DAYS) {
  const d = Math.max(0, daysIdle);
  return score * Math.exp(-d / halfLife);
}

// ADR-0006 + DESIGN §4.3
function computeTier({ tier, hits, misses, wilson_lower }) {
  if (tier === "archived") return "archived";

  // demotion takes precedence
  if (tier === "canonical+" && misses >= 5) return "canonical";
  if (tier === "canonical" && misses >= 5) return "experimental";
  if (tier === "experimental" && misses >= 3) return "archived";

  // promotion
  if (tier === "experimental" && hits >= 5 && wilson_lower >= 0.7) return "canonical";
  if (tier === "canonical" && hits >= 20 && wilson_lower >= 0.85) return "canonical+";

  return tier;
}

function applyEvent(rule, evt) {
  let { hits, misses, exceptions, tier, wilson_lower, last_seen_at, last_demerit_at } = rule;
  let recompute = false;
  if (evt.kind === "hit") { hits += 1; last_seen_at = evt.at; recompute = true; }
  else if (evt.kind === "miss") { misses += 1; last_demerit_at = evt.at; recompute = true; }
  else if (evt.kind === "exception") { exceptions += 1; /* wilson unchanged per DESIGN §4.3 */ }
  else throw new Error(`applyEvent unknown kind: ${evt.kind}`);

  if (recompute) wilson_lower = wilsonLowerBound(hits, misses);
  const next = { ...rule, hits, misses, exceptions, wilson_lower, last_seen_at, last_demerit_at };
  next.tier = computeTier(next);
  return next;
}

module.exports = { wilsonLowerBound, decay, computeTier, applyEvent, Z, PRIOR, HALF_LIFE_DAYS };
