# ADR-0013: M5.a — Compile high-tier project rules to AGENTS.md

- **状态**: accepted
- **日期**: 2026-05-15
- **影响**: 数据 / 用户可见输出 / 上下文注入
- **关联**: extends DESIGN §0.3 ("M5 stretch"), §1.3 (4-stage pipeline)

## Context

DESIGN §0.3 listed "编译规则反写 AGENTS.md" as an M5 stretch goal, and the
4-stage Stop pipeline (DESIGN §1.3) reserved a `compile` stage with a
stub. With M1–M4 closed loop landed (capture → match → calibrate →
classify), the natural next step is to let the rules surface to Claude
Code's built-in `AGENTS.md` context-loading: high-tier project rules
should ride along with the project's existing agent instructions instead
of only being injected via the UserPromptSubmit hook.

Two constraints shape the design:

1. Users author `AGENTS.md` by hand. We must not stomp their content.
2. The compile output is for human-and-agent reading, not for
   re-ingestion. This is a one-way write — we never read `AGENTS.md`
   back into knowledge.db.

## Decision

**Where:** `<repo>/AGENTS.md` only (project scope). Global rules do not
ship to `~/AGENTS.md` in M5.a — global rules are noisy enough that we'd
rather keep them in-process via the hooks.

**What ships:** Rules where `tier ∈ {canonical, canonical+}` AND
`wilson_lower ≥ 0.65`, sorted by tier (canonical+ first) then wilson
desc. Cap at **20 rules** to bound AGENTS.md growth.

**How the file is updated:** A managed block delimited by

```
<!-- BEGIN teamagent rules — do not edit by hand, managed by Stop hook -->
...
<!-- END teamagent rules -->
```

is spliced in place. If the file doesn't exist it's created with the
block only. If the markers don't exist, the block is appended with a
blank-line separator — never inserting anywhere user content is.

**When it runs:** Stage 4 of the Stop hook pipeline, after extract +
calibrate. Always best-effort — `try/catch` so a compile failure never
blocks Stop. Logged as `stop_compile` (or `stop_compile_error`) in
events.db.

**Manual invocation:** `teamagent compile [--repo PATH] [--dry-run]`.
`--dry-run` prints the would-be block to stdout without writing. Useful
for previewing in code review or in `teamagent doctor` follow-ups.

## Consequences

### Positive

- Project rules become visible to *every* Claude session, not just the
  one with the plugin installed. The block survives plugin removal —
  the user can decide to keep or strip it manually.
- AGENTS.md is already on Claude Code's built-in context path, so we
  pay zero extra runtime cost for the rules that ship there. The
  UserPromptSubmit hook continues to handle the lower-tier and
  semantic-only matches it always did.
- One-way write means the design is symmetric with how
  `compile_documentation_to_jsonl`-style flows usually go in build
  systems: source of truth is the DB, the rendered artifact is
  regenerated.

### Negative / Risks

- A user editing inside the managed block loses their changes on next
  Stop. Mitigated by the BEGIN/END markers explicitly saying "do not
  edit by hand" and the rendered block linking to the mute/exception
  CLI in its preamble.
- 20-rule cap is a guess; rules above the cap become invisible to
  AGENTS.md readers. If a user has >20 high-tier rules, the
  UserPromptSubmit hook still surfaces them — we trade visibility for
  predictability. A future ADR may revisit the cap with usage data.
- Determining "repo root" relies on `TEAMAGENT_REPO_ROOT` env or
  `process.cwd()` from the hook invocation. Claude Code normally runs
  hooks from the repo root, but a misconfigured launcher could write
  AGENTS.md into the wrong directory. The `--repo` flag on the CLI is
  the escape hatch.

## Migration

None — this is purely additive. Repos that don't have `AGENTS.md` get
one created at first Stop with high-tier rules; repos with existing
AGENTS.md get the managed block appended. No DB migration required.

## Test

- `test/unit/compile.test.cjs` — 13 tests covering `renderRule`,
  `pickRules`, `spliceBlock`, `writeAgentsMd`, `compileFromDb`.
- `test/integration/compile-flow.test.cjs` — 3 end-to-end tests:
  `teamagent compile` from CLI, content preservation on rewrite, Stop
  hook auto-compile via `TEAMAGENT_REPO_ROOT` + cwd.

## Open / Deferred

- Compile to global AGENTS.md (`~/AGENTS.md`) is intentionally not in
  M5.a. If we add it, scope precedence (project AGENTS.md beats global
  AGENTS.md) needs an explicit ADR.
- Optional `--filter <id>` flag for the CLI to write a subset (e.g.,
  for diffing). Skipped in M5.a as low value.
