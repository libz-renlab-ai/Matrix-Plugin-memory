const { wilsonLowerBound, decay, computeTier, applyEvent, effectiveWilson, PRIOR_FLOOR_N } = require("../../hooks/lib/confidence.cjs");

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
  it("hits=10, misses=10 around 0.27-0.34", () => {
    const w = wilsonLowerBound(10, 10);
    expect(w).toBeGreaterThan(0.27);
    expect(w).toBeLessThan(0.34);
  });
});

describe("decay", () => {
  it("days_idle=0 -> score unchanged", () => {
    expect(decay(0.8, 0)).toBeCloseTo(0.8, 5);
  });
  it("days_idle=60 -> half-life decay (1/e of original at 60d)", () => {
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

describe("effectiveWilson (M2 fix, ADR-0011)", () => {
  it("returns max(wilson, prior) when n < 5 (M1 finding fix)", () => {
    expect(effectiveWilson({ hits: 1, misses: 0, wilson_lower: 0.21, prior: 0.6 })).toBeCloseTo(0.6);
  });
  it("returns pure wilson when n >= 5", () => {
    expect(effectiveWilson({ hits: 5, misses: 0, wilson_lower: 0.57, prior: 0.6 })).toBeCloseTo(0.57);
  });
  it("defaults prior to 0.5 if missing", () => {
    expect(effectiveWilson({ hits: 0, misses: 0, wilson_lower: 0.5 })).toBeCloseTo(0.5);
  });
  it("PRIOR_FLOOR_N is 5", () => {
    expect(PRIOR_FLOOR_N).toBe(5);
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
