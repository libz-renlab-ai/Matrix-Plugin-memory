---
name: explain-rule-hit
description: Use when a PreToolUse hook blocks an action with a TeamAgent rule citation. Reads the rule from ~/.teamagent/rules.jsonl, explains it to the user with rationale, and offers the corrected approach.
---

```
   PreToolUse deny
        |
        v
   +-------------+
   | rule_id     |---read--> ~/.teamagent/rules.jsonl
   +-------------+
        |
        v
   +-------------+
   | explain     |  wrong / correct / why / confidence
   +-------------+
        |
        v
   +-------------+
   | suggest fix |  corrected command for the assistant to try
   +-------------+
```

# explain-rule-hit

When the `pretooluse-enforce.cjs` hook denies a Bash command, it returns a
`permissionDecisionReason` that cites a rule id. Use this skill to turn that
machine-readable block into a human-readable explanation and a corrected
follow-up suggestion.

## When to use

- A PreToolUse hook just returned `permissionDecision: "deny"` with a
  TeamAgent rule citation in the reason.
- The user asks "why was that blocked?" / "explain the rule that fired".
- The user asks for the "right way to do this" after a block.

## How to find the rule

1. Locate the rule id in the deny reason. It looks like
   `rule-2026-05-13-moment-dayjs`.
2. Run `teamagent inspect <rule_id>` (CLI in
   `plugins/teamagent-memory/bin/teamagent`).
3. If `jq` is unavailable, fall back to
   `grep -F '"<rule_id>"' ~/.teamagent/rules.jsonl` and parse the JSON.

## How to explain

Produce a short message with these four sections:

1. **What was blocked.** Echo the assistant's attempted command.
2. **Why.** One sentence from `why`, optionally the rationale from
   `evidence.source_text`.
3. **Correct approach.** Quote `correct` verbatim.
4. **Confidence.** Mention the confidence count and `captured_at` so the
   user can decide whether to override.

Keep the explanation to under 8 lines. Do not repaint a wall of JSON.

## How to suggest the fix

If the rule says `Use dayjs` and the blocked command was
`npm install moment`, propose:

```
npm install dayjs
```

If the rule's `correct` does not map cleanly to a single command, ask the
user one clarifying question before issuing a new tool call.

## Override path

If the user explicitly says "ignore the rule" or "force install moment",
do not silently retry. Tell them they can:

- Run the command manually outside Claude Code, or
- Delete or downgrade the rule with `teamagent` then re-run, or
- Lower the rule's confidence (manual edit of `rules.jsonl`).

This skill never edits `rules.jsonl` itself.

## Inputs / outputs

- Read-only on `~/.teamagent/rules.jsonl`.
- Side effects: none.
- Produces: a single text reply to the user, optionally followed by a
  corrected tool call.
