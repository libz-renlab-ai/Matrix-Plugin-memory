```
  _____                      _                    _
 |_   _|__  __ _ _ __ ___   / \   __ _  ___ _ __ | |_
   | |/ _ \/ _` | '_ ` _ \ / _ \ / _` |/ _ \ '_ \| __|
   | |  __/ (_| | | | | | / ___ \ (_| |  __/ | | | |_
   |_|\___|\__,_|_| |_| |_/_/   \_\__, |\___|_| |_|\__|
                                  |___/
                       memory plugin: never repeat the same mistake twice
```

# teamagent-memory (v0.2)

Capture user corrections, store them as SQLite rule cards (LLM-extracted),
then block / warn / suggest / passively-remind the next session — driven by
a Wilson-confidence-aware four-tier interception.

```
   session 1                       stored                    session 2
   ---------                       ------                    ---------
   Alice: npm install moment
   user:  "use dayjs instead"
       |
       v Stop hook (4-stage)
   analyze -> claude -p extract -> calibrate -> compile
                                     |
                                     v
                            knowledge.db / global.db
                                     |
                                     v PreToolUse hook
                                                            Bob: npm install moment
                                                                  -> BLOCKED (canonical+, 0.93)
                                                                  reason: rule-...-moment-dayjs
```

## What's new in v0.2

- **SQLite three-store**:
  - `<repo>/.teamagent/knowledge.db` — project rules
  - `~/.teamagent/global.db` — cross-project rules
  - `~/.teamagent/events.db` — full audit log
- **Stop hook 4-stage pipeline**: analyze → extract (local `claude -p`) → calibrate (Wilson) → compile (stub).
- **Four-tier interception**: block / warn / suggest / passive — driven by `candidate_score = sim × wilson_lower_bound`.
- **Five hooks** wired: SessionStart (load + GC + decay), UserPromptSubmit, PreToolUse (Bash+Edit+Write), PostToolUse (record), Stop.
- **New CLI**: list / inspect / events / mute / demote / promote / doctor / export / forget / gc / --version.
- Full design: [`docs/DESIGN.md`](../../docs/DESIGN.md); decisions: [`docs/adr/`](../../docs/adr/).

## Upgrading from v0.1

v0.2 does **not** auto-migrate `~/.teamagent/rules.jsonl` (see [ADR-0009](../../docs/adr/0009-no-migration.md)).
SessionStart prints a one-line notice when it detects the old file. To preserve
old rules, dump JSONL by hand and re-issue corrections in v0.2.

## Install

```
/plugin marketplace add libz-renlab-ai/Matrix-Plugin-memory
/plugin install teamagent-memory@matrix-plugin-memory
```

For local dev: `--plugin-dir plugins/teamagent-memory`. After cloning the repo,
**you must run `npm install --omit=dev`** inside the plugin directory once so
better-sqlite3 prebuilt binaries are available to the hooks.

## File layout

```
plugins/teamagent-memory/
  .claude-plugin/plugin.json
  skills/
    capture-correction/SKILL.md    manual correction capture (v0.2 schema)
    explain-rule-hit/SKILL.md      explain four-tier deny/ask
    review-new-rules/SKILL.md      list rules from SQLite
    rule-doctor/SKILL.md           self-diagnostics
  hooks/
    hooks.json                     5-hook wiring
    sessionstart.cjs               GC + decay
    userprompt-inject.cjs          fast-path reminder
    pretooluse-enforce.cjs         4-tier (Bash|Edit|Write)
    posttool-record.cjs            event log (override detect = M3)
    stop-capture.cjs               4-stage pipeline
    lib/
      paths.cjs db.cjs schema.cjs rules.cjs events.cjs
      confidence.cjs redos.cjs match.cjs
      analyze.cjs extract.cjs log.cjs
  bin/
    teamagent                      bash wrapper
    teamagent.cjs                  Node-backed CLI
  test/                            vitest unit + integration
  README.md
```

## Storage paths

| Path | Content |
|---|---|
| `<repo>/.teamagent/knowledge.db` | Project rules (add to repo `.gitignore`) |
| `~/.teamagent/global.db` | Cross-project rules |
| `~/.teamagent/events.db` | Hook events + decisions |

All three are SQLite (WAL). Mode 0600 (set on first open where supported).

## Four tiers

| Tier | score range | UI |
|---|---|---|
| block | ≥ 0.85 | `deny` with rule citation |
| warn  | 0.65 – 0.85 | `deny` + retry hint |
| suggest | 0.45 – 0.65 | `ask` + alternative |
| passive | 0.25 – 0.45 | reminder via next UserPromptSubmit |
| pass    | < 0.25 | silent |

`score = sim × wilson_lower_bound`. Experimental rules (wilson ≈ 0.5) cap at
`suggest` until they accumulate hits.

## CLI

```
teamagent list [--tier T] [--scope project|global]
teamagent inspect <id>
teamagent events [N] [--rule R]
teamagent mute <id>            # archive
teamagent demote <id>          # misses += 1, recompute Wilson, maybe demote tier
teamagent promote <id>         # hits += 1
teamagent doctor               # 3-DB self-check
teamagent export [--rule id]   # JSON dump
teamagent forget --rule <id>   # physical delete
teamagent gc [--dry-run]       # archive stale experimentals
teamagent --version
```

On Windows PowerShell, prefer `node bin/teamagent.cjs ...` (bash shebang may not resolve).

## Troubleshooting

- **Hook not firing**: `claude --debug` to see hook discovery. `${CLAUDE_PLUGIN_ROOT}` (not `$`) in hooks.json.
- **better-sqlite3 not found**: `cd plugins/teamagent-memory && npm install --omit=dev`.
- **`teamagent doctor` reports ERROR**: schema mismatch or permissions — archive the affected DB file and let SessionStart recreate.
- **All commands blocked**: a rule's `match_regex` is too greedy. `teamagent demote <id>` or edit via SQLite directly.

## Testing

```
cd plugins/teamagent-memory
npm install
npm test          # vitest, 90 tests
```

## License

MIT. See the marketplace LICENSE at the repo root.
