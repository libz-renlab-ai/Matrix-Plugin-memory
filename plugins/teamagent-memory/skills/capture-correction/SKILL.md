---
name: capture-correction
description: Use when the user issues a correction or "no, use X instead" style guidance. In v0.2, the Stop hook auto-extracts via local `claude -p`; invoke this skill only for manual capture outside that flow.
---

# capture-correction (v0.2)

Capture a user correction as a TeamAgent rule card.

> **v0.2 change:** The Stop hook now uses local `claude -p` headless to extract
> structured rules from candidate moments (`hooks/stop-capture.cjs` → 4-stage
> pipeline: analyze → extract → calibrate → compile). The 6 regex patterns from
> v0.1 are gone. Invoke this skill **manually** when:
> - the user pastes a correction outside an active code task
> - the user explicitly asks to "remember this rule"
> - the Stop pipeline missed something obvious and the user wants it in now

## When to use (manual)

- "remember: don't use moment, use dayjs"
- "save this rule: never `kubectl apply -f -` on prod"
- "X 不要，用 Y"
- "用 Y 替代 X"

## What to write (v0.2 schema)

Rules live in `~/.teamagent/global.db` or `<repo>/.teamagent/knowledge.db`
(SQLite, not JSONL). One row per rule. Required columns:

```
id           rule-YYYY-MM-DD-<wrong-slug>-<correct-slug>
scope        'project' | 'global'
tier         'experimental'   ← always start here for manual capture
wrong        one-sentence wrong action
correct      one-sentence correct action
why          one-sentence rationale
match_regex  optional fast-path regex (lint via lib/redos before insert)
match_literals  optional JSON array of substrings
match_tools  JSON array; defaults to ["Bash"]; include "Edit"/"Write" if code-level
embed_text   "wrong. correct. why" (required, will be embedded in M2)
hits=0, misses=0, exceptions=0
wilson_lower  0.5 (or 0.55/0.6 if confidence_hint suggests higher prior)
captured_at  ISO 8601
session_origin  session id if available
source_text  ≤ 800 chars of the user's exact message
evidence_json  { transcript_path, turn_index } if available
```

Use `bin/teamagent.cjs` style helpers from `hooks/lib/rules.cjs` (`insertRule`)
rather than hand-crafting INSERTs.

## Idempotency

The Stop pipeline dedups by hash of `(transcript_path, turn_index)`. For
manual capture, dedupe by recomputed `id`:

```
rule-YYYY-MM-DD-<slug(wrong)>-<slug(correct)>
```

If `getRule(db, id)` returns a row, apply `applyEvent(rule, { kind: 'hit', at: now })`
and `updateRule` instead of inserting a duplicate.

## Confidence

- New manual rule: `wilson_lower = 0.5`, `tier = 'experimental'`
- Existing rule re-captured: bump via `applyEvent(... 'hit' ...)` — does the
  Wilson math and tier promotion correctly

## Match-pattern construction

For npm-style packages: `(npm|pnpm|yarn)\s+(install|add)\s+<name>`. Always lint
via `lib/redos.cjs::lintRegex` before storing — reject any regex flagged unsafe.

## What NOT to do

- Don't store credentials, emails, absolute paths in `source_text` (DESIGN §10)
- Don't write a rule with `match_regex` covering an entire tool (e.g. catch-all `.*`)
- Don't bypass `applyEvent` when bumping confidence — manual increments skew Wilson

## Inspect what you wrote

`teamagent list` or `teamagent inspect <id>`.
