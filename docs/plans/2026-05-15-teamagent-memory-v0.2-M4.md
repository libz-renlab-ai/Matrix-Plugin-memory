# teamagent-memory v0.2 — M4 Plan

**Goal:** Plug 3 known gaps from M2/M3 smoke notes + DESIGN:

1. **Semantic exception matching** — `rule_exceptions.condition` matched only by literal/token substring in M3. Add an `embedding` column and cosine match against the query.
2. **3-turn auto-classify timeout** — DESIGN §8.3 says unhandled overrides auto-classify as (a) `rule-wrong` after 3 turns to avoid pestering. Implement.
3. **Project / global scope conflict precedence** — When a rule with the same id (or matching trigger) exists in both `knowledge.db` (project) and `global.db`, project wins. ADR-0005 deferred this; close it.

**Out of scope:** M5 (compile to AGENTS.md) — separate plan.

---

## Tasks

### M4.01 Schema v3: rule_exceptions.embedding BLOB

Add column via idempotent ALTER. Update `applyKnowledgeSchema` to call V3. Bump test expectations.

### M4.02 lib/rules.cjs::addException accepts embedding

`addException(db, { parent_rule_id, condition, example, embedding })` — store BLOB if provided.

### M4.03 CLI classify b auto-embeds condition

When the user passes `--condition "..."`, the CLI calls `embedText(condition)` and stores the embedding alongside the row.

### M4.04 lib/match.cjs::ruleHasMatchingException — semantic layer

If exception has `embedding`, compute cosine with the cached query embedding (passed in opts/closure) and treat sim ≥ 0.78 as a match.

### M4.05 UserPromptSubmit auto-classify stale overrides

Count `override_prompt_injected` events for the same `rule_id` after the `override_detected` event. If count >= 3 and no `override_classified` between, classify as (a) `rule-wrong` automatically and log `override_auto_classified`.

### M4.06 PreToolUse / UserPromptSubmit project-wins precedence

When the same rule id appears in both DBs, the project-scope copy wins. (Practical impact: only triggered if a user manually replicates a rule across DBs; design defensible.)

### M4.07 ADR-0012

Document all three M4 decisions.

### M4.08 Integration test

End-to-end: insert rule + exception with embedding → query that doesn't match literally but matches semantically → no firing. Auto-classify after 3 prompts.

### M4.09 Smoke note + commit
