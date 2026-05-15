# ADR-0012: M4 — semantic exceptions, 3-turn auto-classify, project precedence

- **状态**: accepted
- **日期**: 2026-05-15
- **影响**: confidence / 拦截 / 数据 / 互动
- **关联**: extends ADR-0005 (three-stores), ADR-0010 (override classification)

## Context

M3 shipped the override classification flow with three known gaps recorded
in its smoke note:

1. `rule_exceptions.condition` matching was literal substring + simple token
   substring only — paraphrased contexts (e.g. "in test code" vs
   "in __tests__/") leak through.
2. The 3-turn auto-classify timeout described in DESIGN §8.3 was not
   implemented — an unhandled `override_detected` would sit in events.db
   forever and re-prompt every UserPromptSubmit.
3. ADR-0005 split rules into `project` (knowledge.db) and `global`
   (global.db) but never explicitly resolved precedence on id collision.

## Decision

**Semantic exceptions:** Add `rule_exceptions.embedding BLOB` (schema v3,
idempotent ALTER). When `teamagent classify b --condition "..."` runs, the
CLI calls `embedText(condition)` and stores the resulting 384-dim vector
alongside the row. `lib/match.ruleHasMatchingException` adds a third
matching layer: cosine(queryVec, exception.embedding) ≥ **0.82** also
blocks the rule. The literal/token layers are unchanged — embedding is
additive, not replacing.

> **Threshold note:** The DESIGN draft listed `θ_sem = 0.78` for both L2
> rule matching and exception matching. M4 smoke caught that e5-small
> short-query cosine baselines around 0.79–0.80 for unrelated text, so
> 0.78 fired false positives in `override-flow.test.cjs`. The exception
> threshold was raised to **0.82**; the L2 rule-text threshold stays at
> 0.78 because `embed_text` is longer (wrong + correct + why) and more
> discriminative. Detailed empirical numbers in
> `docs/notes/M4-smoke-2026-05-15.md`.

**3-turn auto-classify:** UserPromptSubmit counts `override_prompt_injected`
events per rule_id since the corresponding `override_detected`. When
count ≥ 3 (and no `override_classified` between), the hook auto-classifies
as (a) `rule-wrong`: bumps `misses`, recomputes Wilson, may demote the
tier, and emits both an `override_classified` event (with
`auto: true`) and an `override_auto_classified` marker for audit.
Constant: `AUTO_CLASSIFY_AFTER = 3` in `hooks/userprompt-inject.cjs`.

**Project precedence:** PreToolUse and UserPromptSubmit now load
`knowledge.db` first, build a `seen` set of rule ids, then skip any
`global.db` rule whose id is in `seen`. Project copy wins. Practically
this only matters when a user manually replicates a rule across DBs (no
automated pathway creates that condition today), but the rule now exists.

## Consequences

### Positive

- Exceptions become much more robust against natural-language paraphrase
  (key reason M3 smoke flagged the literal-only limitation).
- Forgotten override prompts get cleared automatically, restoring zero-
  friction UX after 3 prompts.
- Conflict policy is decided and tested; future ADR-0005-related work has
  clear precedent.

### Negative / Risks

- Auto-classify could demote a rule that's actually correct if the user
  simply ignored the prompts (e.g. closed terminal). Mitigated by ≥3
  threshold (intentional friction) + `auto: true` event metadata so users
  can audit. The rule isn't deleted — just demerits by 1.
- Semantic exception matching means the embedding model needs to be loaded
  whenever an exception exists with embedding. Already loaded for L2 match,
  so additive cost is near-zero.

## Migration

DBs from M2 (schema v2) get the new column on next SessionStart via
idempotent ALTER. M3-vintage exceptions get `embedding=NULL` and continue
to match via literal/token only. New exceptions (M4+) get embeddings
automatically.

## Test

- `test/integration/override-flow.test.cjs` covers M3 path; the new path
  is exercised by the M4 smoke test (see `docs/notes/M4-smoke-...md`).
