---
name: rule-doctor
description: Use when the user reports broken hooks, missing rules, or "teamagent feels off". Runs `teamagent doctor` and interprets the output.
---

# rule-doctor

Diagnose the teamagent-memory installation.

## When to use

- User says "teamagent is broken" / "rules don't trigger" / "hook errors"
- After a fresh install before relying on it
- After upgrading Claude Code or moving repos

## How to run

1. Invoke `bin/teamagent doctor` (or `teamagent doctor` if on PATH; on Windows
   PowerShell, use `node plugins/teamagent-memory/bin/teamagent.cjs doctor`).
2. For each of the three rows (`knowledge`, `global`, `events`), confirm `schema=1`
   and `ok`.
3. If any row says `ERROR`, surface the error verbatim and suggest:
   - file permission issues → `chmod 600 ~/.teamagent/*.db` (or NTFS ACL on Windows)
   - schema mismatch → archive the DB and let SessionStart recreate
   - missing parent dir → manually `mkdir -p ~/.teamagent`

## What this skill does NOT do

- Does not modify any rule
- Does not call `teamagent clear` / `forget`
- Does not access events directly — prefer `teamagent events`
