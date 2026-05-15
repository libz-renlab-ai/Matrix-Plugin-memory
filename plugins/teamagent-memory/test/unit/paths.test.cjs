const path = require("path");
const os = require("os");
const { resolveProjectDbPath, resolveGlobalDbPath, resolveEventsDbPath, resolveModelsDir } = require("../../hooks/lib/paths.cjs");

describe("paths", () => {
  it("resolveGlobalDbPath returns ~/.teamagent/global.db", () => {
    expect(resolveGlobalDbPath()).toBe(path.join(process.env.HOME || os.homedir(), ".teamagent", "global.db"));
  });

  it("resolveEventsDbPath returns ~/.teamagent/events.db", () => {
    expect(resolveEventsDbPath()).toBe(path.join(process.env.HOME || os.homedir(), ".teamagent", "events.db"));
  });

  it("resolveModelsDir returns ~/.teamagent/models", () => {
    expect(resolveModelsDir()).toBe(path.join(process.env.HOME || os.homedir(), ".teamagent", "models"));
  });

  it("resolveProjectDbPath uses CWD by default", () => {
    expect(resolveProjectDbPath()).toBe(path.join(process.cwd(), ".teamagent", "knowledge.db"));
  });

  it("resolveProjectDbPath accepts explicit repo root", () => {
    expect(resolveProjectDbPath("/some/repo")).toBe(path.join("/some/repo", ".teamagent", "knowledge.db"));
  });
});
