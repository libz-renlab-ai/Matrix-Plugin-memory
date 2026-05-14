---
name: review-new-rules
description: Use when the user asks "what rules did we capture" or "review new rules". Lists recently-captured rule cards with trigger/wrong/correct/confidence/captured_at.
---

```
   user asks "what did we learn?"
              |
              v
   +----------------------+
   | read rules.jsonl     |
   +----------+-----------+
              |
              v
   +----------------------+
   | sort by captured_at  |   newest first
   +----------+-----------+
              |
              v
   +----------------------+
   | render compact table |   id / wrong / correct / conf / when
   +----------------------+
```

# review-new-rules

Show the user what TeamAgent has captured during recent sessions. This is the
"so what did we actually save?" view that the proof console links into.

## When to use

- "what rules did we capture"
- "review new rules"
- "show me the latest teamagent rules"
- "what did claude learn this week"

## How to read

1. Source of truth: `~/.teamagent/rules.jsonl`.
2. Prefer the CLI: `teamagent list`. If running inline, also accept the raw
   file directly.
3. Treat each line as an independent JSON object — never assume the file
   parses as a single JSON array.

## How to render

Render a compact table sorted by `captured_at` descending (newest first).
Columns:

- `id` — rule id, truncate to 40 chars
- `wrong` — the wrong pattern, one line
- `correct` — the recommended replacement, one line
- `confidence` — integer
- `captured_at` — ISO date (YYYY-MM-DD)

Example output:

```
rule-2026-05-13-moment-dayjs  | moment  | dayjs   | 2 | 2026-05-13
rule-2026-05-12-axios-fetch   | axios   | fetch   | 1 | 2026-05-12
```

If there are more than 20 rules, show the top 20 by recency and add a
"... N more" line at the bottom.

## Empty state

If `~/.teamagent/rules.jsonl` does not exist or is empty, reply with one
sentence: "No rules captured yet. The Stop hook will record corrections
the next time you tell Claude 'use X instead of Y'."

## What this skill does NOT do

- Does not modify or delete rules.
- Does not call any hook directly.
- Does not summarize across rules (no "themes" or "categories"); use the
  proof console plugin for that.

## Pairing

After listing rules, the assistant may suggest running:

- `teamagent events` to see hook events
- `/proof` (provided by `teamagent-proof-console`) to bundle evidence for
  the CEO summary
