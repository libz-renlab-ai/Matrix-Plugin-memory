"use strict";

const path = require("path");
const os = require("os");

const HOME = process.env.HOME || os.homedir();
const TEAMAGENT_HOME = path.join(HOME, ".teamagent");

function resolveProjectDbPath(repoRoot) {
  const root = repoRoot || process.cwd();
  return path.join(root, ".teamagent", "knowledge.db");
}
function resolveGlobalDbPath() { return path.join(TEAMAGENT_HOME, "global.db"); }
function resolveEventsDbPath() { return path.join(TEAMAGENT_HOME, "events.db"); }
function resolveModelsDir() { return path.join(TEAMAGENT_HOME, "models"); }
function resolveTeamagentHome() { return TEAMAGENT_HOME; }

module.exports = {
  resolveProjectDbPath,
  resolveGlobalDbPath,
  resolveEventsDbPath,
  resolveModelsDir,
  resolveTeamagentHome,
};
