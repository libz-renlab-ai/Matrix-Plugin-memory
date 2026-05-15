"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { applyKnowledgeSchema, applyEventsSchemaV1 } = require("./schema.cjs");

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function openKnowledgeDb(filePath) {
  ensureParentDir(filePath);
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  applyKnowledgeSchema(db);
  return db;
}

function openEventsDb(filePath) {
  ensureParentDir(filePath);
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  applyEventsSchemaV1(db);
  return db;
}

function closeDb(db) {
  if (!db) return;
  try { db.close(); } catch (_e) { /* ignore */ }
}

module.exports = { openKnowledgeDb, openEventsDb, closeDb };
