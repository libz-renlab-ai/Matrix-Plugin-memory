const { fastPathMatch, runMatch } = require("../../hooks/lib/match.cjs");

const ruleRegex = { id: "r1", match_regex: "(npm|pnpm|yarn)\\s+(install|add)\\s+moment", match_literals: null };
const ruleLit = { id: "r2", match_regex: null, match_literals: ["axios", "fetch"] };
const ruleNone = { id: "r3", match_regex: null, match_literals: null };

describe("fastPathMatch", () => {
  it("regex matches case-insensitive", () => {
    expect(fastPathMatch("NPM install moment", ruleRegex)).toEqual({ hit: true, sim: 1.0, via: "regex" });
  });
  it("regex does not match unrelated", () => {
    expect(fastPathMatch("ls -la", ruleRegex)).toEqual({ hit: false, sim: 0, via: null });
  });
  it("literal substring case-insensitive", () => {
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
  it("empty rules array returns empty", () => {
    expect(runMatch("xxx", [])).toEqual([]);
  });
});
