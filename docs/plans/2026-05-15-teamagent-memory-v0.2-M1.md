# teamagent-memory v0.2 — M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace v0.1 JSONL + regex with SQLite (three stores) + Stop-hook 4-stage pipeline (analyze → claude -p extract → Wilson calibrate) + four-tier interception driven by fast-path matching. Semantic matching (M2) and override classification (M3) come later.

**Architecture:** New `hooks/lib/` houses pure JS modules (db, schema, rules, events, confidence, match, analyze, extract, redos, paths). Five hook entrypoints (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop) are thin shells delegating to `lib/`. `better-sqlite3` (vendored prebuilt) for SQLite. `vitest` for tests. Stop hook calls local `claude -p` for extraction; PreToolUse uses fast-path only — no embedding in M1.

**Tech Stack:** Node 20+ (`.cjs`), `better-sqlite3` ^11, `vitest` ^1, child_process for `claude -p`, no other runtime deps.

**Reference docs:**
- Spec: [`docs/DESIGN.md`](../DESIGN.md)
- ADRs: [`docs/adr/`](../adr/)

---

## Scope

**In M1:**
- SQLite schema v1 across three DBs
- `lib/` modules: db, schema, paths, rules, events, confidence, redos, match, analyze, extract, log
- Five hooks rewritten / created
- Stop pipeline stages: analyze + extract + calibrate (compile is a stub)
- Four-tier interception logic (block/warn/suggest/passive) using **only fast-path** (`match_regex` + `match_literals`); semantic layer absent
- `teamagent` CLI subcommands: list, inspect, events, mute, demote, promote, doctor, export, forget, gc, --version
- Unit + integration test suite via vitest, fixture transcripts in `test/fixtures/`
- README + plugin.json bump to `0.2.0-alpha.1`
- Skills updated: capture-correction, explain-rule-hit, review-new-rules; new rule-doctor

**Out of scope (deferred):**
- ONNX embedding, sqlite-vec, semantic Layer 2, BM25-lite Layer 3 → M2 plan
- PostToolUse override detection (M1 hook is record-only) → M3 plan
- `rule_exceptions` write path (schema added, no producer) → M3 plan
- `compile` stage (Stop pipeline stops after calibrate) → M5 plan
- JSONL v0.1 migration (ADR-0009 — clean start)

---

## File Structure

### New files

```
plugins/teamagent-memory/
  package.json                          NEW — vitest + better-sqlite3
  .gitignore                            NEW — node_modules artifacts, test outputs
  hooks/
    sessionstart.cjs                    NEW — load + GC
    posttool-record.cjs                 NEW — event log only (M1)
    lib/
      paths.cjs                         NEW — path constants
      db.cjs                            NEW — openDb + migrate
      schema.cjs                        NEW — DDL + migration v1
      rules.cjs                         NEW — rule CRUD
      events.cjs                        NEW — event log
      confidence.cjs                    NEW — Wilson + decay + tier
      redos.cjs                         NEW — regex lint
      match.cjs                         NEW — fast-path only (M1)
      analyze.cjs                       NEW — candidate moment scoring
      extract.cjs                       NEW — claude -p invocation
      log.cjs                           NEW — event helper used by all hooks
  skills/
    rule-doctor/SKILL.md                NEW
  test/
    unit/                               NEW
    integration/                        NEW
    fixtures/transcripts/               NEW — *.jsonl fixtures
    fixtures/expected/                  NEW — expected outputs
```

### Modified files

```
plugins/teamagent-memory/
  .claude-plugin/plugin.json            bump to 0.2.0-alpha.1
  hooks/hooks.json                      add SessionStart, PostToolUse; widen PreToolUse matchers
  hooks/userprompt-inject.cjs           rewrite using lib/ (fast-path only)
  hooks/pretooluse-enforce.cjs          rewrite — four-tier, fast-path only
  hooks/stop-capture.cjs                rewrite — 4-stage pipeline
  bin/teamagent                         rewrite — v0.2 subcommands
  skills/capture-correction/SKILL.md    update — extract is now LLM-driven
  skills/explain-rule-hit/SKILL.md      update — four-tier explanation
  skills/review-new-rules/SKILL.md      update — show tier + wilson_lower
  README.md                             update for v0.2
```

---

## Task 1: Bootstrap test infrastructure

**Files:**
- Create: `plugins/teamagent-memory/package.json`
- Create: `plugins/teamagent-memory/.gitignore`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "teamagent-memory",
  "private": true,
  "version": "0.2.0-alpha.1",
  "type": "commonjs",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "lint:hooks": "for f in hooks/*.cjs hooks/lib/*.cjs; do node --check \"$f\"; done"
  },
  "devDependencies": {
    "vitest": "^1.6.0"
  },
  "dependencies": {
    "better-sqlite3": "^11.7.0"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Write .gitignore**

```
node_modules/
test-output/
*.log
.teamagent-test/
```

- [ ] **Step 3: Install dependencies**

Run: `cd plugins/teamagent-memory && npm install`
Expected: `added N packages`. better-sqlite3 prebuilt binary downloads automatically for win32-x64/linux-x64/darwin.

- [ ] **Step 4: Verify vitest runs (no tests yet)**

Run: `cd plugins/teamagent-memory && npx vitest run`
Expected: `No test files found, exiting with code 1` or similar — that's fine, infrastructure works.

- [ ] **Step 5: Commit**

```bash
git add plugins/teamagent-memory/package.json plugins/teamagent-memory/.gitignore plugins/teamagent-memory/package-lock.json
git commit -m "M1.01 bootstrap vitest + better-sqlite3"
```

> **Note:** Do NOT commit `node_modules/`. Plugin distribution will bundle prebuilt binaries via npm install in a release step (not in M1).

---

## Task 2: lib/paths.cjs — path constants

**Files:**
- Create: `plugins/teamagent-memory/hooks/lib/paths.cjs`
- Test: `plugins/teamagent-memory/test/unit/paths.test.cjs`

- [ ] **Step 1: Write failing test**

```javascript
// test/unit/paths.test.cjs
const path = require("path");
const os = require("os");
const { describe, it, expect } = require("vitest");
const { resolveProjectDbPath, resolveGlobalDbPath, resolveEventsDbPath, resolveModelsDir } = require("../../hooks/lib/paths.cjs");

describe("paths", () => {
  it("resolveGlobalDbPath returns ~/.teamagent/global.db", () => {
    expect(resolveGlobalDbPath()).toBe(path.join(os.homedir(), ".teamagent", "global.db"));
  });

  it("resolveEventsDbPath returns ~/.teamagent/events.db", () => {
    expect(resolveEventsDbPath()).toBe(path.join(os.homedir(), ".teamagent", "events.db"));
  });

  it("resolveModelsDir returns ~/.teamagent/models", () => {
    expect(resolveModelsDir()).toBe(path.join(os.homedir(), ".teamagent", "models"));
  });

  it("resolveProjectDbPath uses CWD by default", () => {
    expect(resolveProjectDbPath()).toBe(path.join(process.cwd(), ".teamagent", "knowledge.db"));
  });

  it("resolveProjectDbPath accepts explicit repo root", () => {
    expect(resolveProjectDbPath("/some/repo")).toBe(path.join("/some/repo", ".teamagent", "knowledge.db"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/teamagent-memory && npx vitest run test/unit/paths.test.cjs`
Expected: 5 failures: "Cannot find module ../../hooks/lib/paths.cjs"

- [ ] **Step 3: Write implementation**

```javascript
// hooks/lib/paths.cjs
"use strict";

const path = require("path");
const os = require("os");

const HOME = process.env.HOME || os.homedir();
const TEAMAGENT_HOME = path.join(HOME, ".teamagent");

function resolveProjectDbPath(repoRoot) {
  const root = repoRoot || process.cwd();
  return path.join(root, ".teamagent", "knowledge.db");
}
function resolveGlobalDbPath() { return path.join(TEAMAGENT_HOME, "global.db"); }
function resolveEventsDbPath() { return path.join(TEAMAGENT_HOME, "events.db"); }
function resolveModelsDir() { return path.join(TEAMAGENT_HOME, "models"); }
function resolveTeamagentHome() { return TEAMAGENT_HOME; }

module.exports = {
  resolveProjectDbPath,
  resolveGlobalDbPath,
  resolveEventsDbPath,
  resolveModelsDir,
  resolveTeamagentHome,
};
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `npx vitest run test/unit/paths.test.cjs`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/paths.cjs test/unit/paths.test.cjs
git commit -m "M1.02 lib/paths constants for three DBs + models dir"
```

---

## Task 3: lib/schema.cjs — DDL + migration v1 for knowledge/global DB

**Files:**
- Create: `plugins/teamagent-memory/hooks/lib/schema.cjs`
- Test: `plugins/teamagent-memory/test/unit/schema.test.cjs`

- [ ] **Step 1: Write failing test**

```javascript
// test/unit/schema.test.cjs
const { describe, it, expect, beforeEach } = require("vitest");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const { applyKnowledgeSchemaV1, applyEventsSchemaV1, getSchemaVersion } = require("../../hooks/lib/schema.cjs");

function tmpDbPath() {
  const p = path.join(os.tmpdir(), `teamagent-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return p;
}

describe("schema knowledge v1", () => {
  let p, db;
  beforeEach(() => { p = tmpDbPath(); db = new Database(p); });

  it("creates rules table with expected columns", () => {
    applyKnowledgeSchemaV1(db);
    const cols = db.prepare("PRAGMA table_info(rules)").all().map(r => r.name);
    expect(cols).toEqual(expect.arrayContaining([
      "id","scope","tier","wrong","correct","why",
      "match_regex","match_literals","match_tools","match_scope_globs",
      "embedding","embed_model","embed_text",
      "hits","misses","exceptions","wilson_lower",
      "last_seen_at","last_demerit_at",
      "captured_at","session_origin","source_text","evidence_json",
    ]));
  });

  it("creates rule_exceptions table", () => {
    applyKnowledgeSchemaV1(db);
    const cols = db.prepare("PRAGMA table_info(rule_exceptions)").all().map(r => r.name);
    expect(cols).toEqual(expect.arrayContaining(["id","parent_rule_id","condition","example","captured_at"]));
  });

  it("creates scan_cursor table", () => {
    applyKnowledgeSchemaV1(db);
    const cols = db.prepare("PRAGMA table_info(scan_cursor)").all().map(r => r.name);
    expect(cols).toEqual(expect.arrayContaining(["transcript_path","last_turn_index","updated_at"]));
  });

  it("records schema_version=1", () => {
    applyKnowledgeSchemaV1(db);
    expect(getSchemaVersion(db)).toBe(1);
  });

  it("is idempotent — running twice does not throw", () => {
    applyKnowledgeSchemaV1(db);
    expect(() => applyKnowledgeSchemaV1(db)).not.toThrow();
    expect(getSchemaVersion(db)).toBe(1);
  });
});

