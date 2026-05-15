# teamagent-memory v0.2 — M3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (Inline mode).

**Goal:** Close the feedback loop. PostToolUse detects when a user "rolls forward" a denied command (override) and queues an `override_detected` event. The next UserPromptSubmit injects a 3-option reply prompt. A new `mute-rule` skill (paired with `bin/teamagent classify`) parses the reply and either demotes the rule (`rule-wrong`) or writes a `rule_exceptions` row (`context-specific`). The match path skips rules with matching exceptions.

**Architecture:** New `lib/override.cjs` houses the detection algorithm + a small `claude -p` call (extract `condition` from user reply). PostToolUse hook calls into it. UserPromptSubmit hook checks for unhandled `override_detected` events at session start and injects the reply prompt. New CLI `teamagent classify <event_id> a|b|c [--condition "..."]` mutates state. `lib/match.cjs` adds an "exception filter" before returning candidates.

**Tech stack additions:** None new (reuses `@xenova/transformers`, `child_process` from M2).

**Reference docs:** DESIGN §6.3, §8, ADR-0010, M1/M2 smoke notes.

---

## Scope

**In M3:**
- `lib/override.cjs`: detection window (last 5 events of session; deny+similar-command+ok)
- `hooks/posttool-record.cjs`: call detection, append `override_detected` event
- `hooks/userprompt-inject.cjs`: surface unhandled override(s) as reply prompt
- `bin/teamagent classify <event_id> <a|b|c> [--condition "..."]`
- `lib/rules.cjs`: `addException(parent_rule_id, condition, example)` + `listExceptions(parent_rule_id)`
- `lib/match.cjs`: filter out a rule when its `exceptions` include a condition matching the current query (literal substring match for M3; semantic exception match deferred)
- `skills/mute-rule/SKILL.md`: tells assistant how to handle the reply prompt and call `classify` on user's answer
- Integration test: deny -> override -> reply -> exception write -> next match skips

**Out of scope (defer):**
- Semantic `condition` matching (currently literal substring); could go in M4
- Bidirectional compile (M5 stretch)
- Voyage / nomic-embed-code swap (ADR-0001 still locks e5-small)

---

## File structure

```
plugins/teamagent-memory/
  hooks/lib/
    override.cjs                  NEW — detection + condition extract via claude -p
  hooks/
    posttool-record.cjs           MODIFY — call detector
    userprompt-inject.cjs         MODIFY — surface pending override reply
  bin/
    teamagent.cjs                 MODIFY — add `classify` subcommand
  hooks/lib/
    rules.cjs                     MODIFY — addException, listExceptions
    match.cjs                     MODIFY — skip rules whose exception condition fires
  skills/
    mute-rule/SKILL.md            NEW
  test/unit/
    override.test.cjs             NEW
  test/integration/
    override-flow.test.cjs        NEW
```

---

## Task 1: lib/override.cjs — detection + condition extract

**Files:**
- Create: `plugins/teamagent-memory/hooks/lib/override.cjs`
- Test: `plugins/teamagent-memory/test/unit/override.test.cjs`

- [ ] **Step 1: Implementation**

