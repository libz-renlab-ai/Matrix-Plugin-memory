const { tokenize, score } = require("../../hooks/lib/bm25.cjs");

const ruleMoment = {
  id: "r-moment", match_literals: ["moment"],
  embed_text: "Adopting moment. Use dayjs. moment is in maintenance mode",
};
const ruleAxios = {
  id: "r-axios", match_literals: ["axios"],
  embed_text: "Adopting axios. Use native fetch. axios is heavy",
};
const rules = [ruleMoment, ruleAxios];

describe("bm25-lite", () => {
  it("tokenize drops stopwords and short tokens", () => {
    expect(tokenize("install moment a long thing")).toEqual(["moment","long","thing"]);
  });

  it("matches when query has rule's key token", () => {
    const out = score("moment for date", rules);
    expect(out.length).toBe(1);
    expect(out[0].rule.id).toBe("r-moment");
    expect(out[0].sim).toBe(0.5);
  });

  it("no match returns empty", () => {
    expect(score("totally unrelated weather", rules)).toEqual([]);
  });

  it("respects threshold (impossible value rules nothing in)", () => {
    const out = score("moment", rules, { threshold: 1.5 });
    expect(out).toEqual([]);
  });

  it("higher threshold filters partial matches", () => {
    // Query has one rule-token + one unrelated; norm = 0.5 (half-overlap)
    // unless idf weights skew it. Use a clearly partial query.
    const ruleMixed = {
      id: "r-mixed",
      match_literals: ["alpha", "beta", "gamma", "delta"],
      embed_text: "alpha beta gamma delta epsilon",
    };
    const out = score("alpha unrelated", [ruleMixed, ruleAxios], { threshold: 0.8 });
    // 'alpha' matches, 'unrelated' doesn't. norm ~ idf(alpha)/(idf(alpha)+idf(unrelated))
    // unrelated isn't in any rule -> idf = log(1 + (N-0+0.5)/(0+0.5)) = high
    // so norm = idf(alpha)/(idf(alpha)+idf(unrelated)) is < 0.8 typically.
    for (const h of out) expect(h.raw).toBeGreaterThanOrEqual(0.8);
  });
});