describe("schema events v1", () => {
  it("creates events table with expected columns", () => {
    const p = tmpDbPath(); const db = new Database(p);
    applyEventsSchemaV1(db);
    const cols = db.prepare("PRAGMA table_info(events)").all().map(r => r.name);
    expect(cols).toEqual(expect.arrayContaining([
      "id","ts","kind","session_id","rule_id","hook_name","tool_name","decision","score","payload_json",
    ]));
    expect(getSchemaVersion(db)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL** (module not found)

Run: `npx vitest run test/unit/schema.test.cjs`

- [ ] **Step 3: Write implementation**

```javascript
// hooks/lib/schema.cjs
"use strict";

const KNOWLEDGE_DDL_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id              TEXT PRIMARY KEY,
  scope           TEXT NOT NULL,
  tier            TEXT NOT NULL,
  wrong           TEXT NOT NULL,
  correct         TEXT NOT NULL,
  why             TEXT NOT NULL,
  match_regex     TEXT,
  match_literals  TEXT,
  match_tools     TEXT NOT NULL,
  match_scope_globs TEXT,
  embedding       BLOB,
  embed_model     TEXT,
  embed_text      TEXT NOT NULL,
  hits            INTEGER NOT NULL DEFAULT 0,
  misses          INTEGER NOT NULL DEFAULT 0,
  exceptions      INTEGER NOT NULL DEFAULT 0,
  wilson_lower    REAL NOT NULL DEFAULT 0.5,
  last_seen_at    TEXT,
  last_demerit_at TEXT,
  captured_at     TEXT NOT NULL,
  session_origin  TEXT,
  source_text     TEXT,
  evidence_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_rules_tier_score ON rules(tier, wilson_lower DESC);
CREATE INDEX IF NOT EXISTS idx_rules_last_seen ON rules(last_seen_at);

CREATE TABLE IF NOT EXISTS rule_exceptions (
  id              TEXT PRIMARY KEY,
  parent_rule_id  TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  condition       TEXT NOT NULL,
  example         TEXT,
  captured_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exc_parent ON rule_exceptions(parent_rule_id);

CREATE TABLE IF NOT EXISTS scan_cursor (
  transcript_path TEXT PRIMARY KEY,
  last_turn_index INTEGER NOT NULL,
  updated_at      TEXT NOT NULL
);
`;

const EVENTS_DDL_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  kind          TEXT NOT NULL,
  session_id    TEXT,
  rule_id       TEXT,
  hook_name     TEXT,
  tool_name     TEXT,
  decision      TEXT,
  score         REAL,
  payload_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_rule ON events(rule_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
`;

function nowIso() { return new Date().toISOString(); }

function applyKnowledgeSchemaV1(db) {
  db.exec(KNOWLEDGE_DDL_V1);
  const v = getSchemaVersion(db);
  if (v < 1) db.prepare("INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (1, ?)").run(nowIso());
}

function applyEventsSchemaV1(db) {
  db.exec(EVENTS_DDL_V1);
  const v = getSchemaVersion(db);
  if (v < 1) db.prepare("INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (1, ?)").run(nowIso());
}

function getSchemaVersion(db) {
  try {
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get();
    return row && row.v ? row.v : 0;
  } catch (_e) {
    return 0;
  }
}

module.exports = { applyKnowledgeSchemaV1, applyEventsSchemaV1, getSchemaVersion };
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `npx vitest run test/unit/schema.test.cjs`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/schema.cjs test/unit/schema.test.cjs
git commit -m "M1.03 schema v1 DDL for knowledge + events DB"
```

---

## Task 4: lib/db.cjs — openDb with auto-migrate

**Files:**
- Create: `plugins/teamagent-memory/hooks/lib/db.cjs`
- Test: `plugins/teamagent-memory/test/unit/db.test.cjs`

- [ ] **Step 1: Write failing test**

```javascript
// test/unit/db.test.cjs
const { describe, it, expect } = require("vitest");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { openKnowledgeDb, openEventsDb, closeDb } = require("../../hooks/lib/db.cjs");
const { getSchemaVersion } = require("../../hooks/lib/schema.cjs");

function tmpDir() {
  const p = path.join(os.tmpdir(), `teamagent-db-test-${process.pid}-${Date.now()}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

describe("openKnowledgeDb", () => {
  it("creates file and applies schema v1", () => {
    const dir = tmpDir();
    const p = path.join(dir, "k.db");
    const db = openKnowledgeDb(p);
    expect(fs.existsSync(p)).toBe(true);
    expect(getSchemaVersion(db)).toBe(1);
    closeDb(db);
  });

  it("opens existing file without re-applying schema", () => {
    const dir = tmpDir();
    const p = path.join(dir, "k.db");
    openKnowledgeDb(p); // create
    const db = openKnowledgeDb(p); // reopen
    expect(getSchemaVersion(db)).toBe(1);
    closeDb(db);
  });

  it("creates parent dir if missing", () => {
    const dir = tmpDir();
    const p = path.join(dir, "nested", "k.db");
    const db = openKnowledgeDb(p);
    expect(fs.existsSync(p)).toBe(true);
    closeDb(db);
  });
});

describe("openEventsDb", () => {
  it("applies events schema", () => {
    const dir = tmpDir();
    const p = path.join(dir, "e.db");
    const db = openEventsDb(p);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
    expect(tables).toContain("events");
    closeDb(db);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL** (module not found)

- [ ] **Step 3: Write implementation**

```javascript
// hooks/lib/db.cjs
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { applyKnowledgeSchemaV1, applyEventsSchemaV1 } = require("./schema.cjs");

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function openKnowledgeDb(filePath) {
  ensureParentDir(filePath);
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  applyKnowledgeSchemaV1(db);
  return db;
}

function openEventsDb(filePath) {
  ensureParentDir(filePath);
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  applyEventsSchemaV1(db);
  return db;
}

function closeDb(db) {
  try { db.close(); } catch (_e) { /* ignore */ }
}

module.exports = { openKnowledgeDb, openEventsDb, closeDb };
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `npx vitest run test/unit/db.test.cjs`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/db.cjs test/unit/db.test.cjs
git commit -m "M1.04 db.cjs — openDb with WAL + auto-migrate"
```

---

## Task 5: lib/events.cjs — writeEvent helper

**Files:**
- Create: `plugins/teamagent-memory/hooks/lib/events.cjs`
- Test: `plugins/teamagent-memory/test/unit/events.test.cjs`

- [ ] **Step 1: Write failing test**

```javascript
// test/unit/events.test.cjs
const { describe, it, expect } = require("vitest");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { openEventsDb, closeDb } = require("../../hooks/lib/db.cjs");
const { writeEvent, readEvents } = require("../../hooks/lib/events.cjs");

function tmpEventsDb() {
  const p = path.join(os.tmpdir(), `tev-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return openEventsDb(p);
}

describe("writeEvent / readEvents", () => {
  it("inserts and reads back", () => {
    const db = tmpEventsDb();
    writeEvent(db, {
      kind: "pretooluse_pass",
      session_id: "s1",
      hook_name: "PreToolUse",
      tool_name: "Bash",
      decision: "pass",
    });
    const rows = readEvents(db, { limit: 10 });
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("pretooluse_pass");
    expect(rows[0].tool_name).toBe("Bash");
    expect(rows[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    closeDb(db);
  });

  it("serializes payload_json", () => {
    const db = tmpEventsDb();
    writeEvent(db, { kind: "stop_extract", payload: { dedup_hash: "abc", attempts: 1 } });
    const row = readEvents(db, { limit: 1 })[0];
    expect(JSON.parse(row.payload_json)).toEqual({ dedup_hash: "abc", attempts: 1 });
    closeDb(db);
  });

  it("readEvents filters by rule_id", () => {
    const db = tmpEventsDb();
    writeEvent(db, { kind: "pretooluse_block", rule_id: "r-1" });
    writeEvent(db, { kind: "pretooluse_pass" });
    writeEvent(db, { kind: "pretooluse_block", rule_id: "r-1" });
    const filtered = readEvents(db, { rule_id: "r-1" });
    expect(filtered.length).toBe(2);
    closeDb(db);
  });

  it("does not throw when db is read-only locked (best-effort write)", () => {
    const db = tmpEventsDb();
    // Just make sure writeEvent does not crash on a normal db; locked scenario tested elsewhere
    expect(() => writeEvent(db, { kind: "test_kind" })).not.toThrow();
    closeDb(db);
  });
});
```

- [ ] **Step 2: Verify FAIL**

Run: `npx vitest run test/unit/events.test.cjs`

- [ ] **Step 3: Write implementation**

```javascript
// hooks/lib/events.cjs
"use strict";

function nowIso() { return new Date().toISOString(); }

function writeEvent(db, evt) {
  const stmt = db.prepare(`
    INSERT INTO events (ts, kind, session_id, rule_id, hook_name, tool_name, decision, score, payload_json)
    VALUES (@ts, @kind, @session_id, @rule_id, @hook_name, @tool_name, @decision, @score, @payload_json)
  `);
  try {
    stmt.run({
      ts: evt.ts || nowIso(),
      kind: evt.kind,
      session_id: evt.session_id || null,
      rule_id: evt.rule_id || null,
      hook_name: evt.hook_name || null,
      tool_name: evt.tool_name || null,
      decision: evt.decision || null,
      score: typeof evt.score === "number" ? evt.score : null,
      payload_json: evt.payload != null ? JSON.stringify(evt.payload) : null,
    });
  } catch (_e) {
    // best-effort: never break a hook over telemetry
  }
}

function readEvents(db, { limit = 50, kind = null, rule_id = null, session_id = null } = {}) {
  let where = [];
  const args = {};
  if (kind) { where.push("kind = @kind"); args.kind = kind; }
  if (rule_id) { where.push("rule_id = @rule_id"); args.rule_id = rule_id; }
  if (session_id) { where.push("session_id = @session_id"); args.session_id = session_id; }
  const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT @limit`;
  args.limit = limit;
  return db.prepare(sql).all(args);
}

module.exports = { writeEvent, readEvents };
```

- [ ] **Step 4: PASS**

Run: `npx vitest run test/unit/events.test.cjs`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/events.cjs test/unit/events.test.cjs
git commit -m "M1.05 lib/events — writeEvent + readEvents, swallow errors"
```

---

## Task 6: lib/rules.cjs — rule CRUD

**Files:**
- Create: `plugins/teamagent-memory/hooks/lib/rules.cjs`
- Test: `plugins/teamagent-memory/test/unit/rules.test.cjs`

- [ ] **Step 1: Write failing test**

```javascript
// test/unit/rules.test.cjs
const { describe, it, expect } = require("vitest");
const path = require("path");
const os = require("os");
const { openKnowledgeDb, closeDb } = require("../../hooks/lib/db.cjs");
const { insertRule, getRule, listRules, updateRule, archiveRule } = require("../../hooks/lib/rules.cjs");

function tmpKnowDb() {
  const p = path.join(os.tmpdir(), `trk-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return openKnowledgeDb(p);
}

const sampleRule = {
  id: "rule-2026-05-15-moment-dayjs",
  scope: "global",
  tier: "experimental",
  wrong: "Adopting moment (per user correction)",
  correct: "Use dayjs",
  why: "moment is in maintenance mode",
  match_regex: "(npm|pnpm|yarn)\\s+(install|add)\\s+moment",
  match_literals: ["moment"],
  match_tools: ["Bash"],
  match_scope_globs: null,
  embedding: null,
  embed_model: null,
  embed_text: "Adopting moment. Use dayjs. moment is in maintenance mode",
  hits: 0,
  misses: 0,
  exceptions: 0,
  wilson_lower: 0.5,
  last_seen_at: null,
  last_demerit_at: null,
  captured_at: "2026-05-15T00:00:00Z",
  session_origin: null,
  source_text: "don't use moment, use dayjs",
  evidence_json: null,
};

describe("rules CRUD", () => {
  it("insert + get round-trip preserves arrays as JSON", () => {
    const db = tmpKnowDb();
    insertRule(db, sampleRule);
    const r = getRule(db, sampleRule.id);
    expect(r.id).toBe(sampleRule.id);
    expect(r.match_literals).toEqual(["moment"]);
    expect(r.match_tools).toEqual(["Bash"]);
    expect(r.wilson_lower).toBeCloseTo(0.5);
    closeDb(db);
  });

  it("listRules returns active rules sorted by wilson_lower desc, excludes archived", () => {
    const db = tmpKnowDb();
    insertRule(db, { ...sampleRule, id: "r1", wilson_lower: 0.6 });
    insertRule(db, { ...sampleRule, id: "r2", wilson_lower: 0.8 });
    insertRule(db, { ...sampleRule, id: "r3", wilson_lower: 0.9, tier: "archived" });
    const list = listRules(db);
    expect(list.map(r => r.id)).toEqual(["r2", "r1"]);
    closeDb(db);
  });

  it("updateRule patches selected fields, preserves others", () => {
    const db = tmpKnowDb();
    insertRule(db, sampleRule);
    updateRule(db, sampleRule.id, { hits: 5, wilson_lower: 0.72, last_seen_at: "2026-05-16T00:00:00Z" });
    const r = getRule(db, sampleRule.id);
    expect(r.hits).toBe(5);
    expect(r.wilson_lower).toBeCloseTo(0.72);
    expect(r.wrong).toBe(sampleRule.wrong); // unchanged
    closeDb(db);
  });

  it("archiveRule sets tier='archived'", () => {
    const db = tmpKnowDb();
    insertRule(db, sampleRule);
    archiveRule(db, sampleRule.id);
    const r = getRule(db, sampleRule.id);
    expect(r.tier).toBe("archived");
    closeDb(db);
  });

  it("listRules with includeArchived: true returns all", () => {
    const db = tmpKnowDb();
    insertRule(db, { ...sampleRule, id: "r1" });
    insertRule(db, { ...sampleRule, id: "r2", tier: "archived" });
    expect(listRules(db, { includeArchived: true }).length).toBe(2);
    closeDb(db);
  });
});
```

- [ ] **Step 2: Verify FAIL**

- [ ] **Step 3: Write implementation**

```javascript
// hooks/lib/rules.cjs
"use strict";

function serializeArrays(rule) {
  return {
    ...rule,
    match_literals: rule.match_literals ? JSON.stringify(rule.match_literals) : null,
    match_tools: rule.match_tools ? JSON.stringify(rule.match_tools) : JSON.stringify(["Bash"]),
    match_scope_globs: rule.match_scope_globs ? JSON.stringify(rule.match_scope_globs) : null,
    evidence_json: rule.evidence_json ? JSON.stringify(rule.evidence_json) : null,
  };
}

function deserializeArrays(row) {
  if (!row) return row;
  return {
    ...row,
    match_literals: row.match_literals ? JSON.parse(row.match_literals) : null,
    match_tools: row.match_tools ? JSON.parse(row.match_tools) : [],
    match_scope_globs: row.match_scope_globs ? JSON.parse(row.match_scope_globs) : null,
    evidence_json: row.evidence_json ? JSON.parse(row.evidence_json) : null,
  };
}

function insertRule(db, rule) {
  const r = serializeArrays(rule);
  db.prepare(`
    INSERT INTO rules (
      id, scope, tier, wrong, correct, why,
      match_regex, match_literals, match_tools, match_scope_globs,
      embedding, embed_model, embed_text,
      hits, misses, exceptions, wilson_lower,
      last_seen_at, last_demerit_at,
      captured_at, session_origin, source_text, evidence_json
    ) VALUES (
      @id, @scope, @tier, @wrong, @correct, @why,
      @match_regex, @match_literals, @match_tools, @match_scope_globs,
      @embedding, @embed_model, @embed_text,
      @hits, @misses, @exceptions, @wilson_lower,
      @last_seen_at, @last_demerit_at,
      @captured_at, @session_origin, @source_text, @evidence_json
    )
  `).run({
    embedding: r.embedding || null,
    embed_model: r.embed_model || null,
    last_seen_at: r.last_seen_at || null,
    last_demerit_at: r.last_demerit_at || null,
    session_origin: r.session_origin || null,
    source_text: r.source_text || null,
    match_regex: r.match_regex || null,
    ...r,
  });
}

function getRule(db, id) {
  const row = db.prepare("SELECT * FROM rules WHERE id = ?").get(id);
  return deserializeArrays(row);
}

function listRules(db, { includeArchived = false, scope = null, limit = 1000 } = {}) {
  const where = [];
  const args = { limit };
  if (!includeArchived) where.push("tier != 'archived'");
  if (scope) { where.push("scope = @scope"); args.scope = scope; }
  const sql = `SELECT * FROM rules ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY wilson_lower DESC, captured_at DESC LIMIT @limit`;
  return db.prepare(sql).all(args).map(deserializeArrays);
}

function updateRule(db, id, patch) {
  const allowed = [
    "tier","wrong","correct","why",
    "match_regex","match_literals","match_tools","match_scope_globs",
    "embedding","embed_model","embed_text",
    "hits","misses","exceptions","wilson_lower",
    "last_seen_at","last_demerit_at","source_text","evidence_json",
  ];
  const sets = [];
  const args = { id };
  for (const k of Object.keys(patch)) {
    if (!allowed.includes(k)) continue;
    let v = patch[k];
    if (["match_literals","match_tools","match_scope_globs","evidence_json"].includes(k) && v != null) {
      v = JSON.stringify(v);
    }
    sets.push(`${k} = @${k}`);
    args[k] = v;
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE rules SET ${sets.join(", ")} WHERE id = @id`).run(args);
}

function archiveRule(db, id) {
  db.prepare("UPDATE rules SET tier = 'archived' WHERE id = ?").run(id);
}

module.exports = { insertRule, getRule, listRules, updateRule, archiveRule };
```

- [ ] **Step 4: PASS**

Run: `npx vitest run test/unit/rules.test.cjs`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/rules.cjs test/unit/rules.test.cjs
git commit -m "M1.06 lib/rules — insert/get/list/update/archive"
```

---

## Task 7: lib/confidence.cjs — Wilson, decay, tier transitions

**Files:**
- Create: `plugins/teamagent-memory/hooks/lib/confidence.cjs`
- Test: `plugins/teamagent-memory/test/unit/confidence.test.cjs`

- [ ] **Step 1: Write failing test**

```javascript
// test/unit/confidence.test.cjs
const { describe, it, expect } = require("vitest");
const { wilsonLowerBound, decay, computeTier, applyEvent } = require("../../hooks/lib/confidence.cjs");

describe("wilsonLowerBound", () => {
  it("n=0 returns prior 0.5", () => {
    expect(wilsonLowerBound(0, 0)).toBeCloseTo(0.5, 5);
  });
  it("hits=1, misses=0 less than 1.0 (small-sample conservative)", () => {
    const w = wilsonLowerBound(1, 0);
    expect(w).toBeLessThan(0.8);
    expect(w).toBeGreaterThan(0.1);
  });
  it("hits=20, misses=0 approaches 0.83+", () => {
    const w = wilsonLowerBound(20, 0);
    expect(w).toBeGreaterThan(0.83);
  });
  it("hits=10, misses=10 around 0.27", () => {
    const w = wilsonLowerBound(10, 10);
    expect(w).toBeGreaterThan(0.27);
    expect(w).toBeLessThan(0.34);
  });
});

describe("decay", () => {
  it("days_idle=0 -> score unchanged", () => {
    expect(decay(0.8, 0)).toBeCloseTo(0.8, 5);
  });
  it("days_idle=60 -> half (within tolerance, half-life 60d)", () => {
    expect(decay(0.8, 60)).toBeCloseTo(0.8 * Math.exp(-1), 4);
  });
  it("negative days treated as 0", () => {
    expect(decay(0.8, -5)).toBeCloseTo(0.8, 5);
  });
});

describe("computeTier", () => {
  it("experimental until hits >= 5 and wilson >= 0.7", () => {
    expect(computeTier({ tier: "experimental", hits: 4, misses: 0, wilson_lower: 0.7 })).toBe("experimental");
    expect(computeTier({ tier: "experimental", hits: 5, misses: 0, wilson_lower: 0.7 })).toBe("canonical");
  });
  it("canonical to canonical+ at hits >= 20 wilson >= 0.85", () => {
    expect(computeTier({ tier: "canonical", hits: 19, misses: 0, wilson_lower: 0.85 })).toBe("canonical");
    expect(computeTier({ tier: "canonical", hits: 20, misses: 0, wilson_lower: 0.85 })).toBe("canonical+");
  });
  it("canonical demotes to experimental at misses >= 5", () => {
    expect(computeTier({ tier: "canonical", hits: 30, misses: 5, wilson_lower: 0.5 })).toBe("experimental");
  });
  it("canonical+ demotes to canonical at misses >= 5", () => {
    expect(computeTier({ tier: "canonical+", hits: 50, misses: 5, wilson_lower: 0.7 })).toBe("canonical");
  });
  it("experimental archives at misses >= 3", () => {
    expect(computeTier({ tier: "experimental", hits: 1, misses: 3, wilson_lower: 0.2 })).toBe("archived");
  });
});

describe("applyEvent", () => {
  it("hit increments hits and updates wilson_lower + last_seen_at", () => {
    const before = { hits: 4, misses: 0, exceptions: 0, wilson_lower: 0.5, tier: "experimental", last_seen_at: null };
    const after = applyEvent(before, { kind: "hit", at: "2026-05-15T00:00:00Z" });
    expect(after.hits).toBe(5);
    expect(after.last_seen_at).toBe("2026-05-15T00:00:00Z");
    expect(after.wilson_lower).toBeGreaterThan(0.5);
  });
  it("miss increments misses and updates last_demerit_at", () => {
    const before = { hits: 4, misses: 2, exceptions: 0, wilson_lower: 0.55, tier: "canonical", last_seen_at: "2026-05-14T00:00:00Z" };
    const after = applyEvent(before, { kind: "miss", at: "2026-05-15T00:00:00Z" });
    expect(after.misses).toBe(3);
    expect(after.last_demerit_at).toBe("2026-05-15T00:00:00Z");
  });
  it("exception only increments exceptions; does not change wilson", () => {
    const before = { hits: 10, misses: 0, exceptions: 0, wilson_lower: 0.8, tier: "canonical", last_seen_at: null };
    const after = applyEvent(before, { kind: "exception", at: "2026-05-15T00:00:00Z" });
    expect(after.exceptions).toBe(1);
    expect(after.wilson_lower).toBeCloseTo(0.8, 5);
  });
});
```

- [ ] **Step 2: Verify FAIL**

- [ ] **Step 3: Write implementation**

```javascript
// hooks/lib/confidence.cjs
"use strict";

const Z = 1.96;       // 95% CI
const PRIOR = 0.5;
const HALF_LIFE_DAYS = 60;

function wilsonLowerBound(hits, misses, z = Z) {
  const n = (hits | 0) + (misses | 0);
  if (n === 0) return PRIOR;
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p) / n) + z2 / (4 * n * n));
  return (center - half) / denom;
}

function decay(score, daysIdle, halfLife = HALF_LIFE_DAYS) {
  const d = Math.max(0, daysIdle);
  return score * Math.exp(-d / halfLife);
}

// ADR-0006 + DESIGN §4.3
function computeTier({ tier, hits, misses, wilson_lower }) {
  // archived only via explicit archive call; demote path
  if (tier === "archived") return "archived";

  // demotion takes precedence over promotion
  if (tier === "canonical+" && misses >= 5) return "canonical";
  if (tier === "canonical" && misses >= 5) return "experimental";
  if (tier === "experimental" && misses >= 3) return "archived";

  // promotion
  if (tier === "experimental" && hits >= 5 && wilson_lower >= 0.7) return "canonical";
  if (tier === "canonical" && hits >= 20 && wilson_lower >= 0.85) return "canonical+";

  return tier;
}

function applyEvent(rule, evt) {
  let { hits, misses, exceptions, tier, last_seen_at, last_demerit_at } = rule;
  if (evt.kind === "hit") { hits += 1; last_seen_at = evt.at; }
  else if (evt.kind === "miss") { misses += 1; last_demerit_at = evt.at; }
  else if (evt.kind === "exception") { exceptions += 1; }
  else throw new Error(`applyEvent unknown kind: ${evt.kind}`);

  const wilson_lower = wilsonLowerBound(hits, misses);
  const next = { ...rule, hits, misses, exceptions, wilson_lower, last_seen_at, last_demerit_at };
  next.tier = computeTier(next);
  return next;
}

module.exports = { wilsonLowerBound, decay, computeTier, applyEvent, Z, PRIOR, HALF_LIFE_DAYS };
```

- [ ] **Step 4: PASS**

Run: `npx vitest run test/unit/confidence.test.cjs`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/confidence.cjs test/unit/confidence.test.cjs
git commit -m "M1.07 lib/confidence — Wilson + decay + tier transitions"
```

---

## Task 8: lib/redos.cjs — regex lint for ADR-0007

**Files:**
- Create: `plugins/teamagent-memory/hooks/lib/redos.cjs`
- Test: `plugins/teamagent-memory/test/unit/redos.test.cjs`

- [ ] **Step 1: Write failing test**

```javascript
// test/unit/redos.test.cjs
const { describe, it, expect } = require("vitest");
const { lintRegex } = require("../../hooks/lib/redos.cjs");

describe("lintRegex", () => {
  it("ok for simple pattern", () => {
    expect(lintRegex("(npm|pnpm|yarn)\\s+install\\s+moment").ok).toBe(true);
  });
  it("rejects >512 chars", () => {
    const long = "a".repeat(513);
    expect(lintRegex(long).ok).toBe(false);
  });
  it("rejects nested quantifier (a+)+", () => {
    const r = lintRegex("(a+)+b");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/nested/i);
  });
  it("rejects (a*)*", () => {
    expect(lintRegex("(a*)*").ok).toBe(false);
  });
  it("rejects invalid regex syntax", () => {
    expect(lintRegex("[unclosed").ok).toBe(false);
  });
  it("returns reason as string for all failures", () => {
    expect(typeof lintRegex("(a+)+").reason).toBe("string");
  });
  it("performance probe rejects catastrophic patterns under 50ms", () => {
    // (.*a){25} type is known catastrophic
    const r = lintRegex("(.*a){25}$");
    // either lint catches structurally OR probe catches by timeout
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Verify FAIL**

- [ ] **Step 3: Write implementation**

```javascript
// hooks/lib/redos.cjs
"use strict";

const MAX_LEN = 512;
const PROBE_INPUT = "a".repeat(10000);
const PROBE_TIMEOUT_MS = 50;

// Static heuristic: detect "(x)+ followed by + or *" and similar.
const DANGEROUS = [
  /\([^()]*[+*?][^()]*\)[+*]/, // (a+)+, (a*)* etc
  /\([^()]*\)\{[^}]*,\s*\}/,   // (x){n,} with high n
  /\(\.\*[^)]*\)\{\d{2,}/,     // (.*a){25}
];

function lintRegex(pat) {
  if (typeof pat !== "string") return { ok: false, reason: "pattern must be string" };
  if (pat.length === 0) return { ok: false, reason: "empty pattern" };
  if (pat.length > MAX_LEN) return { ok: false, reason: `pattern too long (${pat.length} > ${MAX_LEN})` };

  for (const danger of DANGEROUS) {
    if (danger.test(pat)) return { ok: false, reason: `pattern contains catastrophic backtracking pattern: ${danger}` };
  }

  let re;
  try { re = new RegExp(pat, "i"); }
  catch (e) { return { ok: false, reason: `regex compile failed: ${e.message}` }; }

  // Performance probe — run against 10K char string. Node has no native RegExp timeout;
  // we measure wall-clock and reject if > PROBE_TIMEOUT_MS.
  const t0 = Date.now();
  try { re.test(PROBE_INPUT); } catch (_e) { /* ignore */ }
  const dt = Date.now() - t0;
  if (dt > PROBE_TIMEOUT_MS) return { ok: false, reason: `probe slow (${dt}ms > ${PROBE_TIMEOUT_MS}ms)` };

  return { ok: true, reason: null };
}

module.exports = { lintRegex, MAX_LEN, PROBE_TIMEOUT_MS };
```

- [ ] **Step 4: PASS**

Run: `npx vitest run test/unit/redos.test.cjs`
Expected: all passed.

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/redos.cjs test/unit/redos.test.cjs
git commit -m "M1.08 lib/redos — regex lint with length, static patterns, probe"
```

---

## Task 9: lib/match.cjs — fast-path matcher (M1 only)

**Files:**
- Create: `plugins/teamagent-memory/hooks/lib/match.cjs`
- Test: `plugins/teamagent-memory/test/unit/match.test.cjs`

- [ ] **Step 1: Write failing test**

```javascript
// test/unit/match.test.cjs
const { describe, it, expect } = require("vitest");
const { fastPathMatch, runMatch } = require("../../hooks/lib/match.cjs");

const ruleRegex = { id: "r1", match_regex: "(npm|pnpm|yarn)\\s+(install|add)\\s+moment", match_literals: null };
const ruleLit = { id: "r2", match_regex: null, match_literals: ["axios", "fetch"] };
const ruleNone = { id: "r3", match_regex: null, match_literals: null };

describe("fastPathMatch", () => {
  it("regex matches with case-insensitive", () => {
    expect(fastPathMatch("NPM install moment", ruleRegex)).toEqual({ hit: true, sim: 1.0, via: "regex" });
  });
  it("regex does not match unrelated", () => {
    expect(fastPathMatch("ls -la", ruleRegex)).toEqual({ hit: false, sim: 0, via: null });
  });
  it("literal substring matches case-insensitive", () => {
    expect(fastPathMatch("we use AXIOS in this repo", ruleLit)).toMatchObject({ hit: true, sim: 1.0, via: "literal" });
  });
  it("rule with no fast-path returns hit:false", () => {
    expect(fastPathMatch("anything", ruleNone)).toEqual({ hit: false, sim: 0, via: null });
  });
  it("invalid regex returns hit:false (does not throw)", () => {
    const bad = { id: "r4", match_regex: "[unclosed", match_literals: null };
    expect(() => fastPathMatch("foo", bad)).not.toThrow();
    expect(fastPathMatch("foo", bad).hit).toBe(false);
  });
});

describe("runMatch (M1 — fast-path only)", () => {
  it("returns first hit from rules in order", () => {
    const out = runMatch("npm install moment", [ruleRegex, ruleLit]);
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0].rule.id).toBe("r1");
    expect(out[0].sim).toBe(1.0);
  });
  it("returns empty when nothing matches", () => {
    expect(runMatch("uhh", [ruleRegex])).toEqual([]);
  });
  it("aggregate fast-path budget short-circuits if exceeded (caller responsibility, here we just verify shape)", () => {
    const out = runMatch("xxx", []);
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Verify FAIL**

- [ ] **Step 3: Write implementation**

```javascript
// hooks/lib/match.cjs
"use strict";

const FAST_PATH_BUDGET_MS = 50;

function fastPathMatch(query, rule) {
  if (typeof query !== "string" || query.length === 0) return { hit: false, sim: 0, via: null };

  if (rule.match_regex) {
    try {
      const re = new RegExp(rule.match_regex, "i");
      if (re.test(query)) return { hit: true, sim: 1.0, via: "regex" };
    } catch (_e) { /* invalid regex, fall through */ }
  }

  if (Array.isArray(rule.match_literals) && rule.match_literals.length > 0) {
    const q = query.toLowerCase();
    for (const lit of rule.match_literals) {
      if (typeof lit === "string" && lit.length > 0 && q.includes(lit.toLowerCase())) {
        return { hit: true, sim: 1.0, via: "literal" };
      }
    }
  }

  return { hit: false, sim: 0, via: null };
}

function runMatch(query, rules, opts = {}) {
  const budget = opts.budget_ms || FAST_PATH_BUDGET_MS;
  const start = Date.now();
  const hits = [];
  for (const rule of rules) {
    if (Date.now() - start > budget) break;
    const m = fastPathMatch(query, rule);
    if (m.hit) hits.push({ rule, sim: m.sim, via: m.via });
  }
  return hits;
}

module.exports = { fastPathMatch, runMatch, FAST_PATH_BUDGET_MS };
```

- [ ] **Step 4: PASS**

Run: `npx vitest run test/unit/match.test.cjs`

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/match.cjs test/unit/match.test.cjs
git commit -m "M1.09 lib/match — fast-path only (regex/literal), budget guard"
```

---

## Task 10: lib/analyze.cjs — candidate moment scoring

**Files:**
- Create: `plugins/teamagent-memory/hooks/lib/analyze.cjs`
- Test: `plugins/teamagent-memory/test/unit/analyze.test.cjs`
- Test fixture: `plugins/teamagent-memory/test/fixtures/transcripts/correction-moment.jsonl`

- [ ] **Step 1: Write fixture transcript**

```jsonl
{"type":"assistant","message":{"content":"I'll install moment for date handling."}}
{"type":"tool_use","name":"Bash","input":{"command":"npm install moment"}}
{"type":"user","message":{"content":"don't use moment, use dayjs instead"}}
{"type":"assistant","message":{"content":"Got it, installing dayjs."}}
{"type":"tool_use","name":"Bash","input":{"command":"npm install dayjs"}}
{"type":"user","message":{"content":"ok 这样可以"}}
```

Path: `test/fixtures/transcripts/correction-moment.jsonl`

- [ ] **Step 2: Write failing test**

```javascript
// test/unit/analyze.test.cjs
const { describe, it, expect } = require("vitest");
const path = require("path");
const { scoreTurn, findCandidates } = require("../../hooks/lib/analyze.cjs");

const FIX = path.join(__dirname, "..", "fixtures", "transcripts");

describe("scoreTurn", () => {
  it("scores correction pattern message high", () => {
    const turn = { type: "user", message: { content: "don't use moment, use dayjs instead" } };
    const score = scoreTurn(turn, null, { recentDecisionEvent: null });
    expect(score.score).toBeGreaterThanOrEqual(3);
    expect(score.kind).toBe("correction");
  });
  it("scores 'X 不要 用 Y' Chinese pattern", () => {
    const turn = { type: "user", message: { content: "moment不要, 用 dayjs" } };
    expect(scoreTurn(turn, null, {}).score).toBeGreaterThanOrEqual(3);
  });
  it("scores short rejection like '不对' as low (≥2 only with negation+object)", () => {
    const turn = { type: "user", message: { content: "不对" } };
    expect(scoreTurn(turn, null, {}).score).toBeLessThan(3);
  });
  it("success signal short message after tool call gets kind=success and >=2", () => {
    const turn = { type: "user", message: { content: "ok works now" } };
    const prev = { type: "tool_use", name: "Bash" };
    const s = scoreTurn(turn, prev, {});
    expect(s.kind).toBe("success");
    expect(s.score).toBeGreaterThanOrEqual(2);
  });
});

describe("findCandidates", () => {
  it("identifies correction turn in fixture", () => {
    const fp = path.join(FIX, "correction-moment.jsonl");
    const out = findCandidates(fp, 0);
    expect(out.length).toBeGreaterThanOrEqual(1);
    const correction = out.find(c => c.kind === "correction");
    expect(correction).toBeTruthy();
    expect(correction.context_turns.length).toBeGreaterThan(0);
  });

  it("respects cursor: returns nothing if cursor past all turns", () => {
    const fp = path.join(FIX, "correction-moment.jsonl");
    const out = findCandidates(fp, 9999);
    expect(out.length).toBe(0);
  });

  it("caps to top-5 candidates", () => {
    const fp = path.join(FIX, "correction-moment.jsonl");
    const out = findCandidates(fp, 0);
    expect(out.length).toBeLessThanOrEqual(5);
  });
});
```

- [ ] **Step 3: Verify FAIL**

- [ ] **Step 4: Write implementation**

```javascript
// hooks/lib/analyze.cjs
"use strict";

const fs = require("fs");

// Patterns aligned with v0.1 plus broader negation+object signal.
const CORRECTION_PATTERNS = [
  /\bdon['’]?t\s+use\s+[^\s,.;:!?]+.{0,50}\buse\s+/i,
  /\buse\s+[^\s,.;:!?]+\s+instead\s+of\s+/i,
  /\bnot\s+[^\s,.;:!?]+\s*,\s*use\s+/i,
  /[^\s,。.]+不要[,，]?\s*用\s*[^\s,。.]+/,
  /不要用\s*[^\s,。.]+[,，]?\s*用\s*[^\s,。.]+/,
  /用\s*[^\s,。.]+\s*替代\s*[^\s,。.]+/,
];

const NEG_HINTS = [/\bnot\b/i, /\bwrong\b/i, /\binstead\b/i, /\bnever\b/i, /不对/, /不要/, /别用/, /错了/, /不应该/];
const SUCCESS_HINTS = [/\bok\b/i, /\bworks?\b/i, /\bgood\b/i, /\bnice\b/i, /可以/, /行了/, /搞定/];

function textOf(turn) {
  if (!turn || !turn.message) return "";
  const c = turn.message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(x => (typeof x === "string" ? x : (x && x.text) || "")).join("\n");
  return "";
}

function isUser(turn) { return turn && (turn.type === "user" || turn.role === "user"); }
function isTool(turn) { return turn && (turn.type === "tool_use" || turn.type === "tool_call"); }

function scoreTurn(turn, prevTurn, ctx) {
  if (!isUser(turn)) return { score: 0, kind: null };
  const text = textOf(turn).trim();
  if (!text) return { score: 0, kind: null };

  let score = 0;
  let kind = null;

  for (const pat of CORRECTION_PATTERNS) {
    if (pat.test(text)) { score += 3; kind = "correction"; break; }
  }
  if (!kind) {
    const hasNeg = NEG_HINTS.some(p => p.test(text));
    if (hasNeg && /[^\s.,;:!?]/.test(text.replace(/\s+/g, "")) && text.length > 3) {
      // crude "negation + an object" — at least the text has more than just the negation
      const stripped = text.replace(NEG_HINTS.find(p => p.test(text)), "").trim();
      if (stripped.length > 1) { score += 2; kind = "correction"; }
    }
  }
  if (prevTurn && isTool(prevTurn) && isUser(turn)) score += 1;
  if (text.length <= 200) score += 1;
  if (ctx && ctx.recentDecisionEvent) score += 2;
  if (SUCCESS_HINTS.some(p => p.test(text)) && !kind) {
    if (prevTurn && isTool(prevTurn)) { score += 2; kind = "success"; }
  }
  return { score, kind };
}

function readTranscript(fp) {
  if (!fs.existsSync(fp)) return [];
  const raw = fs.readFileSync(fp, "utf8");
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (_e) { /* skip */ }
  }
  return out;
}

function findCandidates(transcriptPath, cursorTurnIndex = 0, opts = {}) {
  const all = readTranscript(transcriptPath);
  if (cursorTurnIndex >= all.length) return [];
  const start = Math.max(0, cursorTurnIndex);
  const results = [];
  for (let i = start; i < all.length; i++) {
    const turn = all[i];
    const prev = i > 0 ? all[i - 1] : null;
    const s = scoreTurn(turn, prev, opts.signalCtx || {});
    if (s.score >= 3) {
      const ctxBefore = all.slice(Math.max(0, i - 5), i);
      const ctxAfter = all.slice(i + 1, Math.min(all.length, i + 6));
      results.push({
        turn_index: i,
        score: s.score,
        kind: s.kind,
        context_turns: [...ctxBefore, turn, ...ctxAfter],
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 5);
}

module.exports = { scoreTurn, findCandidates, readTranscript };
```

- [ ] **Step 5: PASS + commit**

```bash
npx vitest run test/unit/analyze.test.cjs   # expect all passed
git add hooks/lib/analyze.cjs test/unit/analyze.test.cjs test/fixtures/transcripts/correction-moment.jsonl
git commit -m "M1.10 lib/analyze — candidate moment scoring per DESIGN §4.1"
```

---

## Task 11: lib/extract.cjs — claude -p invocation (with binary injection for tests)

**Files:**
- Create: `plugins/teamagent-memory/hooks/lib/extract.cjs`
- Test: `plugins/teamagent-memory/test/unit/extract.test.cjs`
- Test fixture: `plugins/teamagent-memory/test/fixtures/fake-claude.cjs`

- [ ] **Step 1: Write fake-claude stub**

```javascript
// test/fixtures/fake-claude.cjs
// A drop-in stand-in for `claude` CLI invoked with `claude -p ...`.
// Behavior controlled by env vars:
//   FAKE_CLAUDE_MODE=ok      -> stdout valid JSON rule, exit 0
//   FAKE_CLAUDE_MODE=invalid -> stdout garbage, exit 0
//   FAKE_CLAUDE_MODE=timeout -> sleep forever, never exit
//   FAKE_CLAUDE_MODE=error   -> exit 1, stderr message
#!/usr/bin/env node
"use strict";

const mode = process.env.FAKE_CLAUDE_MODE || "ok";
if (mode === "ok") {
  process.stdout.write(JSON.stringify({
    is_actionable_rule: true,
    wrong: "Adopting moment",
    correct: "Use dayjs",
    why: "moment is in maintenance mode",
    scope_hint: "global",
    match_regex: "(npm|pnpm|yarn)\\s+(install|add)\\s+moment",
    match_literals: ["moment"],
    match_tools: ["Bash"],
    confidence_hint: 0.9,
  }));
  process.exit(0);
} else if (mode === "invalid") {
  process.stdout.write("not JSON at all");
  process.exit(0);
} else if (mode === "timeout") {
  setInterval(() => {}, 1000);
} else if (mode === "error") {
  process.stderr.write("simulated failure\n");
  process.exit(1);
}
```

- [ ] **Step 2: Write failing test**

```javascript
// test/unit/extract.test.cjs
const { describe, it, expect } = require("vitest");
const path = require("path");
const { runExtract, dedupHash, buildExtractPrompt } = require("../../hooks/lib/extract.cjs");

const FAKE = path.join(__dirname, "..", "fixtures", "fake-claude.cjs");

describe("dedupHash", () => {
  it("stable across calls", () => {
    expect(dedupHash("/path/to/t.jsonl", 12)).toBe(dedupHash("/path/to/t.jsonl", 12));
  });
  it("differs by index", () => {
    expect(dedupHash("/p", 1)).not.toBe(dedupHash("/p", 2));
  });
});

describe("buildExtractPrompt", () => {
  it("contains schema and the context dump", () => {
    const turns = [{ type: "user", message: { content: "don't use moment" } }];
    const p = buildExtractPrompt(turns);
    expect(p).toMatch(/is_actionable_rule/);
    expect(p).toMatch(/don't use moment/);
  });
});

describe("runExtract (mocked binary)", () => {
  it("ok mode returns parsed rule", async () => {
    const ctx = [{ type: "user", message: { content: "don't use moment" } }];
    const out = await runExtract(ctx, { claudeBin: ["node", FAKE], env: { FAKE_CLAUDE_MODE: "ok" }, timeoutMs: 5000 });
    expect(out).toMatchObject({ is_actionable_rule: true, wrong: "Adopting moment" });
  }, 10000);

  it("invalid JSON returns null after 1 retry", async () => {
    const ctx = [{ type: "user", message: { content: "x" } }];
    const out = await runExtract(ctx, { claudeBin: ["node", FAKE], env: { FAKE_CLAUDE_MODE: "invalid" }, timeoutMs: 5000 });
    expect(out).toBeNull();
  }, 15000);

  it("error mode returns null", async () => {
    const out = await runExtract([{}], { claudeBin: ["node", FAKE], env: { FAKE_CLAUDE_MODE: "error" }, timeoutMs: 5000 });
    expect(out).toBeNull();
  }, 10000);

  it("timeout mode returns null", async () => {
    const out = await runExtract([{}], { claudeBin: ["node", FAKE], env: { FAKE_CLAUDE_MODE: "timeout" }, timeoutMs: 800 });
    expect(out).toBeNull();
  }, 5000);
});
```

- [ ] **Step 3: Verify FAIL**

- [ ] **Step 4: Write implementation**

```javascript
// hooks/lib/extract.cjs
"use strict";

const crypto = require("crypto");
const { spawn } = require("child_process");

const SYSTEM_PROMPT = `You are TeamAgent's rule extractor. Given a Claude Code conversation fragment, decide whether it contains an actionable, cross-session rule, and return JSON only — no markdown, no commentary.`;

function dedupHash(transcriptPath, turnIndex) {
  return crypto.createHash("sha256").update(`${transcriptPath}::${turnIndex}`).digest("hex").slice(0, 32);
}

function summarizeTurn(turn) {
  const role = turn.type || turn.role || "?";
  const c = turn.message && turn.message.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) text = c.map(x => (typeof x === "string" ? x : (x && x.text) || "")).join("\n");
  else if (turn.input && typeof turn.input.command === "string") text = `[tool ${turn.name}] ${turn.input.command}`;
  return `${role}: ${text}`.slice(0, 500);
}

function buildExtractPrompt(contextTurns) {
  const dump = contextTurns.map(summarizeTurn).join("\n");
  return `${SYSTEM_PROMPT}

Conversation fragment (chronological, last is most recent):
<<<
${dump}
>>>

Output JSON only:
{
  "is_actionable_rule": true|false,
  "wrong": "<one-sentence wrong action>",
  "correct": "<one-sentence correct action>",
  "why": "<one-sentence rationale>",
  "scope_hint": "project"|"global",
  "match_regex": "<optional regex that uniquely matches the wrong command, or null>",
  "match_literals": ["<optional keyword>", ...],
  "match_tools": ["Bash"|"Edit"|"Write", ...],
  "confidence_hint": 0.0-1.0
}

Set is_actionable_rule=false if the user is venting, the correction is one-off, it relies on secret context, or contains credentials/paths/emails.`;
}

function spawnWithTimeout(cmd, args, { stdin, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    let settled = false;
    const finish = (res) => { if (settled) return; settled = true; resolve(res); };

    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch (_e) {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch (_e) {} }, 5000);
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);

    child.stdout.on("data", d => stdout += d.toString());
    child.stderr.on("data", d => stderr += d.toString());
    child.on("error", () => { clearTimeout(timer); finish({ code: -1, stdout, stderr, timedOut: false }); });
    child.on("close", code => { clearTimeout(timer); finish({ code, stdout, stderr, timedOut: false }); });

    if (stdin) { child.stdin.write(stdin); }
    child.stdin.end();
  });
}

async function runExtract(contextTurns, opts = {}) {
  const claudeBin = opts.claudeBin || ["claude"];
  const env = opts.env || {};
  const timeoutMs = opts.timeoutMs || 30000;
  const model = opts.model || process.env.TEAMAGENT_EXTRACT_MODEL || "claude-haiku-4-5";

  const prompt = buildExtractPrompt(contextTurns);
  const args = [
    ...claudeBin.slice(1),
    "-p",
    "--model", model,
    "--output-format", "json",
    "--max-turns", "1",
    "--disallowed-tools", "*",
  ];
  // When invoked via node bin (e.g. for tests), claudeBin = ['node', '/path/fake-claude.cjs']
  // In that case, skip the claude-specific flags — the fake binary ignores them anyway.

  let attempts = 0;
  while (attempts < 2) {
    attempts++;
    const res = await spawnWithTimeout(claudeBin[0], args, { stdin: prompt, env, timeoutMs });
    if (res.timedOut || res.code !== 0) return null;
    const text = (res.stdout || "").trim();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_e) {
      // try to extract a JSON object from the output
      const m = text.match(/\{[\s\S]*\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch (_e2) { parsed = null; }
    }
    if (parsed && typeof parsed.is_actionable_rule === "boolean") return parsed;
    // retry once
  }
  return null;
}

module.exports = { runExtract, dedupHash, buildExtractPrompt };
```

- [ ] **Step 5: PASS + commit**

```bash
npx vitest run test/unit/extract.test.cjs
git add hooks/lib/extract.cjs test/unit/extract.test.cjs test/fixtures/fake-claude.cjs
git commit -m "M1.11 lib/extract — claude -p invocation, timeout, retry, mocked test"
```

---

## Task 12: lib/log.cjs — common event logger (shared by all hooks)

**Files:**
- Create: `plugins/teamagent-memory/hooks/lib/log.cjs`
- Test: `plugins/teamagent-memory/test/unit/log.test.cjs`

- [ ] **Step 1: Write failing test**

```javascript
// test/unit/log.test.cjs
const { describe, it, expect } = require("vitest");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { logHook } = require("../../hooks/lib/log.cjs");
const { openEventsDb, closeDb } = require("../../hooks/lib/db.cjs");
const { readEvents } = require("../../hooks/lib/events.cjs");

function tmpDb() {
  const p = path.join(os.tmpdir(), `tlog-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return { p, db: openEventsDb(p) };
}

describe("logHook", () => {
  it("appends event with hook_name auto-filled", () => {
    const { db } = tmpDb();
    logHook(db, "PreToolUse", { kind: "pretooluse_pass", tool_name: "Bash" });
    const ev = readEvents(db, { limit: 1 })[0];
    expect(ev.hook_name).toBe("PreToolUse");
    expect(ev.kind).toBe("pretooluse_pass");
    closeDb(db);
  });

  it("does not throw on a null db", () => {
    expect(() => logHook(null, "x", { kind: "y" })).not.toThrow();
  });
});
```

- [ ] **Step 2: Verify FAIL**

- [ ] **Step 3: Write implementation**

```javascript
// hooks/lib/log.cjs
"use strict";

const { writeEvent } = require("./events.cjs");

function logHook(eventsDb, hookName, evt) {
  if (!eventsDb) return;
  writeEvent(eventsDb, { ...evt, hook_name: hookName });
}

module.exports = { logHook };
```

- [ ] **Step 4: PASS + commit**

```bash
npx vitest run test/unit/log.test.cjs
git add hooks/lib/log.cjs test/unit/log.test.cjs
git commit -m "M1.12 lib/log — common event logger"
```

---

## Task 13: hooks/sessionstart.cjs — load + minimal GC

**Files:**
- Create: `plugins/teamagent-memory/hooks/sessionstart.cjs`
- Test: `plugins/teamagent-memory/test/integration/sessionstart.test.cjs`

- [ ] **Step 1: Write failing integration test**

```javascript
// test/integration/sessionstart.test.cjs
const { describe, it, expect } = require("vitest");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawnSync } = require("child_process");

function tmpHome() {
  const d = path.join(os.tmpdir(), `tses-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const HOOK = path.join(__dirname, "..", "..", "hooks", "sessionstart.cjs");

describe("sessionstart.cjs", () => {
  it("creates DBs and emits valid JSON (or empty) on stdout, exit 0", () => {
    const HOME = tmpHome();
    const cwd = tmpHome();
    const input = JSON.stringify({ session_id: "S1" });
    const r = spawnSync("node", [HOOK], { input, env: { ...process.env, HOME, USERPROFILE: HOME }, cwd, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(HOME, ".teamagent", "global.db"))).toBe(true);
    expect(fs.existsSync(path.join(HOME, ".teamagent", "events.db"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, ".teamagent", "knowledge.db"))).toBe(true);
  });

  it("survives broken stdin (empty)", () => {
    const HOME = tmpHome();
    const r = spawnSync("node", [HOOK], { input: "", env: { ...process.env, HOME, USERPROFILE: HOME }, encoding: "utf8" });
    expect(r.status).toBe(0);
  });
});
```

- [ ] **Step 2: Verify FAIL**

- [ ] **Step 3: Write implementation**

```javascript
// hooks/sessionstart.cjs
#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { resolveProjectDbPath, resolveGlobalDbPath, resolveEventsDbPath } = require("./lib/paths.cjs");
const { openKnowledgeDb, openEventsDb, closeDb } = require("./lib/db.cjs");
const { logHook } = require("./lib/log.cjs");

function readStdinSync() { try { return fs.readFileSync(0, "utf8"); } catch (_e) { return ""; } }
function safeParse(s) { try { return JSON.parse(s); } catch (_e) { return null; } }

function main() {
  const event = safeParse(readStdinSync()) || {};
  const session_id = event.session_id || (event.session && event.session.id) || null;

  // Open all three DBs to ensure schema present + files exist.
  let knowledgeDb = null, globalDb = null, eventsDb = null;
  try { knowledgeDb = openKnowledgeDb(resolveProjectDbPath()); } catch (_e) {}
  try { globalDb = openKnowledgeDb(resolveGlobalDbPath()); } catch (_e) {}
  try { eventsDb = openEventsDb(resolveEventsDbPath()); } catch (_e) {}

  logHook(eventsDb, "SessionStart", { kind: "session_start", session_id });

  // GC: minimal in M1 — mark experimental rules with hits=0 and >30d as archived
  if (knowledgeDb || globalDb) {
    const cutoffMs = Date.now() - 30 * 86400 * 1000;
    const cutoff = new Date(cutoffMs).toISOString();
    for (const db of [knowledgeDb, globalDb].filter(Boolean)) {
      try {
        db.prepare(`UPDATE rules SET tier='archived' WHERE tier='experimental' AND hits=0 AND captured_at < ?`).run(cutoff);
      } catch (_e) {}
    }
  }

  for (const db of [knowledgeDb, globalDb, eventsDb]) closeDb(db);
  process.exit(0);
}

try { main(); } catch (err) {
  try { process.stderr.write("teamagent sessionstart error: " + (err && err.message) + "\n"); } catch (_e) {}
  process.exit(0);
}
```

- [ ] **Step 4: PASS + commit**

```bash
npx vitest run test/integration/sessionstart.test.cjs
git add hooks/sessionstart.cjs test/integration/sessionstart.test.cjs
git commit -m "M1.13 hooks/sessionstart — create DBs, mark stale experimentals"
```

---

## Task 14: hooks/userprompt-inject.cjs — rewrite using lib (fast-path only)

**Files:**
- Modify: `plugins/teamagent-memory/hooks/userprompt-inject.cjs`
- Test: `plugins/teamagent-memory/test/integration/userprompt.test.cjs`

- [ ] **Step 1: Write failing integration test**

```javascript
// test/integration/userprompt.test.cjs
const { describe, it, expect } = require("vitest");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { openKnowledgeDb, closeDb } = require("../../hooks/lib/db.cjs");
const { insertRule } = require("../../hooks/lib/rules.cjs");
const { resolveGlobalDbPath } = require("../../hooks/lib/paths.cjs");

function tmpHome() {
  const d = path.join(os.tmpdir(), `tup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const HOOK = path.join(__dirname, "..", "..", "hooks", "userprompt-inject.cjs");

function makeRule(over = {}) {
  return {
    id: "rule-test-1", scope: "global", tier: "canonical",
    wrong: "Adopting moment", correct: "Use dayjs", why: "deprecated",
    match_regex: "(npm|pnpm|yarn)\\s+(install|add)\\s+moment", match_literals: ["moment"],
    match_tools: ["Bash"], match_scope_globs: null,
    embedding: null, embed_model: null, embed_text: "x",
    hits: 10, misses: 0, exceptions: 0, wilson_lower: 0.8,
    last_seen_at: "2026-05-14T00:00:00Z", last_demerit_at: null,
    captured_at: "2026-05-01T00:00:00Z", session_origin: null, source_text: null, evidence_json: null,
    ...over,
  };
}

describe("userprompt-inject", () => {
  it("injects reminder when prompt contains rule literal", () => {
    const HOME = tmpHome();
    const env = { ...process.env, HOME, USERPROFILE: HOME };
    const gdb = openKnowledgeDb(path.join(HOME, ".teamagent", "global.db"));
    insertRule(gdb, makeRule());
    closeDb(gdb);

    const input = JSON.stringify({ session_id: "S1", prompt: "let's install moment for date handling" });
    const r = spawnSync("node", [HOOK], { input, env, encoding: "utf8" });
    expect(r.status).toBe(0);
    const out = r.stdout ? JSON.parse(r.stdout) : null;
    expect(out).toBeTruthy();
    expect(out.hookSpecificOutput.additionalContext).toMatch(/rule-test-1/);
  });

  it("emits no output when no rule matches", () => {
    const HOME = tmpHome();
    const env = { ...process.env, HOME, USERPROFILE: HOME };
    openKnowledgeDb(path.join(HOME, ".teamagent", "global.db")); // no rules
    const input = JSON.stringify({ prompt: "what's the weather" });
    const r = spawnSync("node", [HOOK], { input, env, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});
```

- [ ] **Step 2: Verify FAIL** (hook still v0.1 behavior)

- [ ] **Step 3: Replace implementation**

```javascript
// hooks/userprompt-inject.cjs
#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { resolveProjectDbPath, resolveGlobalDbPath, resolveEventsDbPath } = require("./lib/paths.cjs");
const { openKnowledgeDb, openEventsDb, closeDb } = require("./lib/db.cjs");
const { listRules } = require("./lib/rules.cjs");
const { runMatch } = require("./lib/match.cjs");
const { logHook } = require("./lib/log.cjs");

const MAX_INJECT = 5;

function readStdinSync() { try { return fs.readFileSync(0, "utf8"); } catch (_e) { return ""; } }
function safeParse(s) { try { return JSON.parse(s); } catch (_e) { return null; } }

function extractPrompt(ev) {
  if (typeof ev.prompt === "string") return ev.prompt;
  if (typeof ev.user_prompt === "string") return ev.user_prompt;
  if (ev.message && typeof ev.message.content === "string") return ev.message.content;
  if (ev.message && Array.isArray(ev.message.content)) {
    return ev.message.content.map(c => (typeof c === "string" ? c : (c && c.text) || "")).join("\n");
  }
  return "";
}

function main() {
  const ev = safeParse(readStdinSync()) || {};
  const session_id = ev.session_id || null;
  const prompt = extractPrompt(ev);
  if (!prompt) { process.exit(0); }

  let knowledgeDb = null, globalDb = null, eventsDb = null;
  try { knowledgeDb = openKnowledgeDb(resolveProjectDbPath()); } catch (_e) {}
  try { globalDb = openKnowledgeDb(resolveGlobalDbPath()); } catch (_e) {}
  try { eventsDb = openEventsDb(resolveEventsDbPath()); } catch (_e) {}

  const rules = [];
  if (knowledgeDb) rules.push(...listRules(knowledgeDb));
  if (globalDb) rules.push(...listRules(globalDb));

  const hits = runMatch(prompt, rules);
  logHook(eventsDb, "UserPromptSubmit", {
    kind: "prompt_match",
    session_id,
    payload: { hit_count: hits.length, rule_ids: hits.map(h => h.rule.id) },
  });

  for (const db of [knowledgeDb, globalDb, eventsDb]) closeDb(db);

  if (hits.length === 0) { process.exit(0); }

  const lines = ["TeamAgent rule reminder (do not repeat past mistakes):"];
  for (const h of hits.slice(0, MAX_INJECT)) {
    const r = h.rule;
    lines.push(`- [${r.id}] wrong: ${r.wrong} | correct: ${r.correct} | why: ${r.why} | tier: ${r.tier} (wilson ${r.wilson_lower.toFixed(2)})`);
  }
  const out = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: lines.join("\n"),
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

try { main(); } catch (err) {
  try { process.stderr.write("teamagent userprompt-inject error: " + (err && err.message) + "\n"); } catch (_e) {}
  process.exit(0);
}
```

- [ ] **Step 4: PASS + commit**

```bash
npx vitest run test/integration/userprompt.test.cjs
git add hooks/userprompt-inject.cjs test/integration/userprompt.test.cjs
git commit -m "M1.14 userprompt-inject rewrite — db-backed, fast-path only"
```

---

## Task 15: hooks/pretooluse-enforce.cjs — four-tier, fast-path only

**Files:**
- Modify: `plugins/teamagent-memory/hooks/pretooluse-enforce.cjs`
- Test: `plugins/teamagent-memory/test/integration/pretooluse.test.cjs`

- [ ] **Step 1: Write failing integration test**

```javascript
// test/integration/pretooluse.test.cjs
const { describe, it, expect } = require("vitest");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { openKnowledgeDb, closeDb } = require("../../hooks/lib/db.cjs");
const { insertRule } = require("../../hooks/lib/rules.cjs");

function tmpHome() {
  const d = path.join(os.tmpdir(), `tpt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const HOOK = path.join(__dirname, "..", "..", "hooks", "pretooluse-enforce.cjs");

function rule(over = {}) {
  return {
    id: "rule-block", scope: "global", tier: "canonical+",
    wrong: "Adopting moment", correct: "Use dayjs", why: "deprecated",
    match_regex: "(npm|pnpm|yarn)\\s+(install|add)\\s+moment", match_literals: ["moment"],
    match_tools: ["Bash"], match_scope_globs: null,
    embedding: null, embed_model: null, embed_text: "x",
    hits: 30, misses: 0, exceptions: 0, wilson_lower: 0.93,
    last_seen_at: "2026-05-14T00:00:00Z", last_demerit_at: null,
    captured_at: "2026-04-01T00:00:00Z", session_origin: null, source_text: null, evidence_json: null,
    ...over,
  };
}

function runHook(input, HOME) {
  return spawnSync("node", [HOOK], { input, env: { ...process.env, HOME, USERPROFILE: HOME }, encoding: "utf8" });
}

describe("pretooluse four tiers (Bash)", () => {
  it("canonical+ rule -> block (score >= 0.85)", () => {
    const HOME = tmpHome();
    const gdb = openKnowledgeDb(path.join(HOME, ".teamagent", "global.db"));
    insertRule(gdb, rule()); closeDb(gdb);
    const r = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm install moment" } }), HOME);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/rule-block/);
  });

  it("canonical rule -> warn (deny but allow retry message)", () => {
    const HOME = tmpHome();
    const gdb = openKnowledgeDb(path.join(HOME, ".teamagent", "global.db"));
    insertRule(gdb, rule({ id: "rule-warn", tier: "canonical", hits: 10, wilson_lower: 0.72 }));
    closeDb(gdb);
    const r = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm install moment" } }), HOME);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/warn/i);
  });

  it("experimental rule -> suggest (ask)", () => {
    const HOME = tmpHome();
    const gdb = openKnowledgeDb(path.join(HOME, ".teamagent", "global.db"));
    insertRule(gdb, rule({ id: "rule-sug", tier: "experimental", hits: 1, wilson_lower: 0.5 }));
    closeDb(gdb);
    const r = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm install moment" } }), HOME);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("no match -> pass (no output)", () => {
    const HOME = tmpHome();
    openKnowledgeDb(path.join(HOME, ".teamagent", "global.db"));
    const r = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls -la" } }), HOME);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });

  it("Edit tool uses new_string", () => {
    const HOME = tmpHome();
    const gdb = openKnowledgeDb(path.join(HOME, ".teamagent", "global.db"));
    insertRule(gdb, rule({ id: "rule-edit", match_regex: null, match_literals: ["moment"], match_tools: ["Bash","Edit"] }));
    closeDb(gdb);
    const r = runHook(JSON.stringify({ tool_name: "Edit", tool_input: { new_string: "import moment from 'moment'", file_path: "/repo/x.ts" } }), HOME);
    const out = r.stdout ? JSON.parse(r.stdout) : null;
    expect(out).toBeTruthy();
    expect(out.hookSpecificOutput.permissionDecision).toBeDefined();
  });
});
```

- [ ] **Step 2: Verify FAIL**

- [ ] **Step 3: Replace implementation**

```javascript
// hooks/pretooluse-enforce.cjs
#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { resolveProjectDbPath, resolveGlobalDbPath, resolveEventsDbPath } = require("./lib/paths.cjs");
const { openKnowledgeDb, openEventsDb, closeDb } = require("./lib/db.cjs");
const { listRules } = require("./lib/rules.cjs");
const { runMatch } = require("./lib/match.cjs");
const { logHook } = require("./lib/log.cjs");

const THRESH = { block: 0.85, warn: 0.65, suggest: 0.45, passive: 0.25 };

function readStdinSync() { try { return fs.readFileSync(0, "utf8"); } catch (_e) { return ""; } }
function safeParse(s) { try { return JSON.parse(s); } catch (_e) { return null; } }

function extractQuery(toolName, input) {
  if (!input || typeof input !== "object") return "";
  if (toolName === "Bash") return typeof input.command === "string" ? input.command : "";
  if (toolName === "Edit") {
    const ns = typeof input.new_string === "string" ? input.new_string.slice(0, 200) : "";
    const fp = typeof input.file_path === "string" ? path.basename(input.file_path) : "";
    return ns ? ns + " :: " + fp : "";
  }
  if (toolName === "Write") {
    const c = typeof input.content === "string" ? input.content.slice(0, 500) : "";
    const fp = typeof input.file_path === "string" ? path.basename(input.file_path) : "";
    return c ? c + " :: " + fp : "";
  }
  return "";
}

function decisionFor(score) {
  if (score >= THRESH.block) return "block";
  if (score >= THRESH.warn) return "warn";
  if (score >= THRESH.suggest) return "suggest";
  if (score >= THRESH.passive) return "passive";
  return "pass";
}

function buildReason(rule, decision, sim, wilson, score) {
  const lines = [
    `TeamAgent rule ${rule.id} ${decision === "warn" ? "blocks this (warn-tier)" : decision === "block" ? "blocks this" : "suggests a change"}.`,
    `- wrong:   ${rule.wrong}`,
    `- correct: ${rule.correct}`,
    `- why:     ${rule.why}`,
    `- score:   ${score.toFixed(2)} (sim=${sim.toFixed(2)}, wilson=${wilson.toFixed(2)}, tier=${rule.tier})`,
    `- hits/misses: ${rule.hits}/${rule.misses}; last_seen ${rule.last_seen_at || "never"}`,
  ];
  if (decision === "warn") lines.push("If this is a false positive: > /mute-rule " + rule.id);
  if (decision === "suggest") lines.push("Suggestion only — you can proceed.");
  return lines.join("\n");
}

function main() {
  const ev = safeParse(readStdinSync()) || {};
  const toolName = ev.tool_name || (ev.tool && ev.tool.name);
  const toolInput = ev.tool_input || (ev.tool && ev.tool.input) || {};
  const session_id = ev.session_id || null;

  if (!["Bash", "Edit", "Write"].includes(toolName)) { process.exit(0); }
  const query = extractQuery(toolName, toolInput);
  if (!query) { process.exit(0); }

  let knowledgeDb = null, globalDb = null, eventsDb = null;
  try { knowledgeDb = openKnowledgeDb(resolveProjectDbPath()); } catch (_e) {}
  try { globalDb = openKnowledgeDb(resolveGlobalDbPath()); } catch (_e) {}
  try { eventsDb = openEventsDb(resolveEventsDbPath()); } catch (_e) {}

  const rules = [];
  if (knowledgeDb) rules.push(...listRules(knowledgeDb));
  if (globalDb) rules.push(...listRules(globalDb));
  // tool filter
  const eligible = rules.filter(r => Array.isArray(r.match_tools) && r.match_tools.includes(toolName));

  const matches = runMatch(query, eligible);
  let best = null;
  for (const m of matches) {
    const sim = m.sim;
    const wilson = typeof m.rule.wilson_lower === "number" ? m.rule.wilson_lower : 0.5;
    const score = sim * wilson;
    if (!best || score > best.score) best = { rule: m.rule, sim, wilson, score };
  }

  const decision = best ? decisionFor(best.score) : "pass";

  logHook(eventsDb, "PreToolUse", {
    kind: "pretooluse_" + decision,
    session_id,
    rule_id: best ? best.rule.id : null,
    tool_name: toolName,
    decision,
    score: best ? best.score : 0,
    payload: { command: query.slice(0, 500) },
  });

  for (const db of [knowledgeDb, globalDb, eventsDb]) closeDb(db);

  if (decision === "pass" || decision === "passive") { process.exit(0); }

  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision === "suggest" ? "ask" : "deny",
      permissionDecisionReason: buildReason(best.rule, decision, best.sim, best.wilson, best.score),
    },
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

try { main(); } catch (err) {
  try { process.stderr.write("teamagent pretooluse error: " + (err && err.message) + "\n"); } catch (_e) {}
  process.exit(0);
}
```

- [ ] **Step 4: PASS + commit**

```bash
npx vitest run test/integration/pretooluse.test.cjs
git add hooks/pretooluse-enforce.cjs test/integration/pretooluse.test.cjs
git commit -m "M1.15 pretooluse rewrite — four tiers, Bash+Edit+Write, fast-path only"
```

---

## Task 16: hooks/posttool-record.cjs — record-only (override detection in M3)

**Files:**
- Create: `plugins/teamagent-memory/hooks/posttool-record.cjs`
- Test: `plugins/teamagent-memory/test/integration/posttool.test.cjs`

- [ ] **Step 1: Write failing test**

```javascript
// test/integration/posttool.test.cjs
const { describe, it, expect } = require("vitest");
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { openEventsDb, closeDb } = require("../../hooks/lib/db.cjs");
const { readEvents } = require("../../hooks/lib/events.cjs");
const { resolveEventsDbPath } = require("../../hooks/lib/paths.cjs");

function tmpHome() {
  const d = path.join(os.tmpdir(), `tpost-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const HOOK = path.join(__dirname, "..", "..", "hooks", "posttool-record.cjs");

describe("posttool-record", () => {
  it("records tool result event with exit code and stderr excerpt", () => {
    const HOME = tmpHome();
    const env = { ...process.env, HOME, USERPROFILE: HOME };
    const input = JSON.stringify({
      session_id: "S1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: { exit_code: 0, stderr: "" },
    });
    const r = spawnSync("node", [HOOK], { input, env, encoding: "utf8" });
    expect(r.status).toBe(0);
    const db = openEventsDb(resolveEventsDbPath());
    const ev = readEvents(db, { limit: 1 })[0];
    expect(ev.kind).toBe("posttool_ok");
    expect(ev.tool_name).toBe("Bash");
    closeDb(db);
  });

  it("records posttool_fail when exit_code != 0", () => {
    const HOME = tmpHome();
    const env = { ...process.env, HOME, USERPROFILE: HOME };
    const input = JSON.stringify({
      session_id: "S1", tool_name: "Bash",
      tool_input: { command: "false" },
      tool_response: { exit_code: 1, stderr: "boom" },
    });
    const r = spawnSync("node", [HOOK], { input, env, encoding: "utf8" });
    expect(r.status).toBe(0);
    const db = openEventsDb(resolveEventsDbPath());
    const ev = readEvents(db, { limit: 1 })[0];
    expect(ev.kind).toBe("posttool_fail");
    closeDb(db);
  });
});
```

- [ ] **Step 2: Verify FAIL**

- [ ] **Step 3: Write implementation**

```javascript
// hooks/posttool-record.cjs
#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { resolveEventsDbPath } = require("./lib/paths.cjs");
const { openEventsDb, closeDb } = require("./lib/db.cjs");
const { logHook } = require("./lib/log.cjs");

function readStdinSync() { try { return fs.readFileSync(0, "utf8"); } catch (_e) { return ""; } }
function safeParse(s) { try { return JSON.parse(s); } catch (_e) { return null; } }

function main() {
  const ev = safeParse(readStdinSync()) || {};
  const session_id = ev.session_id || null;
  const tool_name = ev.tool_name || (ev.tool && ev.tool.name) || null;
  const resp = ev.tool_response || ev.toolResult || {};
  const exit_code = typeof resp.exit_code === "number" ? resp.exit_code : (typeof resp.exitCode === "number" ? resp.exitCode : null);
  const stderr = typeof resp.stderr === "string" ? resp.stderr.slice(0, 500) : null;

  let eventsDb = null;
  try { eventsDb = openEventsDb(resolveEventsDbPath()); } catch (_e) {}

  const kind = exit_code === 0 || exit_code === null ? "posttool_ok" : "posttool_fail";
  logHook(eventsDb, "PostToolUse", {
    kind,
    session_id,
    tool_name,
    payload: {
      exit_code,
      stderr_excerpt: stderr,
      command: ev.tool_input && typeof ev.tool_input.command === "string" ? ev.tool_input.command.slice(0, 500) : null,
    },
  });

  closeDb(eventsDb);
  process.exit(0);
}

try { main(); } catch (err) {
  try { process.stderr.write("teamagent posttool error: " + (err && err.message) + "\n"); } catch (_e) {}
  process.exit(0);
}
```

- [ ] **Step 4: PASS + commit**

```bash
npx vitest run test/integration/posttool.test.cjs
git add hooks/posttool-record.cjs test/integration/posttool.test.cjs
git commit -m "M1.16 posttool-record — minimal event log (override detection deferred to M3)"
```

---

## Task 17: hooks/stop-capture.cjs — 4-stage pipeline

**Files:**
- Modify: `plugins/teamagent-memory/hooks/stop-capture.cjs`
- Test: `plugins/teamagent-memory/test/integration/stop-pipeline.test.cjs`

- [ ] **Step 1: Write failing integration test**

```javascript
// test/integration/stop-pipeline.test.cjs
const { describe, it, expect } = require("vitest");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { openKnowledgeDb, closeDb } = require("../../hooks/lib/db.cjs");
const { listRules } = require("../../hooks/lib/rules.cjs");
const { resolveGlobalDbPath } = require("../../hooks/lib/paths.cjs");

function tmpHome() {
  const d = path.join(os.tmpdir(), `tstop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const HOOK = path.join(__dirname, "..", "..", "hooks", "stop-capture.cjs");
const FIX = path.join(__dirname, "..", "fixtures", "transcripts", "correction-moment.jsonl");
const FAKE_CLAUDE = path.join(__dirname, "..", "fixtures", "fake-claude.cjs");

describe("stop-capture 4-stage pipeline", () => {
  it("analyzes fixture, extracts rule via fake claude, inserts into global.db", () => {
    const HOME = tmpHome();
    const env = {
      ...process.env, HOME, USERPROFILE: HOME,
      TEAMAGENT_CLAUDE_BIN: `node ${FAKE_CLAUDE}`,
      FAKE_CLAUDE_MODE: "ok",
    };
    const input = JSON.stringify({ session_id: "S1", transcript_path: FIX });
    const r = spawnSync("node", [HOOK], { input, env, encoding: "utf8", timeout: 30000 });
    expect(r.status).toBe(0);
    const gdb = openKnowledgeDb(path.join(HOME, ".teamagent", "global.db"));
    const rules = listRules(gdb);
    expect(rules.length).toBeGreaterThan(0);
    expect(rules[0].wrong).toMatch(/moment/i);
    closeDb(gdb);
  });

  it("survives missing transcript", () => {
    const HOME = tmpHome();
    const env = { ...process.env, HOME, USERPROFILE: HOME };
    const input = JSON.stringify({ session_id: "S1", transcript_path: "/nonexistent/x.jsonl" });
    const r = spawnSync("node", [HOOK], { input, env, encoding: "utf8" });
    expect(r.status).toBe(0);
  });
});
```

- [ ] **Step 2: Verify FAIL**

- [ ] **Step 3: Replace implementation**

```javascript
// hooks/stop-capture.cjs
#!/usr/bin/env node
"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { resolveProjectDbPath, resolveGlobalDbPath, resolveEventsDbPath } = require("./lib/paths.cjs");
const { openKnowledgeDb, openEventsDb, closeDb } = require("./lib/db.cjs");
const { insertRule, getRule, updateRule } = require("./lib/rules.cjs");
const { findCandidates } = require("./lib/analyze.cjs");
const { runExtract, dedupHash } = require("./lib/extract.cjs");
const { applyEvent, wilsonLowerBound } = require("./lib/confidence.cjs");
const { lintRegex } = require("./lib/redos.cjs");
const { logHook } = require("./lib/log.cjs");
const { readEvents } = require("./lib/events.cjs");

const STOP_BUDGET_MS = 25000;

function readStdinSync() { try { return fs.readFileSync(0, "utf8"); } catch (_e) { return ""; } }
function safeParse(s) { try { return JSON.parse(s); } catch (_e) { return null; } }

function nowIso() { return new Date().toISOString(); }

function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
}

function isoDate() { return new Date().toISOString().slice(0, 10); }

function pickDbForScope(scope, knowledgeDb, globalDb) {
  return scope === "project" ? (knowledgeDb || globalDb) : (globalDb || knowledgeDb);
}

function isDuplicate(eventsDb, hash) {
  if (!eventsDb) return false;
  try {
    const rows = readEvents(eventsDb, { kind: "stop_extract", limit: 500 });
    return rows.some(r => {
      try { const p = r.payload_json ? JSON.parse(r.payload_json) : null; return p && p.dedup_hash === hash; }
      catch (_e) { return false; }
    });
  } catch (_e) { return false; }
}

async function processCandidate(cand, ctx) {
  const { transcript_path, knowledgeDb, globalDb, eventsDb, session_id, claudeBin, env } = ctx;
  const hash = dedupHash(transcript_path, cand.turn_index);
  if (isDuplicate(eventsDb, hash)) {
    logHook(eventsDb, "Stop", { kind: "stop_extract_skipped", payload: { dedup_hash: hash, reason: "duplicate" }, session_id });
    return;
  }

  const extracted = await runExtract(cand.context_turns, { claudeBin, env, timeoutMs: 30000 });
  logHook(eventsDb, "Stop", {
    kind: "stop_extract",
    session_id,
    payload: { dedup_hash: hash, ok: !!extracted, turn_index: cand.turn_index },
  });
  if (!extracted || !extracted.is_actionable_rule) return;

  // sanitize regex
  let matchRegex = null;
  if (extracted.match_regex && typeof extracted.match_regex === "string") {
    const lint = lintRegex(extracted.match_regex);
    if (lint.ok) matchRegex = extracted.match_regex;
    else logHook(eventsDb, "Stop", { kind: "rule_regex_rejected", payload: { reason: lint.reason }, session_id });
  }

  const scope = extracted.scope_hint === "project" ? "project" : "global";
  const db = pickDbForScope(scope, knowledgeDb, globalDb);
  if (!db) return;

  const wrongSlug = slug(extracted.wrong);
  const correctSlug = slug(extracted.correct);
  const id = `rule-${isoDate()}-${wrongSlug}-${correctSlug}`;
  const embedText = `${extracted.wrong}. ${extracted.correct}. ${extracted.why}`.trim();

  const existing = getRule(db, id);
  if (existing) {
    const next = applyEvent(existing, { kind: "hit", at: nowIso() });
    updateRule(db, id, { hits: next.hits, wilson_lower: next.wilson_lower, last_seen_at: next.last_seen_at, tier: next.tier });
    logHook(eventsDb, "Stop", { kind: "rule_updated", rule_id: id, session_id });
    return;
  }

  const hint = typeof extracted.confidence_hint === "number" ? extracted.confidence_hint : 0.5;
  const prior = hint >= 0.9 ? 0.6 : (hint >= 0.7 ? 0.55 : 0.5);

  insertRule(db, {
    id, scope, tier: "experimental",
    wrong: extracted.wrong, correct: extracted.correct, why: extracted.why,
    match_regex: matchRegex,
    match_literals: Array.isArray(extracted.match_literals) ? extracted.match_literals.slice(0, 8) : null,
    match_tools: Array.isArray(extracted.match_tools) && extracted.match_tools.length ? extracted.match_tools : ["Bash"],
    match_scope_globs: null,
    embedding: null, embed_model: null,
    embed_text: embedText,
    hits: 0, misses: 0, exceptions: 0, wilson_lower: prior,
    last_seen_at: null, last_demerit_at: null,
    captured_at: nowIso(),
    session_origin: session_id,
    source_text: cand.context_turns.map(t => {
      const c = t && t.message && t.message.content;
      return typeof c === "string" ? c : "";
    }).join("\n").slice(0, 800),
    evidence_json: { transcript_path, turn_index: cand.turn_index },
  });
  logHook(eventsDb, "Stop", { kind: "rule_created", rule_id: id, session_id });
}

async function main() {
  const ev = safeParse(readStdinSync()) || {};
  const transcript_path = ev.transcript_path || (ev.session && ev.session.transcript_path) || null;
  const session_id = ev.session_id || (ev.session && ev.session.id) || null;

  let knowledgeDb = null, globalDb = null, eventsDb = null;
  try { knowledgeDb = openKnowledgeDb(resolveProjectDbPath()); } catch (_e) {}
  try { globalDb = openKnowledgeDb(resolveGlobalDbPath()); } catch (_e) {}
  try { eventsDb = openEventsDb(resolveEventsDbPath()); } catch (_e) {}

  if (!transcript_path) {
    logHook(eventsDb, "Stop", { kind: "stop_skipped", payload: { reason: "no_transcript" }, session_id });
    for (const db of [knowledgeDb, globalDb, eventsDb]) closeDb(db);
    process.exit(0);
  }

  // analyze
  const cands = findCandidates(transcript_path, 0);
  logHook(eventsDb, "Stop", { kind: "stop_analyze", payload: { candidate_count: cands.length }, session_id });
  if (cands.length === 0) {
    for (const db of [knowledgeDb, globalDb, eventsDb]) closeDb(db);
    process.exit(0);
  }

  // extract (serial; budget guard)
  const claudeBinSpec = process.env.TEAMAGENT_CLAUDE_BIN ? process.env.TEAMAGENT_CLAUDE_BIN.split(/\s+/) : ["claude"];
  const startedAt = Date.now();
  for (const cand of cands) {
    if (Date.now() - startedAt > STOP_BUDGET_MS) {
      logHook(eventsDb, "Stop", { kind: "stop_extract_skipped_remainder", session_id });
      break;
    }
    await processCandidate(cand, { transcript_path, knowledgeDb, globalDb, eventsDb, session_id, claudeBin: claudeBinSpec, env: process.env });
  }

  for (const db of [knowledgeDb, globalDb, eventsDb]) closeDb(db);
  process.exit(0);
}

main().catch(err => {
  try { process.stderr.write("teamagent stop error: " + (err && err.message) + "\n"); } catch (_e) {}
  process.exit(0);
});
```

- [ ] **Step 4: PASS + commit**

```bash
npx vitest run test/integration/stop-pipeline.test.cjs
git add hooks/stop-capture.cjs test/integration/stop-pipeline.test.cjs
git commit -m "M1.17 stop-capture rewrite — 4-stage pipeline (analyze/extract/calibrate)"
```

---

## Task 18: hooks/hooks.json — wire all 5 hooks

**Files:**
- Modify: `plugins/teamagent-memory/hooks/hooks.json`

- [ ] **Step 1: Replace contents**

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/sessionstart.cjs" } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/userprompt-inject.cjs" } ] }
    ],
    "PreToolUse": [
      { "matcher": "Bash|Edit|Write",
        "hooks": [ { "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse-enforce.cjs" } ]
      }
    ],
    "PostToolUse": [
      { "matcher": "Bash|Edit|Write",
        "hooks": [ { "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/posttool-record.cjs" } ]
      }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/stop-capture.cjs" } ] }
    ]
  }
}
```

- [ ] **Step 2: Syntax check all hooks**

Run: `npm run lint:hooks`
Expected: no output (all files parse).

- [ ] **Step 3: Commit**

```bash
git add hooks/hooks.json
git commit -m "M1.18 hooks.json — wire 5 hooks (SessionStart/PostToolUse new, PreToolUse widened)"
```

---

## Task 19: bin/teamagent — CLI rewrite for v0.2 subcommands

**Files:**
- Modify: `plugins/teamagent-memory/bin/teamagent`
- Test: `plugins/teamagent-memory/test/integration/cli.test.cjs`

- [ ] **Step 1: Write failing test**

```javascript
// test/integration/cli.test.cjs
const { describe, it, expect } = require("vitest");
const { spawnSync } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { openKnowledgeDb, closeDb } = require("../../hooks/lib/db.cjs");
const { insertRule } = require("../../hooks/lib/rules.cjs");

function tmpHome() {
  const d = path.join(os.tmpdir(), `tcli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const CLI = path.join(__dirname, "..", "..", "bin", "teamagent");
function run(args, HOME) {
  return spawnSync("bash", [CLI, ...args], { env: { ...process.env, HOME, USERPROFILE: HOME }, encoding: "utf8" });
}

function sample(over = {}) {
  return {
    id: "r1", scope: "global", tier: "canonical",
    wrong: "x", correct: "y", why: "z",
    match_regex: null, match_literals: ["x"], match_tools: ["Bash"], match_scope_globs: null,
    embedding: null, embed_model: null, embed_text: "x. y. z",
    hits: 3, misses: 0, exceptions: 0, wilson_lower: 0.6,
    last_seen_at: null, last_demerit_at: null,
    captured_at: "2026-05-15T00:00:00Z", session_origin: null, source_text: null, evidence_json: null,
    ...over,
  };
}

describe("teamagent CLI v0.2", () => {
  it("--version prints version", () => {
    const r = run(["--version"], tmpHome());
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/teamagent-memory\s+0\.2/);
  });

  it("list shows inserted rules", () => {
    const HOME = tmpHome();
    const gdb = openKnowledgeDb(path.join(HOME, ".teamagent", "global.db"));
    insertRule(gdb, sample());
    closeDb(gdb);
    const r = run(["list"], HOME);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/r1/);
  });

  it("inspect returns the rule", () => {
    const HOME = tmpHome();
    const gdb = openKnowledgeDb(path.join(HOME, ".teamagent", "global.db"));
    insertRule(gdb, sample());
    closeDb(gdb);
    const r = run(["inspect", "r1"], HOME);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/wilson_lower/);
  });

  it("mute archives the rule", () => {
    const HOME = tmpHome();
    const gdb = openKnowledgeDb(path.join(HOME, ".teamagent", "global.db"));
    insertRule(gdb, sample()); closeDb(gdb);
    const r = run(["mute", "r1"], HOME);
    expect(r.status).toBe(0);
    const r2 = run(["list"], HOME);
    expect(r2.stdout).not.toMatch(/r1/);
  });

  it("doctor passes on healthy DBs", () => {
    const HOME = tmpHome();
    openKnowledgeDb(path.join(HOME, ".teamagent", "global.db"));
    const r = run(["doctor"], HOME);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/ok/i);
  });
});
```

- [ ] **Step 2: Verify FAIL**

- [ ] **Step 3: Replace CLI with Node-backed wrapper**

```bash
#!/usr/bin/env bash
# teamagent CLI — delegates to bin/teamagent.cjs (Node) for SQLite logic.

set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "${DIR}/teamagent.cjs" "$@"
```

- [ ] **Step 4: Write `bin/teamagent.cjs`**

```javascript
#!/usr/bin/env node
// bin/teamagent.cjs — v0.2 CLI
"use strict";

const path = require("path");
const fs = require("fs");
const HOOKS_LIB = path.join(__dirname, "..", "hooks", "lib");
const { resolveProjectDbPath, resolveGlobalDbPath, resolveEventsDbPath } = require(path.join(HOOKS_LIB, "paths.cjs"));
const { openKnowledgeDb, openEventsDb, closeDb } = require(path.join(HOOKS_LIB, "db.cjs"));
const { listRules, getRule, updateRule, archiveRule } = require(path.join(HOOKS_LIB, "rules.cjs"));
const { readEvents } = require(path.join(HOOKS_LIB, "events.cjs"));
const { applyEvent } = require(path.join(HOOKS_LIB, "confidence.cjs"));
const { getSchemaVersion } = require(path.join(HOOKS_LIB, "schema.cjs"));

const VERSION = "0.2.0-alpha.1";

function usage() {
  console.log(`teamagent — TeamAgent memory store CLI (v${VERSION})

Usage:
  teamagent list [--tier T] [--scope project|global]
  teamagent inspect <id>
  teamagent events [N] [--rule R]
  teamagent mute <id>            archive
  teamagent demote <id>          misses+=1
  teamagent promote <id>         hits+=1
  teamagent doctor               self-check
  teamagent export [--rule id]   JSON dump
  teamagent forget --rule <id>   physical delete
  teamagent gc [--dry-run]       trigger gc
  teamagent --version
`);
}

function bothDbs() {
  const result = { knowledge: null, global: null };
  try { result.knowledge = openKnowledgeDb(resolveProjectDbPath()); } catch (_e) {}
  try { result.global = openKnowledgeDb(resolveGlobalDbPath()); } catch (_e) {}
  return result;
}
function closeAll(dbs) { for (const k of Object.keys(dbs)) closeDb(dbs[k]); }
function findRule(dbs, id) {
  for (const k of ["knowledge", "global"]) {
    if (!dbs[k]) continue;
    const r = getRule(dbs[k], id);
    if (r) return { db: dbs[k], rule: r };
  }
  return null;
}

function cmdList(args) {
  const dbs = bothDbs();
  const filter = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tier") filter.tier = args[++i];
    else if (args[i] === "--scope") filter.scope = args[++i];
  }
  const rows = [];
  for (const k of ["knowledge", "global"]) {
    if (!dbs[k]) continue;
    let list = listRules(dbs[k]);
    if (filter.tier) list = list.filter(r => r.tier === filter.tier);
    if (filter.scope) list = list.filter(r => r.scope === filter.scope);
    rows.push(...list);
  }
  if (rows.length === 0) { console.log("(no rules)"); closeAll(dbs); return 0; }
  for (const r of rows) {
    console.log(`${r.id}\t${r.tier}\twilson=${r.wilson_lower.toFixed(2)}\thits=${r.hits}\tmisses=${r.misses}\twrong: ${r.wrong}`);
  }
  closeAll(dbs);
  return 0;
}

function cmdInspect(args) {
  const id = args[0];
  if (!id) { console.error("inspect: missing id"); return 2; }
  const dbs = bothDbs();
  const found = findRule(dbs, id);
  if (!found) { console.error("rule not found"); closeAll(dbs); return 1; }
  console.log(JSON.stringify(found.rule, null, 2));
  closeAll(dbs);
  return 0;
}

function cmdEvents(args) {
  let n = 50, rule = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rule") rule = args[++i];
    else if (/^\d+$/.test(args[i])) n = parseInt(args[i], 10);
  }
  let db = null;
  try { db = openEventsDb(resolveEventsDbPath()); } catch (_e) { console.error("cannot open events.db"); return 1; }
  const rows = readEvents(db, { limit: n, rule_id: rule });
  for (const r of rows.reverse()) {
    console.log(`${r.ts}\t${r.kind}\t${r.rule_id || ""}\t${r.decision || ""}\t${r.payload_json || ""}`);
  }
  closeDb(db);
  return 0;
}

function cmdMute(args) {
  const id = args[0]; if (!id) return 2;
  const dbs = bothDbs();
  const found = findRule(dbs, id);
  if (!found) { closeAll(dbs); return 1; }
  archiveRule(found.db, id);
  console.log(`archived ${id}`);
  closeAll(dbs);
  return 0;
}

function cmdDemote(args) {
  const id = args[0]; if (!id) return 2;
  const dbs = bothDbs();
  const found = findRule(dbs, id);
  if (!found) { closeAll(dbs); return 1; }
  const next = applyEvent(found.rule, { kind: "miss", at: new Date().toISOString() });
  updateRule(found.db, id, { misses: next.misses, wilson_lower: next.wilson_lower, last_demerit_at: next.last_demerit_at, tier: next.tier });
  console.log(`demoted ${id} -> tier=${next.tier} wilson=${next.wilson_lower.toFixed(2)}`);
  closeAll(dbs);
  return 0;
}

function cmdPromote(args) {
  const id = args[0]; if (!id) return 2;
  const dbs = bothDbs();
  const found = findRule(dbs, id);
  if (!found) { closeAll(dbs); return 1; }
  const next = applyEvent(found.rule, { kind: "hit", at: new Date().toISOString() });
  updateRule(found.db, id, { hits: next.hits, wilson_lower: next.wilson_lower, last_seen_at: next.last_seen_at, tier: next.tier });
  console.log(`promoted ${id} -> tier=${next.tier} wilson=${next.wilson_lower.toFixed(2)}`);
  closeAll(dbs);
  return 0;
}

function cmdDoctor() {
  let ok = true;
  for (const [name, p] of [["knowledge", resolveProjectDbPath()], ["global", resolveGlobalDbPath()], ["events", resolveEventsDbPath()]]) {
    try {
      const db = name === "events" ? openEventsDb(p) : openKnowledgeDb(p);
      const v = getSchemaVersion(db);
      console.log(`${name}\t${p}\tschema=${v}\tok`);
      closeDb(db);
    } catch (e) { ok = false; console.error(`${name}\t${p}\tERROR: ${e.message}`); }
  }
  return ok ? 0 : 1;
}

function cmdExport(args) {
  let ruleFilter = null;
  for (let i = 0; i < args.length; i++) if (args[i] === "--rule") ruleFilter = args[++i];
  const dbs = bothDbs();
  const out = [];
  for (const k of ["knowledge", "global"]) {
    if (!dbs[k]) continue;
    for (const r of listRules(dbs[k], { includeArchived: true })) {
      if (ruleFilter && r.id !== ruleFilter) continue;
      out.push(r);
    }
  }
  console.log(JSON.stringify(out, null, 2));
  closeAll(dbs);
  return 0;
}

function cmdForget(args) {
  let id = null;
  for (let i = 0; i < args.length; i++) if (args[i] === "--rule") id = args[++i];
  if (!id) { console.error("forget: --rule <id> required"); return 2; }
  const dbs = bothDbs();
  for (const k of ["knowledge", "global"]) {
    if (!dbs[k]) continue;
    const r = getRule(dbs[k], id);
    if (r) dbs[k].prepare("DELETE FROM rules WHERE id = ?").run(id);
  }
  let ev = null;
  try { ev = openEventsDb(resolveEventsDbPath()); ev.prepare("DELETE FROM events WHERE rule_id = ?").run(id); } catch (_e) {}
  closeDb(ev);
  console.log(`forgot ${id}`);
  closeAll(dbs);
  return 0;
}

function cmdGc(args) {
  const dryRun = args.includes("--dry-run");
  const dbs = bothDbs();
  const cutoff = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  let archived = 0;
  for (const k of ["knowledge", "global"]) {
    if (!dbs[k]) continue;
    const rows = dbs[k].prepare(`SELECT id FROM rules WHERE tier='experimental' AND hits=0 AND captured_at < ?`).all(cutoff);
    archived += rows.length;
    if (!dryRun) {
      dbs[k].prepare(`UPDATE rules SET tier='archived' WHERE tier='experimental' AND hits=0 AND captured_at < ?`).run(cutoff);
    }
  }
  console.log(`${dryRun ? "[dry-run] " : ""}archived ${archived} stale experimental rules`);
  closeAll(dbs);
  return 0;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "--version":
    case "-v":
      console.log(`teamagent-memory ${VERSION}`); return 0;
    case "list": return cmdList(rest);
    case "inspect": return cmdInspect(rest);
    case "events": return cmdEvents(rest);
    case "mute": return cmdMute(rest);
    case "demote": return cmdDemote(rest);
    case "promote": return cmdPromote(rest);
    case "doctor": return cmdDoctor();
    case "export": return cmdExport(rest);
    case "forget": return cmdForget(rest);
    case "gc": return cmdGc(rest);
    case undefined:
    case "":
    case "-h":
    case "--help":
    case "help":
      usage(); return 0;
    default:
      console.error("unknown subcommand: " + cmd); usage(); return 2;
  }
}

process.exit(main(process.argv.slice(2)));
```

- [ ] **Step 5: Make scripts executable, run tests, commit**

```bash
chmod +x bin/teamagent
npx vitest run test/integration/cli.test.cjs
git add bin/teamagent bin/teamagent.cjs test/integration/cli.test.cjs
git commit -m "M1.19 bin/teamagent — Node-backed CLI with v0.2 subcommands"
```

---

## Task 20: skills/rule-doctor SKILL — new

**Files:**
- Create: `plugins/teamagent-memory/skills/rule-doctor/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

```markdown
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

1. Invoke `bin/teamagent doctor` (or `teamagent doctor` if on PATH).
2. For each of the three rows (knowledge, global, events), confirm `schema=1` and `ok`.
3. If any row says `ERROR`, surface the error verbatim and suggest:
   - file permission issues -> `chmod 600 ~/.teamagent/*.db`
   - schema mismatch -> archive the DB and let SessionStart recreate
   - missing parent dir -> manually `mkdir -p ~/.teamagent`

## What this skill does NOT do

- Does not modify any rule
- Does not call `teamagent clear` / `forget`
- Does not access events directly — prefer `teamagent events`
```

- [ ] **Step 2: Commit**

```bash
git add skills/rule-doctor/SKILL.md
git commit -m "M1.20 skills/rule-doctor — self-check skill"
```

---

## Task 21: Update existing skills for v0.2 wording

**Files:**
- Modify: `plugins/teamagent-memory/skills/capture-correction/SKILL.md`
- Modify: `plugins/teamagent-memory/skills/explain-rule-hit/SKILL.md`
- Modify: `plugins/teamagent-memory/skills/review-new-rules/SKILL.md`

- [ ] **Step 1: capture-correction — update extraction note**

Edit `skills/capture-correction/SKILL.md` and replace the line under "What to write" that references v0.1 regex extraction with this paragraph (insert after the header):

```markdown
> **v0.2 note:** Stop hook now extracts rules via local `claude -p` (see DESIGN §4.2),
> not the 6 regex patterns from v0.1. Invoke this skill only when you want to
> capture a correction outside the automatic Stop pipeline — e.g. the user pastes a
> rule they want remembered directly.
```

Also update the schema example block to add the v0.2 fields (`scope`, `tier`, `match_regex`, `match_literals`, `match_tools`, `wilson_lower`, etc.) — copy from DESIGN §2.2.

- [ ] **Step 2: explain-rule-hit — update to 4 tiers**

Replace the explanation section with:

```markdown
## How to explain

The PreToolUse deny / ask reason includes the score and tier. Render:

1. **What was blocked or asked.** Echo the assistant's attempted command.
2. **Tier and score.** "TeamAgent rule R fired with score 0.91 (canonical+, wilson 0.96)."
3. **Why.** One sentence from `why`.
4. **Correct approach.** Quote `correct` verbatim.
5. **Escape hatch.** If the user thinks it's a false positive, mention `> /mute-rule <id>`
   (M3 will offer interactive classification).

Keep under 8 lines. Never dump JSON.
```

- [ ] **Step 3: review-new-rules — add tier + wilson columns**

Replace the "Render" section with:

```markdown
## How to render

Sort by `wilson_lower DESC, captured_at DESC`. Columns:

- `id` (truncate 40)
- `tier` (experimental | canonical | canonical+ | archived)
- `wilson_lower` (2 decimals)
- `hits` / `misses`
- `wrong` (one line)

Example:

```
rule-2026-05-13-moment-dayjs  canonical+  0.93  24/0  Adopting moment
rule-2026-05-12-axios-fetch   canonical   0.78  10/1  Adopting axios for fetch
```

Show top 20 by score; "... N more" if longer.
```

- [ ] **Step 4: Commit**

```bash
git add skills/capture-correction/SKILL.md skills/explain-rule-hit/SKILL.md skills/review-new-rules/SKILL.md
git commit -m "M1.21 update existing skills for v0.2 schema + 4-tier explanation"
```

---

## Task 22: plugin.json version bump + README update

**Files:**
- Modify: `plugins/teamagent-memory/.claude-plugin/plugin.json`
- Modify: `plugins/teamagent-memory/README.md`
- Modify (repo root): `.claude-plugin/marketplace.json`

- [ ] **Step 1: Bump plugin.json**

Read existing `plugins/teamagent-memory/.claude-plugin/plugin.json`, replace its `version` field with `"0.2.0-alpha.1"`. If it has a `description`, replace with: `"Capture corrections as SQLite-backed rule cards (LLM-extracted), match via fast-path, four-tier interception with Wilson confidence."`

- [ ] **Step 2: Bump marketplace.json**

Edit repo-root `.claude-plugin/marketplace.json`: bump the `version` of the `teamagent-memory` entry to `"0.2.0-alpha.1"` and update description in the same way.

- [ ] **Step 3: Update README front-matter section**

Replace `## Why` and `## Demo flow` in `README.md` with the v0.2 versions:

```markdown
## What's new in v0.2

- SQLite three-store: project (`<repo>/.teamagent/knowledge.db`) + global (`~/.teamagent/global.db`) + events (`~/.teamagent/events.db`)
- Stop hook 4-stage pipeline: analyze → extract (local `claude -p`) → calibrate (Wilson) → compile (stub)
- Four-tier interception: block / warn / suggest / passive — driven by candidate_score = sim × wilson_lower_bound
- New CLI: list/inspect/events/mute/demote/promote/doctor/export/forget/gc
- See `docs/DESIGN.md` for the full design and `docs/adr/` for decisions.

## Upgrading from v0.1

v0.2 does **not** auto-migrate `~/.teamagent/rules.jsonl`. New start. If you need to
preserve v0.1 rules, dump them and re-issue corrections; see `docs/adr/0009-no-migration.md`.

## Storage paths

- `<repo>/.teamagent/knowledge.db` — project rules (add to repo `.gitignore`)
- `~/.teamagent/global.db` — cross-project rules
- `~/.teamagent/events.db` — audit log
```

- [ ] **Step 4: Commit**

```bash
git add plugins/teamagent-memory/.claude-plugin/plugin.json plugins/teamagent-memory/README.md .claude-plugin/marketplace.json
git commit -m "M1.22 bump plugin to 0.2.0-alpha.1 + README v0.2 section"
```

---

## Task 23: Add `.gitignore` for `.teamagent/` at repo level

**Files:**
- Modify (create if missing): `.gitignore` (repo root)

- [ ] **Step 1: Append**

```
# teamagent-memory local stores
.teamagent/
```

- [ ] **Step 2: Verify**

Run: `git check-ignore .teamagent/knowledge.db` (after creating the path)
Expected: prints the path → it is ignored.

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "M1.23 gitignore .teamagent/ project store"
```

---

## Task 24: Smoke test runner — `npm test` runs everything

**Files:**
- Verify only

- [ ] **Step 1: Run full suite**

Run: `cd plugins/teamagent-memory && npm test`
Expected: all unit + integration tests pass. Output ends with "Tests N passed".

- [ ] **Step 2: If any failures, fix before continuing**

Each failure should fall into one of:
- Path / env mismatch in test fixture
- Native binary missing (better-sqlite3 rebuild)

Address the failure, then re-run.

- [ ] **Step 3: Commit (no changes if all passed)**

If you fixed anything, commit with `M1.24 fix <component> test`. Otherwise skip.

---

## Task 25: Manual smoke — load plugin in Claude Code with --debug

**Files:**
- Verify only (no code changes)

- [ ] **Step 1: Run Claude Code with the plugin**

```bash
cd plugins/teamagent-memory
npm install --omit=dev    # ensure better-sqlite3 prebuilt is present at runtime
cd ../..
claude --plugin-dir plugins/teamagent-memory --debug
```

- [ ] **Step 2: In the session, verify**

Type:
```
hello, please run `ls`
```

Expected (in `--debug` output): SessionStart hook fires (creates ~/.teamagent/*.db), UserPromptSubmit fires (no rules → no injection), PreToolUse fires for Bash → pass.

- [ ] **Step 3: Confirm DBs exist**

Run from another shell:
```bash
ls ~/.teamagent/
# expect: global.db  events.db
sqlite3 ~/.teamagent/events.db "SELECT kind, ts FROM events ORDER BY id DESC LIMIT 5"
# expect: rows for session_start, prompt_match (empty), pretooluse_pass
```

- [ ] **Step 4: Commit smoke results (write a note)**

```bash
mkdir -p docs/notes
cat > docs/notes/M1-smoke-2026-05-15.md <<'EOF'
# M1 smoke results

- claude --debug shows all 5 hooks discovered
- SessionStart creates ~/.teamagent/global.db and events.db
- UserPromptSubmit no rules → no injection
- PreToolUse Bash → pass (no rules)

Next: manual end-to-end correction → wait for Stop → confirm rule appears in global.db.
EOF
git add docs/notes/M1-smoke-2026-05-15.md
git commit -m "M1.25 smoke notes — hooks discoverable, DBs created"
```

---

## Task 26: End-to-end manual demo — correction → rule

**Files:**
- Verify (no code changes); appends to smoke notes if anything off

- [ ] **Step 1: In a Claude Code session (debug on), issue a correction**

```
> please run: npm install moment
(Claude proposes/runs it)
> don't use moment, use dayjs instead
> /quit
```

- [ ] **Step 2: After session ends, verify Stop pipeline ran**

```bash
sqlite3 ~/.teamagent/events.db "SELECT kind FROM events WHERE kind LIKE 'stop_%' ORDER BY id DESC LIMIT 10"
# expect: stop_analyze, stop_extract, rule_created
sqlite3 ~/.teamagent/global.db "SELECT id, wrong, correct, wilson_lower FROM rules"
# expect: a rule with wrong like "Adopting moment", correct "Use dayjs"
```

- [ ] **Step 3: In a new session, try to repeat the mistake**

```
> please run: npm install moment
```

Expected: PreToolUse `permissionDecision: "ask"` (suggest tier since experimental, wilson=0.5, score=0.5).

- [ ] **Step 4: Append a "PASS" or "FAIL with notes" to smoke doc**

```bash
echo "" >> docs/notes/M1-smoke-2026-05-15.md
echo "## End-to-end demo: PASS / FAIL — <fill in>" >> docs/notes/M1-smoke-2026-05-15.md
git add docs/notes/M1-smoke-2026-05-15.md
git commit -m "M1.26 end-to-end demo notes"
```

---

## Self-Review

Run this checklist before declaring M1 done:

**Spec coverage** — every DESIGN.md M1 line item must trace to a task:

- [x] SQLite schema v1 (3 DBs)              → Tasks 3, 4
- [x] paths + db + schema modules           → Tasks 2-4
- [x] rules CRUD                            → Task 6
- [x] events log                            → Task 5
- [x] Wilson + decay + tier                 → Task 7
- [x] ReDoS lint                            → Task 8
- [x] Fast-path match                       → Task 9
- [x] Analyze (candidate scoring)           → Task 10
- [x] Extract (claude -p)                   → Task 11
- [x] Common logger                         → Task 12
- [x] SessionStart hook                     → Task 13
- [x] UserPromptSubmit hook                 → Task 14
- [x] PreToolUse hook (Bash+Edit+Write)     → Task 15
- [x] PostToolUse hook (record-only)        → Task 16
- [x] Stop 4-stage pipeline                 → Task 17
- [x] hooks.json wiring                     → Task 18
- [x] CLI rewrite                           → Task 19
- [x] rule-doctor skill                     → Task 20
- [x] Existing skill updates                → Task 21
- [x] plugin.json + README bump             → Task 22
- [x] .gitignore                            → Task 23
- [x] Full test run                         → Task 24
- [x] Manual smoke                          → Task 25
- [x] End-to-end demo                       → Task 26

**Out of scope confirmation** — these must NOT appear in M1:
- Semantic embedding / sqlite-vec / Layer 2 matching → M2
- Override detection logic in PostToolUse → M3
- mute-rule skill reading override events → M3
- compile stage producing AGENTS.md → M5

**Placeholder scan** — searched plan for: TBD, TODO, "implement later", "add error handling", "similar to". None found in plan text. Each step includes runnable code/commands.

**Type consistency** — verified across tasks:
- `wilson_lower` (REAL) used in schema, lib/rules, lib/confidence, hooks
- `match_tools` as JSON array of strings everywhere
- `tier` enum: 'experimental' | 'canonical' | 'canonical+' | 'archived'
- `kind` strings: `pretooluse_block/warn/suggest/passive/pass`, `stop_analyze/extract`, `rule_created/updated/archived`, `posttool_ok/fail`, `session_start`, `prompt_match`

---

## Execution Handoff

**Plan complete and saved to `docs/plans/2026-05-15-teamagent-memory-v0.2-M1.md`.**

26 tasks. Estimated 1.5-2 wall days @ ~30-60 min/task including review.

Two execution options:

1. **Subagent-Driven (recommended)** — Dispatcher launches one fresh subagent per task, reviews diff between tasks, fast iteration with clean context per task.

2. **Inline Execution** — Run tasks in this same session with `superpowers:executing-plans`, batch execution with checkpoint reviews every 4-5 tasks.

Which approach?