```javascript
// hooks/lib/override.cjs
"use strict";

const { spawn } = require("child_process");
const { readEvents } = require("./events.cjs");

// Detection: within last LOOKBACK events of this session,
// is there a pretooluse_{block,warn} followed by the current PostToolUse
// reporting success on a "similar" command?
const LOOKBACK = 10;
const SIMILARITY_THRESHOLD = 0.6;  // simple Jaccard token similarity

function tokenize(s) {
  return new Set(String(s || "").toLowerCase().split(/[^a-z0-9_\-\/@.]+/).filter(Boolean));
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function detect(eventsDb, sessionId, currentCommand, currentExitOk) {
  if (!eventsDb || !currentExitOk || !sessionId) return null;
  let rows;
  try { rows = readEvents(eventsDb, { session_id: sessionId, limit: LOOKBACK + 1 }); }
  catch (_e) { return null; }
  if (!rows || rows.length === 0) return null;

  const currentToks = tokenize(currentCommand);
  for (const r of rows) {
    if (r.kind !== "pretooluse_block" && r.kind !== "pretooluse_warn") continue;
    if (!r.rule_id) continue;
    const payload = r.payload_json ? safeParse(r.payload_json) : null;
    const prior = payload && typeof payload.command === "string" ? payload.command : "";
    if (!prior) continue;
    const sim = jaccard(currentToks, tokenize(prior));
    if (sim >= SIMILARITY_THRESHOLD) {
      return { rule_id: r.rule_id, prior_command: prior, similarity: sim };
    }
  }
  return null;
}

function safeParse(s) { try { return JSON.parse(s); } catch (_e) { return null; } }

// Extract a one-line "condition" from a user reply describing the context.
// Returns null if extract fails. Uses the same `claude -p` shape as lib/extract.cjs.
async function extractCondition(userReply, opts = {}) {
  const claudeBin = opts.claudeBin || ["claude"];
  const timeoutMs = opts.timeoutMs || 20000;
  const model = opts.model || process.env.TEAMAGENT_EXTRACT_MODEL || "claude-haiku-4-5";
  const prompt = `Extract a one-line "condition" describing the specific context in which a TeamAgent rule
should be skipped, based on the user's reply below. Output JSON only:
{ "condition": "<one short clause, less than 20 words>", "example": "<optional matching token from the reply, or null>" }

User reply:
<<<
${userReply}
>>>

If the reply doesn't describe a real exception context (just venting / ambiguous), return:
{ "condition": null }`;
  return new Promise((resolve) => {
    const args = [
      ...claudeBin.slice(1),
      "-p",
      "--model", model,
      "--output-format", "json",
      "--max-turns", "1",
      "--disallowed-tools", "*",
    ];
    const child = spawn(claudeBin[0], args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(opts.env || {}) } });
    let stdout = "", stderr = "";
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; resolve(v); };
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch (_e) {} finish(null); }, timeoutMs);
    child.stdout.on("data", d => stdout += d.toString());
    child.stderr.on("data", d => stderr += d.toString());
    child.on("error", () => { clearTimeout(timer); finish(null); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) return finish(null);
      const text = stdout.trim();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (_e) {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { try { parsed = JSON.parse(m[0]); } catch (_e2) {} }
      }
      if (parsed && typeof parsed.condition === "string" && parsed.condition.length > 0 && parsed.condition.length < 200) return finish(parsed);
      finish(null);
    });
    try { child.stdin.write(prompt); child.stdin.end(); } catch (_e) {}
  });
}

module.exports = { detect, extractCondition, tokenize, jaccard, LOOKBACK, SIMILARITY_THRESHOLD };
```

- [ ] **Step 2: Tests**

```javascript
// test/unit/override.test.cjs
const path = require("path");
const os = require("os");
const fs = require("fs");
const { openEventsDb, closeDb } = require("../../hooks/lib/db.cjs");
const { writeEvent } = require("../../hooks/lib/events.cjs");
const { detect, extractCondition, jaccard, tokenize } = require("../../hooks/lib/override.cjs");

function tmpEventsDb() {
  const p = path.join(os.tmpdir(), `tovr-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  return openEventsDb(p);
}

const FAKE = path.join(__dirname, "..", "fixtures", "fake-claude.cjs");

