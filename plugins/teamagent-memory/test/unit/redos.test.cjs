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
    expect(r.reason).toMatch(/catastrophic|nested|backtrack/i);
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
  it("performance probe rejects catastrophic patterns", () => {
    const r = lintRegex("(.*a){25}$");
    expect(r.ok).toBe(false);
  });
});
