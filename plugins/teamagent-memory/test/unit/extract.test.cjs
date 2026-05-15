const path = require("path");
const { runExtract, dedupHash, buildExtractPrompt } = require("../../hooks/lib/extract.cjs");

const FAKE = path.join(__dirname, "..", "fixtures", "fake-claude.cjs");

describe("dedupHash", () => {
  it("stable across calls", () => {
    expect(dedupHash("/path/to/t.jsonl", 12)).toBe(dedupHash("/path/to/t.jsonl", 12));
  });
  it("differs by index", () => {
    expect(dedupHash("/p", 1)).not.toBe(dedupHash("/p", 2));
  });
});

describe("buildExtractPrompt", () => {
  it("contains schema and the context dump", () => {
    const turns = [{ type: "user", message: { content: "don't use moment" } }];
    const p = buildExtractPrompt(turns);
    expect(p).toMatch(/is_actionable_rule/);
    expect(p).toMatch(/don't use moment/);
  });
});

describe("runExtract (mocked binary)", () => {
  it("ok mode returns parsed rule", async () => {
    const ctx = [{ type: "user", message: { content: "don't use moment" } }];
    const out = await runExtract(ctx, { claudeBin: ["node", FAKE], env: { FAKE_CLAUDE_MODE: "ok" }, timeoutMs: 5000 });
    expect(out).toMatchObject({ is_actionable_rule: true, wrong: "Adopting moment" });
  }, 10000);

  it("invalid JSON returns null after retry", async () => {
    const ctx = [{ type: "user", message: { content: "x" } }];
    const out = await runExtract(ctx, { claudeBin: ["node", FAKE], env: { FAKE_CLAUDE_MODE: "invalid" }, timeoutMs: 5000 });
    expect(out).toBeNull();
  }, 15000);

  it("error mode returns null", async () => {
    const out = await runExtract([{}], { claudeBin: ["node", FAKE], env: { FAKE_CLAUDE_MODE: "error" }, timeoutMs: 5000 });
    expect(out).toBeNull();
  }, 10000);

  it("timeout mode returns null", async () => {
    const out = await runExtract([{}], { claudeBin: ["node", FAKE], env: { FAKE_CLAUDE_MODE: "timeout" }, timeoutMs: 800 });
    expect(out).toBeNull();
  }, 10000);
});
