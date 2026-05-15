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
  it("scores short rejection '不对' below correction threshold", () => {
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
