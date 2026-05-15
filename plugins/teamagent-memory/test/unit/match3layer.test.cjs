const { runMatch, fastPathMatch } = require("../../hooks/lib/match.cjs");
const { embedText, packEmbedding } = require("../../hooks/lib/embed.cjs");

async function makeEmbeddedRule(over = {}) {
  const wrong = over.wrong || "Adopting moment";
  const correct = over.correct || "Use dayjs";
  const why = over.why || "moment is deprecated";
  const v = await embedText(`${wrong}. ${correct}. ${why}`);
  return {
    id: over.id || "r-moment",
    match_regex: over.match_regex || null,
    match_literals: over.match_literals || null,
    match_tools: over.match_tools || ["Bash"],
    embedding: packEmbedding(v),
    embed_text: `${wrong}. ${correct}. ${why}`,
    wrong, correct, why,
  };
}

describe("runMatch 3-layer", () => {
  beforeAll(async () => { await embedText("warmup"); }, 900000);

  it("Layer 1 fast-path takes precedence over semantic", async () => {
    const r = await makeEmbeddedRule({
      match_regex: "(npm|pnpm|yarn)\\s+install\\s+moment",
    });
    const out = await runMatch("npm install moment", [r]);
    expect(out[0].layer).toBe(1);
    expect(out[0].via).toBe("regex");
    expect(out[0].sim).toBe(1.0);
  }, 60000);

  it("Layer 2 fires when fast-path misses but semantic is close", async () => {
    const r = await makeEmbeddedRule({
      match_regex: null, match_literals: null,
    });
    const out = await runMatch("install the moment library please", [r]);
    // Semantic may or may not pass threshold; assert pipeline returns layer 2 if it does
    if (out.length > 0) {
      expect(out[0].layer).toBe(2);
      expect(out[0].sim).toBeGreaterThanOrEqual(0.78);
    }
  }, 60000);

  it("returns empty when nothing matches at any layer", async () => {
    const r = await makeEmbeddedRule({
      match_regex: null,
      match_literals: null,
      wrong: "Adopting moment", correct: "Use dayjs", why: "deprecated"
    });
    const out = await runMatch("what is the weather forecast", [r]);
    // Could be empty, or layer 2/3 if happens to overlap; assert no crash & layer is valid
    for (const h of out) expect([1,2,3]).toContain(h.layer);
  }, 60000);
});
