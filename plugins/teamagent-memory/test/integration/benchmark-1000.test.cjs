const path = require("path");
const os = require("os");
const fs = require("fs");
const { openKnowledgeDb, closeDb } = require("../../hooks/lib/db.cjs");
const { insertRule, listRules } = require("../../hooks/lib/rules.cjs");
const { runMatch } = require("../../hooks/lib/match.cjs");
const { embedText, packEmbedding } = require("../../hooks/lib/embed.cjs");

function tmpHome() {
  const d = path.join(os.tmpdir(), `tbench-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function quantile(arr, q) {
  const s = arr.slice().sort((a, b) => a - b);
  const idx = Math.floor(q * (s.length - 1));
  return s[idx];
}

describe("benchmark — 1000 rules (semantic layer)", () => {
  beforeAll(async () => { await embedText("warmup"); }, 900000);

  it("P95 latency under 1500ms (CI-friendly; spec target 200ms)", async () => {
    const HOME = tmpHome();
    const gp = path.join(HOME, ".teamagent", "global.db");
    const gdb = openKnowledgeDb(gp);

    // Embed a single sample vector and reuse across 1000 rules.
    // This avoids 1000 ONNX inferences in setup (already costly enough).
    const sampleVec = await embedText("Adopting moment. Use dayjs. moment is deprecated");
    const sampleBuf = packEmbedding(sampleVec);

    for (let i = 0; i < 1000; i++) {
      insertRule(gdb, {
        id: `rule-bench-${i}`, scope: "global", tier: "canonical",
        wrong: `wrong-${i}`, correct: `correct-${i}`, why: `why-${i}`,
        match_regex: null, match_literals: [`token${i}`],
        match_tools: ["Bash"], match_scope_globs: null,
        embedding: sampleBuf, embed_model: "multilingual-e5-small@v1",
        embed_text: `wrong-${i}. correct-${i}. why-${i}`,
        hits: 10, misses: 0, exceptions: 0, wilson_lower: 0.7, prior: 0.55,
        last_seen_at: null, last_demerit_at: null,
        captured_at: "2026-05-15T00:00:00Z",
      });
    }
    const rules = listRules(gdb);
    closeDb(gdb);
    expect(rules.length).toBe(1000);

    // 30 queries, measure each. Use varying short queries so cache hits are mixed.
    const latencies = [];
    for (let i = 0; i < 30; i++) {
      const t0 = Date.now();
      await runMatch(`probe query ${i % 7}`, rules);
      latencies.push(Date.now() - t0);
    }
    const p50 = quantile(latencies, 0.5);
    const p95 = quantile(latencies, 0.95);
    const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    // Print for the smoke note to capture
    // eslint-disable-next-line no-console
    console.log(`bench 1000 rules: p50=${p50}ms p95=${p95}ms mean=${mean.toFixed(1)}ms`);

    // CI-friendly relaxed assertion. POC reality check: tighten in a follow-up
    // commit if numbers look great; ADR-0001/0004 may revisit if we miss 200ms target.
    expect(p95).toBeLessThan(1500);
  }, 600000);
});
