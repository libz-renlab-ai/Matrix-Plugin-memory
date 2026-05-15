```
  __  __       _        _      ____  _             _
 |  \/  | __ _| |_ _ __(_)_  _|  _ \| |_   _  __ _(_)_ __
 | |\/| |/ _` | __| '__| \ \/ / |_) | | | | |/ _` | | '_ \
 | |  | | (_| | |_| |  | |>  <|  __/| | |_| | (_| | | | | |
 |_|  |_|\__,_|\__|_|  |_/_/\_\_|   |_|\__,_|\__, |_|_| |_|
                                             |___/
                  Matrix-Plugin-memory — TeamAgent marketplace
```

# Matrix-Plugin-memory

> Claude Code marketplace + a single working plugin (`teamagent-memory`) that
> captures user corrections into SQLite, blocks repeats via fast-path +
> semantic (e5-small) + BM25 matching, with effective-Wilson-confidence
> four-tier interception. Override classification differentiates "rule wrong"
> from "context-specific" — so good rules survive false alarms.

## What's here

| Path | Purpose |
|---|---|
| [`plugins/teamagent-memory/`](plugins/teamagent-memory/) | The plugin (v0.2.0) |
| [`docs/DESIGN.md`](docs/DESIGN.md) | Full design — 740 lines, M1-M5.a scope |
| [`docs/adr/`](docs/adr/) | 13 architecture decision records |
| [`docs/plans/`](docs/plans/) | M1 / M2 / M3 / M4 implementation plans (TDD task lists) |
| [`docs/notes/`](docs/notes/) | M1 / M2 / M3 / M4 / M5.a smoke results |
| [`CHANGELOG.md`](CHANGELOG.md) | Version history |
| [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) | Marketplace manifest |

## Install (Claude Code session)

```
/plugin marketplace add libz-renlab-ai/Matrix-Plugin-memory
/plugin install teamagent-memory@matrix-plugin-memory
```

For local development, see [`INSTALL.md`](INSTALL.md).

## What `teamagent-memory` does

```
   session 1                       stored                    session 2
   ---------                       ------                    ---------
   Alice: npm install moment
   user:  "use dayjs instead"
       |
       v Stop hook (4-stage)
   analyze → claude -p extract → calibrate → compile
                                     |
                                     v
                            knowledge.db / global.db
                                     |
                                     v PreToolUse hook
                                                            Bob: npm install moment
                                                                  → BLOCKED (canonical+, 0.93)
                                                                  reason: rule-...-moment-dayjs
```

Three layers of matching:
1. **Fast-path** (regex / literal) — 0ms, highest priority for code-pattern rules
2. **Semantic** (`multilingual-e5-small` ONNX) — for paraphrased natural-language matches
3. **BM25-lite** — fallback for very short queries

Four-tier interception based on `score = sim × effectiveWilson(rule)`:

| Tier | score | hook output |
|---|---|---|
| block | ≥ 0.85 | `deny` |
| warn | 0.65–0.85 | `deny` with retry hint |
| suggest | 0.45–0.65 | `ask` with alternative |
| passive | 0.25–0.45 | reminder on next prompt |

If a user bypasses a `deny`/`warn`, PostToolUse detects it; the next
UserPromptSubmit asks "rule wrong, context-specific, or skip?" and routes
to demote / save exception / no-op accordingly.

## Tested via 128 vitest tests + automated end-to-end smoke

```
Test Files  24 passed (24)
     Tests  128 passed (128)
Benchmark   1000 rules: p50=4ms p95=12ms (vs 200ms target)
```

## License

MIT. See [LICENSE](LICENSE).