describe("override.detect", () => {
  it("returns null when no prior deny", () => {
    const db = tmpEventsDb();
    writeEvent(db, { kind: "session_start", session_id: "S1" });
    expect(detect(db, "S1", "npm install moment", true)).toBeNull();
    closeDb(db);
  });

  it("returns hit when prior block + similar command + ok", () => {
    const db = tmpEventsDb();
    writeEvent(db, { kind: "pretooluse_block", session_id: "S1", rule_id: "r-1", payload: { command: "npm install moment" } });
    const out = detect(db, "S1", "npm install moment", true);
    expect(out).toBeTruthy();
    expect(out.rule_id).toBe("r-1");
    expect(out.similarity).toBeCloseTo(1.0, 1);
    closeDb(db);
  });

  it("returns null when prior block but command is different", () => {
    const db = tmpEventsDb();
    writeEvent(db, { kind: "pretooluse_block", session_id: "S1", rule_id: "r-1", payload: { command: "npm install moment" } });
    const out = detect(db, "S1", "ls -la", true);
    expect(out).toBeNull();
    closeDb(db);
  });

  it("warn also triggers detection", () => {
    const db = tmpEventsDb();
    writeEvent(db, { kind: "pretooluse_warn", session_id: "S1", rule_id: "r-w", payload: { command: "npm install moment" } });
    const out = detect(db, "S1", "npm install moment@2.29", true);
    expect(out).toBeTruthy();
    expect(out.rule_id).toBe("r-w");
    closeDb(db);
  });

  it("does not trigger when exit_code != 0", () => {
    const db = tmpEventsDb();
    writeEvent(db, { kind: "pretooluse_block", session_id: "S1", rule_id: "r-1", payload: { command: "npm install moment" } });
    expect(detect(db, "S1", "npm install moment", false)).toBeNull();
    closeDb(db);
  });
});

describe("jaccard", () => {
  it("returns 1.0 for identical token sets", () => {
    expect(jaccard(tokenize("npm install moment"), tokenize("npm install moment"))).toBeCloseTo(1.0);
  });
  it("returns ~0.5 for half-overlap", () => {
    expect(jaccard(tokenize("a b"), tokenize("b c"))).toBeCloseTo(1/3);
  });
});

describe("extractCondition (with fake-claude)", () => {
  it("fake-claude error mode returns null", async () => {
    const out = await extractCondition("just testing", { claudeBin: ["node", FAKE], env: { FAKE_CLAUDE_MODE: "error" }, timeoutMs: 5000 });
    expect(out).toBeNull();
  }, 10000);

  it("fake-claude invalid output returns null", async () => {
    const out = await extractCondition("testing", { claudeBin: ["node", FAKE], env: { FAKE_CLAUDE_MODE: "invalid" }, timeoutMs: 5000 });
    expect(out).toBeNull();
  }, 10000);
});
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run test/unit/override.test.cjs
git add hooks/lib/override.cjs test/unit/override.test.cjs
git commit -m "M3.01 lib/override — detection + condition extract"
```

---

## Task 2: lib/rules.cjs — addException + listExceptions

**Files:**
- Modify: `plugins/teamagent-memory/hooks/lib/rules.cjs`
- Test: extend `test/unit/rules.test.cjs`

- [ ] **Step 1: Implementation**

Add to `hooks/lib/rules.cjs`:

```javascript
function addException(db, { parent_rule_id, condition, example }) {
  const id = `exc-${parent_rule_id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.prepare(`
    INSERT INTO rule_exceptions (id, parent_rule_id, condition, example, captured_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, parent_rule_id, condition, example || null, new Date().toISOString());
  return id;
}

