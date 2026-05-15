# Changelog

All notable changes to this marketplace and to `teamagent-memory` are recorded here.
This file follows the [Keep a Changelog](https://keepachangelog.com/) format;
versions follow [SemVer](https://semver.org/).

## [0.2.0] — 2026-05-15

The full M1–M5.a closed loop. Major rewrite from v0.1's JSONL store to SQLite
+ semantic matching + override classification + AGENTS.md compile.

### Added — M5.a (compile to AGENTS.md)
- `lib/compile.cjs` — render high-tier project rules into a managed block
  in `<repo>/AGENTS.md`. Tiers `canonical`/`canonical+`, wilson ≥ 0.65,
  cap 20 rules. BEGIN/END HTML-comment markers preserve all user-authored
  content above and below the block.
- Stop hook stage 4 — best-effort `compileFromDb` after extract+calibrate.
  Repo root resolved via `TEAMAGENT_REPO_ROOT` env or `process.cwd()`.
- New CLI: `teamagent compile [--repo PATH] [--dry-run]` for manual
  invocation and previewing the block.
- 13 new unit tests + 3 integration tests.

### Added — M4 (semantic exceptions + auto-classify + project precedence)
- `rule_exceptions.embedding BLOB` (schema v3, idempotent ALTER). CLI
  `classify b --condition "..."` auto-embeds the condition.
- `lib/match.ruleHasMatchingException` gains a third layer: cosine
  exception match with threshold **0.82** (tuned from the draft's 0.78
  after smoke caught e5-small's ~0.79–0.80 baseline for unrelated short
  queries; see ADR-0012 and `docs/notes/M4-smoke-2026-05-15.md`).
- `runMatch` now lazy-embeds via a thunk so fast-path-only matches don't
  load the embedding model.
- UserPromptSubmit `findUnhandledOverride` counts `override_prompt_injected`
  events and auto-classifies as (a) `rule-wrong` at ≥3 prompts. Emits both
  `override_classified {auto:true}` and `override_auto_classified`.
- PreToolUse and UserPromptSubmit load `knowledge.db` before `global.db`
  and skip global rules whose id collides — project always wins.
- 3 new integration tests covering all three M4 paths.

### Added — M1 (basic SQLite + 4-tier interception)
- Three SQLite stores: `<repo>/.teamagent/knowledge.db` (project),
  `~/.teamagent/global.db` (cross-project), `~/.teamagent/events.db` (audit).
- Stop hook 4-stage pipeline: **analyze** (signal-scored candidate moments) →
  **extract** (local `claude -p` headless call) → **calibrate** (Wilson lower
  bound + exponential decay) → **compile** (stub, M5).
- Five hooks wired: `SessionStart`, `UserPromptSubmit`, `PreToolUse`
  (Bash + Edit + Write — was Bash-only in v0.1), `PostToolUse`, `Stop`.
- Four-tier interception: **block / warn / suggest / passive** based on
  `score = sim × wilson_lower`.
- Wilson 95% CI lower bound + exponential decay (half-life 60 days).
- Tier transitions: experimental → canonical → canonical+ → archived.
- Regex ReDoS lint (length cap, static danger patterns, perf probe).
- New CLI: `list / inspect / events / mute / demote / promote / doctor /
  export / forget / gc / --version`.
- New skill: `rule-doctor`.
- 90 vitest tests (47 unit + 38 integration).

### Added — M2 (semantic matching)
- ONNX embedding via `@xenova/transformers` (`multilingual-e5-small`, 384-dim,
  L2-normalised, mean-pooled). Lazy model load; weights cached in
  `~/.cache/huggingface/`.
- Three-layer match: fast-path → semantic (cosine top-K, threshold 0.78) →
  BM25-lite (short-query fallback).
- LRU cache for query embeddings (size 64, per hook process).
- Embed-on-insert in Stop hook; backfill missing embeddings in SessionStart
  (max 50/session).
- Schema v2: ADD COLUMN `prior REAL` on `rules` (idempotent ALTER).
- **`effectiveWilson(rule)`** — `max(wilson_lower, prior)` until n≥5
  ([ADR-0011](docs/adr/0011-effective-wilson.md)). Fixes the M1 finding:
  fresh high-prior rules dipping to ~0.21 after first hit due to wide Wilson
  CI at n=1.
- 1000-rule benchmark: **P50=4ms, P95=12ms** (vs 200ms design target,
  ~16× headroom).
- 23 new tests; CLI surface unchanged.

### Added — M3 (override feedback loop)
- `lib/override.cjs`: Jaccard-similarity detection across the last 10 events
  of a session; if a prior `pretooluse_block` or `pretooluse_warn` references
  a similar-token command and the current `posttool_ok` succeeded, emit
  `override_detected`.
- UserPromptSubmit injects a 3-option reply prompt (a/b/c) on unhandled
  `override_detected` events.
- New CLI: `teamagent classify <event_id> <a|b|c> [--condition "..."]`.
  - `a` (rule-wrong) → `applyEvent(miss)` → wilson recompute → tier demotion.
  - `b` (context-specific) → write `rule_exceptions` row with the condition.
  - `c` (skip) → record decision, no rule change.
- `lib/match.cjs::applyExceptionFilter` — skip rules whose exception
  condition (literal or token substring) matches the current query.
- New skill: `mute-rule` (documents reply → CLI mapping).
- 13 new tests including 2 end-to-end override-flow integration tests.

### Changed
- **BREAKING:** Storage moves from `~/.teamagent/rules.jsonl` to SQLite three-
  store. No auto-migration ([ADR-0009](docs/adr/0009-no-migration.md));
  v0.1 users start clean in v0.2.
- All hooks now async (because of M2 embed); legacy synchronous match path
  preserved via `runMatchSync` for back-compat tests.
- Plugin metadata (`plugin.json`, `marketplace.json`) re-describe the v0.2
  architecture.

### Schema versions
- **v1** — `rules`, `rule_exceptions`, `scan_cursor`, `events` tables (M1).
- **v2** — ADD COLUMN `prior REAL` on `rules` (M2, idempotent).
- **v3** — ADD COLUMN `embedding BLOB` on `rule_exceptions` (M4, idempotent).

### Architecture Decision Records
- [ADR-0001](docs/adr/0001-embedding-model.md) e5-small default — exploration
- [ADR-0002](docs/adr/0002-semantic-threshold.md) θ_sem = 0.78 — exploration
- [ADR-0003](docs/adr/0003-block-tiers.md) block-tier thresholds — exploration
- [ADR-0004](docs/adr/0004-sqlite-vec.md) full-table → sqlite-vec at 500 rules — accepted
- [ADR-0005](docs/adr/0005-three-stores.md) project/global/events split — accepted
- [ADR-0006](docs/adr/0006-wilson-decay.md) Wilson z=1.96 + 60d half-life — exploration
- [ADR-0007](docs/adr/0007-fastpath-redos.md) regex ReDoS guard — accepted
- [ADR-0008](docs/adr/0008-claude-p-timeout.md) `claude -p` 30s timeout + fallback — accepted
- [ADR-0009](docs/adr/0009-no-migration.md) no v0.1 → v0.2 migration — accepted
- [ADR-0010](docs/adr/0010-override-classification.md) 3-way override classification — accepted
- [ADR-0011](docs/adr/0011-effective-wilson.md) effectiveWilson floor — accepted (M2)
- [ADR-0012](docs/adr/0012-m4-decisions.md) M4: semantic exceptions, auto-classify, project precedence — accepted
- [ADR-0013](docs/adr/0013-compile-agents-md.md) M5.a: compile to AGENTS.md — accepted

### Known limitations / Follow-ups
- AGENTS.md compile is project-scope only. Global rules continue to surface
  only via the UserPromptSubmit hook; if a future ADR adds `~/AGENTS.md`
  output, scope precedence will need its own decision.
- AGENTS.md managed block includes a `Generated <iso>` line — every Stop
  produces a one-line diff even when rule content is unchanged. Acceptable
  for v0.2; could be hidden behind `TEAMAGENT_COMPILE_STABLE=1` in the
  future.
- Vitest worker pool occasionally segfaults on shutdown (cosmetic, exit 0).
- Cold install in China requires `--registry=https://registry.npmmirror.com`
  for `@xenova/transformers` deps; see [INSTALL.md](INSTALL.md).

### Tests
- 147 passing (27 files) — M1: 90, M2: +23, M3: +13, M4: +5, M5.a: +16.

---

## [0.1.0] — 2026-05-14

Initial release.

### Added
- `teamagent-memory` plugin with 3 hooks (`PreToolUse`, `Stop`,
  `UserPromptSubmit`).
- JSONL rule store at `~/.teamagent/rules.jsonl`.
- Six regex patterns for correction extraction.
- Three skills: `capture-correction`, `explain-rule-hit`,
  `review-new-rules`.
- CLI: `list / events / inspect / clear / --version`.

### Limitations
- Only Bash matcher in PreToolUse.
- Substring / regex match only (no semantic).
- Confidence integer counter, only increments (no decay, no demerit).
- No tier system, no override feedback.
