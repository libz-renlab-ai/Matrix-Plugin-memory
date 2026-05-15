---
name: mute-rule
description: Use when the user replies a/b/c to an override reply prompt from UserPromptSubmit, or directly asks to mute / demote / except a TeamAgent rule.
---

# mute-rule (v0.2 M3)

Process the user's reply to an override reply prompt, or handle direct mute requests.

## When to use

- Last assistant prompt contained `TeamAgent noticed you bypassed rule ...`
- User replies with "a", "b", or "c" (case-insensitive)
- Or user types `/mute-rule <id>`, `/exception <id> <condition>`, etc.

## How to process

1. Find the most recent unhandled `override_detected` event:
   `teamagent events 20` → look for the latest `override_detected` line.
   Parse the leading integer column to get `event_id`.
2. Parse the user reply:
   - "a" / "rule is wrong" / "demote" → `teamagent classify <event_id> a`
   - "b" / "exception" / context phrase → `teamagent classify <event_id> b --condition "..."`
   - "c" / "skip" → `teamagent classify <event_id> c`
3. For (b), if the user didn't include a clear condition phrase, ask one
   clarifying question: "What's the context that makes this OK?
   e.g., 'in test fixtures', 'on Node 16'". Then call classify b once you have it.
4. Echo back to the user the resulting state ("rule demoted to canonical",
   "exception saved: in test fixtures", etc.).

## What this skill does NOT do

- Does not edit the SQLite DB directly — always goes through `teamagent classify`
- Does not re-fire the original blocked command
- Does not skip the question for choice (b); exceptions need a clear context

## Examples

```
user> a
skill> $ teamagent classify 42 a
       → rule demoted to canonical (wilson 0.67)

user> this is in our test fixtures
skill> inferred (b). $ teamagent classify 42 b --condition "in test fixtures"
       → exception saved: "in test fixtures"

user> skip
skill> $ teamagent classify 42 c
       → classified as skip (no change to rule)
```
