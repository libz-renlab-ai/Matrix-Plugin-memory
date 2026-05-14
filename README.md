```
  _____                      _                    _
 |_   _|__  __ _ _ __ ___   / \   __ _  ___ _ __ | |_
   | |/ _ \/ _` | '_ ` _ \ / _ \ / _` |/ _ \ '_ \| __|
   | |  __/ (_| | | | | | / ___ \ (_| |  __/ | | | |_
   |_|\___|\__,_|_| |_| |_/_/   \_\__, |\___|_| |_|\__|
                                  |___/
                       memory plugin: never repeat the same mistake twice
```

# teamagent-memory

Capture user corrections, store them as rule cards, then block the next
session before it repeats the mistake.

```
   session 1            stored             session 2
   ---------            ------             ---------
   Alice: npm install moment
   user:  "use dayjs instead"
       |
       v Stop hook
   stop-capture.cjs ---> rules.jsonl ---> PreToolUse hook
                                              |
                                              v
                                       Bob: npm install moment  -> BLOCKED
                                       reason: rule-...-moment-dayjs
```

## Why

Claude Code teams hit the same advice over and over: "no, don't use moment",
"use ripgrep not grep", "don't `kubectl apply -f -` on prod". Without
persistent memory, every new session starts blank. `teamagent-memory`
turns each correction into a structured rule that survives across
sessions and gates future tool calls.

## Demo flow (8 steps)

1. Alice asks Claude to `npm install moment`.
2. User corrects: "don't use moment, use dayjs".
3. On `Stop`, `stop-capture.cjs` extracts the correction.
4. A rule card is written to `~/.teamagent/rules.jsonl`:
   `{ trigger, wrong, correct, why, confidence }`.
5. Bob starts a new session and asks Claude to `npm install moment`.
6. `pretooluse-enforce.cjs` reads rules, matches the command, and emits
   `permissionDecision: "deny"` with the rule citation.
7. The proof console shows: "saved 1 repeat mistake, rule confidence +1".
8. CEO sees the evidence trail: transcript, rule card, hook event,
   before/after diff.

## Install

This plugin is bundled with the `teamagent-marketplace` marketplace at the
repo root. From a Claude Code session:

```
/plugin marketplace add /path/to/teamagent-marketplace
/plugin install teamagent-memory@teamagent-marketplace
```

For local dev, point Claude Code at this worktree directly with
`--plugin-dir` and the hooks load on next session start.

## File layout

```
plugins/teamagent-memory/
  .claude-plugin/plugin.json       plugin manifest
  skills/
    capture-correction/SKILL.md    extract correction -> rule card
    explain-rule-hit/SKILL.md      explain a PreToolUse deny
    review-new-rules/SKILL.md      list recently-captured rules
  hooks/
    hooks.json                     hook wiring
    pretooluse-enforce.cjs         block matching Bash commands
    stop-capture.cjs               write rule card on Stop
    userprompt-inject.cjs          inject rule reminders on prompt
  bin/teamagent                    CLI for list/events/inspect/clear
  README.md                        this file
```

## Hook contracts

- **PreToolUse** (matcher `Bash`): reads `tool_input.command`, scans
  `rules.jsonl`, on first regex/substring match emits a deny JSON to
  stdout. Logs `pretooluse_block` or `pretooluse_pass` to
  `events.jsonl`.
- **Stop**: reads `transcript_path`, scans the last 40 messages for
  correction patterns, writes deduped rule cards.
- **UserPromptSubmit**: scans the user prompt for rule keywords and
  injects an `additionalContext` reminder so the assistant proposes the
  correct tool call instead of the wrong one.

All three hooks read JSON from stdin, write JSON to stdout, and exit 0
even on bad input. The user's session is never broken by a hook error.

## Storage

- Rules: `~/.teamagent/rules.jsonl` (JSONL, one rule per line)
- Events: `~/.teamagent/events.jsonl` (audit trail of hook decisions)

Schema for one rule:

```json
{
  "id": "rule-2026-05-13-moment-dayjs",
  "trigger": {"tool": "Bash", "pattern": "npm install\\s+moment"},
  "wrong": "Adopting moment (per user correction)",
  "correct": "Use dayjs",
  "why": "Captured from user correction in transcript",
  "confidence": 1,
  "captured_at": "2026-05-13T00:00:00Z",
  "session_origin": null,
  "evidence": {"transcript_path": null, "hook_event_id": null}
}
```

## CLI

```
teamagent list                 list all rule cards
teamagent events [N]           tail N events (default 50)
teamagent inspect <rule_id>    pretty-print a single rule
teamagent clear --yes          truncate rules and events
teamagent --version            print plugin version
```

## Troubleshooting

- Hook not firing: check `claude --debug` output for hook discovery.
  `hooks.json` must use `${CLAUDE_PLUGIN_ROOT}` (not `$CLAUDE_PLUGIN_ROOT`)
  so the path is expanded by Claude Code's hook loader.
- All commands blocked: a rule pattern is probably too greedy. Inspect with
  `teamagent list` and edit `~/.teamagent/rules.jsonl` directly.
- No rules captured after correction: only the last 40 messages of the
  transcript are scanned; older corrections are ignored on purpose. Run
  the correction again on a fresh session, or write the card manually.
- `node --check`: every `.cjs` in `hooks/` must pass. Run from this
  directory: `for f in hooks/*.cjs; do node --check "$f"; done`.

## License

MIT. See the marketplace LICENSE at the repo root.
