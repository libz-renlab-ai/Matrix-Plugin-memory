# ADR-0011: effectiveWilson — floor wilson_lower at prior until n>=5

- **状态**: accepted
- **日期**: 2026-05-15
- **影响**: confidence / 拦截行为
- **关联**: supplements ADR-0006

## Context

M1 smoke note finding: a fresh rule inserted with prior `wilson_lower = 0.6`
(from `confidence_hint >= 0.9`) gets its first hit, and Wilson recompute over
`(hits=1, misses=0)` returns **~0.21** — lower than the prior.

Mathematically correct (Wilson 95% CI lower bound is wide for n=1), but
UX-counterintuitive: the rule loses confidence the moment we count its first
hit. To reach `canonical` (wilson ≥ 0.7), the rule then needs ~5 hits.

## Decision

Add `effectiveWilson(rule)`, used at match decision time (not stored):

```
effectiveWilson(rule):
  n = rule.hits + rule.misses
  wilson = rule.wilson_lower
  if n >= 5: return wilson
  return max(wilson, rule.prior or 0.5)
```

Persist `prior` as a new column on `rules` (schema v2). At insert time,
`prior` = the `wilson_lower` we chose (0.5 / 0.55 / 0.6 based on
`confidence_hint`). The stored `wilson_lower` continues to evolve via Wilson
math; `prior` is immutable after insert.

PreToolUse uses `effectiveWilson(rule)` instead of reading `wilson_lower`
directly. UserPromptSubmit unchanged (it just lists matched rules).

## Consequences

### Positive

- Fresh high-confidence rules don't suffer a UX dip on first hit
- Progress to `canonical` is monotonic for "always hit" rules
- Pure Wilson takes over once n >= 5 — statistical rigor preserved
- Stored `wilson_lower` remains the canonical statistic (no double-bookkeeping)

### Negative / Risks

- Adds one column (schema v2 ALTER TABLE)
- One more rule for engineers to remember when reading the match path
- If `confidence_hint` from LLM is wrong (false positive), the prior floor
  could keep an experimental rule firing higher than its actual evidence
  warrants for the first 5 calls. The 4-tier interception (DESIGN §7) still
  caps it at `suggest` band (≤0.65) until tier promotion at `n=5`.

## Migration

DBs created in M1 (schema v1) get the column via `ALTER TABLE rules ADD COLUMN prior REAL`
on first SessionStart of M2. New rows write `prior` directly via
`insertRule`. Old rows have `prior=NULL`; `effectiveWilson` falls back to
`PRIOR` constant (0.5). Re-evaluating old rules' prior is not attempted —
they will float at `wilson_lower` regardless of `prior`.
