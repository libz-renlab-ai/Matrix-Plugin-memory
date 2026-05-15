const { topK } = require("../../hooks/lib/ann.cjs");
const { embedText, packEmbedding } = require("../../hooks/lib/embed.cjs");

describe("ann.topK", () => {
  beforeAll(async () => { await embedText("warmup"); }, 900000);

  it("returns nearest rule above unrelated", async () => {
    const q = await embedText("npm install moment");
    const r1 = { id: "r1", embedding: packEmbedding(await embedText("Adopting moment. Use dayjs. moment is deprecated")) };
    const r2 = { id: "r2", embedding: packEmbedding(await embedText("Adopting axios. Use native fetch. axios is heavy")) };
    const r3 = { id: "r3", embedding: packEmbedding(await embedText("Never push to main without review")) };
    const out = topK(q, [r1, r2, r3], 3);
    expect(out[0].rule.id).toBe("r1");
    expect(out[0].sim).toBeGreaterThan(out[1].sim);
    expect(out[0].sim).toBeGreaterThan(out[2].sim);
  }, 60000);

  it("respects k cap", () => {
    const q = new Float32Array(384).fill(0.5);
    const fake = (i) => ({ id: `r${i}`, embedding: packEmbedding(new Float32Array(384).fill(0.5 - i * 0.01)) });
    const rules = Array.from({ length: 10 }, (_, i) => fake(i));
    const out = topK(q, rules, 3);
    expect(out.length).toBe(3);
  });

  it("skips rules without embedding", async () => {
    const q = await embedText("x");
    const r1 = { id: "r1", embedding: null };
    const r2 = { id: "r2", embedding: packEmbedding(await embedText("hello")) };
    const out = topK(q, [r1, r2], 5);
    expect(out.map(o => o.rule.id)).toEqual(["r2"]);
  }, 30000);
});
