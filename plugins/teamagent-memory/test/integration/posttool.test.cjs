const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { openEventsDb, closeDb } = require("../../hooks/lib/db.cjs");
const { readEvents } = require("../../hooks/lib/events.cjs");
const { resolveEventsDbPath } = require("../../hooks/lib/paths.cjs");

function tmpHome() {
  const d = path.join(os.tmpdir(), `tpost-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const HOOK = path.join(__dirname, "..", "..", "hooks", "posttool-record.cjs");

describe("posttool-record", () => {
  it("records tool result event with exit code", () => {
    const HOME = tmpHome();
    const env = { ...process.env, HOME, USERPROFILE: HOME };
    const input = JSON.stringify({
      session_id: "S1", tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: { exit_code: 0, stderr: "" },
    });
    const r = spawnSync("node", [HOOK], { input, env, encoding: "utf8" });
    expect(r.status).toBe(0);
    process.env.HOME = HOME;
    const db = openEventsDb(path.join(HOME, ".teamagent", "events.db"));
    const ev = readEvents(db, { limit: 1 })[0];
    expect(ev.kind).toBe("posttool_ok");
    expect(ev.tool_name).toBe("Bash");
    closeDb(db);
  });

  it("records posttool_fail when exit_code != 0", () => {
    const HOME = tmpHome();
    const env = { ...process.env, HOME, USERPROFILE: HOME };
    const input = JSON.stringify({
      session_id: "S1", tool_name: "Bash",
      tool_input: { command: "false" },
      tool_response: { exit_code: 1, stderr: "boom" },
    });
    const r = spawnSync("node", [HOOK], { input, env, encoding: "utf8" });
    expect(r.status).toBe(0);
    const db = openEventsDb(path.join(HOME, ".teamagent", "events.db"));
    const ev = readEvents(db, { limit: 1 })[0];
    expect(ev.kind).toBe("posttool_fail");
    closeDb(db);
  });
});