function listExceptions(db, parent_rule_id) {
  return db.prepare("SELECT * FROM rule_exceptions WHERE parent_rule_id = ?").all(parent_rule_id);
}
```

Export them in `module.exports`.

- [ ] **Step 2: Test**

Add to `test/unit/rules.test.cjs`:

```javascript
describe("rule_exceptions", () => {
  const { addException, listExceptions } = require("../../hooks/lib/rules.cjs");

  it("addException + listExceptions round-trip", () => {
    const db = tmpKnowDb();
    insertRule(db, sampleRule);
    addException(db, { parent_rule_id: sampleRule.id, condition: "in test fixtures", example: "moment in __tests__/" });
    const out = listExceptions(db, sampleRule.id);
    expect(out.length).toBe(1);
    expect(out[0].condition).toBe("in test fixtures");
    closeDb(db);
  });

  it("listExceptions returns empty when none", () => {
    const db = tmpKnowDb();
    insertRule(db, sampleRule);
    expect(listExceptions(db, sampleRule.id)).toEqual([]);
    closeDb(db);
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add hooks/lib/rules.cjs test/unit/rules.test.cjs
git commit -m "M3.02 lib/rules — addException + listExceptions"
```

---

## Task 3: PostToolUse — call override detection

**Files:**
- Modify: `plugins/teamagent-memory/hooks/posttool-record.cjs`

- [ ] **Step 1: Add detection call**

After writing the `posttool_ok` event, look up overrides:

```javascript
const { detect } = require("./lib/override.cjs");

// ... existing logic ...

if (kind === "posttool_ok") {
  const command = ev.tool_input && typeof ev.tool_input.command === "string" ? ev.tool_input.command : "";
  const hit = detect(eventsDb, session_id, command, true);
  if (hit) {
    logHook(eventsDb, "PostToolUse", {
      kind: "override_detected",
      session_id,
      rule_id: hit.rule_id,
      payload: { prior_command: hit.prior_command, similarity: hit.similarity, current_command: command.slice(0, 500) },
    });
  }
}
```

- [ ] **Step 2: Re-run tests + commit**

```bash
npx vitest run test/integration/posttool.test.cjs
git add hooks/posttool-record.cjs
git commit -m "M3.03 PostToolUse — write override_detected event when retry succeeds"
```

---

## Task 4: UserPromptSubmit — surface override reply prompt

**Files:**
- Modify: `plugins/teamagent-memory/hooks/userprompt-inject.cjs`

- [ ] **Step 1: Add unhandled-override check**

Before computing the rule reminder, check for unhandled `override_detected` events:

```javascript
const { readEvents } = require("./lib/events.cjs");

function findUnhandledOverride(eventsDb, session_id) {
  if (!eventsDb || !session_id) return null;
  try {
    const rows = readEvents(eventsDb, { session_id, limit: 50 });
    const handled = new Set();
    for (const r of rows) {
      if (r.kind === "override_classified" && r.rule_id) handled.add(r.rule_id);
    }
    for (const r of rows) {
      if (r.kind === "override_detected" && r.rule_id && !handled.has(r.rule_id)) {
        return r;
      }
    }
  } catch (_e) {}
  return null;
}
```

And in `main()`, before building the regular reminder, check:

```javascript
const override = findUnhandledOverride(eventsDb, session_id);
if (override) {
  // Inject the reply prompt
  const replyLines = [
    `TeamAgent noticed you bypassed rule ${override.rule_id}. Was that:`,
    `  (a) The rule is wrong / no longer applies → demote it`,
    `  (b) Rule is correct but this specific context is an exception → save the exception`,
    `  (c) Skip — don't touch the rule`,
    `Reply with a/b/c. For (b), explain the context in one sentence.`,
    `(To classify directly: \`teamagent classify ${override.id} a|b|c [--condition "..."]\`)`,
  ];
  const out = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: replyLines.join("\n"),
    },
  };
  process.stdout.write(JSON.stringify(out));
  for (const db of [knowledgeDb, globalDb, eventsDb]) closeDb(db);
  process.exit(0);
}
```

- [ ] **Step 2: Commit**

```bash
git add hooks/userprompt-inject.cjs
git commit -m "M3.04 UserPromptSubmit — inject override reply prompt when unhandled"
```

---

## Task 5: CLI `teamagent classify`

**Files:**
- Modify: `plugins/teamagent-memory/bin/teamagent.cjs`
- Test: extend `test/integration/cli.test.cjs`

- [ ] **Step 1: Implementation**

In `bin/teamagent.cjs`, add `cmdClassify`:

```javascript
const { addException } = require(path.join(HOOKS_LIB, "rules.cjs"));

async function cmdClassify(args) {
  // teamagent classify <event_id> <a|b|c> [--condition "..."]
  const [eventIdStr, choice, ...rest] = args;
  if (!eventIdStr || !choice) { console.error("classify: need <event_id> <a|b|c>"); return 2; }
  let condition = null;
  for (let i = 0; i < rest.length; i++) if (rest[i] === "--condition") condition = rest[++i];

  let ev = null;
  try { ev = openEventsDb(resolveEventsDbPath()); } catch (_e) { console.error("cannot open events.db"); return 1; }
  const event = ev.prepare("SELECT * FROM events WHERE id = ?").get(parseInt(eventIdStr, 10));
  if (!event || event.kind !== "override_detected") {
    console.error("classify: event not found or not an override_detected"); closeDb(ev); return 1;
  }
  const ruleId = event.rule_id;
  const dbs = bothDbs();
  const found = findRule(dbs, ruleId);
  if (!found) { console.error("classify: rule not found: " + ruleId); closeDb(ev); closeAll(dbs); return 1; }

  if (choice === "a") {
    const { applyEvent } = require(path.join(HOOKS_LIB, "confidence.cjs"));
    const { updateRule } = require(path.join(HOOKS_LIB, "rules.cjs"));
    const next = applyEvent(found.rule, { kind: "miss", at: new Date().toISOString() });
    updateRule(found.db, ruleId, { misses: next.misses, wilson_lower: next.wilson_lower, last_demerit_at: next.last_demerit_at, tier: next.tier });
    ev.prepare(`INSERT INTO events (ts, kind, rule_id, payload_json) VALUES (?, 'override_classified', ?, ?)`).run(new Date().toISOString(), ruleId, JSON.stringify({ classification: "rule_wrong" }));
    console.log(`classified as rule-wrong; demoted to tier=${next.tier} wilson=${next.wilson_lower.toFixed(2)}`);
  } else if (choice === "b") {
    if (!condition) { console.error("classify b: --condition required"); closeDb(ev); closeAll(dbs); return 2; }
    addException(found.db, { parent_rule_id: ruleId, condition, example: null });
    ev.prepare(`INSERT INTO events (ts, kind, rule_id, payload_json) VALUES (?, 'override_classified', ?, ?)`).run(new Date().toISOString(), ruleId, JSON.stringify({ classification: "context_specific", condition }));
    console.log(`classified as context-specific; exception saved: "${condition}"`);
  } else if (choice === "c") {
    ev.prepare(`INSERT INTO events (ts, kind, rule_id, payload_json) VALUES (?, 'override_classified', ?, ?)`).run(new Date().toISOString(), ruleId, JSON.stringify({ classification: "skip" }));
    console.log(`classified as skip (no change to rule)`);
  } else {
    console.error("classify: choice must be a/b/c"); closeDb(ev); closeAll(dbs); return 2;
  }
  closeDb(ev); closeAll(dbs);
  return 0;
}
```

Add to switch statement: `case "classify": return cmdClassify(rest);`.
Add to usage().

- [ ] **Step 2: Tests + commit**

```bash
npx vitest run test/integration/cli.test.cjs
git add bin/teamagent.cjs test/integration/cli.test.cjs
git commit -m "M3.05 teamagent classify <event_id> <a|b|c> [--condition ...]"
```

---

## Task 6: lib/match.cjs — exception filter

**Files:**
- Modify: `plugins/teamagent-memory/hooks/lib/match.cjs`

- [ ] **Step 1: Pass exceptions through rule object**

The hooks pre-load rules via `listRules`. Extend to pre-load exceptions per rule. In `pretooluse-enforce.cjs`:

```javascript
const { listExceptions } = require("./lib/rules.cjs");
// after listRules:
for (const r of rules) {
  r._exceptions = []; // empty; only project / global db has them
}
// Actually we need to pull from the db that the rule came from. Use scope:
for (const r of rules) {
  const sourceDb = r.scope === "project" ? knowledgeDb : globalDb;
  if (sourceDb) {
    try { r._exceptions = listExceptions(sourceDb, r.id); } catch (_e) { r._exceptions = []; }
  }
}
```

- [ ] **Step 2: Filter in match.cjs**

In `match.cjs`, after determining candidate, filter:

```javascript
function ruleHasMatchingException(rule, query) {
  const excs = rule._exceptions;
  if (!Array.isArray(excs) || excs.length === 0) return false;
  const q = (query || "").toLowerCase();
  for (const e of excs) {
    if (typeof e.condition === "string" && e.condition.length > 0) {
      if (q.includes(e.condition.toLowerCase())) return true;
      // Also match any single token in condition
      const tokens = e.condition.toLowerCase().split(/\s+/).filter(t => t.length > 2);
      for (const t of tokens) if (q.includes(t)) return true;
    }
  }
  return false;
}
```

Apply this filter in `runMatch` for all 3 layers — if matched, drop from candidates.

```javascript
function _applyExceptions(query, matches) {
  return matches.filter(m => !ruleHasMatchingException(m.rule, query));
}
```

And call `matches = _applyExceptions(query, matches)` before returning at each layer.

Export `ruleHasMatchingException` for tests.

- [ ] **Step 3: Tests + commit**

```bash
npx vitest run test/unit/match3layer.test.cjs test/integration/pretooluse.test.cjs
git add hooks/lib/match.cjs hooks/pretooluse-enforce.cjs hooks/userprompt-inject.cjs
git commit -m "M3.06 match — skip rules with matching exception condition"
```

---

## Task 7: skill `mute-rule`

**Files:**
- Create: `plugins/teamagent-memory/skills/mute-rule/SKILL.md`

- [ ] **Step 1: SKILL.md**

```markdown
---
name: mute-rule
description: Use when the user replies a/b/c to an override reply prompt from UserPromptSubmit, or directly asks to mute / demote / except a TeamAgent rule.
---

# mute-rule

Process the user's reply to an override reply prompt, or handle direct mute requests.

## When to use

- Last assistant prompt contained `TeamAgent noticed you bypassed rule ...`
- User replies with "a", "b", or "c" (case-insensitive)
- Or user types `/mute-rule <id>`, `/exception <id> <condition>`, etc.

## How to process

1. Find the most recent unhandled `override_detected` event:
   `teamagent events 20 | grep override_detected` (most recent first).
2. Parse the user reply:
   - "a" / "rule is wrong" / "demote" → `teamagent classify <event_id> a`
   - "b" / "exception" / context phrase → `teamagent classify <event_id> b --condition "..."`
   - "c" / "skip" → `teamagent classify <event_id> c`
3. For (b), if the user didn't include a condition phrase, ask one clarifying
   question: "What's the context that makes this OK? e.g., 'in test fixtures', 'on Node 16'".
4. Echo back to the user the resulting state ("rule demoted to canonical", "exception saved").

## What this skill does NOT do

- Does not edit the database directly — always goes through `teamagent classify`
- Does not re-fire the original blocked command
- Does not skip the question for choice (b); rule exceptions need a clear context

## Examples

User says "a" → run `teamagent classify <event_id> a` → report new tier
User says "this is in our test fixtures" → infer (b), `teamagent classify <event_id> b --condition "in test fixtures"`
User says "skip" or "leave it" → `teamagent classify <event_id> c`
```

- [ ] **Step 2: Commit**

```bash
git add skills/mute-rule/SKILL.md
git commit -m "M3.07 skills/mute-rule — handle a/b/c override reply"
```

---

## Task 8: end-to-end test + smoke note

**Files:**
- Create: `plugins/teamagent-memory/test/integration/override-flow.test.cjs`
- Create: `docs/notes/M3-smoke-<date>.md`

- [ ] **Step 1: Integration test**

```javascript
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { openKnowledgeDb, openEventsDb, closeDb } = require("../../hooks/lib/db.cjs");
const { insertRule } = require("../../hooks/lib/rules.cjs");
const { readEvents } = require("../../hooks/lib/events.cjs");
const { embedText, packEmbedding } = require("../../hooks/lib/embed.cjs");

function tmpHome() {
  const d = path.join(os.tmpdir(), `tovr-flow-${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

describe("override flow end-to-end", () => {
  beforeAll(async () => { await embedText("warmup"); }, 900000);

  it("deny -> retry -> override_detected -> classify b -> exception saved -> next match skips", async () => {
    const HOME = tmpHome();
    const env = { ...process.env, HOME, USERPROFILE: HOME };
    const gp = path.join(HOME, ".teamagent", "global.db");
    const gdb = openKnowledgeDb(gp);
    const v = await embedText("Adopting moment. Use dayjs. deprecated");
    insertRule(gdb, {
      id: "r-moment", scope: "global", tier: "canonical+",
      wrong: "Adopting moment", correct: "Use dayjs", why: "deprecated",
      match_regex: "(npm|pnpm|yarn)\\s+(install|add)\\s+moment",
      match_literals: ["moment"], match_tools: ["Bash"], match_scope_globs: null,
      embedding: packEmbedding(v), embed_model: "multilingual-e5-small@v1",
      embed_text: "Adopting moment. Use dayjs. deprecated",
      hits: 30, misses: 0, exceptions: 0, wilson_lower: 0.93, prior: 0.6,
      captured_at: "2026-05-15T00:00:00Z",
    });
    closeDb(gdb);

    const SESSION = "S-override";
    // 1. PreToolUse: deny
    const pretool = spawnSync("node", [path.join(__dirname, "..", "..", "hooks", "pretooluse-enforce.cjs")], {
      input: JSON.stringify({ session_id: SESSION, tool_name: "Bash", tool_input: { command: "npm install moment" } }),
      env, encoding: "utf8",
    });
    const decision = JSON.parse(pretool.stdout).hookSpecificOutput.permissionDecision;
    expect(decision).toBe("deny");

    // 2. PostToolUse: user reissued retried successfully
    spawnSync("node", [path.join(__dirname, "..", "..", "hooks", "posttool-record.cjs")], {
      input: JSON.stringify({ session_id: SESSION, tool_name: "Bash", tool_input: { command: "npm install moment" }, tool_response: { exit_code: 0 } }),
      env, encoding: "utf8",
    });
    const evdb = openEventsDb(path.join(HOME, ".teamagent", "events.db"));
    const overrideEvents = readEvents(evdb, { kind: "override_detected" });
    expect(overrideEvents.length).toBeGreaterThan(0);
    const eventId = overrideEvents[0].id;
    closeDb(evdb);

    // 3. CLI classify b with condition
    const cli = path.join(__dirname, "..", "..", "bin", "teamagent.cjs");
    const cls = spawnSync("node", [cli, "classify", String(eventId), "b", "--condition", "in test fixtures"], { env, encoding: "utf8" });
    expect(cls.status).toBe(0);

    // 4. Next PreToolUse with query containing "test fixtures" should be skipped
    const next = spawnSync("node", [path.join(__dirname, "..", "..", "hooks", "pretooluse-enforce.cjs")], {
      input: JSON.stringify({ session_id: SESSION, tool_name: "Bash", tool_input: { command: "npm install moment in test fixtures" } }),
      env, encoding: "utf8",
    });
    expect(next.status).toBe(0);
    // exception fires -> rule skipped -> pass (no stdout)
    expect(next.stdout.trim()).toBe("");
  }, 120000);
});
```

- [ ] **Step 2: Run + smoke note + commit**

```bash
npx vitest run test/integration/override-flow.test.cjs
git add test/integration/override-flow.test.cjs
git commit -m "M3.08 end-to-end override-flow test"
```

Then write `docs/notes/M3-smoke-<date>.md` with results, commit separately.

---

## Self-Review

- [x] DESIGN §6.3 + §8 (override classification) → Tasks 1-5
- [x] `rule_exceptions` (schema v1) writes → Task 2
- [x] Match-time exception filter → Task 6
- [x] mute-rule skill → Task 7
- [x] End-to-end demo → Task 8

**Out of scope confirmed:**
- Semantic exception matching (current is literal/token substring) — M4 if needed
- AGENTS.md propagation (M5 stretch)

**Placeholder scan:** none.

---

## Execution: Inline (auto-chosen, no asking).
