"use strict";

const { writeEvent } = require("./events.cjs");

function logHook(eventsDb, hookName, evt) {
  if (!eventsDb) return;
  writeEvent(eventsDb, { ...evt, hook_name: hookName });
}

module.exports = { logHook };
