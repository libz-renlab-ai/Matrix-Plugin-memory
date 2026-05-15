const { embedText, packEmbedding, unpackEmbedding, cosine, EMBED_DIM } = require("../../hooks/lib/embed.cjs");

describe("embed", () => {
  // Warm up the model so all subsequent tests get a hot cache.
  // First call downloads weights (~125 MB), which can take minutes on slow networks.
  beforeAll(async () => { await embedText("warmup"); }, 900000);

  it("embedText returns Float32Array of length 384", async () => {
    const v = await embedText("npm install moment");
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(EMBED_DIM);
  }, 30000);

  it("L2-normalized: dot with self ≈ 1", async () => {
    const v = await embedText("hello world");
    expect(cosine(v, v)).toBeCloseTo(1.0, 3);
  }, 60000);

  it("deterministic: same text -> same vector", async () => {
    const a = await embedText("npm install moment");
    const b = await embedText("npm install moment");
    expect(cosine(a, b)).toBeCloseTo(1.0, 3);
  }, 60000);

  it("similar texts cluster (cosine > 0.7)", async () => {
    const a = await embedText("npm install moment");
    const b = await embedText("pnpm add moment");
    expect(cosine(a, b)).toBeGreaterThan(0.7);
  }, 60000);

  it("unrelated texts diverge (cosine < 0.95)", async () => {
    const a = await embedText("npm install moment");
    const b = await embedText("what is the weather today");
    expect(cosine(a, b)).toBeLessThan(0.95);
  }, 60000);

  it("pack/unpack round-trip preserves values", async () => {
    const v = await embedText("test pack roundtrip");
    const buf = packEmbedding(v);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.byteLength).toBe(384 * 4);
    const v2 = unpackEmbedding(buf);
    for (let i = 0; i < v.length; i++) expect(v2[i]).toBeCloseTo(v[i], 5);
  }, 60000);

  it("empty string returns zero vector", async () => {
    const v = await embedText("");
    expect(v.every(x => x === 0)).toBe(true);
  });
});
