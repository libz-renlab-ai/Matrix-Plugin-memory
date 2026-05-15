---
name: explain-rule-hit
description: Use when a PreToolUse hook blocks or asks with a TeamAgent rule citation. Reads the rule from SQLite, explains the tier/score, offers the corrected approach.
---

# explain-rule-hit (v0.2)

The PreToolUse hook in v0.2 produces four kinds of citation:

| permissionDecision | tier we usually saw |
|---|---|
| `deny` (block tier) | canonical+ rule, score ≥ 0.85 |
| `deny` (warn tier)  | canonical rule, 0.65 ≤ score < 0.85 |
| `ask` (suggest tier) | experimental rule, 0.45 ≤ score < 0.65 |
| (passive — no UI)   | low-confidence reminder, ≥ 0.25 score |

Use this skill to turn the machine-readable `permissionDecisionReason` into a
short explanation and a corrected follow-up.

## When to use

- PreToolUse just returned `deny` or `ask` citing a TeamAgent rule
- User asks "why was that blocked?" / "what's that ask about?"
- User asks "what's the right way to do this?"

## How to find the rule

1. Locate the rule id in the deny/ask reason — `rule-2026-05-13-moment-dayjs`.
2. Run `teamagent inspect <rule_id>` (or `node bin/teamagent.cjs inspect <id>` on Windows).
3. Output is JSON with full fields including `tier`, `wilson_lower`, `hits`, `misses`.

## How to explain (≤ 8 lines)

1. **What was blocked/asked.** Echo the assistant's attempted command.
2. **Tier + score.** "Rule fired with score 0.91 (canonical+, wilson 0.96, hits 24/0)."
3. **Why.** One sentence from `why`.
4. **Correct approach.** Quote `correct` verbatim.
5. **Escape hatch.**
   - For `block` (canonical+): "If wrong: `teamagent mute <id>` or `teamagent demote <id>`"
   - For `warn` (canonical): "If wrong: `teamagent demote <id>` (lowers tier)"
   - For `ask` (experimental): "Decide: proceed or `teamagent demote <id>`"

Never dump full JSON.

## How to suggest the fix

If rule says `Use dayjs` and the blocked command was `npm install moment`,
propose `npm install dayjs` as the corrected tool call.

If `correct` does not map to a single command, ask one clarifying question
before re-issuing the tool call.

## Override path (M1)

M3 will add interactive `(a) rule-wrong / (b) context-specific / (c) skip`
classification. For now:

- Manual override: `teamagent demote <id>` (misses+=1, recomputes Wilson, may
  demote tier)
- Permanent removal: `teamagent mute <id>` (archives)
- Hard delete: `teamagent forget --rule <id>`

This skill never edits the DB itself.

## Inputs / outputs

- Read-only on knowledge.db / global.db / events.db
- Produces: one short text reply + optionally a corrected tool call
