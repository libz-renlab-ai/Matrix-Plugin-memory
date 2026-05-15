---
name: review-new-rules
description: Use when the user asks "what rules did we capture" or "show recent rules". Lists rules from SQLite sorted by Wilson lower bound, with tier and hits/misses.
---

# review-new-rules (v0.2)

Show the user what TeamAgent has captured. Source-of-truth changed from
JSONL to SQLite three-store.

## When to use

- "what rules did we capture"
- "review new rules"
- "show me the latest teamagent rules"
- "what did claude learn this week"

## How to read

1. Source of truth: `~/.teamagent/global.db` (cross-project) and
   `<repo>/.teamagent/knowledge.db` (project).
2. Prefer the CLI: `teamagent list` (auto-merges both DBs, sorted by
   `wilson_lower DESC`, archived hidden by default).
3. To filter by tier: `teamagent list --tier canonical+`.
4. To filter by scope: `teamagent list --scope global`.

## How to render

Sort by `wilson_lower DESC, captured_at DESC`. Columns:

- `id` (truncate 40)
- `tier` — experimental | canonical | canonical+ | archived (archived hidden by default)
- `wilson_lower` — 2 decimals
- `hits/misses`
- `wrong` — one line

Example:

```
rule-2026-05-13-moment-dayjs   canonical+  0.93   24/0  Adopting moment
rule-2026-05-12-axios-fetch    canonical   0.78   10/1  Adopting axios for fetch
rule-2026-05-15-foo-bar        experimental 0.50   0/0  Adopting foo
```

Show top 20 by score; "... N more" if longer.

## Empty state

If both DBs return no rows, reply: "No rules captured yet. The Stop hook
will record corrections the next time you tell Claude 'use X instead of Y'."

## What this skill does NOT do

- Does not modify, archive, demote, or delete rules
- Does not call any hook directly
- Does not summarize across rules (no themes/categories)

## Pairing

After listing rules:

- `teamagent events` — see recent hook events / decisions
- `teamagent inspect <id>` — full rule detail (JSON)
- `teamagent gc --dry-run` — preview what GC would archive
