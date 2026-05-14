---
name: capture-correction
description: Use when the user issues a correction or "no, use X instead" style guidance. Extracts trigger/wrong/correct/why and stores as a rule card in ~/.teamagent/rules.jsonl.
---

```
      user says "no, use X"
              |
              v
   +----------------------+
   |  extract correction  |    wrong / correct / why
   +----------+-----------+
              |
              v
   +----------------------+
   |  dedupe by pattern   |    case-insensitive on trigger.pattern
   +----------+-----------+
              |
              v
   +----------------------+
   |  write rule card     |    append JSON line to rules.jsonl
   +----------------------+
```

# capture-correction

Capture a single user correction as a TeamAgent rule card so that future
Claude Code sessions cannot quietly repeat the same mistake.

## When to use

Invoke this skill when the user message contains any of:

- "don't use X, use Y"
- "use Y instead of X"
- "not X, use Y"
- "X 不要，用 Y"
- "不要用 X，用 Y"
- "用 Y 替代 X"

The Stop hook (`stop-capture.cjs`) already runs these patterns automatically.
Invoke this skill manually when the user pastes a correction outside of a
code task, or asks the assistant to "remember this rule".

## What to write

Each rule card is one JSON object on one line in
`~/.teamagent/rules.jsonl`. Schema (per BRIEF.md):

```json
{
  "id": "rule-YYYY-MM-DD-<wrong-slug>-<correct-slug>",
  "trigger": {"tool": "Bash", "pattern": "<regex or substring>"},
  "wrong": "Adopting <wrong> (per user correction)",
  "correct": "Use <correct>",
  "why": "<one-sentence rationale>",
  "confidence": 1,
  "captured_at": "<ISO8601>",
  "session_origin": "<session_id or null>",
  "evidence": {
    "transcript_path": "<path or null>",
    "hook_event_id": "<id or null>",
    "source_text": "<<= 400 chars of the user message>"
  }
}
```

## Idempotency rules

1. Compare `trigger.pattern` case-insensitively against existing rules.
2. If a rule with the same pattern already exists, **do not append**. Instead
   read the file, bump `confidence += 1`, set `last_seen_at` to the current
   ISO timestamp, and rewrite the file.
3. Never duplicate a card on identical pattern, even if `wrong` / `correct`
   text wording differs slightly.

## Confidence increment

- New rule: `confidence: 1`.
- Same pattern observed again: increment by exactly 1.
- The `teamagent-proof-console` plugin counts these increments as
  "saved repeat mistakes".

## Pattern construction

If `wrong` is a simple npm-style package name (matches
`[a-z0-9._@/-]+`), build the pattern as:

```
npm install\s+<escaped-name>
```

Otherwise, escape regex metacharacters in the raw token and use that.
This keeps the trigger keyed on the bash command the assistant is most
likely to run next.

## What NOT to do

- Do not write rule cards for sarcastic or hypothetical corrections.
- Do not write rule cards that block an entire tool (e.g. all of `Bash`).
- Do not delete or rewrite existing rules from this skill — use
  `teamagent clear --yes` or edit `rules.jsonl` manually.
- Do not store secrets or credentials in `wrong` / `correct` / `why`.

## Where rules go

- Path: `~/.teamagent/rules.jsonl`
- Format: JSONL (one object per line)
- Created on first capture by `stop-capture.cjs` if missing
- Inspect via: `teamagent list` (CLI in `plugins/teamagent-memory/bin/`)
