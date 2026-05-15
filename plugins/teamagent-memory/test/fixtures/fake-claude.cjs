#!/usr/bin/env node
// Drop-in stand-in for `claude` CLI. Behavior controlled by env vars:
//   FAKE_CLAUDE_MODE=ok      -> stdout valid JSON rule, exit 0
//   FAKE_CLAUDE_MODE=invalid -> stdout garbage, exit 0
//   FAKE_CLAUDE_MODE=timeout -> sleep forever, never exit
//   FAKE_CLAUDE_MODE=error   -> exit 1, stderr message
"use strict";

const mode = process.env.FAKE_CLAUDE_MODE || "ok";
if (mode === "ok") {
  process.stdout.write(JSON.stringify({
    is_actionable_rule: true,
    wrong: "Adopting moment",
    correct: "Use dayjs",
    why: "moment is in maintenance mode",
    scope_hint: "global",
    match_regex: "(npm|pnpm|yarn)\\s+(install|add)\\s+moment",
    match_literals: ["moment"],
    match_tools: ["Bash"],
    confidence_hint: 0.9,
  }));
  process.exit(0);
} else if (mode === "invalid") {
  process.stdout.write("not JSON at all");
  process.exit(0);
} else if (mode === "timeout") {
  setInterval(() => {}, 1000);
} else if (mode === "error") {
  process.stderr.write("simulated failure\n");
  process.exit(1);
}
